import { spawn } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs'
import path from 'node:path'
import { bus } from '../bus.js'
import { env } from '../config/env.js'
import { swyBin } from './bin.js'
import { discoverCache, infoCache, listCache, normalizeIntent } from './cache.js'
import { policyLock, Semaphore } from './lock.js'
import {
  extractAuditIds,
  inferCategory,
  isDryRunRequest,
  parseErrorPayload,
  parsePolicyBlock,
  parseStdout,
  parseVersion,
  type DryRunRequest,
} from './parse.js'
import { preview, redact, redactDeep } from './redact.js'
import { runtimeRoot, runtimeSwyDir } from './runtime-dir.js'

// Async wrapper around the swytchcode binary. The official JS runtime uses a
// blocking spawnSync and JSON.parse(stderr) (breaks on mixed log lines), so we
// own the process handling: spawn → JSON on stdin → parse both streams.

export type SwyKind = 'exec' | 'dry-run' | 'discover' | 'info' | 'list' | 'policy' | 'audit' | 'help'

export interface SwyArgs {
  body?: unknown
  params?: Record<string, unknown>
  headers?: Record<string, string>
  Authorization?: string
  [key: string]: unknown
}

export interface SwyExecOptions {
  dryRun?: boolean
  timeoutMs?: number
  runId?: string
  signal?: AbortSignal
}

export interface SwyResult<T = unknown> {
  /** Provider response (`data`) for live calls; the request preview for dry-runs. */
  data: T
  raw: unknown
  /** Dry-run: the exact HTTP request the CLI would send (auth redacted by the CLI). */
  request?: DryRunRequest
  statusCode?: number
  auditIds: string[]
  durationMs: number
  exitCode: number
}

export class SwyError extends Error {
  readonly category: string
  readonly retryable: boolean
  readonly suggestedAction?: string
  readonly referenceId?: string
  readonly docsUrl?: string
  readonly exitCode: number
  readonly policyId?: string
  readonly policyMessage?: string
  readonly auditIds: string[]
  readonly tool: string
  readonly data?: unknown

  constructor(init: {
    message: string
    tool: string
    category: string
    exitCode: number
    retryable?: boolean
    suggestedAction?: string
    referenceId?: string
    docsUrl?: string
    policyId?: string
    policyMessage?: string
    auditIds?: string[]
    data?: unknown
  }) {
    super(redact(init.message))
    this.name = 'SwyError'
    this.tool = init.tool
    this.category = init.category
    this.exitCode = init.exitCode
    this.retryable = init.retryable ?? false
    this.suggestedAction = init.suggestedAction
    this.referenceId = init.referenceId
    this.docsUrl = init.docsUrl
    this.policyId = init.policyId
    this.policyMessage = init.policyMessage
    this.auditIds = init.auditIds ?? []
    this.data = init.data
  }

  /** REQUIRES_APPROVAL: Swytchcode is holding the call until a mod approves it (exit 7). */
  get isApprovalHold(): boolean {
    return this.category === 'approval_pending'
  }

  /** Dry-run of a REQUIRES_APPROVAL call: a live run would be held for a mod (nothing was created). */
  get wouldNeedApproval(): boolean {
    return this.category === 'approval_required'
  }

  /** REQUIRES_APPROVAL matched but Swytchcode couldn't open the request (e.g. no HITL provider). Nothing ran. */
  get isApprovalRefused(): boolean {
    return this.category === 'approval_failed'
  }

  /** Blocked by a policies.json rule (POLICY_BLOCKED → policy_denied, RATE_LIMITED → rate_limit). */
  get isPolicy(): boolean {
    return this.category === 'policy_denied' || this.category === 'policy_error' || (this.category === 'rate_limit' && !!this.policyId)
  }
}

// ── Interceptor / result hooks (mock + replay modes, recorder) ────────────

export interface SwyCall {
  kind: SwyKind
  tool: string
  args?: SwyArgs
  argv?: string[]
  opts?: SwyExecOptions
}

export type SwyInterceptor = (call: SwyCall) => Promise<SwyResult | SwyError | undefined> | SwyResult | SwyError | undefined
export type SwyResultListener = (call: SwyCall, outcome: { result?: SwyResult; error?: SwyError }) => void

let interceptor: SwyInterceptor | null = null
const resultListeners = new Set<SwyResultListener>()

export function setSwyInterceptor(fn: SwyInterceptor | null): void {
  interceptor = fn
}

export function onSwyResult(listener: SwyResultListener): () => void {
  resultListeners.add(listener)
  return () => resultListeners.delete(listener)
}

function notify(call: SwyCall, outcome: { result?: SwyResult; error?: SwyError }): void {
  const safeCall = { ...call, args: call.args ? redactDeep(call.args) : undefined }
  for (const l of resultListeners) {
    try {
      l(safeCall, outcome)
    } catch {
      /* listeners must not break execution */
    }
  }
}

// ── Process runner ─────────────────────────────────────────────────────────

const globalSem = new Semaphore(4)
const providerSems = new Map<string, Semaphore>()

function providerOf(tool: string): string {
  return tool.split('.')[0] ?? tool
}

function providerSem(tool: string): Semaphore {
  const p = providerOf(tool)
  let s = providerSems.get(p)
  if (!s) providerSems.set(p, (s = new Semaphore(2)))
  return s
}

interface ProcOutput {
  code: number
  stdout: string
  stderr: string
  durationMs: number
}

const DEFAULT_TIMEOUT_MS = 60_000

function childEnv(): NodeJS.ProcessEnv {
  const e: NodeJS.ProcessEnv = { ...process.env, NO_COLOR: '1' }
  // The CLI reads these itself; keep them only when set.
  if (env.SWYTCHCODE_TOKEN) e.SWYTCHCODE_TOKEN = env.SWYTCHCODE_TOKEN
  return e
}

export function runSwyProcess(
  argv: string[],
  stdin: string | undefined,
  opts: { timeoutMs?: number; signal?: AbortSignal; cwd?: string } = {},
): Promise<ProcOutput> {
  const started = Date.now()
  return new Promise((resolve, reject) => {
    const child = spawn(swyBin(), argv, {
      cwd: opts.cwd ?? runtimeRoot(),
      env: childEnv(),
      windowsHide: true,
      stdio: ['pipe', 'pipe', 'pipe'],
    })
    let stdout = ''
    let stderr = ''
    let settled = false
    const finish = (fn: () => void) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      opts.signal?.removeEventListener('abort', onAbort)
      fn()
    }
    const timer = setTimeout(() => {
      child.kill()
      finish(() => reject(new Error(`swytchcode ${argv[0]} timed out after ${opts.timeoutMs ?? DEFAULT_TIMEOUT_MS}ms`)))
    }, opts.timeoutMs ?? DEFAULT_TIMEOUT_MS)
    const onAbort = () => {
      child.kill()
      finish(() => reject(new Error('aborted')))
    }
    opts.signal?.addEventListener('abort', onAbort, { once: true })

    child.stdout.setEncoding('utf8').on('data', (d: string) => (stdout += d))
    child.stderr.setEncoding('utf8').on('data', (d: string) => (stderr += d))
    child.on('error', (err) => finish(() => reject(err)))
    child.on('close', (code) => finish(() => resolve({ code: code ?? -1, stdout, stderr, durationMs: Date.now() - started })))

    child.stdin.on('error', () => {
      /* process may exit before reading stdin (e.g. --help) */
    })
    if (stdin !== undefined) child.stdin.write(stdin)
    child.stdin.end()
  })
}

// ── Credentials (injected here so callers never handle tokens) ────────────

function withAuth(tool: string, args: SwyArgs, dryRun: boolean): SwyArgs {
  if (args.Authorization) return args
  const p = providerOf(tool)
  const bearer = (token: string | undefined) => (token ? `Bearer ${token}` : dryRun ? 'Bearer dry-run' : undefined)
  let auth: string | undefined
  if (p.startsWith('telegram')) auth = 'x' // the token lives in the patched manifest base URL
  else if (p === 'slack') auth = bearer(env.SLACK_BOT_TOKEN)
  else if (p === 'notion') auth = bearer(env.NOTION_TOKEN)
  else if (p === 'resend') auth = bearer(env.RESEND_API_KEY)
  else if (dryRun) auth = 'dry-run'
  // No token + live call → let the CLI fall back to managed creds (`swy auth connect`).
  return auth ? { ...args, Authorization: auth } : args
}

// ── Events ─────────────────────────────────────────────────────────────────

type SwyCallEvent = Extract<Parameters<typeof bus.emit>[0], { type: 'swy.call' }>

function emitStart(callId: string, call: SwyCall, argsPreview?: string): void {
  bus.emit({
    type: 'swy.call',
    callId,
    runId: call.opts?.runId,
    tool: call.tool,
    command: call.kind,
    status: 'start',
    argsPreview,
  } satisfies SwyCallEvent)
}

function emitEnd(callId: string, call: SwyCall, o: { ok: boolean; durationMs: number; category?: string; auditIds?: string[]; resultPreview?: string; cached?: boolean }): void {
  bus.emit({
    type: 'swy.call',
    callId,
    runId: call.opts?.runId,
    tool: call.tool,
    command: call.kind,
    status: o.ok ? 'ok' : 'error',
    durationMs: o.durationMs,
    category: o.category,
    auditIds: o.auditIds,
    resultPreview: o.resultPreview,
    cached: o.cached,
  } satisfies SwyCallEvent)
}

// ── Error construction ─────────────────────────────────────────────────────

function toSwyError(tool: string, out: ProcOutput): SwyError {
  const payload = parseErrorPayload(out.stderr, out.stdout)
  const message = payload?.error ?? (out.stderr.trim().split(/\r?\n/).pop() || `swytchcode exited with code ${out.code}`)
  const approval = approvalState(out)
  const category = approval ?? payload?.category ?? inferCategory(out.code, message)
  const block = parsePolicyBlock(message)
  return new SwyError({
    message,
    tool,
    category,
    exitCode: out.code,
    retryable: payload?.retryable,
    suggestedAction: payload?.suggested_action,
    referenceId: payload?.reference_id,
    docsUrl: payload?.docs_url,
    policyId: block.policyId,
    policyMessage: block.message,
    auditIds: extractAuditIds(out.stdout + out.stderr),
  })
}

/**
 * REQUIRES_APPROVAL outcomes. Verified 2026-09-26 (2.23.7): with no HITL
 * provider the CLI prints "This command needs approval, but the request could
 * not be created … The command was not run." and exits 6; a created request
 * exits 7 and runs in the background once a mod approves. A dry-run exits 7
 * with "would require human approval … (dry-run/explain)" and creates nothing.
 */
function approvalState(out: ProcOutput): 'approval_pending' | 'approval_failed' | 'approval_required' | undefined {
  const text = `${out.stdout}
${out.stderr}`
  if (/would require human approval|approval required \(dry-run/i.test(text)) return 'approval_required'
  if (/approval request refused|request could not be created/i.test(text)) return 'approval_failed'
  if (out.code === 7 || /pending approval|awaiting approval|waiting for approval|approval request (created|sent)|sent for approval/i.test(text)) return 'approval_pending'
  return undefined
}

/** Policy blocks and approval holds don't print their id; fetch it from the local audit log. */
async function attachPolicyAuditId(err: SwyError, since: number): Promise<SwyError> {
  if (!err.isPolicy && !err.isApprovalHold && !err.isApprovalRefused) return err // dry-run holds leave no audit entry
  try {
    const entries = await swyAuditPolicy(10)
    const hit = entries.find((e) => e.tool === err.tool && e.requestedAt * 1000 >= since - 2000)
    if (hit) err.auditIds.push(hit.id)
  } catch {
    /* audit is best-effort */
  }
  return err
}

/** Slack answers HTTP 200 with {ok:false,error} — "200 OK is not success". */
function providerFailure(tool: string, data: unknown): string | undefined {
  if (providerOf(tool) !== 'slack' || !data || typeof data !== 'object') return undefined
  const d = data as { ok?: boolean; error?: string }
  return d.ok === false ? d.error ?? 'slack_error' : undefined
}

// ── Public API ─────────────────────────────────────────────────────────────

/** Execute (or dry-run) a canonical tool through Swytchcode. */
export async function swyExec<T = unknown>(tool: string, args: SwyArgs = {}, opts: SwyExecOptions = {}): Promise<SwyResult<T>> {
  const kind: SwyKind = opts.dryRun ? 'dry-run' : 'exec'
  const call: SwyCall = { kind, tool, args, opts }
  const callId = randomUUID()
  emitStart(callId, call, preview(args))

  const intercepted = interceptor ? await interceptor(call) : undefined
  if (intercepted instanceof SwyError) {
    emitEnd(callId, call, { ok: false, durationMs: 0, category: intercepted.category, auditIds: intercepted.auditIds, resultPreview: intercepted.message })
    throw intercepted
  }
  if (intercepted) {
    emitEnd(callId, call, { ok: true, durationMs: intercepted.durationMs, auditIds: intercepted.auditIds, resultPreview: preview(intercepted.data), cached: true })
    return intercepted as SwyResult<T>
  }

  const started = Date.now()
  const argv = ['exec', tool, '--json', ...(opts.dryRun ? ['--dry-run'] : [])]
  const stdin = JSON.stringify(withAuth(tool, args, !!opts.dryRun))

  let out: ProcOutput
  try {
    // Provider slot first, so calls queued on a busy provider don't hold global slots.
    out = await providerSem(tool).run(() =>
      globalSem.run(() =>
        policyLock.read(() => runSwyProcess(argv, stdin, { timeoutMs: opts.timeoutMs, signal: opts.signal, cwd: runtimeRoot() })),
      ),
    )
  } catch (e) {
    const err = new SwyError({ message: (e as Error).message, tool, category: 'network', exitCode: -1, retryable: true })
    emitEnd(callId, call, { ok: false, durationMs: Date.now() - started, category: err.category, resultPreview: err.message })
    notify(call, { error: err })
    throw err
  }

  if (out.code !== 0) {
    const err = await attachPolicyAuditId(toSwyError(tool, out), started)
    emitEnd(callId, call, { ok: false, durationMs: out.durationMs, category: err.category, auditIds: err.auditIds, resultPreview: err.message })
    notify(call, { error: err })
    throw err
  }

  const raw = parseStdout(out.stdout)
  const auditIds = extractAuditIds(out.stdout + out.stderr)
  let result: SwyResult<T>
  if (opts.dryRun && isDryRunRequest(raw)) {
    result = { data: raw as T, raw, request: raw, auditIds, durationMs: out.durationMs, exitCode: out.code }
  } else {
    const envelope = (raw ?? {}) as { data?: unknown; request?: DryRunRequest; status_code?: number }
    const data = (envelope.data !== undefined ? envelope.data : raw) as T
    result = { data, raw, request: envelope.request, statusCode: envelope.status_code, auditIds, durationMs: out.durationMs, exitCode: out.code }
  }

  const failure = opts.dryRun ? undefined : providerFailure(tool, result.data)
  if (failure) {
    const err = new SwyError({
      message: `${tool} returned HTTP ${result.statusCode ?? 200} but ok:false (${failure})`,
      tool,
      category: 'provider_error',
      exitCode: 0,
      retryable: failure === 'ratelimited',
      data: redactDeep(result.data),
    })
    emitEnd(callId, call, { ok: false, durationMs: out.durationMs, category: err.category, resultPreview: err.message })
    notify(call, { error: err })
    throw err
  }

  emitEnd(callId, call, { ok: true, durationMs: out.durationMs, auditIds, resultPreview: preview(result.data) })
  notify(call, { result: result as SwyResult })
  return result
}

/** Run a non-exec subcommand (discover/info/list/…) with events + interception. */
async function swyCommand(
  kind: SwyKind,
  tool: string,
  argv: string[],
  opts: { timeoutMs?: number; runId?: string; emit?: boolean } = {},
): Promise<ProcOutput> {
  const call: SwyCall = { kind, tool, argv, opts: { runId: opts.runId } }
  const callId = randomUUID()
  const emit = opts.emit !== false
  if (emit) emitStart(callId, call, argv.slice(1).join(' '))

  const intercepted = interceptor ? await interceptor(call) : undefined
  if (intercepted instanceof SwyError) {
    if (emit) emitEnd(callId, call, { ok: false, durationMs: 0, category: intercepted.category, resultPreview: intercepted.message })
    throw intercepted
  }
  if (intercepted) {
    if (emit) emitEnd(callId, call, { ok: true, durationMs: intercepted.durationMs, resultPreview: preview(intercepted.raw), cached: true })
    const stdout = typeof intercepted.raw === 'string' ? intercepted.raw : JSON.stringify(intercepted.raw)
    return { code: 0, stdout, stderr: '', durationMs: intercepted.durationMs }
  }

  let out: ProcOutput
  try {
    out = await globalSem.run(() => policyLock.read(() => runSwyProcess(argv, undefined, { timeoutMs: opts.timeoutMs ?? 30_000 })))
  } catch (e) {
    const err = new SwyError({ message: (e as Error).message, tool, category: 'network', exitCode: -1, retryable: true })
    if (emit) emitEnd(callId, call, { ok: false, durationMs: 0, category: 'network', resultPreview: err.message })
    notify(call, { error: err })
    throw err
  }
  const ok = out.code === 0 && !/^error:/im.test(out.stdout)
  const result: SwyResult = { data: out.stdout, raw: out.stdout, auditIds: [], durationMs: out.durationMs, exitCode: out.code }
  if (emit) {
    emitEnd(callId, call, {
      ok,
      durationMs: out.durationMs,
      category: ok ? undefined : toSwyError(tool, out).category,
      resultPreview: preview(ok ? out.stdout : parseErrorPayload(out.stderr, out.stdout)?.error ?? out.stderr),
    })
  }
  notify(call, ok ? { result } : { error: toSwyError(tool, out) })
  return out
}

export interface DiscoverCandidate {
  canonical_id: string
  summary?: string
  library?: string
  lib_version?: string
  distance?: number
  type?: string
}

/** Semantic search over the Swytchcode registry (hits the network). */
export async function swyDiscover(
  intent: string,
  opts: { provider?: string; top?: number; runId?: string } = {},
): Promise<{ candidates: DiscoverCandidate[]; cached: boolean }> {
  const top = opts.top ?? 5
  const key = `${normalizeIntent(intent)}|${opts.provider ?? ''}|${top}`
  const hit = discoverCache.get(key) as DiscoverCandidate[] | undefined
  if (hit) {
    emitCached('discover', `discover:${opts.provider ?? '*'}`, opts.runId, hit)
    return { candidates: hit, cached: true }
  }
  const argv = ['discover', intent, '--json', '--top', String(top), ...(opts.provider ? ['--provider', opts.provider] : [])]
  const out = await swyCommand('discover', `discover:${opts.provider ?? '*'}`, argv, { runId: opts.runId })
  if (out.code !== 0) throw toSwyError('discover', out)
  const parsed = parseStdout(out.stdout) as { capabilities?: DiscoverCandidate[] } | undefined
  const candidates = (parsed?.capabilities ?? []).map((c) => ({
    canonical_id: c.canonical_id,
    summary: c.summary,
    library: c.library,
    lib_version: c.lib_version,
    distance: c.distance,
    type: c.type,
  }))
  discoverCache.set(key, candidates)
  return { candidates, cached: false }
}

export interface ToolInfo {
  canonical_id: string
  integration?: string
  version?: string
  summary?: string
  description?: string
  http_method?: string
  endpoint?: string
  inputs?: unknown[]
  output?: unknown
  [k: string]: unknown
}

/** Resolved schema for a canonical ID (local bundles, no network). Cached per bundle version. */
export async function swyInfo(id: string, opts: { runId?: string } = {}): Promise<{ info: ToolInfo; cached: boolean }> {
  const key = `${id}@${bundleFingerprint()}`
  const hit = infoCache.get(key) as ToolInfo | undefined
  if (hit) {
    emitCached('info', id, opts.runId, { canonical_id: hit.canonical_id, endpoint: hit.endpoint })
    return { info: hit, cached: true }
  }
  const out = await swyCommand('info', id, ['info', id, '--json'], { runId: opts.runId })
  const parsed = parseStdout(out.stdout)
  const info = (Array.isArray(parsed) ? parsed[0] : parsed) as ToolInfo | undefined
  if (out.code !== 0 || !info?.canonical_id) {
    const err = toSwyError(id, out)
    throw new SwyError({ message: err.message, tool: id, category: err.category === 'unknown' ? 'not_found' : err.category, exitCode: out.code })
  }
  infoCache.set(key, info)
  return { info, cached: false }
}

/**
 * All canonical IDs available locally for a provider. `swy list methods` prints
 * nothing in 2.23.7 (verified — docs say otherwise), so fall back to scanning
 * the downloaded wrekenfiles, which is exactly what the CLI resolves against.
 */
export async function swyListMethods(provider?: string, opts: { runId?: string } = {}): Promise<string[]> {
  const key = `${provider ?? '*'}@${bundleFingerprint()}`
  const hit = listCache.get(key)
  if (hit) {
    emitCached('list', `list:${provider ?? '*'}`, opts.runId, { count: hit.length })
    return hit
  }
  const out = await swyCommand('list', `list:${provider ?? '*'}`, ['list', 'methods', ...(provider ? [provider] : []), '--json'], {
    runId: opts.runId,
  })
  let ids: string[] = []
  const parsed = parseStdout(out.stdout) as { methods?: Array<{ canonical_id: string }> } | undefined
  if (parsed?.methods?.length) ids = parsed.methods.map((m) => m.canonical_id)
  if (!ids.length) ids = scanWrekenfiles(provider)
  listCache.set(key, ids)
  return ids
}

/** Tools enabled in tooling.json (the fail-closed allow-list). */
export async function swyListTooling(): Promise<string[]> {
  const out = await swyCommand('list', 'list:tooling', ['list', 'tooling', '--json'], { emit: false })
  const parsed = parseStdout(out.stdout) as { methods?: Array<{ canonical_id: string }> } | undefined
  return parsed?.methods?.map((m) => m.canonical_id) ?? []
}

const HELP_ALLOW = new Set([
  'exec', 'discover', 'info', 'list', 'add', 'get', 'policy', 'policy add', 'policy validate', 'audit', 'audit policy',
  'audit network', 'auth', 'auth connect', 'init', 'search', 'doctor', 'mcp', 'mcp serve', 'login', 'sync', 'bootstrap',
  'workspace', 'workflow',
])

/** `swy <sub> --help` for an allow-listed subcommand (CLI-drift probe). */
export async function swyHelp(sub: string, opts: { runId?: string } = {}): Promise<string> {
  const normalized = sub.trim().toLowerCase().replace(/\s+/g, ' ')
  if (!HELP_ALLOW.has(normalized)) {
    throw new SwyError({ message: `subcommand "${sub}" is not in the help allow-list`, tool: 'help', category: 'validation', exitCode: -1 })
  }
  const out = await swyCommand('help', `help:${normalized}`, [...normalized.split(' '), '--help'], { runId: opts.runId })
  return `${out.stdout}${out.stderr}`.trim()
}

let versionCache: string | undefined
export async function swyVersion(): Promise<string> {
  if (versionCache) return versionCache
  const out = await runSwyProcess(['--version'], undefined, { timeoutMs: 15_000 })
  versionCache = parseVersion(out.stdout + out.stderr) ?? 'unknown'
  return versionCache
}

export async function swyPolicyValidate(): Promise<{ valid: boolean; warnings: string[]; output: string }> {
  const out = await runSwyProcess(['policy', 'validate'], undefined, { timeoutMs: 20_000 })
  const output = `${out.stdout}\n${out.stderr}`.trim()
  const warnings = output.split(/\r?\n/).filter((l) => l.trim().startsWith('⚠')).map((l) => l.trim())
  const valid = out.code === 0 && /is valid/i.test(output)
  return { valid, warnings, output }
}

export interface PolicyAuditEntry {
  id: string
  tool: string
  policyId: string
  /** blocked | hitl (waiting for a mod) | approved | rejected | expired | failed */
  status: string
  requestedAt: number // epoch seconds
  resolvedAt?: number
}

export async function swyAuditPolicy(limit = 20): Promise<PolicyAuditEntry[]> {
  const out = await runSwyProcess(['audit', 'policy', '--json', '-n', String(Math.max(limit, 20))], undefined, { timeoutMs: 15_000 })
  return parseJsonl(out.stdout)
    .map((o) => {
      const e = o as { id?: string; tool?: string; policy_id?: string; status?: string; requested_at?: number; resolved_at?: number }
      return { id: e.id ?? '', tool: e.tool ?? '', policyId: e.policy_id ?? '', status: e.status ?? '', requestedAt: e.requested_at ?? 0, resolvedAt: e.resolved_at || undefined }
    })
    .filter((e) => e.id)
    .slice(0, limit)
}

export interface NetworkAuditEntry {
  id: string
  tool: string
  host: string
  method: string
  status: number
  durationMs: number
  timestamp: string
}

export async function swyAuditNetwork(limit = 20): Promise<NetworkAuditEntry[]> {
  const out = await runSwyProcess(['audit', 'network', '--json'], undefined, { timeoutMs: 15_000 })
  return parseJsonl(out.stdout)
    .map((o) => {
      const e = o as { id?: string; tool?: string; host?: string; method?: string; status?: number; duration_ms?: number; timestamp?: string }
      return { id: e.id ?? '', tool: e.tool ?? '', host: e.host ?? '', method: e.method ?? '', status: e.status ?? 0, durationMs: e.duration_ms ?? 0, timestamp: e.timestamp ?? '' }
    })
    .filter((e) => e.id)
    .slice(-limit)
}

// ── helpers ────────────────────────────────────────────────────────────────

function parseJsonl(text: string): unknown[] {
  const out: unknown[] = []
  for (const line of text.split(/\r?\n/)) {
    const l = line.trim()
    if (!l.startsWith('{')) continue
    try {
      out.push(JSON.parse(l))
    } catch {
      /* skip */
    }
  }
  return out
}

function emitCached(kind: SwyKind, tool: string, runId: string | undefined, value: unknown): void {
  const callId = randomUUID()
  const call: SwyCall = { kind, tool, opts: { runId } }
  emitStart(callId, call)
  emitEnd(callId, call, { ok: true, durationMs: 0, cached: true, resultPreview: preview(value) })
}

let fingerprintCache: string | undefined
/** Bundle versions from tooling.json — cache keys change when bundles change. */
export function bundleFingerprint(): string {
  if (fingerprintCache) return fingerprintCache
  let fingerprint: string
  try {
    const tooling = JSON.parse(readFileSync(path.join(runtimeSwyDir(), 'tooling.json'), 'utf8')) as {
      version?: string
      integrations?: Record<string, { version: string }>
    }
    fingerprint = [tooling.version, ...Object.entries(tooling.integrations ?? {}).map(([k, v]) => `${k}@${v.version}`).sort()].join(',')
  } catch {
    fingerprint = 'unknown'
  }
  fingerprintCache = fingerprint
  return fingerprint
}

export function scanWrekenfiles(provider?: string): string[] {
  const root = path.join(runtimeSwyDir(), 'integrations')
  const ids: string[] = []
  const want = provider?.toLowerCase()
  const walk = (dir: string) => {
    for (const name of readdirSync(dir)) {
      const p = path.join(dir, name)
      if (statSync(p).isDirectory()) walk(p)
      else if (name === 'wrekenfile.yaml') {
        for (const m of readFileSync(p, 'utf8').matchAll(/^\s*CANONICAL_ID:\s*(\S+)\s*$/gm)) if (m[1]) ids.push(m[1])
      }
    }
  }
  if (existsSync(root)) walk(root)
  const filtered = want ? ids.filter((id) => id.toLowerCase().startsWith(want) || id.toLowerCase().split('.')[0]?.includes(want)) : ids
  return [...new Set(filtered)].sort()
}

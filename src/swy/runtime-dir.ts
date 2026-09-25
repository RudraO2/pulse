import { cpSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { env } from '../config/env.js'

// The committed `.swytchcode/` is the frozen, reviewable config (bundles,
// allow-list, manifest). At boot we copy it into a gitignored runtime dir and
// patch in things that must never be committed or that the CLI rewrites:
//   • Telegram's base URL carries the bot token ({token} isn't substituted by
//     pass-through auth, and SWYTCHCODE_BASE_URL_* is ignored for templated
//     endpoints — verified 2026-09-25, research §6b).
//   • Per-integration execution policy (retries, timeouts, idempotency).
// All swy processes run with cwd = runtimeRoot().

const PROJECT_ROOT = process.cwd()

export function sourceDir(): string {
  return path.join(PROJECT_ROOT, '.swytchcode')
}

export function runtimeRoot(): string {
  // Tests get their own copy so they never clobber a running server's patched manifest.
  return path.join(PROJECT_ROOT, '.runtime', process.env.PULSE_RUNTIME ?? 'pulse')
}

export function runtimeSwyDir(): string {
  return path.join(runtimeRoot(), '.swytchcode')
}

export function manifestPath(dir = runtimeSwyDir()): string {
  return path.join(dir, 'integrations', 'manifest.json')
}

export function policiesPath(dir = runtimeSwyDir()): string {
  return path.join(dir, 'integrations', 'policies.json')
}

interface ExecutionPolicy {
  max_retries?: number
  retry_on?: number[]
  http_timeout_ms?: number
  total_timeout_ms?: number
  max_response_bytes?: number
  idempotency?: { mode: string; header_name: string; scope?: string }
  [k: string]: unknown
}

interface ManifestEntry {
  production_endpoint: string
  execution_policy?: ExecutionPolicy
  [k: string]: unknown
}

type Manifest = Record<string, ManifestEntry>

const SKIP = /(\.lock$|workspace\.json$|mcp\.pid$)/

/** Per-integration execution policy overrides, keyed by manifest key prefix. */
const POLICY_OVERRIDES: Record<string, Partial<ExecutionPolicy>> = {
  // Sends must not be silently retried on 5xx/timeouts (Telegram/Slack don't
  // honour idempotency keys → a retry could double-post). A 429 means the
  // request was rejected before processing, so retrying it is safe.
  'Telegram.': { retry_on: [429], max_retries: 2, http_timeout_ms: 40000, total_timeout_ms: 90000 },
  'Slack.': { retry_on: [429], max_retries: 2, max_response_bytes: 1_048_576 },
  'Notion.': { max_response_bytes: 1_048_576 },
  'Resend.': { idempotency: { mode: 'dynamic', header_name: 'Idempotency-Key', scope: 'call' } },
}

export function patchManifest(manifest: Manifest, telegramToken: string | undefined): Manifest {
  const out: Manifest = structuredClone(manifest)
  for (const [key, entry] of Object.entries(out)) {
    for (const [prefix, override] of Object.entries(POLICY_OVERRIDES)) {
      if (key.startsWith(prefix)) entry.execution_policy = { ...(entry.execution_policy ?? {}), ...override }
    }
    if (key.startsWith('Telegram.')) {
      entry.production_endpoint = telegramToken
        ? `https://api.telegram.org/bot${telegramToken}`
        : 'https://api.telegram.org/bot{token}'
    }
  }
  return out
}

/**
 * Sync the committed config into the runtime dir and apply patches.
 * Safe to call repeatedly; policies.json in the runtime dir is owned by
 * policies.ts and is preserved unless `resetPolicies` is set.
 */
export function prepareRuntimeDir(opts: { resetPolicies?: boolean } = {}): string {
  const src = sourceDir()
  const dst = runtimeSwyDir()
  if (!existsSync(src)) throw new Error(`.swytchcode/ not found at ${src}`)
  mkdirSync(dst, { recursive: true })

  const keepPolicies = !opts.resetPolicies && existsSync(policiesPath(dst))
  const savedPolicies = keepPolicies ? readFileSync(policiesPath(dst), 'utf8') : undefined

  cpSync(src, dst, { recursive: true, force: true, filter: (p) => !SKIP.test(p) })

  const manifest = JSON.parse(readFileSync(manifestPath(src), 'utf8')) as Manifest
  writeFileSync(manifestPath(dst), JSON.stringify(patchManifest(manifest, env.TELEGRAM_BOT_TOKEN), null, 2))

  if (savedPolicies) writeFileSync(policiesPath(dst), savedPolicies)
  return runtimeRoot()
}

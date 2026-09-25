import { readFileSync } from 'node:fs'
import { beforeAll, describe, expect, it } from 'vitest'
import { bus } from '../../src/bus.js'
import {
  swyExec,
  SwyError,
  swyHelp,
  swyInfo,
  swyListMethods,
  swyListTooling,
  swyPolicyValidate,
  swyVersion,
  setSwyInterceptor,
  onSwyResult,
} from '../../src/swy/exec.js'
import { applyPolicies, getPolicyState, resetPolicyState, setCooldownChats, setDmMembers } from '../../src/swy/policies.js'
import { manifestPath, prepareRuntimeDir } from '../../src/swy/runtime-dir.js'
import { runGuardrailSelfTest } from '../../src/swy/selftest.js'
import type { SequencedEvent } from '../../src/shared/events.js'

// Runs the REAL swytchcode binary, dry-run only (free, no provider traffic).

beforeAll(async () => {
  prepareRuntimeDir({ resetPolicies: true })
  resetPolicyState()
  await applyPolicies({ force: true })
}, 60_000)

describe('runtime dir', () => {
  it('patches Telegram base URL and execution policies', () => {
    const m = JSON.parse(readFileSync(manifestPath(), 'utf8')) as Record<string, { production_endpoint: string; execution_policy: Record<string, unknown> }>
    const tg = Object.entries(m).find(([k]) => k.startsWith('Telegram.'))![1]
    expect(tg.production_endpoint).toMatch(/^https:\/\/api\.telegram\.org\/bot/)
    expect(tg.execution_policy.retry_on).toEqual([429])
    const resend = Object.entries(m).find(([k]) => k.startsWith('Resend.'))![1]
    expect(resend.execution_policy.idempotency).toMatchObject({ mode: 'dynamic', header_name: 'Idempotency-Key' })
  })
})

describe('swy CLI wrapper (real binary)', () => {
  it('reports the CLI version', async () => {
    expect(await swyVersion()).toMatch(/^\d+\.\d+\.\d+$/)
  })

  it('dry-runs Slack postMessage and returns the exact request', async () => {
    const r = await swyExec('slack.chat.postmessage.create', { body: { channel: 'C0TEST', text: 'hello' } }, { dryRun: true })
    expect(r.request?.method).toBe('POST')
    expect(r.request?.url).toBe('https://slack.com/api/chat.postMessage')
    expect(r.request?.headers?.Authorization).toBe('[REDACTED]')
  })

  it('surfaces schema validation errors as category=validation', async () => {
    await expect(swyExec('slack.chat.postmessage.create', {}, { dryRun: true })).rejects.toMatchObject({ category: 'validation' })
  })

  it('blocks secrets through the policy engine and attaches the pol_ audit id', async () => {
    const leak = ['xoxb', '111111111111', 'INTEGRATIONTEST'].join('-')
    const err = (await swyExec('slack.chat.postmessage.create', { body: { channel: 'C0TEST', text: `token ${leak}` } }, { dryRun: true }).catch((e) => e)) as SwyError
    expect(err).toBeInstanceOf(SwyError)
    expect(err.category).toBe('policy_denied')
    expect(err.policyId).toBe('no-secrets')
    expect(err.isPolicy).toBe(true)
    expect(err.message).not.toContain(leak)
    expect(err.auditIds.some((id) => id.startsWith('pol_'))).toBe(true)
  })

  it('emits redacted swy.call events', async () => {
    const events: SequencedEvent[] = []
    const off = bus.on((e) => events.push(e))
    await swyExec('telegram_v5_0.sendmessage.create', { body: { chat_id: -1000000000099, text: 'hi' } }, { dryRun: true, runId: 'r1' })
    off()
    const calls = events.filter((e) => e.type === 'swy.call')
    expect(calls.map((c) => (c as { status: string }).status)).toEqual(['start', 'ok'])
    expect(JSON.stringify(calls)).not.toMatch(/api\.telegram\.org\/bot\d/)
  })

  it('inspects a tool schema and caches it', async () => {
    const first = await swyInfo('notion.page.create')
    expect(first.info.canonical_id).toBe('notion.page.create')
    const second = await swyInfo('notion.page.create')
    expect(second.cached).toBe(true)
  })

  it('reports unknown canonical ids as not_found', async () => {
    await expect(swyInfo('slack.does.not.exist')).rejects.toMatchObject({ category: 'not_found' })
  })

  it('lists methods from local bundles even though `swy list methods` prints nothing', async () => {
    const ids = await swyListMethods('slack')
    expect(ids).toContain('slack.chat.postmessage.create')
    expect(ids.length).toBeGreaterThan(100)
    expect((await swyListMethods('telegram')).length).toBeGreaterThan(50)
  })

  it('lists the fail-closed allow-list', async () => {
    const tools = await swyListTooling()
    expect(tools).toContain('telegram_v5_0.getupdate.create')
    expect(tools).not.toContain('telegram_v5_0.deletemessage.create')
  })

  it('returns CLI help only for allow-listed subcommands', async () => {
    expect(await swyHelp('discover')).toMatch(/--provider/)
    await expect(swyHelp('rm -rf /')).rejects.toMatchObject({ category: 'validation' })
  })

  it('validates the compiled policies', async () => {
    const v = await swyPolicyValidate()
    expect(v.valid).toBe(true)
  })
})

describe('dynamic policies', () => {
  it('cooldown and member lists are enforced by swytchcode', async () => {
    await setCooldownChats('telegram', ['-1005550001'])
    await setDmMembers('telegram', ['9090'])
    expect(getPolicyState().cooldown.telegram).toEqual(['-1005550001'])

    await expect(swyExec('telegram_v5_0.sendmessage.create', { body: { chat_id: -1005550001, text: 'x' } }, { dryRun: true })).rejects.toMatchObject({ category: 'rate_limit', policyId: 'cooldown-telegram' })
    await expect(swyExec('telegram_v5_0.sendmessage.create', { body: { chat_id: 9090, text: 'x' } }, { dryRun: true })).resolves.toBeTruthy()
    await expect(swyExec('telegram_v5_0.sendmessage.create', { body: { chat_id: 9191, text: 'x' } }, { dryRun: true })).rejects.toMatchObject({ policyId: 'dm-members-only-telegram' })

    await setCooldownChats('telegram', [])
    await expect(swyExec('telegram_v5_0.sendmessage.create', { body: { chat_id: -1005550001, text: 'x' } }, { dryRun: true })).resolves.toBeTruthy()
  })

  it('rewrites policies safely while execs are in flight', async () => {
    const execs = Array.from({ length: 6 }, (_, i) =>
      swyExec('slack.chat.postmessage.create', { body: { channel: `C0PAR${i}`, text: 'x' } }, { dryRun: true }),
    )
    const writes = [setCooldownChats('slack', ['C0A']), setCooldownChats('slack', ['C0A', 'C0B']), setCooldownChats('slack', [])]
    await expect(Promise.all([...execs, ...writes])).resolves.toBeTruthy()
  })
})

describe('interceptor + result hooks', () => {
  it('serves intercepted results without spawning, and notifies listeners on real calls', async () => {
    setSwyInterceptor((call) => (call.tool === 'fake.tool.x' ? { data: { ok: 1 }, raw: { ok: 1 }, auditIds: [], durationMs: 1, exitCode: 0 } : undefined))
    const r = await swyExec('fake.tool.x', {})
    expect(r.data).toEqual({ ok: 1 })

    const seen: string[] = []
    const off = onSwyResult((call, outcome) => seen.push(`${call.tool}:${outcome.result ? 'ok' : 'err'}`))
    await swyExec('slack.chat.postmessage.create', { body: { channel: 'C0HOOK', text: 'x' } }, { dryRun: true })
    off()
    setSwyInterceptor(null)
    expect(seen).toEqual(['slack.chat.postmessage.create:ok'])
  })
})

describe('guardrail self-test', () => {
  it('all cases pass against the real policy engine', async () => {
    const results = await runGuardrailSelfTest()
    const failed = results.filter((r) => !r.ok)
    expect(failed).toEqual([])
    expect(results.length).toBeGreaterThanOrEqual(13)
  }, 90_000)
})

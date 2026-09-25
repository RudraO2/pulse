import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { prepareRuntimeDir } from '../../src/swy/runtime-dir.js'
import { closeDb, openDb } from '../../src/store/db.js'
import { bus } from '../../src/bus.js'
import { channels } from '../../src/core/channels.js'
import { decide, getApproval, onApprovalExecuted, postAction, requestApproval } from '../../src/core/approvals.js'
import { setSwyInterceptor, SwyError } from '../../src/swy/exec.js'
import type { TelegramAdapter } from '../../src/channels/telegram.js'
import type { SequencedEvent } from '../../src/shared/events.js'

// The approval state machine: dry-run preview → approve → execute exactly once.
// Swytchcode is intercepted (no binary, no network) so this runs anywhere.

const sends: Array<{ chatId: string; text: string; key?: string }> = []
const fakeTelegram = {
  platform: 'telegram',
  send: vi.fn(async (chatId: string, text: string, opts: { key?: string } = {}) => {
    sends.push({ chatId, text, key: opts.key })
    return { msgId: String(100 + sends.length) }
  }),
} as unknown as TelegramAdapter

beforeAll(() => {
  prepareRuntimeDir()
})

beforeEach(() => {
  openDb(':memory:')
  sends.length = 0
  channels.telegram = fakeTelegram
  setSwyInterceptor((call) => {
    if (call.kind === 'dry-run') {
      const body = (call.args as { body?: { text?: string } }).body
      if (body?.text?.includes('bit.ly')) {
        return new SwyError({ message: 'blocked', tool: call.tool, category: 'policy_denied', exitCode: 6, policyId: 'no-shady-links', policyMessage: 'Shortened links are not allowed' })
      }
      return { data: {}, raw: {}, request: { method: 'POST', url: 'https://api.telegram.org/bot1234567890:SECRETSECRETSECRETSECRETSECRETSECRET1/sendMessage', body }, auditIds: [], durationMs: 1, exitCode: 0 }
    }
    return { data: { ok: true, result: {} }, raw: {}, auditIds: [], durationMs: 1, exitCode: 0 }
  })
})

afterEach(() => {
  setSwyInterceptor(null)
  channels.telegram = undefined
  closeDb()
})

describe('approvals', () => {
  it('previews every action with a Swytchcode dry-run (auth redacted) and waits', async () => {
    const a = await requestApproval({
      kind: 'announcement',
      title: 'Lunch moved',
      summary: 'Lunch is at 1:30',
      actions: [postAction('telegram', '-100', 'Lunch is at **1:30**', 'Post to Telegram')],
      requestedBy: 'test',
      mirrorToSlack: false,
    })
    expect(a.status).toBe('pending')
    expect(a.actions[0]!.preview?.method).toBe('POST')
    expect(a.actions[0]!.preview?.url).not.toContain('SECRETSECRET')
    expect(sends).toHaveLength(0)
  })

  it('executes exactly once on approval, even if approved twice', async () => {
    const followUp = vi.fn()
    onApprovalExecuted('announcement', followUp)
    const a = await requestApproval({
      kind: 'announcement',
      title: 'Lunch moved',
      summary: '',
      actions: [postAction('telegram', '-100', 'Lunch is at 1:30', 'Post')],
      requestedBy: 'test',
      mirrorToSlack: false,
    })
    const [first, second] = await Promise.all([decide(a.id, 'approve', 'Neha'), decide(a.id, 'approve', 'Neha')])
    expect(first?.status === 'executed' || second?.status === 'executed').toBe(true)
    expect(sends).toHaveLength(1)
    expect(sends[0]!.key).toBe(`${a.id}:0`)
    expect(getApproval(a.id)?.decidedBy).toBe('Neha')
    expect(followUp).toHaveBeenCalledTimes(1)
    await decide(a.id, 'approve', 'Neha')
    expect(sends).toHaveLength(1)
  })

  it('marks actions blocked by policy during preview and never runs them', async () => {
    const guardrails: SequencedEvent[] = []
    const off = bus.on((e) => e.type === 'guardrail' && guardrails.push(e))
    const a = await requestApproval({
      kind: 'announcement',
      title: 'Spam',
      summary: '',
      actions: [postAction('telegram', '-100', 'free credits https://bit.ly/x', 'Post')],
      requestedBy: 'test',
      mirrorToSlack: false,
    })
    off()
    expect(a.actions[0]!.blocked).toContain('no-shady-links')
    expect(guardrails).toHaveLength(1)
    const done = await decide(a.id, 'approve', 'Neha')
    expect(sends).toHaveLength(0)
    expect(done?.actions[0]!.ok).toBe(false)
  })

  it('rejection never executes', async () => {
    const a = await requestApproval({ kind: 'post', title: 'x', summary: '', actions: [postAction('telegram', '-100', 'hi', 'Post')], requestedBy: 't', mirrorToSlack: false })
    expect((await decide(a.id, 'reject', 'Neha'))?.status).toBe('rejected')
    expect((await decide(a.id, 'approve', 'Neha'))?.status).toBe('rejected')
    expect(sends).toHaveLength(0)
  })
})

import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { MockLanguageModelV4 } from 'ai/test'
import { closeDb, openDb } from '../../src/store/db.js'
import { reloadEnv } from '../../src/config/env.js'
import { keywordMood, readMood, type MoodReading } from '../../src/agent/mood.js'
import { caseOf, closeCase, escalate, getCase, linkCasesToAttention, noteReply, observe, shouldEscalate } from '../../src/core/cases.js'
import { allAttention, openAttention, resolveAttention } from '../../src/core/state-docs.js'
import { flushEmail, handled, notifyState, setNotifySinkForTest, startNotifier, stopNotifier, verifyItem, signItem, addDevice } from '../../src/core/notify.js'
import { bus } from '../../src/bus.js'
import type { InboundMessage, MemberCase } from '../../src/shared/events.js'

// Member cases: mood per message → a case per member with a problem → the
// trend decides when a human is needed → "works now, thanks" closes it.
// Plus the organizer notifier (push instantly, email urgent-now / rest bundled).

let n = 0
const msg = (text: string, over: Partial<InboundMessage> = {}): InboundMessage => ({
  platform: 'slack',
  chatId: 'C1',
  chatType: 'group',
  userId: 'u_rohan',
  userName: 'Rohan Das',
  text,
  msgId: `m${++n}`,
  addressed: false,
  ts: Date.now(),
  ...over,
})
const reading = (m: InboundMessage, over: Partial<MoodReading> = {}): MoodReading => ({
  msgId: m.msgId,
  score: 0,
  emotion: 'calm',
  problem: false,
  resolved: false,
  wantsHuman: false,
  via: 'llm',
  ...over,
})
const feed = (text: string, over: Partial<MoodReading>, m: Partial<InboundMessage> = {}) => {
  const x = msg(text, m)
  return observe(x, reading(x, over))
}

const usage = { inputTokens: { total: 10, noCache: 10, cacheRead: 0, cacheWrite: 0 }, outputTokens: { total: 5, text: 5, reasoning: 0 } }
const toolCall = (toolName: string, input: unknown) => ({
  content: [{ type: 'tool-call' as const, toolCallId: 't1', toolName, input: JSON.stringify(input) }],
  finishReason: { unified: 'tool-calls' as const, raw: 'tool_calls' },
  usage,
  warnings: [],
})

let unlink: (() => void) | undefined
beforeAll(() => {
  linkCasesToAttention()
})
beforeEach(() => openDb(':memory:'))
afterEach(() => {
  unlink?.()
  closeDb()
})

describe('mood reading', () => {
  it('keywords: plain questions are neutral, frustration is negative, "works now" is solved', () => {
    expect(keywordMood(msg('what time is lunch?')).problem).toBe(false)
    const angry = keywordMood(msg('SERIOUSLY?? nothing works, still broken'))
    expect(angry.score).toBeLessThanOrEqual(-0.6)
    expect(angry.problem).toBe(true)
    const solved = keywordMood(msg('it works now, thanks!'))
    expect(solved.resolved).toBe(true)
    expect(solved.score).toBeGreaterThan(0)
  })

  it('uses the mood model when it answers, keywords when it fails', async () => {
    const m = msg('great, broken again')
    const model = new MockLanguageModelV4({
      doGenerate: [toolCall('rate_messages', { ratings: [{ msg_id: m.msgId, score: -0.7, emotion: 'annoyed', problem: true, resolved: false, wants_human: false, topic: 'deploy broken' }] })] as never,
    })
    const [r] = await readMood([m], { history: [], openCases: [] }, { model })
    expect(r).toMatchObject({ via: 'llm', score: -0.7, emotion: 'annoyed', problem: true, topic: 'deploy broken' })

    const broken = new MockLanguageModelV4({ doGenerate: async () => { throw new Error('429') } })
    const [k] = await readMood([m], { history: [], openCases: [] }, { model: broken })
    expect(k!.via).toBe('keywords')
  })

  it('never loses an explicit request for a person', async () => {
    const m = msg('can I talk to an organizer please')
    const model = new MockLanguageModelV4({
      doGenerate: [toolCall('rate_messages', { ratings: [{ msg_id: m.msgId, score: 0, emotion: 'calm', problem: false, resolved: false, wants_human: false }] })] as never,
    })
    const [r] = await readMood([m], { history: [], openCases: [] }, { model })
    expect(r!.wantsHuman).toBe(true)
  })
})

describe('member cases', () => {
  it('opens a case for a stuck member, not for a plain question', () => {
    expect(feed('what time is lunch?', { score: 0 }).case).toBeUndefined()
    const r = feed('swy exec hangs when I call it from node', { score: -0.3, problem: true, emotion: 'confused', topic: 'swy exec hangs in node' })
    expect(r.opened).toBe(true)
    expect(r.case).toMatchObject({ status: 'open', topic: 'swy exec hangs in node', asks: 1 })
  })

  it('smooths mood over messages and escalates on a worsening trend', () => {
    feed('swy exec hangs', { score: -0.1, problem: true })
    feed('still hanging', { score: -0.3, problem: true })
    const c = feed('this is getting ridiculous', { score: -0.5, problem: true }).case!
    expect(c.mood).toBeLessThan(-0.3)
    expect(shouldEscalate(c)?.reason).toMatch(/getting worse|asked 3 times/)
  })

  it('escalates when still stuck after Pulse answered', () => {
    let c = feed('swy exec hangs', { score: -0.3, problem: true }).case!
    expect(shouldEscalate(c)).toBeUndefined()
    c = noteReply(c, 'pulse', 'Try the async exec wrapper')
    expect(shouldEscalate(c)).toBeUndefined()
    c = feed('nope, same thing', { score: -0.35, problem: true }, { ts: Date.now() + 1000 }).case!
    expect(shouldEscalate(c)?.reason).toMatch(/still stuck after Pulse's answer/)
  })

  it('escalates at once when very upset or asking for a person', () => {
    expect(shouldEscalate(feed('THIS IS USELESS', { score: -0.9, problem: true, emotion: 'angry' }).case!)?.kind).toBe('frustrated')
    const c = feed('can I talk to a human', { score: -0.1, wantsHuman: true }, { userId: 'u2', userName: 'Dev Patel' }).case!
    expect(shouldEscalate(c)).toEqual({ kind: 'needs_human', reason: 'asked for a person' })
  })

  it("an organizer's reply satisfies a request for a person (no re-escalation on the next sweep)", () => {
    let c = feed('can I talk to a human', { score: -0.1, wantsHuman: true }, { userId: 'u3', userName: 'Dev Patel' }).case!
    expect(shouldEscalate(c)?.kind).toBe('needs_human')
    c = noteReply({ ...c, status: 'open' }, 'organizer', 'Your submission is saved')
    expect(shouldEscalate(c, Date.now() + 60 * 60_000)).toBeUndefined()
  })

  it('escalates an upset member left waiting, not a calm one', () => {
    const c = feed('my submission failed to upload', { score: -0.3, problem: true }).case!
    const later = Date.now() + 15 * 60_000
    expect(shouldEscalate(c, later, 10)?.kind).toBe('ignored')
    expect(shouldEscalate({ ...c, mood: 0 }, later, 10)).toBeUndefined()
  })

  it('escalation opens an Inbox item linked to the case; "works now" closes both', async () => {
    const c = feed('THIS IS USELESS', { score: -0.9, problem: true, emotion: 'angry', topic: 'exec hangs' }).case!
    const e = await escalate(c, shouldEscalate(c)!)
    expect(e.status).toBe('escalated')
    const item = allAttention().find((a) => a.caseId === c.id)
    expect(item?.status).toBe('open')
    const done = feed('ok it works now, thank you!!', { score: 0.7, resolved: true, emotion: 'grateful' })
    expect(done.resolved).toBe(true)
    expect(getCase(c.id)).toMatchObject({ status: 'resolved', resolvedBy: 'member' })
    expect(allAttention().find((a) => a.id === item!.id)?.status).toBe('resolved')
    expect(caseOf('slack', 'u_rohan')).toBeUndefined()
  })

  it("links the agent's own flag to the member's case, and an organizer resolving it closes the case", () => {
    const c = feed('the wifi keeps dropping', { score: -0.3, problem: true }).case!
    const a = openAttention({ kind: 'frustrated', platform: 'slack', chatId: 'C1', userId: 'u_rohan', userName: 'Rohan Das', text: 'x', reason: 'agent flag' })
    expect(getCase(c.id)).toMatchObject({ status: 'escalated', escalation: { attentionId: a.id } })
    resolveAttention(a.id)
    expect(getCase(c.id)).toMatchObject({ status: 'resolved', resolvedBy: 'Organizer' })
  })

  it('keeps scripted and real members apart', () => {
    feed('broken', { score: -0.4, problem: true }, { simulated: true })
    expect(caseOf('slack', 'u_rohan', false)).toBeUndefined()
    expect(caseOf('slack', 'u_rohan', true)).toBeDefined()
  })

  it('closeCase is idempotent', () => {
    const c = feed('broken', { score: -0.4, problem: true }).case!
    const first = closeCase(c, 'Organizer')
    expect(closeCase(first, 'someone else').resolvedBy).toBe('Organizer')
  })
})

describe('organizer notifications', () => {
  const sent: Array<{ ch: string; payload: any }> = []
  beforeEach(() => {
    reloadEnv({ ...process.env, RESEND_API_KEY: 're_test', DIGEST_TO: 'me@example.com', NOTIFY_EMAIL: 'true', NOTIFY_SCRIPTED: 'true' })
    sent.length = 0
    setNotifySinkForTest((ch, payload) => sent.push({ ch, payload }))
    addDevice({ endpoint: 'https://push.example/abc', keys: { p256dh: 'p', auth: 'a' } })
    startNotifier({ bundleMs: 3_600_000, caseOf: (id) => (id ? getCase(id) : undefined) })
  })
  afterEach(() => {
    stopNotifier()
    setNotifySinkForTest(undefined)
  })
  afterAll(() => reloadEnv())

  it('pushes each new item at once with a signed quick action, and bundles email', async () => {
    bus.emit({ type: 'pending', item: { id: 'pq_1', platform: 'slack', chatId: 'C1', msgId: '1', userName: 'Ishaan Verma', question: 'Is there parking?', status: 'waiting', askedAt: Date.now() } })
    const push = sent.find((s) => s.ch === 'push')!.payload
    expect(push).toMatchObject({ id: 'pq_1', kind: 'question', url: '/m/#/i/pq_1' })
    expect(verifyItem('pq_1', push.sig)).toBe(true)
    expect(verifyItem('pq_2', push.sig)).toBe(false)
    expect(notifyState().queued).toBe(1)
    expect(sent.some((s) => s.ch === 'email')).toBe(false)

    const res = await flushEmail()
    expect(res.items).toBe(1)
    const email = sent.find((s) => s.ch === 'email')!.payload
    expect(email.to).toBe('me@example.com')
    expect(email.html).toContain('/m/#/i/pq_1')
    expect(email.html).not.toContain('token=')
  })

  it('drops items handled before the bundle goes out', async () => {
    bus.emit({ type: 'pending', item: { id: 'pq_9', platform: 'slack', chatId: 'C1', msgId: '1', userName: 'A', question: 'q', status: 'waiting', askedAt: Date.now() } })
    bus.emit({ type: 'pending', item: { id: 'pq_9', platform: 'slack', chatId: 'C1', msgId: '1', userName: 'A', question: 'q', status: 'answered', askedAt: Date.now() } })
    expect(notifyState().queued).toBe(0)
    handled('nothing')
    expect((await flushEmail()).items).toBe(0)
  })

  it('an upset member is urgent and the email carries their mood trend', async () => {
    const c: MemberCase = feed('THIS IS USELESS', { score: -0.9, problem: true, emotion: 'angry', topic: 'exec hangs' }).case!
    await escalate(c, shouldEscalate(c)!)
    const push = sent.find((s) => s.ch === 'push' && s.payload.kind === 'member')!.payload
    expect(push.urgent).toBe(true)
    await flushEmail()
    const email = sent.find((s) => s.ch === 'email')!.payload
    expect(email.subject).toContain('Rohan needs a human')
    expect(email.html).toContain('exec hangs')
    expect(signItem(push.id)).toBe(push.sig)
  })
})

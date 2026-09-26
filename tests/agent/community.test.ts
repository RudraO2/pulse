import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { MockLanguageModelV4 } from 'ai/test'
import { closeDb, openDb } from '../../src/store/db.js'
import { channels } from '../../src/core/channels.js'
import { startRun } from '../../src/core/runs.js'
import { runCommunityAgent } from '../../src/agent/community.js'
import { setEntriesForTest } from '../../src/kb/knowledge.js'
import { setSwyInterceptor } from '../../src/swy/exec.js'
import { prepareRuntimeDir } from '../../src/swy/runtime-dir.js'
import { unansweredQuestions, insertMessage } from '../../src/store/repo.js'
import type { TelegramAdapter } from '../../src/channels/telegram.js'
import type { WhatsAppAdapter } from '../../src/channels/whatsapp.js'
import { decide, pendingApprovals } from '../../src/core/approvals.js'
import type { InboundMessage, KbItem } from '../../src/shared/events.js'

// The Community Agent decides; these tests script the model's decisions and
// check the effects (posts, source links, answered state, silence).

const usage = { inputTokens: { total: 10, noCache: 10, cacheRead: 0, cacheWrite: 0 }, outputTokens: { total: 5, text: 5, reasoning: 0 } }
const call = (toolName: string, input: unknown, id = toolName) => ({
  content: [{ type: 'tool-call' as const, toolCallId: id, toolName, input: JSON.stringify(input) }],
  finishReason: { unified: 'tool-calls' as const, raw: 'tool_calls' },
  usage,
  warnings: [],
})
const script = (...steps: ReturnType<typeof call>[]) => new MockLanguageModelV4({ doGenerate: steps as never })

const sends: Array<{ chatId: string; text: string; replyToId?: string }> = []
const fakeTelegram = {
  platform: 'telegram',
  send: vi.fn(async (chatId: string, text: string, opts: { replyToId?: string } = {}) => {
    sends.push({ chatId, text, replyToId: opts.replyToId })
    return { msgId: String(500 + sends.length) }
  }),
} as unknown as TelegramAdapter

const KB: KbItem[] = [
  {
    id: 'kb-deadline',
    url: 'https://www.notion.so/deadline',
    question: 'What is the submission deadline?',
    answer: 'Final submission is due at 3:30 PM on Commudle.',
    type: 'FAQ',
    source: 'Seed',
    status: 'Live',
    used: 0,
    scripted: false,
    updatedAt: 1,
    createdAt: 1,
  },
]

const msg = (text: string, over: Partial<InboundMessage> = {}): InboundMessage => ({
  platform: 'telegram',
  chatId: '-1001',
  chatType: 'group',
  userId: 'u1',
  userName: 'Meera Iyer',
  text,
  msgId: '77',
  addressed: false,
  ts: Date.now() - 20 * 60_000,
  ...over,
})

beforeAll(() => prepareRuntimeDir())
beforeEach(() => {
  openDb(':memory:')
  sends.length = 0
  channels.telegram = fakeTelegram
  setEntriesForTest(KB)
  // Notion "used" counter writes are fire-and-forget; answer them locally.
  setSwyInterceptor((c) => (c.tool.startsWith('notion.') ? { data: { id: 'kb-deadline', properties: {} }, raw: {}, auditIds: [], durationMs: 1, exitCode: 0 } : undefined))
})
afterEach(() => {
  setSwyInterceptor(null)
  channels.telegram = undefined
  closeDb()
})

describe('community agent', () => {
  it('in a WhatsApp group on Approve, drafts the reply for the organizer instead of sending it', async () => {
    const waSends: Array<{ chatId: string; text: string; replyToId?: string; byOrganizer?: boolean }> = []
    let mode: 'auto' | 'approve' = 'approve'
    channels.whatsapp = {
      platform: 'whatsapp',
      replyMode: () => mode,
      groupName: () => 'Hack Gurgaon',
      send: async (chatId: string, text: string, opts: { replyToId?: string; byOrganizer?: boolean } = {}) => {
        waSends.push({ chatId, text, replyToId: opts.replyToId, byOrganizer: opts.byOrganizer })
        return { msgId: 'WA1' }
      },
    } as unknown as WhatsAppAdapter
    const m = msg('what time is the submission deadline?', { platform: 'whatsapp', chatId: '1203@g.us', chatTitle: 'Hack Gurgaon', msgId: 'ABC' })
    insertMessage(m, true)
    const run = startRun('community', m.text)
    const res = await runCommunityAgent({
      run,
      model: script(call('reply', { text: 'It’s **3:30 PM** today.', kb_ids: ['kb-deadline'] })),
      chatKey: 'whatsapp:1203@g.us',
      batch: [m],
      history: [],
      signals: [],
      waiting: [],
    })
    expect(res.outcome).toBe('answered')
    expect(waSends).toHaveLength(0)
    const [a] = pendingApprovals()
    expect(a?.title).toBe('Reply to Meera Iyer')
    expect(a?.requestedBy).toBe('Pulse')

    // Approving sends it, quoting the member's message.
    await decide(a!.id, 'approve', 'Organizer (dashboard)')
    expect(waSends).toHaveLength(1)
    expect(waSends[0]).toMatchObject({ chatId: '1203@g.us', replyToId: 'ABC', byOrganizer: true })
    expect(waSends[0]!.text).toContain('3:30 PM')

    // On Auto it just sends.
    mode = 'auto'
    const m2 = msg('and where do we submit?', { platform: 'whatsapp', chatId: '1203@g.us', msgId: 'DEF' })
    await runCommunityAgent({ run: startRun('community', m2.text), model: script(call('reply', { text: 'On Commudle.' })), chatKey: 'whatsapp:1203@g.us', batch: [m2], history: [], signals: [], waiting: [] })
    expect(waSends).toHaveLength(2)
    channels.whatsapp = undefined
  })

  it('answers from the knowledge base, links the Notion source and marks the question answered', async () => {
    const m = msg('what time is the submission deadline?')
    insertMessage(m, true)
    const run = startRun('community', m.text)
    const res = await runCommunityAgent({
      run,
      model: script(call('reply', { text: 'It’s **3:30 PM** today, on Commudle.', kb_ids: ['kb-deadline'] })),
      chatKey: 'telegram:-1001',
      batch: [m],
      history: [],
      signals: [],
      waiting: [],
    })
    expect(res.outcome).toBe('answered')
    expect(sends).toHaveLength(1)
    expect(sends[0]!.replyToId).toBe('77')
    expect(sends[0]!.text).toContain('3:30 PM')
    expect(sends[0]!.text).toContain('https://www.notion.so/deadline')
    expect(unansweredQuestions(0)).toHaveLength(0)
  })

  it('stays silent on chit-chat and posts nothing', async () => {
    const m = msg('haha same, my laptop is dying')
    const res = await runCommunityAgent({
      run: startRun('community', m.text),
      model: script(call('stay_silent', { reason: 'banter between members' })),
      chatKey: 'telegram:-1001',
      batch: [m],
      history: [],
      signals: [],
      waiting: [],
    })
    expect(res.outcome).toBe('silent')
    expect(sends).toHaveLength(0)
  })

  it('ignores kb ids the model invented (no fake source links)', async () => {
    const m = msg('deadline?')
    await runCommunityAgent({
      run: startRun('community', m.text),
      model: script(call('reply', { text: '3:30 PM.', kb_ids: ['made-up-id'] })),
      chatKey: 'telegram:-1001',
      batch: [m],
      history: [],
      signals: [],
      waiting: [],
    })
    expect(sends[0]!.text).not.toContain('📎')
  })

  it('does not post twice if the model calls reply again', async () => {
    const m = msg('deadline?')
    await runCommunityAgent({
      run: startRun('community', m.text),
      model: script(call('reply', { text: 'one', kb_ids: [] }, 'a'), call('reply', { text: 'two', kb_ids: [] }, 'b')),
      chatKey: 'telegram:-1001',
      batch: [m],
      history: [],
      signals: [],
      waiting: [],
    })
    expect(sends.map((s) => s.text)).toEqual(['one'])
  })
})

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { closeDb, getDb, openDb } from '../../src/store/db.js'
import { getOutbox, isOwnMessage, outboxKey, sweepStalePending, withOutbox } from '../../src/store/outbox.js'
import { HISTORY_LIMIT, clearHistory, readHistory, writeHistory } from '../../src/conversation/memory.js'
import {
  addToCluster, creditHelper, deleteSimulatedRows, getDoc, insertMessage, insertQuestion, kvGet, kvSet, listDocs, markAnswered,
  putDoc, recentMessages, searchQuestions, topHelpers, unansweredQuestions, clusterSamples,
} from '../../src/store/repo.js'
import { Bm25Index } from '../../src/store/bm25.js'
import type { InboundMessage } from '../../src/shared/events.js'

beforeEach(() => { openDb(':memory:') })
afterEach(() => { closeDb() })

describe('outbox (idempotent posting)', () => {
  const target = { platform: 'telegram' as const, chatId: '-100', replyTo: '42', text: 'verified answer' }

  it('sends once; a retry with the same target returns the stored result without sending', async () => {
    const send = vi.fn(async () => ({ providerMsgId: '777' }))
    const first = await withOutbox(target, send)
    const second = await withOutbox(target, send)
    expect(send).toHaveBeenCalledTimes(1)
    expect(first).toEqual({ status: 'sent', providerMsgId: '777', duplicate: false })
    expect(second).toEqual({ status: 'sent', providerMsgId: '777', duplicate: true })
    expect(isOwnMessage('telegram', '-100', '777')).toBe(true)
  })

  it('records failures and does not resend the same text automatically', async () => {
    const failing = vi.fn(async () => { throw new Error('policy_denied') })
    await expect(withOutbox(target, failing)).rejects.toThrow('policy_denied')
    const again = vi.fn(async () => ({ providerMsgId: '1' }))
    const res = await withOutbox(target, again)
    expect(again).not.toHaveBeenCalled()
    expect(res).toMatchObject({ status: 'skipped', reason: 'failed_before' })
  })

  it('treats a concurrent in-flight send as skipped', async () => {
    let release!: () => void
    const slow = () => new Promise<{ providerMsgId: string }>(r => { release = () => r({ providerMsgId: '9' }) })
    const p1 = withOutbox(target, slow)
    const p2 = await withOutbox(target, async () => ({ providerMsgId: 'dup' }))
    expect(p2).toMatchObject({ status: 'skipped', reason: 'in_flight' })
    release()
    await expect(p1).resolves.toMatchObject({ status: 'sent', providerMsgId: '9' })
  })

  it('marks stale pending rows (crash mid-send) as failed_unknown at boot, never resends', async () => {
    const key = outboxKey('slack', 'C1', undefined, 'hello')
    getDb().prepare("INSERT INTO outbox (key, platform, chat_id, text_sha, status, created_at) VALUES (?, 'slack', 'C1', 'x', 'pending', ?)").run(key, Date.now() - 5 * 60_000)
    expect(sweepStalePending()).toBe(1)
    expect(getOutbox(key)?.status).toBe('failed_unknown')
    const send = vi.fn(async () => ({}))
    await withOutbox({ platform: 'slack', chatId: 'C1', text: 'hello' }, send)
    expect(send).not.toHaveBeenCalled()
  })

  it('different text or reply target is a different key', () => {
    expect(outboxKey('telegram', '1', '2', 'a')).not.toBe(outboxKey('telegram', '1', '2', 'b'))
    expect(outboxKey('telegram', '1', '2', 'a')).not.toBe(outboxKey('telegram', '1', '3', 'a'))
  })
})

describe('memory', () => {
  it('keeps only the last HISTORY_LIMIT messages per chat, in order', () => {
    for (let i = 0; i < HISTORY_LIMIT + 15; i++) writeHistory('telegram:1', { sender: 'u', text: `m${i}` })
    writeHistory('telegram:2', { sender: 'u', text: 'other chat' })
    const h = readHistory('telegram:1')
    expect(h).toHaveLength(HISTORY_LIMIT)
    expect(h[0]!.text).toBe('m15')
    expect(h.at(-1)!.text).toBe(`m${HISTORY_LIMIT + 14}`)
    clearHistory('telegram:1')
    expect(readHistory('telegram:1')).toEqual([])
    expect(readHistory('telegram:2')).toHaveLength(1)
  })
})

describe('repeat-question search (BM25; node:sqlite has no FTS5)', () => {
  it('ranks the paraphrase of an earlier question first', () => {
    const base = { platform: 'telegram' as const, chatId: 'c', userName: 'u', ts: Date.now() }
    insertQuestion({ ...base, msgId: '1', text: 'how do I send a telegram message with swytchcode?' })
    insertQuestion({ ...base, msgId: '2', text: 'what is the notion page create schema' })
    insertQuestion({ ...base, msgId: '3', text: 'resend digest email idempotency key' })
    const hits = searchQuestions("what's the tool id for sending a telegram message")
    expect(hits[0]?.msgId).toBe('1')
    expect(searchQuestions('completely unrelated banana')).toEqual([])
  })

  it('clusters questions and tracks size', () => {
    const base = { platform: 'slack' as const, chatId: 'c', userName: 'u', ts: Date.now() }
    const a = insertQuestion({ ...base, msgId: 'a', text: 'telegram token substitution?' })
    const b = insertQuestion({ ...base, msgId: 'b', text: 'telegram {token} not replaced' })
    const c = insertQuestion({ ...base, msgId: 'c', text: 'bot{token} in url??' })
    addToCluster(b, a, 'Telegram token in URL')
    const cl = addToCluster(c, b, 'Telegram token in URL')
    expect(cl.size).toBe(3)
    expect(clusterSamples(cl.id)).toHaveLength(3)
  })

  it('BM25 index handles an empty corpus', () => {
    expect(new Bm25Index<string>(s => s).search('x')).toEqual([])
  })
})

describe('messages / docs / helpers / kv', () => {
  const m = (over: Partial<InboundMessage> = {}): InboundMessage => ({
    platform: 'telegram', chatId: 'g', chatType: 'group', userId: 'u', userName: 'U', text: 'how?', msgId: '1', addressed: false, ts: Date.now() - 10 * 60_000, ...over,
  })

  it('dedupes messages and finds unanswered questions', () => {
    expect(insertMessage(m(), true)).toBe(true)
    expect(insertMessage(m(), true)).toBe(false)
    insertMessage(m({ msgId: '2' }), true)
    markAnswered('telegram', 'g', ['2'], 'human')
    expect(unansweredQuestions(5 * 60_000).map(x => x.msgId)).toEqual(['1'])
  })

  it('kv round-trip', () => {
    kvSet('telegram:offset', '123')
    expect(kvGet('telegram:offset')).toBe('123')
  })

  it('stores docs by kind and filters by status', () => {
    putDoc('approval', { id: 'a1', status: 'pending', title: 'x' })
    putDoc('approval', { id: 'a2', status: 'executed', title: 'y' })
    putDoc('approval', { id: 'a1', status: 'executed', title: 'x' })
    expect(listDocs('approval', { status: 'pending' })).toHaveLength(0)
    expect(getDoc<{ status: string }>('approval', 'a1')?.status).toBe('executed')
  })

  it('credits helpers and resets scripted traffic without touching real data', () => {
    creditHelper('telegram', 'Meera', false)
    creditHelper('slack', 'Kabir', true)
    creditHelper('slack', 'Kabir', true)
    expect(topHelpers()[0]).toMatchObject({ userName: 'Kabir', answers: 2, simulated: true })
    insertMessage(m({ msgId: 'real' }))
    insertMessage(m({ msgId: 'sim', simulated: true }))
    putDoc('pending', { id: 'p1', status: 'waiting', simulated: true })
    deleteSimulatedRows()
    expect(recentMessages().map(x => x.msgId)).toEqual(['real'])
    expect(topHelpers().map(h => h.userName)).toEqual(['Meera'])
    expect(listDocs('pending')).toHaveLength(0)
  })
})

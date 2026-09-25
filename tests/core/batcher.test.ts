import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { openDb, closeDb } from '../../src/store/db.js'
import { createBatcher, selectTarget, type BatchReason } from '../../src/conversation/batcher.js'
import { readHistory } from '../../src/conversation/memory.js'
import type { InboundMessage } from '../../src/shared/events.js'

let n = 0
function msg(over: Partial<InboundMessage> = {}): InboundMessage {
  n++
  return {
    platform: 'telegram', chatId: 'c1', chatType: 'dm', userId: 'u1', userName: 'Aarav',
    text: `fragment ${n}`, msgId: String(n), addressed: true, ts: Date.now(), ...over,
  }
}

type Call = { key: string; texts: string[]; reason: BatchReason }

function setup(extra: Parameters<typeof createBatcher>[0] extends infer O ? Partial<O> : never = {}) {
  const calls: Call[] = []
  const b = createBatcher({
    writeMemory: false,
    onBatch: async (key, batch, reason) => {
      calls.push({ key, texts: batch.map(m => m.text), reason })
    },
    ...extra,
  })
  return { b, calls }
}

beforeEach(() => {
  vi.useFakeTimers()
  openDb(':memory:')
})
afterEach(() => {
  vi.useRealTimers()
  closeDb()
})

describe('DM collect window', () => {
  it('waits for 8s of silence and sends one combined batch', async () => {
    const { b, calls } = setup()
    b.push(msg({ text: 'hey' }))
    await vi.advanceTimersByTimeAsync(5000)
    b.push(msg({ text: 'how do I post to slack' }))
    await vi.advanceTimersByTimeAsync(7900)
    expect(calls).toHaveLength(0)
    await vi.advanceTimersByTimeAsync(200)
    expect(calls).toEqual([{ key: 'telegram:c1', texts: ['hey', 'how do I post to slack'], reason: 'dm' }])
  })

  it('caps the wait at 60s from the first fragment even if they keep typing', async () => {
    const { b, calls } = setup()
    for (let i = 0; i < 12; i++) {
      b.push(msg())
      await vi.advanceTimersByTimeAsync(6000) // never 8s of silence
    }
    expect(calls).toHaveLength(1)
    expect(calls[0]!.texts.length).toBeGreaterThanOrEqual(10)
  })
})

describe('group window', () => {
  it('collects for 10s and answers the last message not from the bot', async () => {
    const isFromBot = (m: InboundMessage) => m.userId === 'bot'
    const { b, calls } = setup({ isFromBot })
    b.push(msg({ chatType: 'group', chatId: 'g1', text: 'q from Aarav' }))
    b.push(msg({ chatType: 'group', chatId: 'g1', text: 'follow-up from Isha', userId: 'u2' }))
    b.push(msg({ chatType: 'group', chatId: 'g1', text: 'bot echo', userId: 'bot' }))
    await vi.advanceTimersByTimeAsync(10_050)
    expect(calls).toHaveLength(1)
    expect(calls[0]!.reason).toBe('group')
    expect(calls[0]!.texts).toHaveLength(3)
    const batch = calls[0]!.texts.map((t, i) => msg({ text: t, userId: i === 2 ? 'bot' : 'u' }))
    expect(selectTarget(batch, isFromBot)?.text).toBe('follow-up from Isha')
  })

  it('skips batches made only of the bot\'s own messages but still stores them as memory', async () => {
    const isFromBot = (m: InboundMessage) => m.userId === 'bot'
    const { b, calls } = setup({ isFromBot, writeMemory: true })
    b.push(msg({ chatType: 'group', chatId: 'g2', userId: 'bot', userName: 'GroundTruth', text: 'my own echo' }))
    await vi.advanceTimersByTimeAsync(10_050)
    await b.idle()
    expect(calls).toHaveLength(0)
    expect(readHistory('telegram:g2').map(m => m.text)).toEqual(['my own echo'])
  })
})

describe('backlog drain', () => {
  it('collapses a redelivered backlog into one batch per chat', async () => {
    const { b, calls } = setup()
    b.beginBacklog('telegram')
    b.push(msg({ chatId: 'a', text: 'a1' }))
    b.push(msg({ chatId: 'b', chatType: 'group', text: 'b1' }))
    b.push(msg({ chatId: 'a', text: 'a2' }))
    await vi.advanceTimersByTimeAsync(9000) // live windows would have fired by now
    expect(calls).toHaveLength(0)
    await b.endBacklog('telegram')
    await b.idle()
    expect(calls).toEqual([
      { key: 'telegram:a', texts: ['a1', 'a2'], reason: 'backlog' },
      { key: 'telegram:b', texts: ['b1'], reason: 'backlog' },
    ])
    expect(b.isDraining('telegram')).toBe(false)
  })

  it('flushes on the safety timeout if the adapter never signals the end', async () => {
    const { b, calls } = setup({ backlogSafetyMs: 15_000 })
    b.beginBacklog('slack')
    b.push(msg({ platform: 'slack', chatId: 'C1', chatType: 'group', text: 's1' }))
    await vi.advanceTimersByTimeAsync(15_050)
    await b.idle()
    expect(calls).toEqual([{ key: 'slack:C1', texts: ['s1'], reason: 'backlog' }])
  })

  it('only buffers the draining platform', async () => {
    const { b, calls } = setup()
    b.beginBacklog('telegram')
    b.push(msg({ platform: 'web', chatType: 'web', chatId: 'w', text: 'web q' }))
    await b.idle()
    expect(calls).toEqual([{ key: 'web:w', texts: ['web q'], reason: 'web' }])
  })
})

describe('per-chat serialization', () => {
  it('never runs two batches for the same chat at once; mid-run messages fold into the next run', async () => {
    const calls: string[][] = []
    let active = 0
    let maxActive = 0
    const b = createBatcher({
      writeMemory: false,
      onBatch: async (_key, batch) => {
        active++
        maxActive = Math.max(maxActive, active)
        calls.push(batch.map(m => m.text))
        await new Promise(r => setTimeout(r, 20_000))
        active--
      },
    })
    b.push(msg({ platform: 'web', chatType: 'web', chatId: 'x', text: 'first' }))
    await vi.advanceTimersByTimeAsync(10)
    b.push(msg({ platform: 'web', chatType: 'web', chatId: 'x', text: 'second' }))
    b.push(msg({ platform: 'web', chatType: 'web', chatId: 'x', text: 'third' }))
    expect(b.isBusy('web:x')).toBe(true)
    await vi.advanceTimersByTimeAsync(20_010)
    await vi.advanceTimersByTimeAsync(20_010)
    await b.idle()
    expect(maxActive).toBe(1)
    expect(calls).toEqual([['first'], ['second', 'third']])
  })

  it('runs different chats concurrently and survives a failing batch', async () => {
    const seen: string[] = []
    const b = createBatcher({
      writeMemory: false,
      onBatch: async key => {
        seen.push(key)
        if (key === 'web:bad') throw new Error('boom')
      },
    })
    b.push(msg({ platform: 'web', chatType: 'web', chatId: 'bad' }))
    b.push(msg({ platform: 'web', chatType: 'web', chatId: 'good' }))
    await b.idle()
    expect(seen.sort()).toEqual(['web:bad', 'web:good'])
    b.push(msg({ platform: 'web', chatType: 'web', chatId: 'bad' }))
    await b.idle()
    expect(seen).toHaveLength(3)
  })
})

describe('slack threads', () => {
  it('keys slack thread replies separately from the channel root', async () => {
    const { b, calls } = setup()
    b.push(msg({ platform: 'slack', chatType: 'group', chatId: 'C1', text: 'root' }))
    b.push(msg({ platform: 'slack', chatType: 'group', chatId: 'C1', threadTs: '171.1', text: 'in thread' }))
    await vi.advanceTimersByTimeAsync(10_050)
    await b.idle()
    expect(calls.map(c => c.key).sort()).toEqual(['slack:C1', 'slack:C1:171.1'])
  })
})

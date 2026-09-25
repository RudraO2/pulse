import { bus } from '../bus.js'
import { chatKey, writeHistory } from './memory.js'
import type { InboundMessage, Platform } from '../shared/events.js'

// Port of the WhatsApp bot's handler.ts batching, made platform-agnostic.
//
// People type in fragments ("hey" / "how do I post to slack" / "with the js sdk").
// Answering each fragment separately is noisy and burns LLM quota, so we collect:
//   • DMs:    until 8s of silence, capped at 60s from the first fragment
//   • Groups: a 10s sliding window, then answer only the last relevant message
//   • Backlog: after a restart the platform redelivers everything we missed —
//     buffer per chat and flush ONE batch per chat once the adapter says the
//     queue is drained (or a safety timeout fires).
// Runs are serialized per chat: a batch that closes while the previous run for
// the same chat is still going waits and is merged into the next run.

export type BatchReason = 'dm' | 'group' | 'backlog' | 'web'

export interface BatcherOptions {
  onBatch: (chatKey: string, batch: InboundMessage[], reason: BatchReason) => Promise<void>
  /** messages authored by the bot itself are stored as context but never trigger a run */
  isFromBot?: (m: InboundMessage) => boolean
  /** write every incoming message to per-chat memory before the run (default true) */
  writeMemory?: boolean
  dmCollectMs?: number
  dmMaxWaitMs?: number
  groupCollectMs?: number
  groupMaxWaitMs?: number
  backlogSafetyMs?: number
}

export interface Batcher {
  push(msg: InboundMessage): void
  beginBacklog(platform: Platform): void
  endBacklog(platform: Platform): Promise<void>
  isDraining(platform: Platform): boolean
  /** chats with a window open or a run in flight */
  pendingChats(): string[]
  isBusy(key: string): boolean
  /** resolves when every in-flight and queued run has finished (tests, shutdown) */
  idle(): Promise<void>
  stop(): void
}

interface Window {
  messages: InboundMessage[]
  reason: BatchReason
  startedAt: number
  timer: ReturnType<typeof setTimeout> | null
}

interface Lane {
  running: Promise<void> | null
  queued: { messages: InboundMessage[]; reason: BatchReason } | null
}

export const DM_COLLECT_MS = 8000
export const DM_MAX_WAIT_MS = 60000
export const GROUP_COLLECT_MS = 10000
export const BACKLOG_SAFETY_MS = 15000

export function keyOf(m: InboundMessage): string {
  // Slack threads are their own conversation; channel roots and Telegram chats key by chat.
  const key = chatKey(m.platform, m.chatId, m.platform === 'slack' ? m.threadTs : undefined)
  // Scripted demo traffic keeps its own memory so it never pollutes real chats.
  return m.simulated ? `sim:${key}` : key
}

/**
 * processGroupBatch target selection: the last message not authored by the bot.
 * Returns undefined when the whole batch is the bot's own messages.
 */
export function selectTarget(batch: InboundMessage[], isFromBot: (m: InboundMessage) => boolean = () => false): InboundMessage | undefined {
  for (let i = batch.length - 1; i >= 0; i--) {
    const m = batch[i]!
    if (!isFromBot(m)) return m
  }
  return undefined
}

export function createBatcher(opts: BatcherOptions): Batcher {
  const dmCollect = opts.dmCollectMs ?? DM_COLLECT_MS
  const dmMax = opts.dmMaxWaitMs ?? DM_MAX_WAIT_MS
  const groupCollect = opts.groupCollectMs ?? GROUP_COLLECT_MS
  const groupMax = opts.groupMaxWaitMs ?? DM_MAX_WAIT_MS
  const backlogSafety = opts.backlogSafetyMs ?? BACKLOG_SAFETY_MS
  const isFromBot = opts.isFromBot ?? (() => false)
  const writeMemory = opts.writeMemory ?? true

  const windows = new Map<string, Window>()
  const lanes = new Map<string, Lane>()
  const draining = new Set<Platform>()
  const backlogBuffer = new Map<Platform, Map<string, InboundMessage[]>>()
  const backlogTimers = new Map<Platform, ReturnType<typeof setTimeout>>()
  const inflight = new Set<Promise<void>>()
  let stopped = false

  function logError(where: string, key: string, err: unknown): void {
    console.error(`[Batcher] ${where} (${key}):`, err)
    bus.emit({ type: 'log', level: 'error', text: `${where} (${key}): ${String((err as Error)?.message ?? err)}` })
  }

  // ── per-chat serial lane ──────────────────────────────────────────────────

  function dispatch(key: string, messages: InboundMessage[], reason: BatchReason): void {
    if (stopped || !messages.length) return
    const lane = lanes.get(key) ?? { running: null, queued: null }
    lanes.set(key, lane)
    if (lane.running) {
      // A run for this chat is in flight — fold into the next run so the agent
      // sees the follow-up fragments together instead of racing itself.
      lane.queued = lane.queued
        ? { messages: [...lane.queued.messages, ...messages], reason: lane.queued.reason }
        : { messages, reason }
      return
    }
    run(key, lane, messages, reason)
  }

  function run(key: string, lane: Lane, messages: InboundMessage[], reason: BatchReason): void {
    const p = (async () => {
      if (writeMemory) {
        for (const m of messages) writeHistory(key, { sender: m.userName, text: m.text, ts: m.ts })
      }
      // Batch made only of our own echoes → context only, no reply
      if (messages.every(isFromBot)) return
      await opts.onBatch(key, messages, reason)
    })()
      .catch(err => logError('Error processing batch', key, err))
      .finally(() => {
        inflight.delete(p)
        lane.running = null
        const next = lane.queued
        lane.queued = null
        if (next) run(key, lane, next.messages, next.reason)
        else if (!windows.has(key)) lanes.delete(key)
      })
    lane.running = p
    inflight.add(p)
  }

  // ── collect windows ───────────────────────────────────────────────────────

  function arm(key: string, w: Window): void {
    if (w.timer) clearTimeout(w.timer)
    const collect = w.reason === 'dm' ? dmCollect : groupCollect
    const cap = w.reason === 'dm' ? dmMax : groupMax
    const remainingCap = w.startedAt + cap - Date.now()
    const delay = Math.max(0, Math.min(collect, remainingCap))
    w.timer = setTimeout(() => {
      windows.delete(key)
      dispatch(key, w.messages, w.reason)
    }, delay)
  }

  function push(msg: InboundMessage): void {
    if (stopped) return
    const key = keyOf(msg)

    // Still draining the offline backlog → buffer, don't arm live timers.
    if (draining.has(msg.platform)) {
      const perChat = backlogBuffer.get(msg.platform) ?? new Map<string, InboundMessage[]>()
      backlogBuffer.set(msg.platform, perChat)
      const buf = perChat.get(key) ?? []
      buf.push(msg)
      perChat.set(key, buf)
      return
    }

    if (msg.chatType === 'web') {
      dispatch(key, [msg], 'web')
      return
    }

    const reason: BatchReason = msg.chatType === 'dm' ? 'dm' : 'group'
    const existing = windows.get(key)
    if (existing) {
      existing.messages.push(msg)
      arm(key, existing)
    } else {
      const w: Window = { messages: [msg], reason, startedAt: Date.now(), timer: null }
      windows.set(key, w)
      arm(key, w)
    }
  }

  // ── backlog drain ─────────────────────────────────────────────────────────

  function beginBacklog(platform: Platform): void {
    draining.add(platform)
    backlogBuffer.set(platform, new Map())
    const prev = backlogTimers.get(platform)
    if (prev) clearTimeout(prev)
    backlogTimers.set(
      platform,
      setTimeout(() => {
        console.log(`[Batcher] ${platform} backlog drain timed out — flushing anyway`)
        void endBacklog(platform)
      }, backlogSafety),
    )
  }

  async function endBacklog(platform: Platform): Promise<void> {
    if (!draining.has(platform)) return
    draining.delete(platform)
    const t = backlogTimers.get(platform)
    if (t) clearTimeout(t)
    backlogTimers.delete(platform)
    const chats = [...(backlogBuffer.get(platform)?.entries() ?? [])]
    backlogBuffer.delete(platform)
    if (chats.length) {
      console.log(`[Batcher] Flushing ${platform} backlog for ${chats.length} chat(s)`)
      bus.emit({ type: 'log', level: 'info', text: `Flushing ${platform} backlog: ${chats.length} chat(s), one reply each` })
    }
    // One combined batch per chat — the processor answers the last relevant message.
    for (const [key, msgs] of chats) dispatch(key, msgs, 'backlog')
  }

  async function idle(): Promise<void> {
    while (inflight.size) await Promise.allSettled([...inflight])
  }

  function stop(): void {
    stopped = true
    for (const w of windows.values()) if (w.timer) clearTimeout(w.timer)
    for (const t of backlogTimers.values()) clearTimeout(t)
    windows.clear()
    backlogTimers.clear()
  }

  return {
    push,
    beginBacklog,
    endBacklog,
    isDraining: p => draining.has(p),
    pendingChats: () => [...new Set([...windows.keys(), ...[...lanes.entries()].filter(([, l]) => l.running).map(([k]) => k)])],
    isBusy: key => windows.has(key) || !!lanes.get(key)?.running,
    idle,
    stop,
  }
}

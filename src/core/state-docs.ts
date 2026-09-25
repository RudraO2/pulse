import { randomUUID } from 'node:crypto'
import { bus } from '../bus.js'
import type { AttentionItem, PendingQuestion } from '../shared/events.js'
import { getDoc, listDocs, markEscalated, putDoc } from '../store/repo.js'

// Pending mod questions and members needing attention: small persisted state
// machines. Every change is an event, so the dashboard Inbox stays live.

// ── pending questions (asked the mods, waiting for a reply) ────────────────

export function createPending(p: Omit<PendingQuestion, 'id' | 'status' | 'askedAt'>): PendingQuestion {
  const item: PendingQuestion = { ...p, id: `pq_${randomUUID().slice(0, 8)}`, status: 'waiting', askedAt: Date.now() }
  savePending(item)
  return item
}

export function savePending(item: PendingQuestion): void {
  putDoc('pending', item, item.askedAt)
  bus.emit({ type: 'pending', item })
}

export const getPending = (id: string): PendingQuestion | undefined => getDoc<PendingQuestion>('pending', id)
export const waitingQuestions = (): PendingQuestion[] => listDocs<PendingQuestion>('pending', { status: 'waiting' })
export const allPending = (limit = 100): PendingQuestion[] => listDocs<PendingQuestion>('pending', { limit })

export function pendingByThread(ts: string): PendingQuestion | undefined {
  return waitingQuestions().find((p) => p.modsThreadTs === ts)
}

// ── attention (frustrated / ignored / needs a human) ───────────────────────

export function openAttention(a: Omit<AttentionItem, 'id' | 'status' | 'ts'>): AttentionItem {
  // one open item per member+kind: repeated signals update it instead of spamming mods
  const existing = listDocs<AttentionItem>('attention', { status: 'open' }).find(
    (x) => x.platform === a.platform && x.userId === a.userId && x.kind === a.kind,
  )
  const item: AttentionItem = existing ? { ...existing, text: a.text, reason: a.reason, ts: Date.now() } : { ...a, id: `at_${randomUUID().slice(0, 8)}`, status: 'open', ts: Date.now() }
  putDoc('attention', item, item.ts)
  if (a.msgId) markEscalated(a.platform, a.chatId, a.msgId)
  bus.emit({ type: 'attention', item })
  return item
}

export function resolveAttention(id: string): AttentionItem | undefined {
  const item = getDoc<AttentionItem>('attention', id)
  if (!item) return undefined
  const next: AttentionItem = { ...item, status: 'resolved' }
  putDoc('attention', next, item.ts)
  bus.emit({ type: 'attention', item: next })
  return next
}

export const openAttentionItems = (): AttentionItem[] => listDocs<AttentionItem>('attention', { status: 'open' })
export const allAttention = (limit = 100): AttentionItem[] => listDocs<AttentionItem>('attention', { limit })

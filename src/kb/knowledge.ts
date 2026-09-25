import { bus } from '../bus.js'
import { hasNotion } from '../config/env.js'
import type { KbItem } from '../shared/events.js'
import { Bm25Index } from '../store/bm25.js'
import { createPage, queryAll, updatePage, type NewEntry } from './notion.js'

// The community knowledge base, mirrored from Notion. Notion is the source of
// truth (mods can edit it directly); Pulse keeps an in-memory copy + a BM25
// index so answering never waits on Notion, and re-syncs every minute.

const SYNC_MS = 60_000

let entries: KbItem[] = []
let index = new Bm25Index<KbItem>((e) => `${e.question} ${e.question} ${e.answer}`)
let timer: ReturnType<typeof setInterval> | undefined
let lastSync = 0

function rebuild(next: KbItem[]): void {
  entries = next.sort((a, b) => b.updatedAt - a.updatedAt)
  index = new Bm25Index<KbItem>((e) => `${e.question} ${e.question} ${e.answer}`)
  for (const e of entries) if (e.status === 'Live' && e.type !== 'Digest') index.add(e)
}

function status(state: 'up' | 'degraded' | 'down' | 'disabled', detail: string): void {
  bus.emit({ type: 'status', service: 'notion', status: { state, detail, at: Date.now() } })
}

export async function syncKnowledge(): Promise<number> {
  if (!hasNotion()) {
    status('disabled', 'NOTION_TOKEN / NOTION_DATABASE_ID not set')
    return 0
  }
  try {
    const all = await queryAll()
    const changed = all.length !== entries.length || all.some((e) => entries.find((x) => x.id === e.id)?.updatedAt !== e.updatedAt)
    rebuild(all)
    lastSync = Date.now()
    status('up', `${liveEntries().length} live entries`)
    if (changed) bus.emit({ type: 'kb', action: 'synced', entries: all })
    return all.length
  } catch (e) {
    status('degraded', String((e as Error).message).slice(0, 120))
    return entries.length
  }
}

export function startKnowledgeSync(): void {
  if (timer) return
  timer = setInterval(() => void syncKnowledge(), SYNC_MS)
  timer.unref?.()
}

export function stopKnowledgeSync(): void {
  if (timer) clearInterval(timer)
  timer = undefined
}

export const allEntries = (): KbItem[] => entries
export const liveEntries = (): KbItem[] => entries.filter((e) => e.status === 'Live' && e.type !== 'Digest')
export const lastKnowledgeSync = (): number => lastSync

export interface KbHit {
  entry: KbItem
  score: number
}

export function searchKnowledge(query: string, limit = 5): KbHit[] {
  return index.search(query, limit, 0.5).map((h) => ({ entry: h.doc, score: Number(h.score.toFixed(2)) }))
}

export function getEntry(id: string): KbItem | undefined {
  return entries.find((e) => e.id === id || e.id.replace(/-/g, '') === id.replace(/-/g, ''))
}

function upsertLocal(e: KbItem): void {
  rebuild([e, ...entries.filter((x) => x.id !== e.id)])
}

export async function addKnowledge(e: NewEntry, runId?: string): Promise<KbItem> {
  const created = await createPage(e, runId)
  upsertLocal(created)
  bus.emit({ type: 'kb', action: 'added', entry: created })
  return created
}

export async function updateKnowledge(id: string, patch: Partial<NewEntry>, runId?: string): Promise<KbItem> {
  const updated = await updatePage(id, patch, runId)
  upsertLocal(updated)
  bus.emit({ type: 'kb', action: 'updated', entry: updated })
  return updated
}

/** Count a use (fire-and-forget: answering never waits on this write). */
export function markUsed(id: string, runId?: string): void {
  const e = getEntry(id)
  if (!e) return
  const local = { ...e, used: e.used + 1 }
  upsertLocal(local)
  bus.emit({ type: 'kb', action: 'used', entry: local })
  void updatePage(e.id, { used: local.used }, runId).catch(() => {})
}

/** Demo reset: move every scripted entry to Notion's trash. */
export async function archiveScripted(): Promise<number> {
  const scripted = entries.filter((e) => e.scripted)
  for (const e of scripted) {
    await updatePage(e.id, { archived: true }).catch(() => {})
    bus.emit({ type: 'kb', action: 'archived', entry: { ...e, status: 'Archived' } })
  }
  rebuild(entries.filter((e) => !e.scripted))
  return scripted.length
}

/** Tests only. */
export function setEntriesForTest(next: KbItem[]): void {
  rebuild(next)
}

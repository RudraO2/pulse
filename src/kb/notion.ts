import { env } from '../config/env.js'
import { kvGet, kvSet } from '../store/repo.js'
import { swyExec } from '../swy/exec.js'

// Thin Notion layer over Swytchcode. The knowledge base is one Notion database
// (data-source API, Notion-Version 2025-09-03 is sent by the bundle itself).
// Path ids go in `params`, everything else in `body`.

export const N = {
  dbGet: 'notion.databas.get',
  dsGet: 'notion.data_source.get',
  dsUpdate: 'notion.data_source.update',
  query: 'notion.query.create',
  pageCreate: 'notion.page.create',
  pageUpdate: 'notion.page.update',
  pageGet: 'notion.page.get',
  children: 'notion.children.update',
} as const

export type KbType = 'FAQ' | 'Announcement' | 'Digest'
export type KbSource = 'Seed' | 'Mod' | 'Member' | 'Organizer'
export type KbStatus = 'Live' | 'Pending' | 'Archived'

export interface KbEntry {
  id: string
  url: string
  question: string
  answer: string
  type: KbType
  source: KbSource
  status: KbStatus
  used: number
  learnedFrom?: string
  thread?: string
  scripted: boolean
  updatedAt: number
  createdAt: number
}

/** The schema Pulse needs. setup-notion adds whatever is missing. */
export const KB_PROPERTIES = {
  Answer: { rich_text: {} },
  Type: { select: { options: [{ name: 'FAQ', color: 'blue' }, { name: 'Announcement', color: 'purple' }, { name: 'Digest', color: 'gray' }] } },
  Source: {
    select: {
      options: [
        { name: 'Seed', color: 'gray' },
        { name: 'Mod', color: 'green' },
        { name: 'Member', color: 'orange' },
        { name: 'Organizer', color: 'purple' },
      ],
    },
  },
  Status: { select: { options: [{ name: 'Live', color: 'green' }, { name: 'Pending', color: 'yellow' }, { name: 'Archived', color: 'gray' }] } },
  Used: { number: { format: 'number' } },
  'Learned from': { rich_text: {} },
  Thread: { url: {} },
  Scripted: { checkbox: {} },
} as const

const MAX_TEXT = 1900

/** Notion rich text objects are capped at 2000 chars; split long text. */
export function richText(text: string): Array<{ type: 'text'; text: { content: string } }> {
  const out: Array<{ type: 'text'; text: { content: string } }> = []
  for (let i = 0; i < text.length; i += MAX_TEXT) out.push({ type: 'text', text: { content: text.slice(i, i + MAX_TEXT) } })
  return out.length ? out : [{ type: 'text', text: { content: '' } }]
}

const plain = (arr: unknown): string =>
  Array.isArray(arr) ? arr.map((t) => (t as { plain_text?: string; text?: { content?: string } }).plain_text ?? (t as { text?: { content?: string } }).text?.content ?? '').join('') : ''

export async function dataSourceId(runId?: string): Promise<string> {
  const cached = kvGet('notion.dataSourceId')
  if (cached) return cached
  if (!env.NOTION_DATABASE_ID) throw new Error('NOTION_DATABASE_ID is not set')
  const r = await swyExec<{ data_sources?: Array<{ id: string }> }>(N.dbGet, { params: { database_id: env.NOTION_DATABASE_ID } }, { runId })
  const id = r.data.data_sources?.[0]?.id
  if (!id) throw new Error('Notion database has no data source (is the integration connected to it?)')
  kvSet('notion.dataSourceId', id)
  return id
}

export interface NotionPage {
  id: string
  url: string
  created_time: string
  last_edited_time: string
  archived?: boolean
  in_trash?: boolean
  properties: Record<string, { type: string; [k: string]: unknown }>
}

export function pageToEntry(p: NotionPage): KbEntry {
  const props = p.properties
  const title = Object.values(props).find((v) => v.type === 'title')
  const sel = (name: string) => ((props[name]?.select as { name?: string } | null)?.name ?? undefined)
  return {
    id: p.id,
    url: p.url,
    question: plain(title?.title),
    answer: plain(props.Answer?.rich_text),
    type: (sel('Type') as KbType) ?? 'FAQ',
    source: (sel('Source') as KbSource) ?? 'Seed',
    status: (sel('Status') as KbStatus) ?? 'Live',
    used: Number(props.Used?.number ?? 0) || 0,
    learnedFrom: plain(props['Learned from']?.rich_text) || undefined,
    thread: (props.Thread?.url as string | null) ?? undefined,
    scripted: !!props.Scripted?.checkbox,
    updatedAt: Date.parse(p.last_edited_time),
    createdAt: Date.parse(p.created_time),
  }
}

/** All pages in the KB (paginated). Archived/trashed pages are skipped. */
export async function queryAll(filter?: unknown, runId?: string): Promise<KbEntry[]> {
  const ds = await dataSourceId(runId)
  const out: KbEntry[] = []
  let cursor: string | undefined
  for (let page = 0; page < 20; page++) {
    const r = await swyExec<{ results?: NotionPage[]; has_more?: boolean; next_cursor?: string | null }>(
      N.query,
      { params: { data_source_id: ds }, body: { page_size: 100, ...(filter ? { filter } : {}), ...(cursor ? { start_cursor: cursor } : {}) } },
      { runId },
    )
    for (const p of r.data.results ?? []) if (!p.archived && !p.in_trash) out.push(pageToEntry(p))
    if (!r.data.has_more || !r.data.next_cursor) break
    cursor = r.data.next_cursor
  }
  return out
}

export interface NewEntry {
  question: string
  answer: string
  type?: KbType
  source: KbSource
  status?: KbStatus
  learnedFrom?: string
  thread?: string
  scripted?: boolean
}

let titleProp: string | undefined
async function titleName(runId?: string): Promise<string> {
  if (titleProp) return titleProp
  const cached = kvGet('notion.titleProp')
  if (cached) return (titleProp = cached)
  const ds = await dataSourceId(runId)
  const r = await swyExec<{ properties?: Record<string, { type: string }> }>(N.dsGet, { params: { data_source_id: ds } }, { runId })
  titleProp = Object.entries(r.data.properties ?? {}).find(([, v]) => v.type === 'title')?.[0] ?? 'Question'
  kvSet('notion.titleProp', titleProp)
  return titleProp
}

function entryProperties(e: Partial<NewEntry> & { used?: number }, title: string): Record<string, unknown> {
  const p: Record<string, unknown> = {}
  if (e.question !== undefined) p[title] = { title: richText(e.question.slice(0, 1900)) }
  if (e.answer !== undefined) p.Answer = { rich_text: richText(e.answer) }
  if (e.type) p.Type = { select: { name: e.type } }
  if (e.source) p.Source = { select: { name: e.source } }
  if (e.status) p.Status = { select: { name: e.status } }
  if (e.learnedFrom !== undefined) p['Learned from'] = { rich_text: richText(e.learnedFrom) }
  if (e.thread !== undefined) p.Thread = { url: e.thread || null }
  if (e.scripted !== undefined) p.Scripted = { checkbox: e.scripted }
  if (e.used !== undefined) p.Used = { number: e.used }
  return p
}

export async function createPage(e: NewEntry, runId?: string): Promise<KbEntry> {
  const ds = await dataSourceId(runId)
  const title = await titleName(runId)
  const r = await swyExec<NotionPage>(
    N.pageCreate,
    {
      body: {
        parent: { type: 'data_source_id', data_source_id: ds },
        icon: { type: 'emoji', emoji: e.type === 'Announcement' ? '📣' : e.type === 'Digest' ? '🗞️' : e.source === 'Seed' ? '📌' : '💡' },
        properties: entryProperties({ type: 'FAQ', status: 'Live', ...e, used: 0 }, title),
      },
    },
    { runId },
  )
  return pageToEntry(r.data)
}

export async function updatePage(id: string, patch: Partial<NewEntry> & { used?: number; archived?: boolean }, runId?: string): Promise<KbEntry> {
  const title = await titleName(runId)
  const { archived, ...rest } = patch
  const r = await swyExec<NotionPage>(
    N.pageUpdate,
    { params: { page_id: id }, body: { properties: entryProperties(rest, title), ...(archived !== undefined ? { in_trash: archived } : {}) } },
    { runId },
  )
  return pageToEntry(r.data)
}

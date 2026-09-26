import { existsSync, readFileSync, statSync } from 'node:fs'
import path from 'node:path'
import { Bm25Index } from '../store/bm25.js'
import { kvGetJson, kvSetJson } from '../store/repo.js'

// A guide attached to one chat (e.g. the event's participant guide for the
// event's WhatsApp group). Pulse answers that chat from the guide first.
// The file is re-read when it changes; only the few sections that match a
// question go into the prompt, so replies stay fast on small-context models.

export interface GuideSection {
  /** "Event Schedule › Important Deadline" */
  title: string
  text: string
}

export interface GuideHit {
  section: GuideSection
  score: number
}

interface Loaded {
  path: string
  mtimeMs: number
  name: string
  sections: GuideSection[]
  index: Bm25Index<GuideSection>
}

const KEY = 'chat.guides'
const MAX_SECTION = 1800
const cache = new Map<string, Loaded>()

const clean = (s: string) => s.replace(/\*\*/g, '').replace(/^#+\s*/, '').trim()

/** "Track 3" → "track3": single digits are dropped by the tokenizer, but they matter here. */
const glue = (s: string) => s.replace(/\b([A-Za-z]+)\s+(\d{1,2})\b/g, '$1$2')

/** Split markdown into heading sections ("H1 › H3"), long ones into paragraph chunks. */
export function splitGuide(md: string): GuideSection[] {
  const out: GuideSection[] = []
  let top = ''
  let title = ''
  let buf: string[] = []
  const flush = () => {
    const text = buf.join('\n').trim()
    buf = []
    if (!text) return
    const t = title || top || 'Overview'
    if (text.length <= MAX_SECTION) return void out.push({ title: t, text })
    let chunk = ''
    for (const para of text.split(/\n\s*\n/)) {
      if (chunk && chunk.length + para.length > MAX_SECTION) {
        out.push({ title: t, text: chunk.trim() })
        chunk = ''
      }
      chunk += `${para}\n\n`
    }
    if (chunk.trim()) out.push({ title: t, text: chunk.trim() })
  }
  for (const line of md.split(/\r?\n/)) {
    const h = /^(#{1,6})\s+(.+)$/.exec(line)
    if (h) {
      flush()
      const name = clean(h[2]!)
      if (h[1]!.length === 1) {
        top = name
        title = name
      } else title = top && top !== name ? `${top} › ${name}` : name
      continue
    }
    buf.push(line)
  }
  flush()
  return out
}

function load(file: string): Loaded | undefined {
  if (!existsSync(file)) return undefined
  const { mtimeMs } = statSync(file)
  const hit = cache.get(file)
  if (hit && hit.mtimeMs === mtimeMs) return hit
  const sections = splitGuide(readFileSync(file, 'utf8'))
  // Titles count twice: "deadline" should find the section called Important Deadline.
  const index = new Bm25Index<GuideSection>((s) => glue(`${s.title} ${s.title} ${s.text}`))
  sections.forEach((s) => index.add(s))
  const loaded = { path: file, mtimeMs, name: path.basename(file).replace(/\.[^.]+$/, ''), sections, index }
  cache.set(file, loaded)
  return loaded
}

const guides = (): Record<string, string> => kvGetJson<Record<string, string>>(KEY) ?? {}

/** Attach (or with no path, detach) a guide file for one chat. */
export function setGuide(chatId: string, file?: string): { name?: string; sections?: number } {
  const all = guides()
  if (!file) {
    delete all[chatId]
    kvSetJson(KEY, all)
    return {}
  }
  const abs = path.resolve(file)
  const g = load(abs)
  if (!g) throw new Error(`guide not found: ${abs}`)
  kvSetJson(KEY, { ...all, [chatId]: abs })
  return { name: g.name, sections: g.sections.length }
}

export function guideFor(chatId: string): { name: string; sections: number } | undefined {
  const file = guides()[chatId]
  const g = file ? load(file) : undefined
  return g ? { name: g.name, sections: g.sections.length } : undefined
}

export function searchGuide(chatId: string, query: string, limit = 3): GuideHit[] {
  const file = guides()[chatId]
  const g = file ? load(file) : undefined
  if (!g) return []
  return g.index.search(glue(query), limit, 0.5).map((h) => ({ section: h.doc, score: Math.round(h.score * 10) / 10 }))
}

/** Section titles, so the model knows what else the guide covers. */
export function guideOutline(chatId: string): string[] {
  const file = guides()[chatId]
  const g = file ? load(file) : undefined
  return g ? [...new Set(g.sections.map((s) => s.title))] : []
}

/** All guides by chat, for the dashboard. */
export function guideNames(): Record<string, string> {
  const out: Record<string, string> = {}
  for (const chatId of Object.keys(guides())) {
    const g = guideFor(chatId)
    if (g) out[chatId] = g.name
  }
  return out
}

import { getDb, tx } from './db.js'
import { Bm25Index } from './bm25.js'
import type { GtEvent, Helper, InboundMessage, Platform, RunSummary, SequencedEvent } from '../shared/events.js'

// Typed repository helpers, one block per table. Plain SQL, no ORM.

type Row = Record<string, unknown>
const str = (v: unknown): string | undefined => (v === null || v === undefined ? undefined : String(v))
const num = (v: unknown): number => Number(v ?? 0)

// ── events ──────────────────────────────────────────────────────────────────

export function insertEvents(events: SequencedEvent[]): void {
  if (!events.length) return
  const stmt = getDb().prepare('INSERT OR IGNORE INTO events (seq, ts, type, json) VALUES (?, ?, ?, ?)')
  tx(() => {
    for (const e of events) stmt.run(e.seq, e.ts, e.type, JSON.stringify(e))
  })
}

export function lastEvents(limit: number): SequencedEvent[] {
  const rows = getDb().prepare('SELECT json FROM events ORDER BY seq DESC LIMIT ?').all(limit) as Row[]
  return rows.map(r => JSON.parse(String(r.json)) as SequencedEvent).reverse()
}

export function eventsBetween(fromTs: number, toTs: number): SequencedEvent[] {
  const rows = getDb().prepare('SELECT json FROM events WHERE ts >= ? AND ts <= ? ORDER BY seq').all(fromTs, toTs) as Row[]
  return rows.map(r => JSON.parse(String(r.json)) as SequencedEvent)
}

export function maxEventSeq(): number {
  const r = getDb().prepare('SELECT MAX(seq) AS m FROM events').get() as Row
  return num(r.m)
}

// ── messages ────────────────────────────────────────────────────────────────

export interface StoredMessage extends InboundMessage {
  id: number
  questionLike: boolean
  answeredBy?: string
  answeredAt?: number
  runId?: string
  escalated: boolean
  simulated: boolean
}

function toMessage(r: Row): StoredMessage {
  return {
    id: num(r.id),
    platform: String(r.platform) as Platform,
    chatId: String(r.chat_id),
    chatType: String(r.chat_type) as InboundMessage['chatType'],
    chatTitle: str(r.chat_title),
    userId: String(r.user_id),
    userName: String(r.user_name),
    text: String(r.text),
    msgId: String(r.msg_id),
    replyToId: str(r.reply_to_id),
    threadTs: str(r.thread_ts),
    addressed: !!num(r.addressed),
    ts: num(r.ts),
    questionLike: !!num(r.question_like),
    answeredBy: str(r.answered_by),
    answeredAt: r.answered_at == null ? undefined : num(r.answered_at),
    runId: str(r.run_id),
    escalated: !!num(r.escalated),
    simulated: !!num(r.simulated),
  }
}

/** Returns false when the message was already stored (poll overlap / backlog re-delivery). */
export function insertMessage(m: InboundMessage, questionLike = false): boolean {
  const res = getDb()
    .prepare(
      `INSERT OR IGNORE INTO messages
       (platform, chat_id, chat_type, chat_title, user_id, user_name, text, msg_id, reply_to_id, thread_ts, addressed, ts, question_like, simulated)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      m.platform, m.chatId, m.chatType, m.chatTitle ?? null, m.userId, m.userName, m.text, m.msgId,
      m.replyToId ?? null, m.threadTs ?? null, m.addressed ? 1 : 0, m.ts, questionLike ? 1 : 0, m.simulated ? 1 : 0,
    )
  return Number(res.changes) > 0
}

export function markQuestionLike(platform: Platform, chatId: string, msgId: string, questionLike = true): void {
  getDb().prepare('UPDATE messages SET question_like = ? WHERE platform = ? AND chat_id = ? AND msg_id = ?').run(questionLike ? 1 : 0, platform, chatId, msgId)
}

export function markAnswered(platform: Platform, chatId: string, msgIds: string[], by: 'bot' | 'human', runId?: string): void {
  const stmt = getDb().prepare(
    'UPDATE messages SET answered_by = ?, answered_at = ?, run_id = COALESCE(?, run_id) WHERE platform = ? AND chat_id = ? AND msg_id = ? AND answered_by IS NULL',
  )
  const now = Date.now()
  tx(() => {
    for (const id of msgIds) stmt.run(by, now, runId ?? null, platform, chatId, id)
  })
}

export function markEscalated(platform: Platform, chatId: string, msgId: string): void {
  getDb().prepare('UPDATE messages SET escalated = 1 WHERE platform = ? AND chat_id = ? AND msg_id = ?').run(platform, chatId, msgId)
}

/** Question-like messages nobody (bot or human) has answered, older than `olderThanMs`, not yet escalated. */
export function unansweredQuestions(olderThanMs: number, withinMs = 24 * 3600_000): StoredMessage[] {
  const now = Date.now()
  const rows = getDb()
    .prepare(
      `SELECT * FROM messages WHERE question_like = 1 AND answered_by IS NULL AND escalated = 0
       AND ts <= ? AND ts >= ? ORDER BY ts`,
    )
    .all(now - olderThanMs, now - withinMs) as Row[]
  return rows.map(toMessage)
}

export function recentMessages(limit = 200): StoredMessage[] {
  const rows = getDb().prepare('SELECT * FROM messages ORDER BY ts DESC LIMIT ?').all(limit) as Row[]
  return rows.map(toMessage).reverse()
}

export function getMessage(platform: Platform, chatId: string, msgId: string): StoredMessage | undefined {
  const r = getDb().prepare('SELECT * FROM messages WHERE platform = ? AND chat_id = ? AND msg_id = ?').get(platform, chatId, msgId) as Row | undefined
  return r ? toMessage(r) : undefined
}

// ── runs ────────────────────────────────────────────────────────────────────

export function upsertRun(run: RunSummary): void {
  getDb()
    .prepare('INSERT INTO runs (run_id, started_at, json) VALUES (?, ?, ?) ON CONFLICT(run_id) DO UPDATE SET json = excluded.json')
    .run(run.runId, run.startedAt, JSON.stringify(run))
}

export function getRun(runId: string): RunSummary | undefined {
  const r = getDb().prepare('SELECT json FROM runs WHERE run_id = ?').get(runId) as Row | undefined
  return r ? (JSON.parse(String(r.json)) as RunSummary) : undefined
}

export function recentRuns(limit = 100): RunSummary[] {
  const rows = getDb().prepare('SELECT json FROM runs ORDER BY started_at DESC LIMIT ?').all(limit) as Row[]
  return rows.map(r => JSON.parse(String(r.json)) as RunSummary)
}

// ── docs (approvals, attention, pending mod questions) ─────────────────────

export type DocKind = 'approval' | 'attention' | 'pending' | 'case' | 'push'

export function putDoc<T extends { id: string; status: string }>(kind: DocKind, doc: T, createdAt = Date.now()): void {
  getDb()
    .prepare(
      `INSERT INTO docs (kind, id, status, created_at, json) VALUES (?, ?, ?, ?, ?)
       ON CONFLICT(kind, id) DO UPDATE SET status = excluded.status, json = excluded.json`,
    )
    .run(kind, doc.id, doc.status, createdAt, JSON.stringify(doc))
}

export function getDoc<T>(kind: DocKind, id: string): T | undefined {
  const r = getDb().prepare('SELECT json FROM docs WHERE kind = ? AND id = ?').get(kind, id) as Row | undefined
  return r ? (JSON.parse(String(r.json)) as T) : undefined
}

export function listDocs<T>(kind: DocKind, opts: { status?: string; limit?: number } = {}): T[] {
  const rows = (
    opts.status
      ? getDb().prepare('SELECT json FROM docs WHERE kind = ? AND status = ? ORDER BY created_at DESC LIMIT ?').all(kind, opts.status, opts.limit ?? 200)
      : getDb().prepare('SELECT json FROM docs WHERE kind = ? ORDER BY created_at DESC LIMIT ?').all(kind, opts.limit ?? 200)
  ) as Row[]
  return rows.map(r => JSON.parse(String(r.json)) as T)
}

// ── helpers (members who answered others) ──────────────────────────────────

export function creditHelper(platform: Platform, userName: string, simulated = false): void {
  getDb()
    .prepare(
      `INSERT INTO helpers (platform, user_name, simulated, answers) VALUES (?, ?, ?, 1)
       ON CONFLICT(platform, user_name, simulated) DO UPDATE SET answers = answers + 1`,
    )
    .run(platform, userName, simulated ? 1 : 0)
}

export function topHelpers(limit = 10): Helper[] {
  const rows = getDb().prepare('SELECT * FROM helpers ORDER BY answers DESC LIMIT ?').all(limit) as Row[]
  return rows.map(r => ({ platform: String(r.platform) as Platform, userName: String(r.user_name), answers: num(r.answers), simulated: !!num(r.simulated) }))
}

// ── questions + clusters (repeat detection) ────────────────────────────────

export interface QuestionRow {
  id: number
  platform: Platform
  chatId: string
  msgId: string
  userName: string
  text: string
  ts: number
  clusterId?: string
}

function toQuestion(r: Row): QuestionRow {
  return {
    id: num(r.id), platform: String(r.platform) as Platform, chatId: String(r.chat_id), msgId: String(r.msg_id),
    userName: String(r.user_name), text: String(r.text), ts: num(r.ts), clusterId: str(r.cluster_id),
  }
}

export function insertQuestion(q: Omit<QuestionRow, 'id' | 'clusterId'> & { simulated?: boolean }): number {
  const res = getDb()
    .prepare('INSERT INTO questions (platform, chat_id, msg_id, user_name, text, ts, simulated) VALUES (?, ?, ?, ?, ?, ?, ?)')
    .run(q.platform, q.chatId, q.msgId, q.userName, q.text, q.ts, q.simulated ? 1 : 0)
  return Number(res.lastInsertRowid)
}

/**
 * Lexical candidates for "has this been asked before?". The triage LLM makes the
 * final call — BM25 only has to surface the right few candidates.
 */
export function searchQuestions(query: string, opts: { limit?: number; excludeId?: number; window?: number } = {}): Array<QuestionRow & { score: number }> {
  const rows = getDb().prepare('SELECT * FROM questions ORDER BY id DESC LIMIT ?').all(opts.window ?? 2000) as Row[]
  const index = new Bm25Index<QuestionRow>(q => q.text)
  for (const r of rows) {
    const q = toQuestion(r)
    if (q.id !== opts.excludeId) index.add(q)
  }
  return index.search(query, opts.limit ?? 5, 0.5).map(h => ({ ...h.doc, score: h.score }))
}

export function getQuestion(id: number): QuestionRow | undefined {
  const r = getDb().prepare('SELECT * FROM questions WHERE id = ?').get(id) as Row | undefined
  return r ? toQuestion(r) : undefined
}

export interface ClusterRow {
  id: string
  label: string
  size: number
  createdAt: number
  updatedAt: number
}

/** Attach question `questionId` to the cluster of `toQuestionId` (creating it if needed). */
export function addToCluster(questionId: number, toQuestionId: number, label: string): ClusterRow {
  return tx(() => {
    const d = getDb()
    const target = getQuestion(toQuestionId)
    const now = Date.now()
    let clusterId = target?.clusterId
    if (!clusterId) {
      clusterId = `c_${toQuestionId}`
      d.prepare('INSERT OR IGNORE INTO clusters (id, label, size, created_at, updated_at) VALUES (?, ?, 0, ?, ?)').run(clusterId, label, now, now)
      d.prepare('INSERT OR IGNORE INTO cluster_members (cluster_id, question_id) VALUES (?, ?)').run(clusterId, toQuestionId)
      d.prepare('UPDATE questions SET cluster_id = ? WHERE id = ?').run(clusterId, toQuestionId)
    }
    d.prepare('INSERT OR IGNORE INTO cluster_members (cluster_id, question_id) VALUES (?, ?)').run(clusterId, questionId)
    d.prepare('UPDATE questions SET cluster_id = ? WHERE id = ?').run(clusterId, questionId)
    const size = num((d.prepare('SELECT COUNT(*) AS n FROM cluster_members WHERE cluster_id = ?').get(clusterId) as Row).n)
    d.prepare('UPDATE clusters SET size = ?, updated_at = ? WHERE id = ?').run(size, now, clusterId)
    return getCluster(clusterId)!
  })
}

export function getCluster(id: string): ClusterRow | undefined {
  const r = getDb().prepare('SELECT * FROM clusters WHERE id = ?').get(id) as Row | undefined
  return r ? { id: String(r.id), label: String(r.label), size: num(r.size), createdAt: num(r.created_at), updatedAt: num(r.updated_at) } : undefined
}

export function clusterSamples(id: string, limit = 5): string[] {
  const rows = getDb()
    .prepare('SELECT q.text FROM cluster_members m JOIN questions q ON q.id = m.question_id WHERE m.cluster_id = ? ORDER BY q.ts DESC LIMIT ?')
    .all(id, limit) as Row[]
  return rows.map(r => String(r.text))
}

export function topClusters(limit = 10, sinceTs = 0): ClusterRow[] {
  const rows = getDb().prepare('SELECT * FROM clusters WHERE updated_at >= ? ORDER BY size DESC, updated_at DESC LIMIT ?').all(sinceTs, limit) as Row[]
  return rows.map(r => ({ id: String(r.id), label: String(r.label), size: num(r.size), createdAt: num(r.created_at), updatedAt: num(r.updated_at) }))
}

// ── members ─────────────────────────────────────────────────────────────────

export function setMember(platform: Platform, userId: string, chatId: string, isMember: boolean): void {
  getDb()
    .prepare(
      `INSERT INTO members (platform, user_id, chat_id, verified_at, is_member) VALUES (?, ?, ?, ?, ?)
       ON CONFLICT(platform, user_id, chat_id) DO UPDATE SET verified_at = excluded.verified_at, is_member = excluded.is_member`,
    )
    .run(platform, userId, chatId, Date.now(), isMember ? 1 : 0)
}

/** undefined = never checked, or the check is older than maxAgeMs. */
export function getMember(platform: Platform, userId: string, chatId: string, maxAgeMs = 3600_000): boolean | undefined {
  const r = getDb().prepare('SELECT * FROM members WHERE platform = ? AND user_id = ? AND chat_id = ?').get(platform, userId, chatId) as Row | undefined
  if (!r || Date.now() - num(r.verified_at) > maxAgeMs) return undefined
  return !!num(r.is_member)
}

export function listMembers(platform: Platform, chatId: string): string[] {
  const rows = getDb().prepare('SELECT user_id FROM members WHERE platform = ? AND chat_id = ? AND is_member = 1').all(platform, chatId) as Row[]
  return rows.map(r => String(r.user_id))
}

// ── kv (offsets, cursors, flags) ────────────────────────────────────────────

export function kvGet(key: string): string | undefined {
  const r = getDb().prepare('SELECT value FROM kv WHERE key = ?').get(key) as Row | undefined
  return r ? String(r.value) : undefined
}

export function kvSet(key: string, value: string): void {
  getDb().prepare('INSERT INTO kv (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value').run(key, value)
}

export function kvGetJson<T>(key: string): T | undefined {
  const v = kvGet(key)
  return v === undefined ? undefined : (JSON.parse(v) as T)
}

export function kvSetJson(key: string, value: unknown): void {
  kvSet(key, JSON.stringify(value))
}

// ── demo reset ──────────────────────────────────────────────────────────────

/** Forget all scripted traffic (runs, messages, questions, helpers, docs). */
export function deleteSimulatedRows(): void {
  const d = getDb()
  tx(() => {
    d.prepare('DELETE FROM messages WHERE simulated = 1').run()
    d.prepare('DELETE FROM questions WHERE simulated = 1').run()
    d.prepare('DELETE FROM helpers WHERE simulated = 1').run()
    d.prepare(`DELETE FROM runs WHERE json LIKE '%"simulated":true%'`).run()
    d.prepare(`DELETE FROM docs WHERE json LIKE '%"simulated":true%'`).run()
    d.prepare(`DELETE FROM memory WHERE chat_key LIKE 'sim:%'`).run()
  })
}

export type { GtEvent }

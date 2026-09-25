import { getDb } from '../store/db.js'

// Port of the WhatsApp bot's memory.ts — same API, SQLite instead of one JSON
// file per chat. Chat key = `${platform}:${chatId}` (optionally `:${threadTs}`).

export interface Message {
  sender: string
  text: string
  ts?: number
}

// Context window per chat — enough history for follow-ups ("that didn't work")
// without blowing the free-tier token budget (the agent trims further).
export const HISTORY_LIMIT = 100

export function chatKey(platform: string, chatId: string, threadTs?: string): string {
  return threadTs ? `${platform}:${chatId}:${threadTs}` : `${platform}:${chatId}`
}

export function readHistory(key: string, limit = HISTORY_LIMIT): Message[] {
  const rows = getDb()
    .prepare('SELECT sender, text, ts FROM memory WHERE chat_key = ? ORDER BY id DESC LIMIT ?')
    .all(key, limit) as Array<{ sender: string; text: string; ts: number }>
  return rows.reverse().map(r => ({ sender: r.sender, text: r.text, ts: Number(r.ts) }))
}

export function writeHistory(key: string, entry: Message): void {
  const d = getDb()
  d.prepare('INSERT INTO memory (chat_key, sender, text, ts) VALUES (?, ?, ?, ?)').run(key, entry.sender, entry.text, entry.ts ?? Date.now())
  // Trim to the window, like the original's slice(-HISTORY_LIMIT)
  d.prepare(
    `DELETE FROM memory WHERE chat_key = ? AND id NOT IN (
       SELECT id FROM memory WHERE chat_key = ? ORDER BY id DESC LIMIT ?)`,
  ).run(key, key, HISTORY_LIMIT)
}

export function clearHistory(key: string): void {
  getDb().prepare('DELETE FROM memory WHERE chat_key = ?').run(key)
}

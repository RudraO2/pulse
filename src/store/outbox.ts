import { createHash } from 'node:crypto'
import { getDb } from './db.js'
import type { Platform } from '../shared/events.js'

// Idempotent posting. The row is written as `pending` BEFORE the send, so the
// UNIQUE key makes a second attempt for the same (chat, reply-to, text) a no-op.
// A crash between send and `sent` leaves the row pending; at boot those become
// `failed_unknown` and are NEVER resent — a double post in a public community
// is worse than a missed one (a human can re-ask; a duplicate can't be unsent
// by an agent that has no delete permission).

export type OutboxStatus = 'pending' | 'sent' | 'failed' | 'failed_unknown'

export interface OutboxRow {
  key: string
  platform: Platform
  chatId: string
  replyTo?: string
  textSha: string
  status: OutboxStatus
  providerMsgId?: string
  createdAt: number
  sentAt?: number
  error?: string
}

export type OutboxResult =
  | { status: 'sent'; providerMsgId?: string; duplicate: boolean }
  | { status: 'skipped'; reason: 'in_flight' | 'failed_before'; row: OutboxRow }

export const sha256 = (s: string): string => createHash('sha256').update(s).digest('hex')

export function outboxKey(platform: Platform, chatId: string, replyTo: string | undefined, text: string): string {
  return sha256([platform, chatId, replyTo ?? '', sha256(text)].join('\u0000'))
}

export function getOutbox(key: string): OutboxRow | undefined {
  const r = getDb().prepare('SELECT * FROM outbox WHERE key = ?').get(key) as Record<string, unknown> | undefined
  if (!r) return undefined
  return {
    key: String(r.key),
    platform: String(r.platform) as Platform,
    chatId: String(r.chat_id),
    replyTo: r.reply_to == null ? undefined : String(r.reply_to),
    textSha: String(r.text_sha),
    status: String(r.status) as OutboxStatus,
    providerMsgId: r.provider_msg_id == null ? undefined : String(r.provider_msg_id),
    createdAt: Number(r.created_at),
    sentAt: r.sent_at == null ? undefined : Number(r.sent_at),
    error: r.error == null ? undefined : String(r.error),
  }
}

/** Provider message ids we sent — used for echo suppression when our own posts come back through polling. */
export function isOwnMessage(platform: Platform, chatId: string, providerMsgId: string): boolean {
  const r = getDb()
    .prepare("SELECT 1 FROM outbox WHERE platform = ? AND chat_id = ? AND provider_msg_id = ? AND status = 'sent'")
    .get(platform, chatId, providerMsgId)
  return !!r
}

export interface OutboxTarget {
  platform: Platform
  chatId: string
  replyTo?: string
  text: string
}

/**
 * Run `send` at most once for this target. `send` must return the provider's
 * message id (if any). Errors are recorded and rethrown.
 */
export async function withOutbox(
  target: OutboxTarget,
  send: () => Promise<{ providerMsgId?: string }>,
  key = outboxKey(target.platform, target.chatId, target.replyTo, target.text),
): Promise<OutboxResult> {
  const d = getDb()
  const inserted = d
    .prepare(
      `INSERT OR IGNORE INTO outbox (key, platform, chat_id, reply_to, text_sha, status, created_at)
       VALUES (?, ?, ?, ?, ?, 'pending', ?)`,
    )
    .run(key, target.platform, target.chatId, target.replyTo ?? null, sha256(target.text), Date.now())

  if (Number(inserted.changes) === 0) {
    const row = getOutbox(key)!
    if (row.status === 'sent') return { status: 'sent', providerMsgId: row.providerMsgId, duplicate: true }
    return { status: 'skipped', reason: row.status === 'pending' ? 'in_flight' : 'failed_before', row }
  }

  try {
    const { providerMsgId } = await send()
    d.prepare("UPDATE outbox SET status = 'sent', provider_msg_id = ?, sent_at = ? WHERE key = ?").run(providerMsgId ?? null, Date.now(), key)
    return { status: 'sent', providerMsgId, duplicate: false }
  } catch (err) {
    d.prepare("UPDATE outbox SET status = 'failed', error = ? WHERE key = ?").run(String((err as Error)?.message ?? err).slice(0, 500), key)
    throw err
  }
}

/**
 * A failed (definitely-not-delivered, e.g. policy_denied) row may be retried
 * with a *different* text — that's a new key. Same text stays blocked unless
 * explicitly released here (used after a transient network error we know
 * never reached the provider).
 */
export function releaseFailed(key: string): void {
  getDb().prepare("DELETE FROM outbox WHERE key = ? AND status = 'failed'").run(key)
}

/** Boot-time sweep: pending rows older than maxAgeMs are of unknown fate. */
export function sweepStalePending(maxAgeMs = 2 * 60_000): number {
  const res = getDb()
    .prepare("UPDATE outbox SET status = 'failed_unknown', error = 'process ended mid-send' WHERE status = 'pending' AND created_at < ?")
    .run(Date.now() - maxAgeMs)
  return Number(res.changes)
}

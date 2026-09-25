import { env } from '../config/env.js'
import { channels, reportBlock } from './channels.js'
import { formatFor } from '../agent/format.js'

// The private #mods channel on Slack: where Pulse asks, escalates and requests
// approvals. Cards are posted without the outbox because each card's caller
// owns its idempotency (a pending question / approval id is created once).

export const modsChannel = (): string | undefined => env.SLACK_ESCALATION_CHANNEL_ID

export function modsAvailable(): boolean {
  return !!(channels.slack && modsChannel())
}

export interface CardResult {
  ts?: string
  error?: string
}

export async function postModsCard(markdown: string, opts: { threadTs?: string; runId?: string } = {}): Promise<CardResult> {
  const slack = channels.slack
  const channel = modsChannel()
  if (!slack || !channel) return { error: 'mods channel not configured' }
  try {
    const ts = await slack.postRaw({ channel, text: formatFor('slack', markdown), ...(opts.threadTs ? { thread_ts: opts.threadTs } : {}) }, opts.runId)
    return { ts }
  } catch (e) {
    const blocked = reportBlock(e, { platform: 'slack', chatId: channel, runId: opts.runId })
    return { error: blocked ? `blocked by ${blocked.policyId ?? blocked.kind}` : String((e as Error).message).slice(0, 160) }
  }
}

export const platformLabel = (p: string): string => (p === 'telegram' ? 'Telegram' : p === 'slack' ? 'Slack' : p)

/** "> line" quote block for Slack cards. */
export const quote = (text: string): string =>
  text
    .split('\n')
    .slice(0, 8)
    .map((l) => `> ${l}`)
    .join('\n')

import type { Platform } from '../shared/events.js'

// Small per-platform facts shared by the agents, approvals and the dashboard.

/** The Swytchcode tool a community post goes through (WhatsApp is sent directly by the linked device). */
export function sendTool(p: Platform): string | undefined {
  if (p === 'telegram') return 'telegram_v5_0.sendmessage.create'
  if (p === 'slack') return 'slack.chat.postmessage.create'
  return undefined
}

export const platformLabel = (p: string): string => (p === 'telegram' ? 'Telegram' : p === 'slack' ? 'Slack' : p === 'whatsapp' ? 'WhatsApp' : p)

/** Telegram and WhatsApp reply by quoting a message; Slack replies in a thread. */
export const quotesReplies = (p: Platform): boolean => p === 'telegram' || p === 'whatsapp'

/** Tool ids shown on a run step for a community post (none for WhatsApp). */
export const sendTools = (p: Platform): string[] => {
  const t = sendTool(p)
  return t ? [t] : []
}

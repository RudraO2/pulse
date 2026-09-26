import type { InboundMessage, Platform, ChatType } from '../shared/events.js'

export type { InboundMessage, Platform, ChatType }

export interface SendOptions {
  replyToId?: string
  threadTs?: string
  /** idempotency: an explicit outbox key (defaults to hash of chat+replyTo+text) */
  key?: string
  runId?: string
  /** written or approved by an organizer: goes out even when Pulse is paused */
  byOrganizer?: boolean
}

export interface OutboundMessage {
  platform: Platform
  chatId: string
  text: string
  opts?: SendOptions
}

export interface SendResult {
  msgId?: string
  duplicate?: boolean
}

export interface ChannelAdapter {
  readonly platform: Platform
  start(): Promise<void>
  stop(): Promise<void>
  send(chatId: string, text: string, opts?: SendOptions): Promise<SendResult>
  edit(chatId: string, msgId: string, text: string): Promise<void>
  typing(chatId: string): Promise<void>
}

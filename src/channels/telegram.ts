import { bus } from '../bus.js'
import { env } from '../config/env.js'
import { formatFor } from '../agent/format.js'
import type { InboundMessage } from '../shared/events.js'
import { kvGet, kvSet, setMember } from '../store/repo.js'
import { withOutbox, outboxKey } from '../store/outbox.js'
import { swyExec, SwyError } from '../swy/exec.js'
import type { ChannelAdapter, SendOptions, SendResult } from './types.js'

// Telegram, entirely through Swytchcode: even the bot's "ears" (getUpdates
// long-polling) are swy exec calls. No webhook, so it runs behind NAT too.

const T = {
  getUpdates: 'telegram_v5_0.getupdate.create',
  send: 'telegram_v5_0.sendmessage.create',
  edit: 'telegram_v5_0.editmessagetext.create',
  action: 'telegram_v5_0.sendchataction.create',
  member: 'telegram_v5_0.getchatmember.create',
  me: 'telegram_v5_0.getme.create',
}

const LONG_POLL_S = 25
const BATCH_LIMIT = 100

interface TgUser { id: number; is_bot?: boolean; first_name?: string; last_name?: string; username?: string }
interface TgChat { id: number; type: string; title?: string; username?: string }
interface TgMessage {
  message_id: number
  from?: TgUser
  chat: TgChat
  date: number
  text?: string
  caption?: string
  entities?: Array<{ type: string; offset: number; length: number }>
  reply_to_message?: { message_id: number; from?: TgUser }
  message_thread_id?: number
  new_chat_members?: TgUser[]
  left_chat_member?: TgUser
}
interface TgUpdate { update_id: number; message?: TgMessage; edited_message?: TgMessage }

export interface TelegramHooks {
  onMessage(msg: InboundMessage): void
  beginBacklog(): void
  endBacklog(): Promise<void>
}

function unwrap<T>(data: unknown): T {
  const d = data as { ok?: boolean; result?: T; description?: string }
  if (d && typeof d === 'object' && 'ok' in d) {
    if (d.ok === false) throw new Error(`telegram: ${d.description ?? 'request failed'}`)
    return d.result as T
  }
  return data as T
}

const displayName = (u?: TgUser) => (u ? [u.first_name, u.last_name].filter(Boolean).join(' ') || u.username || String(u.id) : 'unknown')

export class TelegramAdapter implements ChannelAdapter {
  readonly platform = 'telegram' as const
  botId?: number
  botUsername?: string
  private running = false
  private loop?: Promise<void>

  constructor(private readonly hooks: TelegramHooks) {}

  private status(state: 'up' | 'degraded' | 'down' | 'disabled', detail: string) {
    bus.emit({ type: 'status', service: 'telegram', status: { state, detail, at: Date.now() } })
  }

  async start(): Promise<void> {
    const me = unwrap<TgUser>((await swyExec(T.me, { body: {} })).data)
    this.botId = me.id
    this.botUsername = me.username
    this.running = true
    this.status('up', `@${me.username}`)
    this.loop = this.poll()
  }

  async stop(): Promise<void> {
    this.running = false
    await this.loop?.catch(() => {})
  }

  private async poll(): Promise<void> {
    let offset = Number(kvGet('telegram.offset') ?? 0) || undefined
    let draining = true
    this.hooks.beginBacklog()
    let backoff = 0
    while (this.running) {
      try {
        const r = await swyExec(
          T.getUpdates,
          { body: { offset, timeout: draining ? 0 : LONG_POLL_S, limit: BATCH_LIMIT, allowed_updates: ['message', 'edited_message'] } },
          { timeoutMs: (LONG_POLL_S + 20) * 1000 },
        )
        const updates = unwrap<TgUpdate[]>(r.data) ?? []
        for (const u of updates) {
          offset = u.update_id + 1
          const m = u.message ?? u.edited_message
          if (m) this.handle(m, !!u.edited_message)
        }
        if (updates.length) kvSet('telegram.offset', String(offset))
        if (draining && updates.length < BATCH_LIMIT) {
          draining = false
          await this.hooks.endBacklog()
        }
        if (backoff) this.status('up', `@${this.botUsername}`)
        backoff = 0
      } catch (e) {
        const msg = String((e as Error).message)
        const conflict = /409|conflict|terminated by other getUpdates/i.test(msg)
        backoff = Math.min(conflict ? 30_000 : (backoff || 2_000) * 2, 60_000)
        this.status(conflict ? 'down' : 'degraded', conflict ? 'another instance is polling this bot' : msg.slice(0, 120))
        if (draining) {
          draining = false
          await this.hooks.endBacklog()
        }
        await new Promise(r => setTimeout(r, backoff))
      }
    }
  }

  private handle(m: TgMessage, edited: boolean): void {
    const chatType = m.chat.type === 'private' ? 'dm' : 'group'
    for (const u of m.new_chat_members ?? []) {
      if (u.is_bot) continue
      setMember('telegram', String(u.id), String(m.chat.id), true)
      if (!edited) {
        this.hooks.onMessage({
          platform: 'telegram',
          chatId: String(m.chat.id),
          chatType,
          chatTitle: m.chat.title ?? m.chat.username,
          userId: String(u.id),
          userName: displayName(u),
          text: `${displayName(u)} joined the group`,
          msgId: `join_${m.message_id}_${u.id}`,
          addressed: false,
          joined: true,
          ts: m.date * 1000,
        })
      }
    }
    if (m.left_chat_member) setMember('telegram', String(m.left_chat_member.id), String(m.chat.id), false)
    const raw = m.text ?? m.caption
    if (!raw || !m.from || m.from.is_bot || edited) return
    if (chatType === 'group') setMember('telegram', String(m.from.id), String(m.chat.id), true)

    const mention = this.botUsername ? new RegExp(`@${this.botUsername}\\b`, 'i') : null
    const isCommand = /^\/(ask|start|help)(@\w+)?\b/i.test(raw)
    const repliedToBot = m.reply_to_message?.from?.id === this.botId
    const addressed = chatType === 'dm' || isCommand || repliedToBot || (!!mention && mention.test(raw))
    let text = raw
    if (mention) text = text.replace(mention, '').trim()
    text = text.replace(/^\/(ask|start|help)(@\w+)?\s*/i, '').trim() || (isCommand ? '/start' : text)

    this.hooks.onMessage({
      platform: 'telegram',
      chatId: String(m.chat.id),
      chatType,
      chatTitle: m.chat.title ?? m.chat.username ?? (chatType === 'dm' ? displayName(m.from) : undefined),
      userId: String(m.from.id),
      userName: displayName(m.from),
      text,
      msgId: String(m.message_id),
      replyToId: m.reply_to_message ? String(m.reply_to_message.message_id) : undefined,
      threadTs: m.message_thread_id ? String(m.message_thread_id) : undefined,
      addressed,
      ts: m.date * 1000,
    })
  }

  async send(chatId: string, text: string, opts: SendOptions = {}): Promise<SendResult> {
    const key = opts.key ?? outboxKey('telegram', chatId, opts.replyToId, text)
    const res = await withOutbox({ platform: 'telegram', chatId, replyTo: opts.replyToId, text }, async () => {
      const msg = await this.sendRaw(chatId, text, opts)
      return { providerMsgId: String(msg.message_id) }
    }, key)
    if (res.status === 'skipped') return { duplicate: true }
    return { msgId: res.providerMsgId, duplicate: res.duplicate }
  }

  private async sendRaw(chatId: string, text: string, opts: SendOptions): Promise<TgMessage> {
    const base: Record<string, unknown> = {
      chat_id: chatId,
      disable_web_page_preview: true,
      ...(opts.replyToId ? { reply_to_message_id: Number(opts.replyToId), allow_sending_without_reply: true } : {}),
    }
    try {
      return unwrap<TgMessage>((await swyExec(T.send, { body: { ...base, text: formatFor('telegram', text), parse_mode: 'HTML' } }, { runId: opts.runId })).data)
    } catch (e) {
      // Policy blocks must surface to the guard; only formatting errors fall back to plain text.
      if (e instanceof SwyError && e.isPolicy) throw e
      if (!/parse entities|can't parse|bad request/i.test(String((e as Error).message))) throw e
      return unwrap<TgMessage>((await swyExec(T.send, { body: { ...base, text } }, { runId: opts.runId })).data)
    }
  }

  async edit(chatId: string, msgId: string, text: string): Promise<void> {
    const body = { chat_id: chatId, message_id: Number(msgId), disable_web_page_preview: true }
    try {
      await swyExec(T.edit, { body: { ...body, text: formatFor('telegram', text), parse_mode: 'HTML' } })
    } catch (e) {
      if (e instanceof SwyError && e.isPolicy) throw e
      if (/not modified/i.test(String((e as Error).message))) return
      await swyExec(T.edit, { body: { ...body, text } })
    }
  }

  async typing(chatId: string): Promise<void> {
    await swyExec(T.action, { body: { chat_id: chatId, action: 'typing' } }).catch(() => {})
  }

  /** Membership check through Swytchcode; the answer feeds the DM policy. */
  async isMember(userId: string, chatId = env.TELEGRAM_COMMUNITY_CHAT_ID): Promise<boolean | undefined> {
    if (!chatId) return undefined
    try {
      const m = unwrap<{ status: string }>((await swyExec(T.member, { body: { chat_id: chatId, user_id: Number(userId) } })).data)
      const ok = ['creator', 'administrator', 'member', 'restricted'].includes(m.status)
      setMember('telegram', userId, chatId, ok)
      return ok
    } catch {
      return undefined
    }
  }
}

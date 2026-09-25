import { bus } from '../bus.js'
import { formatFor } from '../agent/format.js'
import type { InboundMessage } from '../shared/events.js'
import { kvGet, kvSet } from '../store/repo.js'
import { outboxKey, withOutbox } from '../store/outbox.js'
import { swyExec } from '../swy/exec.js'
import type { ChannelAdapter, SendOptions, SendResult } from './types.js'

// Slack through Swytchcode. Inbound is adaptive polling of
// conversations.history (fast right after activity, slow when idle) plus
// conversations.replies for threads we're part of. Internal apps keep Tier-3
// limits (50+/min), so this is well within budget.

const S = {
  auth: 'slack.auth.test.list',
  history: 'slack.conversations.history.list',
  replies: 'slack.conversations.reply.list',
  post: 'slack.chat.postmessage.create',
  update: 'slack.chat.update.create',
  react: 'slack.reactions.add.create',
  reactions: 'slack.reactions.get.list',
  user: 'slack.users.info.list',
  members: 'slack.conversations.member.list',
}

const FAST_MS = 3_000
const IDLE_MS = 15_000
const HOT_WINDOW_MS = 120_000
const THREAD_TTL_MS = 30 * 60_000

interface SlackMsg {
  ts: string
  user?: string
  bot_id?: string
  subtype?: string
  text?: string
  thread_ts?: string
  reply_count?: number
}

export interface SlackHooks {
  onMessage(msg: InboundMessage): void
  beginBacklog(): void
  endBacklog(): Promise<void>
}

export interface SlackChannelSpec {
  id: string
  /** community channels are answered; team channels are only read for thread replies */
  role: 'community' | 'team'
}

export class SlackAdapter implements ChannelAdapter {
  readonly platform = 'slack' as const
  botUserId?: string
  private running = false
  private loop?: Promise<void>
  private lastActivity = 0
  private users = new Map<string, string>()
  private skipUntil = new Map<string, number>()
  /** threads to watch for replies: key = channel:thread_ts */
  private threads = new Map<string, { channel: string; ts: string; seen: string; until: number; onReply?: (m: InboundMessage) => void }>()

  constructor(
    private readonly hooks: SlackHooks,
    private readonly channels: SlackChannelSpec[],
  ) {}

  private status(state: 'up' | 'degraded' | 'down', detail: string) {
    bus.emit({ type: 'status', service: 'slack', status: { state, detail, at: Date.now() } })
  }

  async start(): Promise<void> {
    const me = (await swyExec<{ user_id?: string; user?: string; team?: string }>(S.auth, {})).data
    this.botUserId = me.user_id
    this.running = true
    this.status('up', `${me.user ?? 'bot'} @ ${me.team ?? 'workspace'}`)
    this.loop = this.poll()
  }

  async stop(): Promise<void> {
    this.running = false
    await this.loop?.catch(() => {})
  }

  /** Watch a thread for replies (escalations, answered questions). */
  watchThread(channel: string, ts: string, onReply?: (m: InboundMessage) => void, ttlMs = THREAD_TTL_MS): void {
    this.threads.set(`${channel}:${ts}`, { channel, ts, seen: ts, until: Date.now() + ttlMs, onReply })
  }

  private async poll(): Promise<void> {
    this.hooks.beginBacklog()
    let first = true
    while (this.running) {
      try {
        for (const ch of this.channels) {
          if (ch.role !== 'community' || (this.skipUntil.get(ch.id) ?? 0) > Date.now()) continue
          try {
            await this.pollChannel(ch.id, first)
          } catch (e) {
            // Not invited to this channel: skip it for a while instead of failing the whole loop.
            if (!/not_in_channel|channel_not_found/.test(String((e as Error).message))) throw e
            this.skipUntil.set(ch.id, Date.now() + 5 * 60_000)
            bus.emit({ type: 'log', level: 'warn', text: `slack: not a member of ${ch.id}; /invite @Pulse there to include it` })
          }
        }
        await this.pollThreads()
        if (first) {
          first = false
          await this.hooks.endBacklog()
        }
      } catch (e) {
        this.status('degraded', String((e as Error).message).slice(0, 120))
        if (first) {
          first = false
          await this.hooks.endBacklog()
        }
      }
      const hot = Date.now() - this.lastActivity < HOT_WINDOW_MS
      await new Promise(r => setTimeout(r, hot ? FAST_MS : IDLE_MS))
    }
  }

  private async pollChannel(channel: string, first: boolean): Promise<void> {
    const cursorKey = `slack.oldest.${channel}`
    // First boot ever: start from "now" so we don't answer ancient history.
    const oldest = kvGet(cursorKey) ?? String(Date.now() / 1000 - (first ? 600 : 0))
    const r = await swyExec<{ messages?: SlackMsg[] }>(S.history, { params: { channel, oldest, limit: 50, inclusive: false } })
    const msgs = (r.data.messages ?? []).slice().sort((a, b) => Number(a.ts) - Number(b.ts))
    for (const m of msgs) {
      kvSet(cursorKey, m.ts)
      await this.emitMessage(channel, m)
    }
  }

  private async pollThreads(): Promise<void> {
    const now = Date.now()
    for (const [key, t] of this.threads) {
      if (t.until < now) {
        this.threads.delete(key)
        continue
      }
      const r = await swyExec<{ messages?: SlackMsg[] }>(S.replies, { params: { channel: t.channel, ts: t.ts, oldest: t.seen, limit: 50 } })
      for (const m of (r.data.messages ?? []).sort((a, b) => Number(a.ts) - Number(b.ts))) {
        if (Number(m.ts) <= Number(t.seen) || m.ts === t.ts) continue
        t.seen = m.ts
        const msg = await this.toInbound(t.channel, m, true)
        if (!msg) continue
        if (t.onReply) t.onReply(msg)
        else this.hooks.onMessage(msg)
      }
    }
  }

  private async emitMessage(channel: string, m: SlackMsg): Promise<void> {
    const msg = await this.toInbound(channel, m, false)
    if (!msg) return
    this.lastActivity = Date.now()
    this.hooks.onMessage(msg)
  }

  private async toInbound(channel: string, m: SlackMsg, inThread: boolean): Promise<InboundMessage | undefined> {
    if (!m.user || m.bot_id || m.user === this.botUserId) return undefined
    if (m.subtype && m.subtype !== 'thread_broadcast') return undefined
    const raw = m.text ?? ''
    if (!raw.trim()) return undefined
    const mention = this.botUserId ? `<@${this.botUserId}>` : undefined
    const addressed = (!!mention && raw.includes(mention)) || inThread
    const text = (mention ? raw.split(mention).join('') : raw).replace(/<@([A-Z0-9]+)>/g, '@$1').trim()
    return {
      platform: 'slack',
      chatId: channel,
      chatType: channel.startsWith('D') ? 'dm' : 'group',
      chatTitle: channel,
      userId: m.user,
      userName: await this.userName(m.user),
      text,
      msgId: m.ts,
      threadTs: m.thread_ts ?? (inThread ? undefined : undefined),
      addressed,
      ts: Math.round(Number(m.ts) * 1000),
    }
  }

  displayName(id: string): Promise<string> {
    return this.userName(id)
  }

  private async userName(id: string): Promise<string> {
    const cached = this.users.get(id)
    if (cached) return cached
    try {
      const r = await swyExec<{ user?: { real_name?: string; name?: string; profile?: { display_name?: string } } }>(S.user, { params: { user: id } })
      const u = r.data.user
      const name = u?.profile?.display_name || u?.real_name || u?.name || id
      this.users.set(id, name)
      return name
    } catch {
      return id
    }
  }

  async send(chatId: string, text: string, opts: SendOptions = {}): Promise<SendResult> {
    const thread = opts.threadTs ?? opts.replyToId
    const key = opts.key ?? outboxKey('slack', chatId, thread, text)
    const res = await withOutbox({ platform: 'slack', chatId, replyTo: thread, text }, async () => {
      const r = await swyExec<{ ts?: string }>(
        S.post,
        { body: { channel: chatId, text: formatFor('slack', text), unfurl_links: false, unfurl_media: false, ...(thread ? { thread_ts: thread } : {}) } },
        { runId: opts.runId },
      )
      return { providerMsgId: r.data.ts }
    }, key)
    if (res.status === 'skipped') return { duplicate: true }
    return { msgId: res.providerMsgId, duplicate: res.duplicate }
  }

  async edit(chatId: string, msgId: string, text: string): Promise<void> {
    await swyExec(S.update, { body: { channel: chatId, ts: msgId, text: formatFor('slack', text) } })
  }

  async typing(): Promise<void> {
    /* Slack bots have no typing indicator; we react 👀 on the question instead (ack). */
  }

  async ack(chatId: string, msgId: string, emoji = 'eyes'): Promise<void> {
    await swyExec(S.react, { body: { channel: chatId, timestamp: msgId, name: emoji } }).catch(() => {})
  }

  /** Post without the outbox (persona lines, cards whose idempotency the caller owns). */
  async postRaw(body: Record<string, unknown>, runId?: string): Promise<string | undefined> {
    const r = await swyExec<{ ts?: string }>(S.post, { body: { unfurl_links: false, unfurl_media: false, ...body } }, { runId })
    return r.data.ts
  }

  /** Reactions on a message: emoji name → user ids (bot excluded). */
  async reactions(channel: string, ts: string): Promise<Record<string, string[]>> {
    const r = await swyExec<{ message?: { reactions?: Array<{ name: string; users?: string[] }> } }>(S.reactions, {
      params: { channel, timestamp: ts, full: true },
    })
    const out: Record<string, string[]> = {}
    for (const x of r.data.message?.reactions ?? []) out[x.name] = (x.users ?? []).filter((u) => u !== this.botUserId)
    return out
  }

  async channelMembers(channel: string): Promise<string[]> {
    const r = await swyExec<{ members?: string[] }>(S.members, { params: { channel, limit: 500 } })
    return r.data.members ?? []
  }
}

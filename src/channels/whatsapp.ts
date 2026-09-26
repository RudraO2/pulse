import { existsSync, mkdirSync, rmSync } from 'node:fs'
import path from 'node:path'
import makeWASocket, {
  DisconnectReason,
  fetchLatestBaileysVersion,
  getContentType,
  jidNormalizedUser,
  makeCacheableSignalKeyStore,
  useMultiFileAuthState,
  type GroupMetadata,
  type WAMessage,
  type WASocket,
} from 'baileys'
import QRCode from 'qrcode'
import { bus } from '../bus.js'
import { env } from '../config/env.js'
import { formatFor } from '../agent/format.js'
import type { InboundMessage, WhatsAppGroup, WhatsAppState } from '../shared/events.js'
import { kvGetJson, kvSetJson, setMember } from '../store/repo.js'
import { outboxKey, withOutbox } from '../store/outbox.js'
import { containsSecret } from '../swy/redact.js'
import type { ChannelAdapter, SendOptions, SendResult } from './types.js'

// WhatsApp through a linked device (Baileys), patterns from the WhatsApp bot
// (RudraO2/Whatsapp-automation): QR link, lid ↔ phone-number aliasing, offline
// backlog drain, echo-proof sends. Pulse speaks from the linked number, so:
//   • it only listens in groups the organizer turned on (off by default),
//   • DMs are read only from members of those groups (never personal chats),
//   • the organizer's own messages are never treated as member messages.

const AUTH_DIR = path.resolve('data', 'whatsapp-auth')
const BACKLOG_SAFETY_MS = 15_000
const MAX_RECONNECT = 6

const silent = {
  level: 'silent',
  trace: () => {},
  debug: () => {},
  info: () => {},
  warn: () => {},
  error: () => {},
  fatal: () => {},
  child: () => silent,
} as never

export interface WhatsAppHooks {
  onMessage(msg: InboundMessage): void
  beginBacklog(): void
  endBacklog(): Promise<void>
}

const trackable = (jid?: string | null): jid is string =>
  !!jid && (jid.endsWith('@g.us') || jid.endsWith('@s.whatsapp.net') || jid.endsWith('@lid'))

const isGroup = (jid: string) => jid.endsWith('@g.us')

function textOf(msg: WAMessage): string | undefined {
  const m = msg.message
  if (!m) return undefined
  const type = getContentType(m)
  if (type === 'conversation') return m.conversation ?? undefined
  if (type === 'extendedTextMessage') return m.extendedTextMessage?.text ?? undefined
  if (type === 'imageMessage') return m.imageMessage?.caption ?? undefined
  if (type === 'videoMessage') return m.videoMessage?.caption ?? undefined
  return undefined
}

function contextOf(msg: WAMessage) {
  const m = msg.message
  return m?.extendedTextMessage?.contextInfo ?? m?.imageMessage?.contextInfo ?? m?.videoMessage?.contextInfo ?? undefined
}

/** Prefer the phone-number form of a person; lid when that's all WhatsApp gives. */
function personId(primary: string, alt?: string | null): string {
  const a = jidNormalizedUser(primary)
  const b = alt ? jidNormalizedUser(alt) : undefined
  if (b && b.endsWith('@s.whatsapp.net')) return b
  return a
}

export class WhatsAppAdapter implements ChannelAdapter {
  readonly platform = 'whatsapp' as const
  private sock?: WASocket
  private st: WhatsAppState = { status: 'off', groups: [], dms: true }
  private readonly meta = new Map<string, { name: string; size: number; people: Set<string> }>()
  private enabled = new Set<string>(kvGetJson<string[]>('whatsapp.groups') ?? [])
  /** recent inbound messages, so replies can quote them */
  private readonly recent = new Map<string, WAMessage>()
  private reconnects = 0
  private stopped = false
  private draining = false
  private drainTimer?: ReturnType<typeof setTimeout>

  constructor(private readonly hooks: WhatsAppHooks) {
    this.st.dms = kvGetJson<boolean>('whatsapp.dms') ?? true
  }

  // ── state ───────────────────────────────────────────────────────────────

  state(): WhatsAppState {
    return structuredClone(this.st)
  }

  private emitTimer?: ReturnType<typeof setTimeout>
  private emit(patch: Partial<WhatsAppState> = {}): void {
    this.st = { ...this.st, ...patch, groups: this.groupList() }
    if (this.emitTimer) return
    this.emitTimer = setTimeout(() => {
      this.emitTimer = undefined
      bus.emit({ type: 'whatsapp', state: this.state() })
    }, 150)
  }

  private status(state: 'up' | 'degraded' | 'down' | 'disabled', detail: string): void {
    bus.emit({ type: 'status', service: 'whatsapp', status: { state, detail, at: Date.now() } })
  }

  private groupList(): WhatsAppGroup[] {
    return [...this.meta.entries()]
      .map(([jid, g]) => ({ jid, name: g.name, size: g.size, enabled: this.enabled.has(jid) }))
      .sort((a, b) => Number(b.enabled) - Number(a.enabled) || a.name.localeCompare(b.name))
  }

  enabledGroups(): WhatsAppGroup[] {
    return this.groupList().filter((g) => g.enabled)
  }

  groupName(jid: string): string | undefined {
    return this.meta.get(jid)?.name
  }

  setGroup(jid: string, on: boolean): WhatsAppState {
    if (!isGroup(jid)) return this.state()
    if (on) this.enabled.add(jid)
    else this.enabled.delete(jid)
    kvSetJson('whatsapp.groups', [...this.enabled])
    const name = this.meta.get(jid)?.name ?? jid
    bus.emit({ type: 'log', level: 'info', text: `WhatsApp: Pulse ${on ? 'is on in' : 'left'} "${name}"` })
    this.emit()
    this.st.groups = this.groupList()
    return this.state()
  }

  setDms(on: boolean): WhatsAppState {
    kvSetJson('whatsapp.dms', on)
    this.emit({ dms: on })
    this.st.dms = on
    return this.state()
  }

  // ── lifecycle ───────────────────────────────────────────────────────────

  /** Reconnects automatically if this laptop was linked before; otherwise waits for link(). */
  async start(): Promise<void> {
    if (existsSync(path.join(AUTH_DIR, 'creds.json'))) await this.connect()
    else {
      this.emit({ status: 'off' })
      this.status('disabled', 'not linked: scan the QR in the dashboard')
    }
  }

  /** Start pairing: a QR appears in the dashboard. */
  async link(): Promise<WhatsAppState> {
    if (this.sock && (this.st.status === 'connected' || this.st.status === 'qr' || this.st.status === 'connecting')) return this.state()
    this.stopped = false
    this.reconnects = 0
    await this.connect()
    return this.state()
  }

  async logout(): Promise<WhatsAppState> {
    this.stopped = true
    try {
      await this.sock?.logout()
    } catch {
      /* already gone */
    }
    this.sock = undefined
    rmSync(AUTH_DIR, { recursive: true, force: true })
    this.meta.clear()
    this.emit({ status: 'off', qr: undefined, me: undefined })
    this.status('disabled', 'unlinked')
    return this.state()
  }

  async stop(): Promise<void> {
    this.stopped = true
    this.sock?.end(undefined)
    this.sock = undefined
  }

  private async connect(): Promise<void> {
    mkdirSync(AUTH_DIR, { recursive: true })
    this.emit({ status: 'connecting', qr: undefined })
    const { state, saveCreds } = await useMultiFileAuthState(AUTH_DIR)
    const version = await fetchLatestBaileysVersion()
      .then((v) => v.version)
      .catch(() => undefined)
    const sock = makeWASocket({
      auth: { creds: state.creds, keys: makeCacheableSignalKeyStore(state.keys, silent) },
      ...(version ? { version } : {}),
      logger: silent,
      // Keep the organizer's phone getting notifications as usual.
      markOnlineOnConnect: false,
      syncFullHistory: false,
      getMessage: async () => undefined,
    })
    this.sock = sock
    sock.ev.on('creds.update', saveCreds)

    sock.ev.on('connection.update', (u) => {
      if (sock !== this.sock) return
      if (u.qr) {
        void QRCode.toDataURL(u.qr, { margin: 1, width: 300 })
          .then((qr) => this.emit({ status: 'qr', qr }))
          .catch(() => {})
        this.status('degraded', 'waiting for the QR to be scanned')
      }
      if (u.connection === 'open') {
        this.reconnects = 0
        const me = sock.user
        const number = me?.id ? jidNormalizedUser(me.id).split('@')[0] : undefined
        this.emit({ status: 'connected', qr: undefined, me: { name: me?.name ?? me?.notify, number } })
        this.status('up', `${me?.name ?? 'linked'}${number ? ` · +${number}` : ''} · ${this.enabled.size} group(s) on`)
        this.beginDrain()
        void this.refreshGroups()
      }
      if (u.receivedPendingNotifications) void this.endDrain()
      if (u.connection === 'close') this.onClose(u.lastDisconnect?.error as { output?: { statusCode?: number } } | undefined, !!state.creds.registered)
    })

    sock.ev.on('messages.upsert', ({ messages, type }) => {
      if (sock !== this.sock) return
      // Only 'notify' is a new message; 'append' is history sync on reconnect.
      if (type !== 'notify') return
      for (const m of messages) {
        try {
          this.handle(m)
        } catch (e) {
          bus.emit({ type: 'log', level: 'warn', text: `WhatsApp message skipped: ${(e as Error).message}` })
        }
      }
    })

    sock.ev.on('groups.upsert', (groups) => groups.forEach((g) => this.remember(g)))
    sock.ev.on('groups.update', (groups) => {
      for (const g of groups) {
        const known = g.id ? this.meta.get(g.id) : undefined
        if (known && g.subject) {
          known.name = g.subject
          this.emit()
        }
      }
    })
    sock.ev.on('group-participants.update', (u) => this.onParticipants(u))
  }

  private onClose(err: { output?: { statusCode?: number } } | undefined, registered: boolean): void {
    const code = err?.output?.statusCode
    this.sock = undefined
    if (this.stopped) return
    if (code === DisconnectReason.loggedOut) {
      rmSync(AUTH_DIR, { recursive: true, force: true })
      this.meta.clear()
      this.emit({ status: 'logged_out', qr: undefined, me: undefined })
      this.status('down', 'logged out from the phone: link again')
      return
    }
    if (code === DisconnectReason.connectionReplaced) {
      this.emit({ status: 'off', qr: undefined })
      this.status('down', 'another Pulse (or WhatsApp Web session) took over this link')
      return
    }
    // QR shown but nobody scanned it: stop until the organizer asks again.
    if (!registered && code !== DisconnectReason.restartRequired) {
      this.emit({ status: 'off', qr: undefined })
      this.status('disabled', 'QR expired: click Link WhatsApp to try again')
      return
    }
    this.reconnects++
    if (this.reconnects > MAX_RECONNECT) {
      this.emit({ status: 'off' })
      this.status('down', `disconnected (${code ?? 'unknown'}), gave up after ${MAX_RECONNECT} tries`)
      return
    }
    const delay = code === DisconnectReason.restartRequired ? 500 : Math.min(3000 * this.reconnects, 30_000)
    this.emit({ status: 'connecting' })
    this.status('degraded', `reconnecting (${code ?? 'network'})`)
    setTimeout(() => void this.connect().catch((e) => this.status('down', String((e as Error).message).slice(0, 120))), delay).unref?.()
  }

  // ── backlog: queued offline messages collapse into one reply per chat ─────

  private beginDrain(): void {
    if (this.draining) return
    this.draining = true
    this.hooks.beginBacklog()
    this.drainTimer = setTimeout(() => void this.endDrain(), BACKLOG_SAFETY_MS)
    this.drainTimer.unref?.()
  }

  private async endDrain(): Promise<void> {
    if (!this.draining) return
    this.draining = false
    if (this.drainTimer) clearTimeout(this.drainTimer)
    await this.hooks.endBacklog()
  }

  // ── groups & members ────────────────────────────────────────────────────

  private remember(g: GroupMetadata): void {
    const people = new Set<string>()
    for (const p of g.participants ?? []) {
      for (const id of [p.id, p.phoneNumber, p.lid]) if (id) people.add(jidNormalizedUser(id))
    }
    this.meta.set(g.id, { name: g.subject || g.id, size: g.participants?.length ?? g.size ?? 0, people })
    this.emit()
  }

  async refreshGroups(): Promise<WhatsAppState> {
    if (!this.sock) return this.state()
    try {
      const all = await this.sock.groupFetchAllParticipating()
      this.meta.clear()
      for (const g of Object.values(all)) this.remember(g)
      // Groups the linked number left can't stay on.
      for (const jid of [...this.enabled]) if (!this.meta.has(jid)) this.enabled.delete(jid)
      kvSetJson('whatsapp.groups', [...this.enabled])
      this.emit()
    } catch (e) {
      bus.emit({ type: 'log', level: 'warn', text: `WhatsApp: could not list groups (${(e as Error).message})` })
    }
    return this.state()
  }

  /** Is this person in a group Pulse is on in? (DMs are only read from them.) */
  private isMember(...ids: Array<string | null | undefined>): boolean {
    const keys = ids.filter((x): x is string => !!x).map((x) => jidNormalizedUser(x))
    for (const jid of this.enabled) {
      const g = this.meta.get(jid)
      if (g && keys.some((k) => g.people.has(k))) return true
    }
    return false
  }

  private myIds(): string[] {
    const u = this.sock?.user
    return [u?.id, u?.lid].filter((x): x is string => !!x).map((x) => jidNormalizedUser(x))
  }

  private onParticipants(u: { id: string; participants: Array<{ id: string; phoneNumber?: string; lid?: string; notify?: string; name?: string }>; action: string }): void {
    const g = this.meta.get(u.id)
    if (!g) return void this.refreshGroups()
    const mine = new Set(this.myIds())
    for (const p of u.participants) {
      const ids = [p.id, p.phoneNumber, p.lid].filter((x): x is string => !!x).map((x) => jidNormalizedUser(x))
      if (u.action === 'add') ids.forEach((id) => g.people.add(id))
      if (u.action === 'remove') ids.forEach((id) => g.people.delete(id))
      const userId = personId(p.id, p.phoneNumber)
      setMember('whatsapp', userId, u.id, u.action !== 'remove')
      if (u.action !== 'add' || !this.enabled.has(u.id) || ids.some((id) => mine.has(id))) continue
      const name = p.notify || p.name || `+${userId.split('@')[0]}`
      this.hooks.onMessage({
        platform: 'whatsapp',
        chatId: u.id,
        chatType: 'group',
        chatTitle: g.name,
        userId,
        userName: name,
        text: `${name} joined the group`,
        msgId: `join_${Date.now()}_${userId}`,
        addressed: false,
        joined: true,
        ts: Date.now(),
      })
    }
    if (u.action === 'add') g.size += u.participants.length
    if (u.action === 'remove') g.size = Math.max(0, g.size - u.participants.length)
    this.emit()
  }

  // ── inbound ─────────────────────────────────────────────────────────────

  private handle(msg: WAMessage): void {
    const chatId = msg.key.remoteJid
    if (!trackable(chatId) || !msg.message) return
    // The linked number is the organizer's: their own messages (and Pulse's echoes) aren't member messages.
    if (msg.key.fromMe) return
    const raw = textOf(msg)
    if (!raw?.trim()) return

    const group = isGroup(chatId)
    const sender = group ? msg.key.participant : chatId
    if (!sender) return
    const senderAlt = group ? msg.key.participantAlt : msg.key.remoteJidAlt
    if (group) {
      if (!this.enabled.has(chatId)) return
    } else {
      // Never read personal chats: only members of a group Pulse is on in.
      if (!this.st.dms || !this.isMember(sender, senderAlt)) return
    }

    const userId = personId(sender, senderAlt)
    const userName = msg.pushName?.trim() || `+${userId.split('@')[0]}`
    const ctx = contextOf(msg)
    const mine = this.myIds()
    const mentioned = (ctx?.mentionedJid ?? []).some((j) => mine.includes(jidNormalizedUser(j)))
    const repliedToMe = !!ctx?.participant && mine.includes(jidNormalizedUser(ctx.participant))
    const called = /^\s*(@?pulse\b[,:]?|\/ask\b)/i.test(raw)
    const addressed = !group || mentioned || repliedToMe || called

    // Strip "@<number>" mentions of the linked account and a leading "pulse,".
    let text = raw
    for (const id of mine) text = text.replace(new RegExp(`@${id.split('@')[0]}\\b`, 'g'), '')
    text = text.replace(/^\s*(@?pulse\b[,:]?|\/ask\b)\s*/i, '').trim() || raw.trim()

    const msgId = msg.key.id ?? `wa_${Date.now()}`
    this.recent.set(`${chatId}:${msgId}`, msg)
    if (this.recent.size > 500) this.recent.delete(this.recent.keys().next().value!)
    if (group) setMember('whatsapp', userId, chatId, true)

    this.hooks.onMessage({
      platform: 'whatsapp',
      chatId,
      chatType: group ? 'group' : 'dm',
      chatTitle: group ? this.meta.get(chatId)?.name : userName,
      userId,
      userName,
      text,
      msgId,
      replyToId: ctx?.stanzaId ?? undefined,
      addressed,
      ts: Number(msg.messageTimestamp ?? 0) * 1000 || Date.now(),
    })
  }

  // ── outbound ────────────────────────────────────────────────────────────

  async send(chatId: string, text: string, opts: SendOptions = {}): Promise<SendResult> {
    const body = `${env.WHATSAPP_PREFIX}${formatFor('whatsapp', text)}`
    // Same secret patterns Pulse redacts everywhere else: never post a token.
    if (containsSecret(body)) throw new Error('blocked: the message contains a secret-like token')
    if (isGroup(chatId) && !this.enabled.has(chatId)) throw new Error('Pulse is off in this WhatsApp group')
    const key = opts.key ?? outboxKey('whatsapp', chatId, opts.replyToId, text)
    const res = await withOutbox({ platform: 'whatsapp', chatId, replyTo: opts.replyToId, text }, async () => {
      const sock = this.sock
      if (!sock || this.st.status !== 'connected') throw new Error('WhatsApp is not connected')
      const quoted = opts.replyToId ? this.recent.get(`${chatId}:${opts.replyToId}`) : undefined
      const sent = await sock.sendMessage(chatId, { text: body }, quoted ? { quoted } : undefined)
      return { providerMsgId: sent?.key.id ?? 'sent' }
    }, key)
    if (res.status === 'skipped') return { duplicate: true }
    return { msgId: res.providerMsgId, duplicate: res.duplicate }
  }

  async edit(chatId: string, msgId: string, text: string): Promise<void> {
    if (!this.sock) return
    await this.sock.sendMessage(chatId, { text: `${env.WHATSAPP_PREFIX}${formatFor('whatsapp', text)}`, edit: { remoteJid: chatId, id: msgId, fromMe: true } })
  }

  async typing(chatId: string): Promise<void> {
    await this.sock?.sendPresenceUpdate('composing', chatId).catch(() => {})
  }
}

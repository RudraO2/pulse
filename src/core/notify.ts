import { createHash, createHmac, randomBytes, timingSafeEqual } from 'node:crypto'
import webpush from 'web-push'
import { bus } from '../bus.js'
import { env, hasResend } from '../config/env.js'
import type { Approval, AttentionItem, MemberCase, NotifyState, PendingQuestion } from '../shared/events.js'
import { getDoc, kvGet, kvGetJson, kvSet, kvSetJson, listDocs, putDoc } from '../store/repo.js'
import { swyExec } from '../swy/exec.js'
import { reportBlock } from './channels.js'

// "Needs you": everything that waits on the organizer reaches their phone.
//   • push: instantly, per item, with Approve/Reject (or Resolve) right on the
//     notification (signed per item, so the service worker needs no password)
//   • email via Swytchcode → Resend: urgent items (an upset member, someone
//     asking for a person) go out within seconds; the rest are bundled.
// Items handled before the bundle goes out are dropped from it.
// Driven by the bus, so no caller has to remember to notify.

export interface NeedsYou {
  /** approval / attention / pending id: also the deep link target */
  id: string
  kind: 'approval' | 'member' | 'question'
  title: string
  body: string
  urgent: boolean
  simulated?: boolean
  at: number
}

interface PushSub {
  id: string
  status: 'active'
  sub: webpush.PushSubscription
  ua?: string
  createdAt: number
}

const URGENT_DELAY_MS = 5_000
const queue = new Map<string, NeedsYou>()
const seen = new Set<string>()
let flushTimer: ReturnType<typeof setTimeout> | undefined
let flushAt = 0
let bundleTimer: ReturnType<typeof setInterval> | undefined
let unsubscribe: (() => void) | undefined
let state: NotifyState = { email: false, devices: 0, queued: 0, tunnel: 'off' }
/** tests: capture instead of sending */
let sink: ((ch: 'email' | 'push', payload: unknown) => void) | undefined

export const notifyState = (): NotifyState => state

function publish(patch: Partial<NotifyState> = {}, sent?: { channel: 'email' | 'push'; ok: boolean; detail: string }): void {
  state = { ...state, ...patch, queued: queue.size, devices: devices().length }
  bus.emit({ type: 'notify', state, ...(sent ? { sent } : {}) })
}

export function setPublicUrl(url: string | undefined, tunnel: NotifyState['tunnel']): void {
  publish({ publicUrl: url, tunnel })
}

export function baseUrl(): string {
  return (state.publicUrl ?? env.PUBLIC_URL ?? `http://localhost:${env.PORT}`).replace(/\/$/, '')
}

export const itemUrl = (id: string): string => `${baseUrl()}/m/#/i/${encodeURIComponent(id)}`

// ── signed quick actions (push notification buttons) ───────────────────────

function secret(): string {
  let s = kvGet('notify.secret')
  if (!s) {
    s = randomBytes(24).toString('base64url')
    kvSet('notify.secret', s)
  }
  return s
}

export const signItem = (id: string): string => createHmac('sha256', secret()).update(`needs-you:${id}`).digest('base64url').slice(0, 32)

export function verifyItem(id: string, sig: string): boolean {
  const want = Buffer.from(signItem(id))
  const got = Buffer.from(String(sig))
  return want.length === got.length && timingSafeEqual(want, got)
}

// ── admin token for the phone (generated once when not configured) ─────────

export function adminToken(): string | undefined {
  if (env.ADMIN_TOKEN) return env.ADMIN_TOKEN
  return kvGet('admin.token')
}

/** Make sure a token exists before anything is reachable from outside the laptop. */
export function ensureAdminToken(): string {
  const t = adminToken()
  if (t) return t
  const fresh = randomBytes(18).toString('base64url')
  kvSet('admin.token', fresh)
  return fresh
}

// ── web push ───────────────────────────────────────────────────────────────

function vapid(): { publicKey: string; privateKey: string } {
  let keys = kvGetJson<{ publicKey: string; privateKey: string }>('push.vapid')
  if (!keys) {
    keys = webpush.generateVAPIDKeys()
    kvSetJson('push.vapid', keys)
  }
  return keys
}

export const vapidPublicKey = (): string => vapid().publicKey

const devices = (): PushSub[] => {
  try {
    return listDocs<PushSub>('push', { status: 'active' })
  } catch {
    return []
  }
}

export function addDevice(sub: webpush.PushSubscription, ua?: string): { devices: number } {
  if (!sub?.endpoint || !sub.keys?.p256dh || !sub.keys?.auth) throw new Error('invalid subscription')
  const id = createHash('sha256').update(sub.endpoint).digest('hex').slice(0, 24)
  putDoc<PushSub>('push', { id, status: 'active', sub, ua: ua?.slice(0, 160), createdAt: getDoc<PushSub>('push', id)?.createdAt ?? Date.now() })
  publish()
  return { devices: devices().length }
}

export function removeDevice(endpoint: string): void {
  const id = createHash('sha256').update(endpoint).digest('hex').slice(0, 24)
  const d = getDoc<PushSub>('push', id)
  if (d) putDoc('push', { ...d, status: 'removed' })
  publish()
}

export async function pushToDevices(item: NeedsYou): Promise<number> {
  const list = devices()
  if (!list.length) return 0
  const payload = {
    title: item.title,
    body: item.body.slice(0, 180),
    tag: item.id,
    url: `/m/#/i/${encodeURIComponent(item.id)}`,
    id: item.id,
    kind: item.kind,
    sig: signItem(item.id),
    urgent: item.urgent,
  }
  if (sink) {
    sink('push', payload)
    return list.length
  }
  const keys = vapid()
  let ok = 0
  await Promise.all(
    list.map(async (d) => {
      try {
        await webpush.sendNotification(d.sub, JSON.stringify(payload), {
          vapidDetails: { subject: `mailto:${env.DIGEST_TO ?? 'pulse@example.com'}`, publicKey: keys.publicKey, privateKey: keys.privateKey },
          TTL: 6 * 3600,
          urgency: item.urgent ? 'high' : 'normal',
          topic: item.id.replace(/[^A-Za-z0-9_-]/g, '').slice(0, 32),
        })
        ok++
      } catch (e) {
        const code = (e as { statusCode?: number }).statusCode
        if (code === 404 || code === 410) putDoc('push', { ...d, status: 'removed' })
        else bus.emit({ type: 'log', level: 'warn', text: `push failed (${code ?? 'network'}): ${String((e as Error).message).slice(0, 100)}` })
      }
    }),
  )
  publish({}, { channel: 'push', ok: ok > 0, detail: `${item.title} → ${ok}/${list.length} phone${list.length === 1 ? '' : 's'}` })
  return ok
}

// ── email (Swytchcode → Resend) ────────────────────────────────────────────

const esc = (t: string) => t.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
const plain = (md: string) => md.replace(/\*\*([^*]+)\*\*/g, '$1').replace(/_([^_]+)_/g, '$1').replace(/`([^`]+)`/g, '$1').replace(/\[([^\]]+)\]\([^)]+\)/g, '$1')
const CTA: Record<NeedsYou['kind'], string> = { approval: 'Review & approve', member: 'Open', question: 'Answer' }
const LABEL: Record<NeedsYou['kind'], string> = { approval: 'Approval', member: 'Member', question: 'Question' }

export function renderEmail(items: NeedsYou[]): { subject: string; html: string } {
  const demo = items.every((i) => i.simulated) ? ' [demo]' : ''
  const subject = items.length === 1 ? `${items[0]!.title}${demo}` : `${items.length} things need you${items.some((i) => i.urgent) ? ` · ${items.find((i) => i.urgent)!.title}` : ''}${demo}`
  const rows = items
    .map(
      (i) => `<tr><td style="padding:14px 16px;border:1px solid ${i.urgent ? '#f3c6c1' : '#e2e5ea'};border-radius:12px;background:${i.urgent ? '#fdf5f4' : '#ffffff'}">
  <div style="font-size:11px;letter-spacing:.06em;text-transform:uppercase;color:${i.urgent ? '#c9372c' : '#687080'};margin-bottom:4px">${i.urgent ? 'Urgent · ' : ''}${LABEL[i.kind]}${i.simulated ? ' · demo' : ''}</div>
  <div style="font-size:15px;font-weight:600;color:#12151b;margin-bottom:4px">${esc(i.title)}</div>
  <div style="font-size:13.5px;color:#414856;line-height:1.5;margin-bottom:12px">${esc(plain(i.body)).replace(/\n/g, '<br/>')}</div>
  <a href="${itemUrl(i.id)}" style="display:inline-block;background:#2d5bff;color:#ffffff;text-decoration:none;font-size:13px;font-weight:600;padding:8px 14px;border-radius:8px">${CTA[i.kind]}</a>
</td></tr><tr><td style="height:10px"></td></tr>`,
    )
    .join('\n')
  const html = `<div style="font-family:Geist,Inter,Segoe UI,Helvetica,sans-serif;max-width:560px;margin:0 auto;color:#12151b">
  <p style="font-size:13px;color:#687080;margin:0 0 14px"><strong style="color:#12151b">Pulse</strong> · ${esc(env.COMMUNITY_NAME)}</p>
  <table role="presentation" style="width:100%;border-collapse:separate">${rows}</table>
  <p style="font-size:12px;color:#8a919d;margin-top:14px">Buttons open the Pulse app on your phone; nothing runs until you tap Approve there. Sent via Swytchcode → Resend.</p>
</div>`
  return { subject, html }
}

export async function flushEmail(): Promise<{ ok: boolean; detail: string; items: number }> {
  if (flushTimer) clearTimeout(flushTimer)
  flushTimer = undefined
  flushAt = 0
  const items = [...queue.values()].sort((a, b) => Number(b.urgent) - Number(a.urgent) || a.at - b.at)
  queue.clear()
  if (!items.length) return { ok: true, detail: 'nothing queued', items: 0 }
  if (!state.email) {
    publish()
    return { ok: false, detail: 'email not configured', items: items.length }
  }
  const { subject, html } = renderEmail(items)
  const key = `needs-you-${createHash('sha256').update(items.map((i) => i.id).join(',')).digest('hex').slice(0, 20)}`
  let result: { ok: boolean; detail: string }
  if (sink) {
    sink('email', { to: env.DIGEST_TO, subject, html, items: items.map((i) => i.id) })
    result = { ok: true, detail: `${subject} (test)` }
  } else {
    try {
      const r = await swyExec<{ id?: string }>('resend.email.create', { body: { from: env.DIGEST_FROM, to: env.DIGEST_TO, subject, html }, headers: { 'Idempotency-Key': key } })
      result = { ok: true, detail: `${subject} → ${env.DIGEST_TO} (${r.data?.id ?? 'sent'})` }
    } catch (e) {
      const blocked = reportBlock(e, {})
      result = { ok: false, detail: blocked ? `blocked by ${blocked.policyId}` : String((e as Error).message).slice(0, 160) }
    }
  }
  publish(result.ok ? { lastEmailAt: Date.now() } : {}, { channel: 'email', ...result })
  return { ...result, items: items.length }
}

function scheduleFlush(inMs: number): void {
  const at = Date.now() + inMs
  if (flushTimer && flushAt <= at) return
  if (flushTimer) clearTimeout(flushTimer)
  flushAt = at
  flushTimer = setTimeout(() => void flushEmail().catch(() => undefined), inMs)
  flushTimer.unref?.()
}

// ── the "needs you" stream ─────────────────────────────────────────────────

export function needsYou(item: NeedsYou): void {
  if (seen.has(item.id)) return
  seen.add(item.id)
  if (item.simulated && !env.NOTIFY_SCRIPTED) return
  void pushToDevices(item).catch(() => undefined)
  if (!state.email) return
  queue.set(item.id, item)
  // Urgent: go out in a few seconds (a burst of escalations still lands in one email).
  if (item.urgent) scheduleFlush(URGENT_DELAY_MS)
  publish()
}

/** Handled before the bundle went out: don't email it. */
export function handled(id: string): void {
  if (queue.delete(id)) publish()
}

const firstName = (n: string) => n.split(/\s+/)[0] ?? n

export function fromApproval(a: Approval): NeedsYou {
  return { id: a.id, kind: 'approval', title: `Approve: ${a.title}`, body: a.summary, urgent: false, simulated: a.simulated, at: a.createdAt }
}

export function fromAttention(a: AttentionItem, c?: MemberCase): NeedsYou {
  const trend = c ? c.points.filter((p) => p.by === 'member').slice(-4).map((p) => p.score.toFixed(1)).join(' → ') : ''
  return {
    id: a.id,
    kind: 'member',
    title: `${firstName(a.userName)} needs a human`,
    body: `“${a.text.slice(0, 200)}”\n${a.reason}${c ? ` · problem: ${c.topic}${trend ? ` · mood ${trend}` : ''}` : ''}`,
    // Upset or asking for a person can't wait for a bundle.
    urgent: a.kind !== 'ignored',
    simulated: a.simulated,
    at: a.ts,
  }
}

export function fromPending(p: PendingQuestion): NeedsYou {
  return { id: p.id, kind: 'question', title: `${firstName(p.userName)} asked something Pulse doesn't know`, body: `“${p.question.slice(0, 240)}”\nYour answer is sent to ${firstName(p.userName)} and saved to the knowledge base.`, urgent: false, simulated: p.simulated, at: p.askedAt }
}

export function startNotifier(opts: { bundleMs?: number; caseOf?: (id?: string) => MemberCase | undefined } = {}): void {
  if (unsubscribe) return
  state = { ...state, email: env.NOTIFY_EMAIL && hasResend(), emailTo: env.DIGEST_TO, devices: devices().length }
  unsubscribe = bus.on((ev) => {
    if (ev.type === 'approval') {
      // Approvals the organizer just asked for in the Console: they're looking at them already.
      if (ev.approval.status === 'pending' && !ev.approval.requestedBy.startsWith('Organizer')) needsYou(fromApproval(ev.approval))
      else handled(ev.approval.id)
    } else if (ev.type === 'attention') {
      if (ev.item.status === 'open') needsYou(fromAttention(ev.item, opts.caseOf?.(ev.item.caseId)))
      else handled(ev.item.id)
    } else if (ev.type === 'pending') {
      if (ev.item.status === 'waiting') needsYou(fromPending(ev.item))
      else handled(ev.item.id)
    }
  })
  bundleTimer = setInterval(() => {
    if (queue.size) void flushEmail().catch(() => undefined)
  }, opts.bundleMs ?? env.NOTIFY_BUNDLE_MIN * 60_000)
  bundleTimer.unref?.()
  publish()
}

export function stopNotifier(): void {
  unsubscribe?.()
  unsubscribe = undefined
  if (bundleTimer) clearInterval(bundleTimer)
  if (flushTimer) clearTimeout(flushTimer)
  bundleTimer = flushTimer = undefined
  queue.clear()
  seen.clear()
}

/** Tests only. */
export function setNotifySinkForTest(fn: typeof sink): void {
  sink = fn
}

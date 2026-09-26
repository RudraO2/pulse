import { randomUUID } from 'node:crypto'
import { bus } from '../bus.js'
import { env } from '../config/env.js'
import { formatFor } from '../agent/format.js'
import { addKnowledge, updateKnowledge } from '../kb/knowledge.js'
import type { NewEntry } from '../kb/notion.js'
import type { Approval, ApprovalAction, ApprovalKind, Platform, SwyHold } from '../shared/events.js'
import { getDoc, listDocs, putDoc } from '../store/repo.js'
import { withOutbox } from '../store/outbox.js'
import { swyAuditPolicy, swyExec, SwyError } from '../swy/exec.js'
import { containsSecret, redactDeep } from '../swy/redact.js'
import { channels, post, reportBlock } from './channels.js'
import { modsAvailable, modsChannel, postModsCard } from './mods.js'

// Human approval for anything broadcast-shaped, in two layers:
//   1. Pulse's own loop: dry-run every action through Swytchcode (exact HTTP
//      request, policies enforced) → approval card on the dashboard + in Slack
//      #mods → ✅ reaction or dashboard click → execute once (outbox-keyed).
//   2. Swytchcode's REQUIRES_APPROVAL (Business plan, SWYTCHCODE_HITL=true):
//      pins are held by Swytchcode itself until a mod clicks Approve in Slack,
//      then Swytchcode runs them. Pulse only watches `swy audit policy`.

export const TOOL = {
  tgSend: 'telegram_v5_0.sendmessage.create',
  tgPin: 'telegram_v5_0.pinchatmessage.create',
  tgPoll: 'telegram_v5_0.sendpoll.create',
  slackPost: 'slack.chat.postmessage.create',
  slackPin: 'slack.pins.add.create',
  notionCreate: 'notion.page.create',
  notionUpdate: 'notion.page.update',
  email: 'resend.email.create',
  /** not a Swytchcode tool: the linked WhatsApp device sends it */
  waSend: 'whatsapp.send',
} as const

// ── action builders (args exactly as they will be sent) ────────────────────

export function postAction(platform: Platform, chatId: string, text: string, label: string, opts: { pin?: boolean; threadTs?: string } = {}): ApprovalAction {
  if (platform === 'whatsapp') {
    const where = channels.whatsapp?.groupName(chatId) ?? chatId
    return {
      tool: TOOL.waSend,
      label,
      args: { to: chatId, text: formatFor('whatsapp', text) },
      preview: { method: 'SEND', url: `WhatsApp · ${where}`, body: { text: `${env.WHATSAPP_PREFIX}${formatFor('whatsapp', text)}` } },
      ...(containsSecret(text) ? { blocked: 'secret: the message contains a secret-like token' } : {}),
      meta: { platform, chatId, text },
    }
  }
  if (platform === 'telegram') {
    return {
      tool: TOOL.tgSend,
      label,
      args: { body: { chat_id: chatId, text: formatFor('telegram', text), parse_mode: 'HTML', disable_web_page_preview: true } },
      pin: opts.pin,
      meta: { platform, chatId, text },
    }
  }
  return {
    tool: TOOL.slackPost,
    label,
    args: { body: { channel: chatId, text: formatFor('slack', text), unfurl_links: false, ...(opts.threadTs ? { thread_ts: opts.threadTs } : {}) } },
    pin: opts.pin,
    meta: { platform, chatId, text, threadTs: opts.threadTs },
  }
}

export function knowledgeAction(entry: NewEntry, label = 'Save to the Notion knowledge base'): ApprovalAction {
  return {
    tool: TOOL.notionCreate,
    label,
    args: {
      body: {
        parent: { type: 'data_source_id', data_source_id: '(knowledge base)' },
        properties: { Question: entry.question, Answer: entry.answer, Source: entry.source, Type: entry.type ?? 'FAQ' },
      },
    },
    meta: { entry },
  }
}

export function knowledgeUpdateAction(entryId: string, patch: Partial<NewEntry>, label = 'Update the Notion knowledge base entry'): ApprovalAction {
  return {
    tool: TOOL.notionUpdate,
    label,
    args: { params: { page_id: entryId }, body: { properties: { ...(patch.question ? { Question: patch.question } : {}), ...(patch.answer ? { Answer: patch.answer } : {}) } } },
    meta: { entryId, patch },
  }
}

export function emailAction(to: string[], subject: string, html: string, label = 'Send email via Resend'): ApprovalAction {
  return {
    tool: TOOL.email,
    label,
    // single recipient as a string so the email-recipients policy can check it exactly
    args: { body: { from: env.DIGEST_FROM, to: to.length === 1 ? to[0] : to, subject, html } },
  }
}

export function pollAction(chatId: string, question: string, options: string[], label = 'Create Telegram poll'): ApprovalAction {
  return { tool: TOOL.tgPoll, label, args: { body: { chat_id: chatId, question, options, is_anonymous: true } } }
}

// ── preview ────────────────────────────────────────────────────────────────

export async function previewAction(a: ApprovalAction, runId?: string): Promise<ApprovalAction> {
  // WhatsApp isn't a Swytchcode call: the preview is the message itself.
  if (a.tool === TOOL.waSend) return a
  // The Notion parent id is filled at execution time; preview the real shape.
  if (a.tool === TOOL.notionCreate) return { ...a, preview: { method: 'POST', url: 'https://api.notion.com/v1/pages', body: redactDeep((a.args as { body: unknown }).body) } }
  if (a.tool === TOOL.notionUpdate) {
    const id = (a.meta as { entryId?: string } | undefined)?.entryId ?? ''
    return { ...a, preview: { method: 'PATCH', url: `https://api.notion.com/v1/pages/${id}`, body: redactDeep((a.args as { body: unknown }).body) } }
  }
  try {
    const r = await swyExec(a.tool, a.args as Record<string, unknown>, { dryRun: true, runId })
    const req = r.request
    const hold = a.pin ? await previewPinHold(a, runId) : undefined
    return { ...a, preview: req ? (redactDeep({ method: req.method, url: req.url, body: req.body }) as ApprovalAction['preview']) : undefined, ...(hold ? { hold } : {}) }
  } catch (e) {
    const platform = a.tool.startsWith('telegram') ? 'telegram' : a.tool.startsWith('slack') ? 'slack' : undefined
    const blocked = reportBlock(e, { platform, runId })
    if (blocked) return { ...a, blocked: `${blocked.policyId ?? blocked.kind}: ${blocked.message}` }
    return { ...a, blocked: `dry-run failed: ${e instanceof SwyError ? e.message : String(e)}`.slice(0, 240) }
  }
}

function pinCall(platform: Platform, chatId: string, msgId: string): { tool: string; args: Record<string, unknown> } {
  return platform === 'telegram'
    ? { tool: TOOL.tgPin, args: { body: { chat_id: chatId, message_id: Number(msgId), disable_notification: true } } }
    : { tool: TOOL.slackPin, args: { body: { channel: chatId, timestamp: msgId } } }
}

/** Dry-run the pin: if Swytchcode says a mod must approve it, show that on the card before anything runs. */
async function previewPinHold(a: ApprovalAction, runId?: string): Promise<SwyHold | undefined> {
  const meta = (a.meta ?? {}) as { platform?: Platform; chatId?: string }
  if (!meta.platform || !meta.chatId) return undefined
  const { tool, args } = pinCall(meta.platform, meta.chatId, meta.platform === 'telegram' ? '1' : '1.000001')
  try {
    await swyExec(tool, args, { dryRun: true, runId })
    return undefined
  } catch (e) {
    return e instanceof SwyError && e.wouldNeedApproval ? { tool, status: 'required', message: 'A mod approves the pin in Slack (Swytchcode)' } : undefined
  }
}

// ── lifecycle ──────────────────────────────────────────────────────────────

type FollowUp = (a: Approval) => Promise<void> | void
const followUps = new Map<ApprovalKind, FollowUp>()
/** Register what happens after an approval of this kind executes (e.g. credit a helper). */
export function onApprovalExecuted(kind: ApprovalKind, fn: FollowUp): void {
  followUps.set(kind, fn)
}

function save(a: Approval): Approval {
  putDoc('approval', a, a.createdAt)
  bus.emit({ type: 'approval', approval: a })
  return a
}

export const getApproval = (id: string): Approval | undefined => getDoc<Approval>('approval', id)
export const pendingApprovals = (): Approval[] => listDocs<Approval>('approval', { status: 'pending' })
export const allApprovals = (limit = 100): Approval[] => listDocs<Approval>('approval', { limit })

const EMOJI: Record<ApprovalKind, string> = { announcement: '📣', knowledge: '📚', poll: '📊', email: '✉️', capability: '🧩', pin: '📌', post: '💬' }

export async function requestApproval(input: {
  kind: ApprovalKind
  title: string
  summary: string
  actions: ApprovalAction[]
  requestedBy: string
  runId?: string
  simulated?: boolean
  mirrorToSlack?: boolean
}): Promise<Approval> {
  const actions = await Promise.all(input.actions.map((a) => previewAction(a, input.runId)))
  let approval: Approval = save({
    id: `ap_${randomUUID().slice(0, 8)}`,
    runId: input.runId,
    kind: input.kind,
    title: input.title,
    summary: input.summary,
    actions,
    status: 'pending',
    requestedBy: input.requestedBy,
    createdAt: Date.now(),
    simulated: input.simulated,
  })
  if (input.mirrorToSlack !== false && modsAvailable()) {
    const lines = actions.map((a) => `• ${a.label}  \`${a.tool}\`${a.preview ? ` → ${a.preview.method} ${shortUrl(a.preview.url)}` : ''}${a.blocked ? `  ⛔ ${a.blocked}` : ''}${a.hold ? '\n   ✋ the pin waits for a mod to approve it here (Swytchcode)' : ''}`)
    const card = await postModsCard(
      `${EMOJI[input.kind]} **Approval needed: ${input.title}**\n${input.summary}\n\n${lines.join('\n')}\n\nReact ✅ to run or ❌ to cancel (or use the Pulse dashboard).`,
      { runId: input.runId },
    )
    if (card.ts) approval = save({ ...approval, slackTs: card.ts })
  }
  return approval
}

function shortUrl(url: string): string {
  return url.replace(/^https?:\/\//, '').replace(/\/bot[^/]+/, '/bot…')
}

const executing = new Set<string>()

export async function decide(id: string, decision: 'approve' | 'reject', by: string): Promise<Approval | undefined> {
  const current = getApproval(id)
  if (!current || current.status !== 'pending' || executing.has(id)) return current
  if (decision === 'reject') {
    const a = save({ ...current, status: 'rejected', decidedAt: Date.now(), decidedBy: by })
    if (a.slackTs) void postModsCard(`❌ Cancelled by ${by}.`, { threadTs: a.slackTs })
    return a
  }
  executing.add(id)
  try {
    let a = save({ ...current, status: 'approved', decidedAt: Date.now(), decidedBy: by })
    const results: ApprovalAction[] = []
    for (let i = 0; i < a.actions.length; i++) {
      const action = a.actions[i]!
      if (action.blocked) {
        results.push({ ...action, ok: false, result: 'skipped: blocked in preview' })
        continue
      }
      results.push(await executeAction(a, action, i))
    }
    const ok = results.every((r) => r.ok !== false)
    const failed = results.filter((r) => r.ok === false).length
    a = save({
      ...a,
      actions: results,
      status: ok ? 'executed' : 'failed',
      result: ok ? `${results.length} action(s) executed` : `${failed} of ${results.length} action(s) failed`,
    })
    if (a.slackTs) void postModsCard(ok ? `✅ Approved by ${by} and executed.` : `⚠️ Approved by ${by}; ${a.result}.`, { threadTs: a.slackTs })
    if (ok) await followUps.get(a.kind)?.(a)
    return a
  } finally {
    executing.delete(id)
  }
}

async function executeAction(a: Approval, action: ApprovalAction, i: number): Promise<ApprovalAction> {
  const key = `${a.id}:${i}`
  const meta = (action.meta ?? {}) as { platform?: Platform; chatId?: string; text?: string; threadTs?: string; replyToId?: string; entry?: NewEntry; entryId?: string; patch?: Partial<NewEntry> }
  try {
    if ((action.tool === TOOL.tgSend || action.tool === TOOL.slackPost || action.tool === TOOL.waSend) && meta.platform && meta.chatId && meta.text) {
      const res = await post(meta.platform, meta.chatId, meta.text, { key, runId: a.runId, threadTs: meta.threadTs, replyToId: meta.replyToId, simulated: a.simulated, byOrganizer: true })
      if (!res.ok) return { ...action, ok: false, result: res.blocked ? `blocked by ${res.blocked.policyId ?? res.blocked.kind}` : res.error }
      const posted = `posted${res.msgId ? ` (${res.msgId})` : ''}`
      if (action.pin && res.msgId) {
        const { tool, args } = pinCall(meta.platform, meta.chatId, res.msgId)
        const requestedAt = Date.now()
        try {
          await swyExec(tool, args, { runId: a.runId })
        } catch (e) {
          if (!(e instanceof SwyError) || !(e.isApprovalHold || e.isApprovalRefused)) throw e
          const hold: SwyHold = e.isApprovalHold
            ? { tool, status: 'pending', auditId: e.auditIds[0], requestedAt, message: 'Waiting for a mod to approve in Slack' }
            : { tool, status: 'failed', auditId: e.auditIds[0], requestedAt, message: e.message.slice(0, 200) }
          bus.emit({
            type: 'log',
            level: e.isApprovalHold ? 'info' : 'warn',
            text: e.isApprovalHold ? `Swytchcode is holding the pin for a mod (${a.title})` : `Swytchcode approval unavailable, pin not run: ${hold.message}`,
          })
          return { ...action, ok: true, hold, result: `${posted}, ${e.isApprovalHold ? 'pin waiting for a mod' : 'pin not run'}` }
        }
      }
      return { ...action, ok: true, result: `${posted}${action.pin ? ', pinned' : ''}` }
    }
    if (action.tool === TOOL.notionCreate && meta.entry) {
      const entry = await addKnowledge({ ...meta.entry, scripted: a.simulated || meta.entry.scripted }, a.runId)
      return { ...action, ok: true, result: entry.url }
    }
    if (action.tool === TOOL.notionUpdate && meta.entryId && meta.patch && a.simulated) {
      // Scripted runs never edit real entries: write a scripted copy (archived on demo reset).
      const entry = await addKnowledge({ question: meta.patch.question ?? 'Updated entry', answer: meta.patch.answer ?? '', source: 'Organizer', learnedFrom: 'Organizer (Console, scripted)', scripted: true }, a.runId)
      return { ...action, ok: true, result: entry.url }
    }
    if (action.tool === TOOL.notionUpdate && meta.entryId && meta.patch) {
      const entry = await updateKnowledge(meta.entryId, meta.patch, a.runId)
      return { ...action, ok: true, result: entry.url }
    }
    // Everything else: one idempotent Swytchcode exec keyed by approval + index.
    const args = action.tool === TOOL.email ? { ...(action.args as object), headers: { 'Idempotency-Key': key } } : (action.args as Record<string, unknown>)
    const res = await withOutbox({ platform: 'web', chatId: action.tool, replyTo: a.id, text: JSON.stringify(action.args) }, async () => {
      const r = await swyExec<{ id?: string; result?: { message_id?: number } }>(action.tool, args, { runId: a.runId })
      return { providerMsgId: String(r.data?.id ?? r.data?.result?.message_id ?? 'ok') }
    }, key)
    return { ...action, ok: res.status === 'sent', result: res.status === 'sent' ? `done (${res.providerMsgId})` : `skipped (${res.reason})` }
  } catch (e) {
    const blocked = reportBlock(e, { runId: a.runId })
    return { ...action, ok: false, result: blocked ? `blocked by ${blocked.policyId ?? blocked.kind}` : String((e as Error).message).slice(0, 200) }
  }
}

// ── Slack ✅ / ❌ reactions ────────────────────────────────────────────────

const APPROVE = new Set(['white_check_mark', 'heavy_check_mark', 'ballot_box_with_check', '+1'])
const REJECT = new Set(['x', 'no_entry', 'negative_squared_cross_mark', '-1'])
let watcher: ReturnType<typeof setInterval> | undefined

export function startApprovalWatcher(everyMs = 4000): void {
  if (watcher) return
  watcher = setInterval(() => void Promise.allSettled([checkReactions(), checkHolds()]), everyMs)
  watcher.unref?.()
}

// ── Swytchcode holds: follow the mod's decision in Swytchcode's audit log ──

const HOLD_STATUS: Record<string, SwyHold['status']> = { hitl: 'pending', approved: 'approved', rejected: 'rejected', expired: 'expired', failed: 'failed' }
const HOLD_NOTE: Partial<Record<SwyHold['status'], string>> = {
  approved: '📌 A mod approved the pin in Slack and Swytchcode ran it.',
  rejected: '🚫 A mod rejected the pin in Slack. Swytchcode did not run it.',
  expired: '⌛ Nobody approved the pin in time. Swytchcode dropped it.',
  failed: '⚠️ Swytchcode could not run the approved pin.',
}
let checkingHolds = false

export async function checkHolds(): Promise<void> {
  if (checkingHolds) return
  const waiting = allApprovals(50).filter((a) => a.actions.some((x) => x.hold?.status === 'pending'))
  if (!waiting.length) return
  checkingHolds = true
  try {
    const entries = await swyAuditPolicy(50)
    for (const a of waiting) {
      const notes: string[] = []
      const actions = a.actions.map((x) => {
        const h = x.hold
        if (h?.status !== 'pending') return x
        const hit = entries.find((e) => (h.auditId ? e.id === h.auditId : e.tool === h.tool && e.requestedAt * 1000 >= (h.requestedAt ?? 0) - 2000))
        const status = hit ? HOLD_STATUS[hit.status] : undefined
        if (!hit || !status || status === 'pending') return x
        const note = HOLD_NOTE[status]
        if (note) notes.push(note)
        const result = (x.result ?? '').replace(/, pin waiting for a mod$/, status === 'approved' ? ', pinned (mod approved)' : `, pin ${status}`)
        return { ...x, result, hold: { ...h, auditId: hit.id, status, resolvedAt: hit.resolvedAt ? hit.resolvedAt * 1000 : Date.now() } }
      })
      if (!notes.length) continue
      const next = save({ ...a, actions })
      for (const note of notes) {
        bus.emit({ type: 'log', level: 'info', text: `${note} (${next.title})` })
        if (next.slackTs) void postModsCard(note, { threadTs: next.slackTs })
      }
    }
  } finally {
    checkingHolds = false
  }
}

export function stopApprovalWatcher(): void {
  if (watcher) clearInterval(watcher)
  watcher = undefined
}

async function checkReactions(): Promise<void> {
  const slack = channels.slack
  const channel = modsChannel()
  if (!slack || !channel) return
  for (const a of pendingApprovals()) {
    if (!a.slackTs) continue
    try {
      const reactions = await slack.reactions(channel, a.slackTs)
      const approver = Object.entries(reactions).find(([name, users]) => APPROVE.has(name) && users.length)?.[1][0]
      const rejecter = Object.entries(reactions).find(([name, users]) => REJECT.has(name) && users.length)?.[1][0]
      if (approver) await decide(a.id, 'approve', await slack.displayName(approver))
      else if (rejecter) await decide(a.id, 'reject', await slack.displayName(rejecter))
    } catch {
      /* next tick */
    }
  }
}

import { generateText, isStepCount, tool } from 'ai'
import { z } from 'zod'
import { env } from '../config/env.js'
import {
  emailAction,
  knowledgeAction,
  knowledgeUpdateAction,
  pendingApprovals,
  pollAction,
  postAction,
  requestApproval,
} from '../core/approvals.js'
import { channels } from '../core/channels.js'
import { modsAvailable, postModsCard } from '../core/mods.js'
import { startRun, type Run } from '../core/runs.js'
import { communityStats } from '../core/stats.js'
import { openAttentionItems, waitingQuestions } from '../core/state-docs.js'
import { caseOf, fmtMood, getCase } from '../core/cases.js'
import { getDoc } from '../store/repo.js'
import { getEntry, searchKnowledge } from '../kb/knowledge.js'
import type { ApprovalAction, AttentionItem, MemberCase, Platform } from '../shared/events.js'
import { Bm25Index } from '../store/bm25.js'
import { recentMessages, type StoredMessage } from '../store/repo.js'
import { swyDiscover, swyExec, swyInfo, swyListTooling } from '../swy/exec.js'
import { trimSchema } from '../swy/schema-trim.js'
import { consoleModel } from './models.js'
import { consoleInstructions } from './prompts.js'

// The Agent Console: an organizer types a request in plain English; Pulse
// researches, plans and prepares actions across Telegram, Slack, Notion and
// Resend. Anything that reaches people is prepared as a Swytchcode dry-run
// preview and waits for approval. find/inspect/run_capability let it use any
// allow-listed Swytchcode method without new code.

const MAX_STEPS = 14

/**
 * Where announcements go. Scripted (demo) runs only ever reach the demo Slack
 * channel, never the real Telegram group, so real members aren't confused.
 */
const communityTargets = (simulated = false): Array<{ platform: Platform; chatId: string; label: string }> => {
  const out: Array<{ platform: Platform; chatId: string; label: string }> = []
  if (simulated) {
    const demo = env.DEMO_SLACK_CHANNEL_ID ?? env.SLACK_GENERAL_CHANNEL_ID
    if (channels.slack && demo) out.push({ platform: 'slack', chatId: demo, label: 'Slack (demo channel)' })
    return out
  }
  if (channels.telegram && env.TELEGRAM_COMMUNITY_CHAT_ID) out.push({ platform: 'telegram', chatId: env.TELEGRAM_COMMUNITY_CHAT_ID, label: 'Telegram group' })
  if (channels.slack && env.SLACK_GENERAL_CHANNEL_ID) out.push({ platform: 'slack', chatId: env.SLACK_GENERAL_CHANNEL_ID, label: 'Slack #general' })
  return out
}

const emailAllowlist = (): string[] => [env.DIGEST_TO, ...(env.EMAIL_ALLOWLIST?.split(',') ?? [])].map((s) => s?.trim()).filter((s): s is string => !!s)

let toolingCache: { at: number; ids: Set<string> } | undefined
async function allowList(): Promise<Set<string>> {
  if (toolingCache && Date.now() - toolingCache.at < 60_000) return toolingCache.ids
  const ids = new Set(await swyListTooling().catch(() => []))
  toolingCache = { at: Date.now(), ids }
  return ids
}

const isReadMethod = (id: string, httpMethod?: string) =>
  httpMethod?.toUpperCase() === 'GET' || /\.(get|list)(\.|$)|\.get[a-z]+\.create$|getme|getchat/.test(id)

function mdToHtml(md: string): string {
  const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
  return md
    .split(/\n{2,}/)
    .map((block) => {
      const lines = block.split('\n')
      if (lines.every((l) => /^\s*[-•*]\s+/.test(l))) return `<ul>${lines.map((l) => `<li>${inline(esc(l.replace(/^\s*[-•*]\s+/, '')))}</li>`).join('')}</ul>`
      if (/^#{1,3}\s/.test(lines[0]!)) return `<h3>${inline(esc(lines[0]!.replace(/^#{1,3}\s+/, '')))}</h3>${lines.slice(1).map((l) => `<p>${inline(esc(l))}</p>`).join('')}`
      return `<p>${lines.map((l) => inline(esc(l))).join('<br>')}</p>`
    })
    .join('\n')
  function inline(s: string): string {
    return s.replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>').replace(/\[([^\]]+)\]\((https?:[^)\s]+)\)/g, '<a href="$2">$1</a>')
  }
}

/** A Console request made from one member's card (phone app / Inbox). */
export interface ConsoleAbout {
  kind: 'member'
  /** attention item or case id */
  id: string
}

interface MemberTarget {
  platform: Platform
  chatId: string
  userId: string
  userName: string
  replyTo?: string
  threadTs?: string
  attentionId?: string
  case?: MemberCase
  context: string
}

function memberTarget(about: ConsoleAbout): MemberTarget | undefined {
  const item = about.id.startsWith('at_') ? getDoc<AttentionItem>('attention', about.id) : undefined
  const c = getCase(item?.caseId ?? about.id) ?? (item ? caseOf(item.platform, item.userId, !!item.simulated) : undefined)
  const t = item ?? c
  if (!t) return undefined
  const said = c ? c.points.filter((p) => p.by === 'member').slice(-5).map((p) => `- "${p.text}" (mood ${fmtMood(p.score)}${p.emotion ? `, ${p.emotion}` : ''})`) : [`- "${item!.text}"`]
  const replies = c ? c.points.filter((p) => p.by !== 'member').slice(-3).map((p) => `- ${p.by === 'pulse' ? 'Pulse' : 'Organizer'} replied: "${p.text.slice(0, 200)}"`) : []
  return {
    platform: t.platform,
    chatId: t.chatId,
    userId: t.userId,
    userName: t.userName,
    replyTo: c?.lastMsgId ?? item?.msgId,
    threadTs: c?.threadTs,
    attentionId: item?.id ?? c?.escalation?.attentionId,
    case: c,
    context: [
      `THIS REQUEST IS ABOUT ONE MEMBER: ${t.userName} (${t.platform === 'telegram' ? 'Telegram' : 'Slack'}).`,
      c ? `Their problem: ${c.topic}. Mood now ${fmtMood(c.mood)}. ${c.escalation?.reason ? `Flagged because: ${c.escalation.reason}.` : ''}` : `Flagged because: ${item!.reason}.`,
      `What they said (oldest first):\n${said.join('\n')}`,
      replies.length ? `Replies so far:\n${replies.join('\n')}` : '',
    ]
      .filter(Boolean)
      .join('\n'),
  }
}

export function consoleTools(run: Run, member?: MemberTarget) {
  const approvals: string[] = []
  const approve = async (input: Omit<Parameters<typeof requestApproval>[0], 'requestedBy' | 'runId'>) => {
    const a = await requestApproval({ ...input, runId: run.id, requestedBy: 'Organizer via Console', simulated: run.simulated })
    approvals.push(a.id)
    return a
  }
  const previewSummary = (actions: ApprovalAction[]) =>
    actions.map((x) => ({ label: x.label, tool: x.tool, preview: x.preview ? `${x.preview.method} ${x.preview.url}` : undefined, blocked: x.blocked }))

  const tools = {
    search_messages: tool({
      description: 'Search recent community messages (Telegram + Slack) by keyword. Use to find who asked about something.',
      inputSchema: z.object({ query: z.string(), limit: z.number().int().min(1).max(30).default(12), include_scripted: z.boolean().default(false) }),
      execute: async ({ query, limit, include_scripted }) => {
        const step = run.steps.begin('search', 'Search community messages', `“${query}”`)
        const idx = new Bm25Index<StoredMessage>((m) => m.text)
        for (const m of recentMessages(2000)) if (include_scripted || !m.simulated) idx.add(m)
        const hits = idx.search(query, limit, 0.3)
        step.ok(`${hits.length} message(s)`, { hits: hits.map((h) => `${h.doc.userName}: ${h.doc.text.slice(0, 100)}`) })
        return hits.map((h) => ({
          user: h.doc.userName,
          platform: h.doc.platform,
          text: h.doc.text.slice(0, 300),
          when: new Date(h.doc.ts).toISOString(),
          answered: h.doc.answeredBy ?? 'no',
        }))
      },
    }),

    search_knowledge: tool({
      description: 'Search the Notion knowledge base. Returns entries with kb_id, question, answer.',
      inputSchema: z.object({ query: z.string() }),
      execute: async ({ query }) => {
        const step = run.steps.begin('search', 'Search the knowledge base', `“${query}”`)
        const hits = searchKnowledge(query, 5)
        step.ok(hits.length ? `${hits.length} entr${hits.length === 1 ? 'y' : 'ies'}: ${hits[0]!.entry.question}` : 'no entries')
        return hits.map((h) => ({ kb_id: h.entry.id, question: h.entry.question, answer: h.entry.answer.slice(0, 600), source: h.entry.source, used: h.entry.used }))
      },
    }),

    community_stats: tool({
      description: 'Numbers for the community: messages, questions, answered, unanswered, top askers/topics, knowledge growth, helpers.',
      inputSchema: z.object({ hours: z.number().min(1).max(24 * 14).default(24), include_scripted: z.boolean().default(false) }),
      execute: async ({ hours, include_scripted }) => {
        const step = run.steps.begin('stats', 'Read community stats', `last ${hours}h`)
        const s = communityStats({ sinceMs: hours * 3600_000, includeScripted: include_scripted })
        step.ok(`${s.messages} messages · ${s.questions} questions · ${s.knowledge.learned} learned answers`, s)
        return s
      },
    }),

    members_needing_attention: tool({
      description: 'Members who are frustrated, ignored, or waiting on organizers.',
      inputSchema: z.object({}),
      execute: async () => {
        const step = run.steps.begin('stats', 'Check who needs attention')
        const attention = openAttentionItems().map((a) => ({ user: a.userName, kind: a.kind, reason: a.reason, platform: a.platform, text: a.text.slice(0, 200) }))
        const waiting = waitingQuestions().map((p) => ({ user: p.userName, question: p.question, platform: p.platform, minutes_waiting: Math.round((Date.now() - p.askedAt) / 60_000) }))
        const unanswered = communityStats().unanswered
        step.ok(`${attention.length} flagged · ${waiting.length} waiting on organizers · ${unanswered.length} unanswered`)
        return { flagged: attention, waiting_on_organizers: waiting, unanswered }
      },
    }),

    list_pending: tool({
      description: 'Pending approvals and questions waiting on organizers.',
      inputSchema: z.object({}),
      execute: async () => {
        run.steps.record('stats', 'List pending items', 'ok')
        return { approvals: pendingApprovals().map((a) => ({ id: a.id, title: a.title, kind: a.kind })), waiting: waitingQuestions().map((p) => ({ user: p.userName, question: p.question })) }
      },
    }),

    announce: tool({
      description: 'Prepare an announcement to the community (Telegram group and/or Slack #general), optionally pinned. Creates ONE approval with a Swytchcode dry-run preview per channel.',
      inputSchema: z.object({
        text: z.string().describe('the announcement, markdown, 1–5 sentences'),
        targets: z.array(z.enum(['telegram', 'slack'])).default(['telegram', 'slack']),
        pin: z.boolean().default(false),
        title: z.string().describe('short title for the approval card'),
      }),
      execute: async ({ text, targets, pin, title }) => {
        const step = run.steps.begin('preview', 'Prepare announcement (dry-run)', title)
        const all = communityTargets(run.simulated)
        const chosen = run.simulated ? all : all.filter((t) => targets.includes(t.platform as 'telegram' | 'slack'))
        if (!chosen.length) {
          step.error('no community channel connected for those targets')
          return 'No connected channel for those targets.'
        }
        const actions = chosen.map((t) => postAction(t.platform, t.chatId, text, `Post to ${t.label}${pin ? ' and pin' : ''}`, { pin }))
        step.tools(actions.map((a) => a.tool))
        const a = await approve({ kind: 'announcement', title, summary: text, actions })
        const blocked = a.actions.filter((x) => x.blocked)
        if (blocked.length) step.blocked(`Swytchcode blocked ${blocked.length} action(s) in dry-run: ${blocked[0]!.blocked}`, { approval: a.id, actions: previewSummary(a.actions) })
        else step.waiting(`approval ${a.id} waiting (${a.actions.length} dry-run preview${a.actions.length > 1 ? 's' : ''})`, { approval: a.id, actions: previewSummary(a.actions) })
        return { approval_id: a.id, status: 'waiting for organizer approval', previews: previewSummary(a.actions) }
      },
    }),

    create_poll: tool({
      description: 'Prepare a Telegram poll in the community group (needs approval).',
      inputSchema: z.object({ question: z.string(), options: z.array(z.string()).min(2).max(10) }),
      execute: async ({ question, options }) => {
        const step = run.steps.begin('preview', 'Prepare Telegram poll (dry-run)', question, undefined, ['telegram_v5_0.sendpoll.create'])
        if (!env.TELEGRAM_COMMUNITY_CHAT_ID || !channels.telegram || run.simulated) {
          step.error('Telegram group not connected')
          return 'Telegram group not connected.'
        }
        const a = await approve({ kind: 'poll', title: `Poll: ${question}`, summary: options.map((o) => `• ${o}`).join('\n'), actions: [pollAction(env.TELEGRAM_COMMUNITY_CHAT_ID, question, options)] })
        step.waiting(`approval ${a.id} waiting`, { approval: a.id, actions: previewSummary(a.actions) })
        return { approval_id: a.id, previews: previewSummary(a.actions) }
      },
    }),

    upsert_knowledge: tool({
      description: 'Create a new knowledge-base entry, or update an existing one (pass kb_id). Needs approval.',
      inputSchema: z.object({ question: z.string(), answer: z.string(), kb_id: z.string().optional() }),
      execute: async ({ question, answer, kb_id }) => {
        const existing = kb_id ? getEntry(kb_id) : undefined
        const step = run.steps.begin('knowledge', existing ? 'Prepare knowledge update' : 'Prepare new knowledge entry', question, undefined, [existing ? 'notion.page.update' : 'notion.page.create'])
        const action = existing
          ? knowledgeUpdateAction(existing.id, { question, answer, source: 'Organizer' })
          : knowledgeAction({ question, answer, source: 'Organizer', learnedFrom: 'Organizer (Console)' })
        const a = await approve({ kind: 'knowledge', title: existing ? `Update FAQ: ${existing.question}` : `New FAQ: ${question}`, summary: `**Q:** ${question}\n**A:** ${answer}`, actions: [action] })
        step.waiting(`approval ${a.id} waiting`, { approval: a.id })
        return { approval_id: a.id }
      },
    }),

    send_email: tool({
      description: `Prepare an email via Resend (needs approval). Recipients must be allow-listed: ${emailAllowlist().join(', ') || '(none configured)'}.`,
      inputSchema: z.object({ subject: z.string(), markdown: z.string().describe('email body in simple markdown'), to: z.array(z.string()).optional() }),
      execute: async ({ subject, markdown, to }) => {
        const step = run.steps.begin('email', 'Prepare email (dry-run)', subject, undefined, ['resend.email.create'])
        const recipients = to?.length ? to : emailAllowlist().slice(0, 1)
        if (!recipients.length) {
          step.error('no recipient configured')
          return 'No recipient configured (DIGEST_TO).'
        }
        const html = `<div style="font-family:Inter,Segoe UI,sans-serif;font-size:15px;line-height:1.55;color:#18181b">${mdToHtml(markdown)}<p style="color:#71717a;font-size:12px;margin-top:24px">Sent by Pulse · ${env.COMMUNITY_NAME}</p></div>`
        const a = await approve({ kind: 'email', title: `Email: ${subject}`, summary: `To ${recipients.join(', ')}\n\n${markdown.slice(0, 400)}`, actions: [emailAction(recipients, subject, html)] })
        const blocked = a.actions.find((x) => x.blocked)
        if (blocked) step.blocked(`Swytchcode policy blocked this email: ${blocked.blocked}`, { approval: a.id })
        else step.waiting(`approval ${a.id} waiting`, { approval: a.id, actions: previewSummary(a.actions) })
        return { approval_id: a.id, previews: previewSummary(a.actions) }
      },
    }),

    ...(member
      ? {
          reply_to_member: tool({
            description: `Prepare a reply to ${member.userName} in their chat thread (needs approval). Write it as the organizer would: warm, specific, 1–3 sentences, first name. It is signed by the organizer automatically.`,
            inputSchema: z.object({ text: z.string().describe('the reply the member will see') }),
            execute: async ({ text }) => {
              const step = run.steps.begin('preview', `Prepare a reply to ${member.userName.split(' ')[0]} (dry-run)`, text.slice(0, 120))
              const body = `${text.trim()}\n\n_— ${env.ORGANIZER_NAME}_`
              const action = postAction(member.platform, member.chatId, body, `Reply to ${member.userName} in ${member.platform === 'telegram' ? 'Telegram' : 'Slack'}`, {
                threadTs: member.platform === 'slack' ? member.threadTs ?? member.replyTo : undefined,
              })
              action.meta = { ...action.meta, replyToId: member.platform === 'telegram' ? member.replyTo : undefined, member: { userId: member.userId, caseId: member.case?.id, attentionId: member.attentionId, reply: text } }
              step.tools([action.tool])
              const a = await approve({ kind: 'post', title: `Reply to ${member.userName}`, summary: body, actions: [action] })
              const blocked = a.actions.find((x) => x.blocked)
              if (blocked) step.blocked(`Swytchcode blocked the reply in dry-run: ${blocked.blocked}`, { approval: a.id })
              else step.waiting(`approval ${a.id} waiting`, { approval: a.id, actions: previewSummary(a.actions) })
              return { approval_id: a.id, status: 'waiting for organizer approval', previews: previewSummary(a.actions) }
            },
          }),
        }
      : {}),

    post_to_mods: tool({
      description: 'Post an internal note to the organizers in Slack #mods (no approval needed; internal channel).',
      inputSchema: z.object({ text: z.string() }),
      execute: async ({ text }) => {
        const step = run.steps.begin('mods', 'Post to #mods', text.slice(0, 80), undefined, ['slack.chat.postmessage.create'])
        if (!modsAvailable()) {
          step.error('mods channel not configured')
          return 'Mods channel not configured.'
        }
        const r = await postModsCard(`🛰️ ${text}`, { runId: run.id })
        if (r.ts) step.ok('posted')
        else step.error(r.error ?? 'failed')
        return r.ts ? 'Posted.' : `Failed: ${r.error}`
      },
    }),

    find_capability: tool({
      description: "Semantic search over Swytchcode's API registry for a capability your named tools don't cover. Returns canonical ids and whether each is on Pulse's allow-list (only allowed ones can run).",
      inputSchema: z.object({ intent: z.string().describe('what you want to do, e.g. "pin a message in a Telegram chat"'), provider: z.enum(['telegram', 'slack', 'notion', 'resend']).optional() }),
      execute: async ({ intent, provider }) => {
        const step = run.steps.begin('discover', 'Discover a Swytchcode capability', `“${intent}”`)
        try {
          const [{ candidates }, allowed] = await Promise.all([swyDiscover(intent, { provider, top: 8, runId: run.id }), allowList()])
          const rows = candidates.map((c) => ({ canonical_id: c.canonical_id, summary: c.summary, allowed: allowed.has(c.canonical_id) }))
          // Allow-listed methods that match the intent lexically are surfaced too (discover ranks by vector distance).
          const words = intent.toLowerCase().split(/\W+/).filter((w) => w.length > 3)
          for (const id of allowed) if (!rows.some((r) => r.canonical_id === id) && words.some((w) => id.includes(w))) rows.push({ canonical_id: id, summary: '(allow-listed)', allowed: true })
          step.ok(`${rows.filter((r) => r.allowed).length} allowed of ${rows.length} candidates`, { candidates: rows })
          return rows.slice(0, 10)
        } catch (e) {
          const allowed = [...(await allowList())].filter((id) => !provider || id.startsWith(provider))
          step.error(`discover failed (${String((e as Error).message).slice(0, 80)}), returning the allow-list`)
          return { allow_list: allowed }
        }
      },
    }),

    inspect_capability: tool({
      description: 'Get the real input schema of a canonical Swytchcode id (where each arg goes, required fields).',
      inputSchema: z.object({ canonical_id: z.string() }),
      execute: async ({ canonical_id }) => {
        const step = run.steps.begin('inspect', 'Inspect schema', canonical_id, undefined, [canonical_id])
        try {
          const { info } = await swyInfo(canonical_id, { runId: run.id })
          const trimmed = trimSchema(info)
          step.ok(`${trimmed.http_method ?? ''} ${trimmed.endpoint ?? ''} · required: ${trimmed.required.join(', ') || 'none'}`, trimmed)
          return trimmed
        } catch (e) {
          step.error(String((e as Error).message).slice(0, 160))
          return `Unknown or unavailable: ${(e as Error).message}`
        }
      },
    }),

    run_capability: tool({
      description:
        'Run an allow-listed Swytchcode method with exact args ({"body":{…},"params":{…}}). Read-only methods run immediately; anything that changes state becomes an approval with a dry-run preview. Community chat ids: ' +
        communityTargets(run.simulated).map((t) => `${t.label}=${t.chatId}`).join(', '),
      inputSchema: z.object({ canonical_id: z.string(), args_json: z.string().describe('JSON object'), reason: z.string().describe('one line for the approval card') }),
      execute: async ({ canonical_id, args_json, reason }) => {
        const step = run.steps.begin('execute', `Use ${canonical_id}`, reason, undefined, [canonical_id])
        const allowed = await allowList()
        if (!allowed.has(canonical_id)) {
          step.blocked('not on the Swytchcode allow-list (fail-closed)')
          return 'Refused: this method is not on the allow-list.'
        }
        let args: Record<string, unknown>
        try {
          args = JSON.parse(args_json)
        } catch (e) {
          step.error('args_json is not valid JSON')
          return `args_json is not valid JSON: ${(e as Error).message}`
        }
        const { info } = await swyInfo(canonical_id, { runId: run.id }).catch(() => ({ info: undefined }))
        if (isReadMethod(canonical_id, info?.http_method)) {
          try {
            const r = await swyExec(canonical_id, args, { runId: run.id })
            const data = JSON.stringify(r.data)
            step.ok('read-only call executed', { preview: data.slice(0, 400) })
            return data.length > 2400 ? `${data.slice(0, 2400)}… (truncated)` : r.data
          } catch (e) {
            step.error(String((e as Error).message).slice(0, 160))
            return `Failed: ${(e as Error).message}`
          }
        }
        const a = await approve({ kind: 'capability', title: reason, summary: `\`${canonical_id}\``, actions: [{ tool: canonical_id, label: reason, args }] })
        const blocked = a.actions[0]?.blocked
        if (blocked) step.blocked(`dry-run rejected: ${blocked}`, { approval: a.id })
        else step.waiting(`approval ${a.id} waiting`, { approval: a.id, actions: previewSummary(a.actions) })
        return blocked ? `Dry-run rejected by Swytchcode: ${blocked}. Fix the args (inspect_capability) and try again.` : { approval_id: a.id, previews: previewSummary(a.actions) }
      },
    }),
  }
  return { tools, approvals }
}

export async function runConsole(text: string, opts: { simulated?: boolean; about?: ConsoleAbout } = {}): Promise<{ runId: string }> {
  const member = opts.about ? memberTarget(opts.about) : undefined
  const run = startRun('console', member ? `${member.userName.split(' ')[0]}: ${text}` : text, { userName: 'Organizer', simulated: opts.simulated ?? member?.case?.simulated })
  void executeConsole(run, text, member)
  return { runId: run.id }
}

async function executeConsole(run: Run, text: string, member?: MemberTarget): Promise<void> {
  const model = consoleModel()
  if (!model) {
    run.steps.record('error', 'No model configured', 'error', 'Set ANTHROPIC_API_KEY or GROQ_API_KEY')
    run.end('failed', { summary: 'no model configured' })
    return
  }
  const { tools, approvals } = consoleTools(run, member)
  const surfaces = communityTargets(run.simulated).map((t) => t.label)
  if (modsAvailable()) surfaces.push('Slack #mods (organizers)')
  const now = new Date().toLocaleString('en-IN', { weekday: 'short', day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit', timeZone: 'Asia/Kolkata' })
  const think = run.steps.begin('think', 'Understand the request')
  let first = true
  try {
    const result = await generateText({
      model,
      instructions: consoleInstructions({ now, channels: surfaces.join(', ') || 'none connected', member: !!member }),
      prompt: member ? `${member.context}\n\nORGANIZER'S REQUEST: ${text}` : text,
      tools,
      maxRetries: 1,
      providerOptions: { groq: { reasoningEffort: 'medium' }, anthropic: { cacheControl: { type: 'ephemeral' } } },
      stopWhen: isStepCount(MAX_STEPS),
      onStepEnd: (step) => {
        if (step.response?.modelId) run.steps.model = step.response.modelId
        const said = step.text?.trim()
        if (first) {
          first = false
          think.ok(said ? said.slice(0, 280) : `plan: ${step.toolCalls?.map((c) => c?.toolName).join(' → ') || 'answer directly'}`, { model: step.response?.modelId })
        } else if (said && step.toolCalls?.length) {
          run.steps.record('think', 'Reasoning', 'ok', said.slice(0, 280))
        }
      },
    })
    const summary = result.text?.trim() || (approvals.length ? `Prepared ${approvals.length} action(s) for approval.` : 'Done.')
    if (first) think.ok()
    run.end(approvals.length ? 'awaiting_approval' : 'reported', { summary, reply: summary })
  } catch (e) {
    think.error(String((e as Error).message).slice(0, 200))
    run.end('failed', { summary: String((e as Error).message).slice(0, 200) })
  }
}

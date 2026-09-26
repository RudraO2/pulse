import { quotesReplies, sendTools } from '../channels/platforms.js'
import { generateText, isStepCount, tool, type LanguageModel } from 'ai'
import { z } from 'zod'
import { env } from '../config/env.js'
import { channels, post, replyMode, type PostResult } from '../core/channels.js'
import { requestApproval, knowledgeAction, postAction } from '../core/approvals.js'
import { modsAvailable, platformLabel, postModsCard, quote } from '../core/mods.js'
import type { Run } from '../core/runs.js'
import { createPending, openAttention, savePending, updateAttention } from '../core/state-docs.js'
import { writeHistory, type Message } from '../conversation/memory.js'
import { getEntry, markUsed, searchKnowledge, type KbHit } from '../kb/knowledge.js'
import { eventNow, guideFor, guideNow, guideOutline, searchGuide, type GuideHit } from '../kb/group-docs.js'
import type { InboundMessage, MemberCase, RunOutcome } from '../shared/events.js'
import { markAnswered } from '../store/repo.js'
import { redact } from '../swy/redact.js'
import { clampReply } from './format.js'
import { communityInstructions } from './prompts.js'
import { isQuestionLike } from './triage.js'

// The Community Agent: one tool loop per message batch. It decides whether
// the community needs an answer (from Notion), the organizers (Slack #mods),
// a welcome, a flag, a knowledge proposal, or silence. All effects go through
// Swytchcode via the channel/approval layers.

const MAX_STEPS = 5

export interface MemberSignal {
  msgId: string
  /** 0 … 1, derived from the mood reading */
  frustration: number
  /** this message's mood reading (mood model, or keywords as fallback) */
  mood?: { score: number; emotion: string; wantsHuman: boolean }
  /** the member's open problem, followed until it's solved */
  case?: { topic: string; trend: number[]; status: MemberCase['status']; pulseReplies: number }
  repeatOf?: { text: string; userName: string; answered: boolean }
  asksToday: number
  isNew: boolean
  /** this message is aimed at another member */
  directedAt?: string
  /** looks like an answer to a question this member asked recently */
  answersQuestionOf?: string
}

export interface CommunityRunInput {
  run: Run
  model: LanguageModel
  chatKey: string
  batch: InboundMessage[]
  history: Message[]
  signals: MemberSignal[]
  /** questions from this chat already waiting on the mods */
  waiting: string[]
  onModReplyWatch?: (modsTs: string) => void
}

export interface CommunityRunResult {
  outcome: RunOutcome
  reply?: string
  steps: number
  error?: string
}

function fmtTime(ts: number): string {
  return new Date(ts).toLocaleTimeString('en-IN', { hour: '2-digit', minute: '2-digit', timeZone: 'Asia/Kolkata' })
}

function knowledgeBlock(hits: KbHit[]): string {
  if (!hits.length) return 'KNOWLEDGE: (no matching entries in the Notion knowledge base)'
  return `KNOWLEDGE (best matches from the Notion knowledge base):\n${hits
    .map((h) => `[${h.entry.id}] Q: ${h.entry.question}\n    A: ${h.entry.answer.slice(0, 700)}\n    (source: ${h.entry.source}${h.entry.used ? `, used ${h.entry.used}×` : ''}, relevance ${h.score})`)
    .join('\n')}`
}

function guideBlock(name: string, hits: GuideHit[], outline: string[], now?: string): string {
  const toc = `${outline.length ? `\nAll sections: ${outline.join(' | ')}` : ''}${now ? `\n\n${now}` : ''}`
  if (!hits.length) return `GUIDE "${name}": (no section matches these words; try search_knowledge with other words)${toc}`
  return `GUIDE "${name}" (official for this chat, best matching sections):\n${hits
    .map((h) => `§ ${h.section.title}\n${h.section.text.slice(0, 1400)}`)
    .join('\n\n')}${toc}`
}

export function buildContext(input: Omit<CommunityRunInput, 'run' | 'model'>, hits: KbHit[], guide?: { name: string; hits: GuideHit[]; outline: string[]; now?: string }, timeline?: string): string {
  const hist = input.history
    .slice(-30, -input.batch.length || undefined)
    .map((m) => `${m.ts ? `${fmtTime(m.ts)} ` : ''}${m.sender}: ${redact(m.text).slice(0, 300)}`)
  const batch = input.batch.map((m) => {
    const s = input.signals.find((x) => x.msgId === m.msgId)
    const tags = [
      m.joined ? 'JOINED' : '',
      m.addressed ? 'addressed to Pulse' : '',
      s?.isNew && !m.joined ? 'first message here' : '',
      s?.mood && (s.mood.score <= -0.2 || s.mood.score >= 0.4) ? `mood ${s.mood.score.toFixed(1)} ${s.mood.emotion}` : '',
      s?.mood?.wantsHuman ? 'ASKS FOR A PERSON' : '',
      s?.case
        ? `open problem: "${s.case.topic.slice(0, 60)}", mood ${s.case.trend.map((x) => x.toFixed(1)).join('→')}${s.case.pulseReplies ? `, Pulse answered ${s.case.pulseReplies}× already` : ''}${s.case.status === 'escalated' ? ', organizers already flagged' : ''}`
        : '',
      s && s.asksToday >= 2 ? `asked ${s.asksToday}× today` : '',
      s?.directedAt && !s.answersQuestionOf ? `aimed at ${s.directedAt}, not Pulse` : '',
      s?.answersQuestionOf ? `looks like an ANSWER to ${s.answersQuestionOf}'s question (consider propose_knowledge)` : '',
      s?.repeatOf ? `REPEAT of "${s.repeatOf.text.slice(0, 80)}" (asked by ${s.repeatOf.userName}${s.repeatOf.answered ? ', answered before' : ''})` : '',
      m.replyToId ? `reply to msg ${m.replyToId}` : '',
    ].filter(Boolean)
    return `[${m.msgId}] ${m.userName}${tags.length ? ` {${tags.join('; ')}}` : ''}: ${redact(m.text).slice(0, 800)}`
  })
  return [
    guide ? guideBlock(guide.name, guide.hits, guide.outline, guide.now) : timeline ?? '',
    knowledgeBlock(hits),
    input.waiting.length ? `ALREADY WAITING ON ORGANIZERS (don't ask again): ${input.waiting.map((w) => `"${w.slice(0, 80)}"`).join(', ')}` : '',
    hist.length ? `RECENT CONVERSATION (oldest first):\n${hist.join('\n')}` : 'RECENT CONVERSATION: (none)',
    `NEW MESSAGE(S) TO HANDLE:\n${batch.join('\n')}`,
  ]
    .filter(Boolean)
    .join('\n\n')
}

export async function runCommunityAgent(input: CommunityRunInput): Promise<CommunityRunResult> {
  const { run, batch } = input
  const target = [...batch].reverse().find((m) => !m.joined) ?? batch[batch.length - 1]!
  const platform = target.platform
  const chatId = target.chatId
  const simulated = !!target.simulated
  const threadRoot = platform === 'slack' ? target.threadTs ?? target.msgId : undefined
  const questionIds = batch.filter((m) => !m.joined).map((m) => m.msgId)

  const query = batch.map((m) => m.text).join(' ')
  const hits = searchKnowledge(query, 5)
  // A guide attached to this chat (e.g. the participant guide in the event group) is its first source.
  const guideInfo = guideFor(chatId)
  const guide = guideInfo ? { name: guideInfo.name, hits: searchGuide(chatId, query, 3), outline: guideOutline(chatId), now: guideNow(chatId) } : undefined
  run.steps.record(
    'context',
    'Read the conversation',
    'ok',
    `${batch.length} new message(s), ${input.history.length} in memory · ${hits.length} knowledge match${hits.length === 1 ? '' : 'es'}${guide ? ` · ${guide.hits.length} guide section${guide.hits.length === 1 ? '' : 's'}` : ''}`,
    { knowledge: hits.map((h) => ({ q: h.entry.question, score: h.score })), guide: guide?.hits.map((h) => ({ section: h.section.title, score: h.score })), signals: input.signals },
  )

  /** set by the one terminal action of this batch (reply / welcome / ask_mods / stay_silent) */
  let outcome: RunOutcome | undefined
  let flagged = false
  let proposed = false
  let kbChecked = false
  let replyText: string | undefined
  const usedKb = new Set<string>()

  const sendToChat = async (text: string, step: ReturnType<Run['steps']['begin']>): Promise<PostResult> => {
    const replyToId = quotesReplies(platform) && !target.joined ? target.msgId : undefined
    // WhatsApp chats not on auto: the reply waits for the organizer (Inbox, phone push, ✅ in #mods).
    if (replyMode(platform, chatId) === 'approve' && !simulated) {
      const body = clampReply(text)
      const action = postAction(platform, chatId, body, `Reply to ${target.userName} in ${platformLabel(platform)}${target.chatTitle ? ` · ${target.chatTitle}` : ''}`)
      action.meta = { ...action.meta, replyToId }
      const a = await requestApproval({ kind: 'post', title: `Reply to ${target.userName}`, summary: body, actions: [action], requestedBy: 'Pulse', runId: run.id, simulated })
      return { ok: true, held: a.id }
    }
    const res = await post(platform, chatId, clampReply(text), {
      runId: run.id,
      replyToId,
      threadTs: threadRoot,
      simulated,
    })
    step.tools(sendTools(platform))
    if (res.ok) {
      writeHistory(input.chatKey, { sender: 'Pulse', text, ts: Date.now() })
      if (platform === 'slack' && threadRoot && !simulated) channels.slack?.watchThread(chatId, threadRoot)
    }
    return res
  }

  const guideFooter = (section?: string): string => {
    if (!guide || !section) return ''
    const want = section.toLowerCase().replace(/^§\s*/, '')
    const match = searchGuide(chatId, section, 8).find((h) => h.section.title.toLowerCase() === want || h.section.title.toLowerCase().endsWith(want) || want.endsWith(h.section.title.toLowerCase()))
    return match ? `\n\n📎 _${guide.name} › ${match.section.title}_` : ''
  }

  const sourcesFooter = (ids: string[]): string => {
    const entries = ids.map((id) => getEntry(id)).filter((e): e is NonNullable<typeof e> => !!e)
    if (!entries.length) return ''
    const first = entries[0]!
    return `\n\n📎 [${first.question}](${first.url})`
  }

  const tools = {
    search_knowledge: tool({
      description: 'Search the community knowledge base (Notion) with a rephrased query when the KNOWLEDGE block does not cover the question.',
      inputSchema: z.object({ query: z.string().describe('what to look up') }),
      execute: async ({ query }) => {
        const step = run.steps.begin('search', 'Search the knowledge base', `“${query}”`)
        const found = searchKnowledge(query, 5)
        const sections = guide ? searchGuide(chatId, query, 3) : []
        step.ok(found.length || sections.length ? `${found.length} match(es)${found[0] ? `: ${found[0].entry.question}` : ''}${guide ? ` · ${sections.length} guide section(s)` : ''}` : 'nothing relevant', {
          results: found.map((h) => ({ id: h.entry.id, q: h.entry.question, score: h.score })),
          guide: sections.map((h) => h.section.title),
        })
        if (!found.length && !sections.length) return 'No matching entries. If this is a community-specific question, use ask_mods.'
        return {
          ...(sections.length ? { guide: sections.map((h) => ({ section: h.section.title, text: h.section.text.slice(0, 1400) })) } : {}),
          knowledge: found.map((h) => ({ kb_id: h.entry.id, question: h.entry.question, answer: h.entry.answer.slice(0, 700), relevance: h.score })),
        }
      },
    }),

    reply: tool({
      description: 'Post your answer in the chat (as a reply to the member). Pass kb_ids of the knowledge entries you used.',
      inputSchema: z.object({
        text: z.string().describe('the message, markdown allowed, 1–4 sentences'),
        kb_ids: z.array(z.string()).default([]).describe('ids of KNOWLEDGE entries the answer is based on'),
        ...(guide ? { guide_section: z.string().optional().describe('title of the GUIDE section the answer is based on, if any') } : {}),
      }),
      execute: async ({ text, kb_ids, ...rest }) => {
        const guideSection = (rest as { guide_section?: string }).guide_section
        if (outcome) return 'Already handled this batch.'
        const valid = kb_ids.filter((id) => !!getEntry(id))
        const step = run.steps.begin('reply', 'Reply in the chat', valid.length ? `answered from ${valid.length} knowledge entr${valid.length === 1 ? 'y' : 'ies'}` : 'answered')
        const full = text.trim() + (valid.length ? sourcesFooter(valid) : guideFooter(guideSection))
        const res = await sendToChat(full, step)
        if (!res.ok) {
          if (res.blocked) step.blocked(`Swytchcode policy ${res.blocked.policyId ?? res.blocked.kind} blocked the post: ${res.blocked.message}`)
          else step.error(res.error ?? 'send failed')
          return res.blocked ? `BLOCKED by guardrail (${res.blocked.message}). Rephrase without the offending content and call reply again.` : `Send failed: ${res.error}`
        }
        if (res.held) step.waiting(`reply drafted, waiting for your approval (${res.held})`, { text: full, approval: res.held })
        else step.ok(full.slice(0, 200), { text: full, kb: valid.map((id) => getEntry(id)?.question) })
        for (const id of valid) {
          usedKb.add(id)
          markUsed(id, run.id)
        }
        markAnswered(platform, chatId, questionIds, 'bot', run.id)
        outcome = 'answered'
        replyText = full
        return res.held ? 'Drafted: the organizer approves it before it is sent.' : 'Posted.'
      },
    }),

    welcome: tool({
      description: 'ONLY for a JOINED event with no question: welcome the newcomer with 1–2 useful pointers from the knowledge base and an invitation to ask anything.',
      inputSchema: z.object({ text: z.string() }),
      execute: async ({ text }) => {
        if (outcome) return 'Already handled this batch.'
        // Code-enforced: a question is never "handled" by a welcome.
        if (!batch.some((m) => m.joined) && batch.some((m) => isQuestionLike(m.text))) {
          return 'Refused: this message is a question, not a join. Answer it with reply (greeting them is fine) or use ask_mods if the knowledge base does not cover it.'
        }
        const step = run.steps.begin('welcome', 'Welcome the newcomer')
        const res = await sendToChat(text, step)
        if (!res.ok) {
          step.error(res.blocked?.message ?? res.error ?? 'send failed')
          return `Failed: ${res.blocked?.message ?? res.error}`
        }
        if (res.held) step.waiting(`welcome drafted, waiting for your approval (${res.held})`, { text, approval: res.held })
        else step.ok(text.slice(0, 200), { text })
        outcome = 'welcomed'
        replyText = text
        return res.held ? 'Drafted: the organizer approves it before it is sent.' : 'Posted.'
      },
    }),

    ask_mods: tool({
      description: 'The question is community-specific and NOT in the knowledge base: ask the organizers in Slack #mods. Pulse tells the member it is checking, relays the organizer answer later and saves it to the knowledge base.',
      inputSchema: z.object({
        question: z.string().describe('the member question, cleaned up'),
        note_to_member: z.string().describe('short friendly message to the member saying you are checking with the organizers'),
        context: z.string().default('').describe('anything the organizers should know (1 line)'),
      }),
      execute: async ({ question, note_to_member, context }) => {
        if (outcome) return 'Already handled this batch.'
        // Don't bother organizers with something the knowledge base already answers:
        // give the model the entry once and let it decide again.
        const inGuide = guide ? searchGuide(chatId, question, 1)[0] : undefined
        if (inGuide && inGuide.score >= 3 && !kbChecked) {
          kbChecked = true
          run.steps.record('search', 'Double-check the guide', 'ok', `found “${inGuide.section.title}” before asking organizers`)
          return `Before asking organizers: the GUIDE "${guide!.name}" has a section "${inGuide.section.title}":\n${inGuide.section.text.slice(0, 1400)}\nIf this answers the member, call reply with guide_section "${inGuide.section.title}". Only call ask_mods again if it truly does not answer their question.`
        }
        const known = searchKnowledge(question, 1)[0]
        if (known && known.score >= 3 && !kbChecked) {
          kbChecked = true
          run.steps.record('search', 'Double-check the knowledge base', 'ok', `found “${known.entry.question}” before asking organizers`)
          return `Before asking organizers: the knowledge base has [${known.entry.id}] Q: ${known.entry.question} A: ${known.entry.answer}. If this answers the member, call reply with kb_ids ["${known.entry.id}"]. Only call ask_mods again if it truly does not answer their question.`
        }
        const step = run.steps.begin('mods', 'Ask the organizers', question)
        if (!modsAvailable()) {
          step.error('Slack #mods is not configured')
          return 'Organizers channel unavailable. Reply honestly that you do not know yet.'
        }
        const pending = createPending({ platform, chatId, msgId: target.msgId, userName: target.userName, question, simulated })
        const card = await postModsCard(
          `❓ **${target.userName} asked something Pulse doesn't know yet**  ·  ${platformLabel(platform)}${target.chatTitle && platform !== 'slack' ? ` · ${target.chatTitle}` : ''}\n${quote(question)}${context ? `\n_${context}_` : ''}\n\nReply in this thread. Pulse will answer ${target.userName.split(' ')[0]} and save it to the knowledge base.`,
          { runId: run.id },
        )
        step.tools(['slack.chat.postmessage.create'])
        if (!card.ts) {
          step.error(card.error ?? 'could not post to #mods')
          return `Could not reach organizers: ${card.error}. Reply honestly instead.`
        }
        savePending({ ...pending, modsThreadTs: card.ts })
        input.onModReplyWatch?.(card.ts)
        const ack = await sendToChat(note_to_member, step)
        step.waiting('waiting for an organizer reply in #mods', { question, modsThreadTs: card.ts, acknowledged: ack.ok })
        outcome = 'asked_mods'
        replyText = note_to_member
        return 'Organizers asked, member acknowledged.'
      },
    }),

    flag_member: tool({
      description: 'Flag a member who is frustrated, being ignored, or asks for a human. Organizers get a card in Slack #mods.',
      inputSchema: z.object({
        member: z.string().describe('member name'),
        kind: z.enum(['frustrated', 'needs_human', 'ignored']),
        reason: z.string().describe('one line: why'),
      }),
      execute: async ({ member, kind, reason }) => {
        const m = [...batch].reverse().find((x) => x.userName === member) ?? target
        const step = run.steps.begin('flag', `Flag ${m.userName} for the organizers`, reason)
        const item = openAttention({ kind, platform, chatId, msgId: m.msgId, userId: m.userId, userName: m.userName, text: m.text, reason, simulated })
        if (modsAvailable()) {
          const card = await postModsCard(
            `${kind === 'frustrated' ? '😤' : kind === 'ignored' ? '⏳' : '🙋'} **${m.userName} needs a human**  ·  ${platformLabel(platform)}\n${quote(m.text)}\n_${reason}_`,
            { runId: run.id },
          )
          if (card.ts) updateAttention(item.id, { modsTs: card.ts })
          step.tools(['slack.chat.postmessage.create'])
        }
        step.ok(`organizers notified (${kind})`, { attention: item.id })
        flagged = true
        return 'Organizers notified. Now reply to the member with empathy and what happens next (or stay_silent if a reply would not help).'
      },
    }),

    propose_knowledge: tool({
      description: 'A member gave a correct, reusable answer to another member. Ask organizers to approve saving it to the knowledge base (they react ✅ in Slack).',
      inputSchema: z.object({
        question: z.string().describe('general reusable question'),
        answer: z.string().describe('complete standalone answer'),
        helper: z.string().describe('name of the member who answered'),
      }),
      execute: async ({ question, answer, helper }) => {
        const step = run.steps.begin('knowledge', 'Propose saving a member answer', `${helper}: ${question}`)
        const helperMsg = [...batch].reverse().find((x) => x.userName === helper) ?? target
        const a = await requestApproval({
          kind: 'knowledge',
          title: `Save ${helper}'s answer to the FAQ`,
          summary: `**Q:** ${question}\n**A:** ${answer}\n_answered by ${helper} in ${platformLabel(platform)}_`,
          actions: [
            {
              ...knowledgeAction({ question, answer, source: 'Member', learnedFrom: `${helper} (${platformLabel(platform)})`, scripted: simulated }),
              meta: {
                entry: { question, answer, source: 'Member', learnedFrom: `${helper} (${platformLabel(platform)})`, scripted: simulated },
                helper,
                platform,
                chatId,
                msgId: helperMsg.msgId,
                threadTs: threadRoot,
              },
            },
          ],
          requestedBy: 'Pulse',
          runId: run.id,
          simulated,
        })
        step.tools(['notion.page.create', 'slack.chat.postmessage.create'])
        step.waiting(`waiting for ✅ in #mods (${a.id})`, { approval: a.id })
        proposed = true
        return 'Proposal sent to organizers.'
      },
    }),

    react: tool({
      description: 'Add an emoji reaction to the latest message (Slack only), e.g. to acknowledge a helpful answer.',
      inputSchema: z.object({ emoji: z.string().describe('slack emoji name without colons, e.g. raised_hands') }),
      execute: async ({ emoji }) => {
        if (platform !== 'slack' || !channels.slack || simulated) return 'Reactions unavailable here.'
        await channels.slack.ack(chatId, target.msgId, emoji.replace(/:/g, ''))
        run.steps.record('react', `React :${emoji}:`, 'ok', undefined, undefined, ['slack.reactions.add.create'])
        return 'Reacted.'
      },
    }),

    stay_silent: tool({
      description: 'Do not post anything (chit-chat, thanks, already answered, not for Pulse).',
      inputSchema: z.object({ reason: z.string() }),
      execute: async ({ reason }) => {
        if (outcome) return 'Already handled this batch.'
        outcome = 'silent'
        run.steps.record('silent', 'Stay silent', 'ok', reason)
        return 'OK.'
      },
    }),
  }

  // A flag always wins (organizers must see it); a proposal wins over silence.
  const finalOutcome = (): RunOutcome => (flagged ? 'escalated' : proposed && (!outcome || outcome === 'silent') ? 'proposed' : outcome ?? 'silent')

  let steps = 0
  const now = new Date().toLocaleString('en-IN', { weekday: 'short', day: 'numeric', month: 'short', year: 'numeric', hour: 'numeric', minute: '2-digit', hour12: true, timeZone: 'Asia/Kolkata' })
  const think = run.steps.begin('think', 'Decide what the community needs')
  try {
    await generateText({
      model: input.model,
      instructions: communityInstructions({ platform: platformLabel(platform), chatTitle: target.chatTitle, now, guide: guide?.name }),
      // Chats without a guide still get the event's live timeline (what's done, on, next).
      prompt: buildContext(input, hits, guide, guide ? undefined : eventNow()),
      tools,
      toolChoice: 'required',
      maxRetries: 0,
      providerOptions: { groq: { reasoningEffort: 'low' }, google: { thinkingConfig: { thinkingLevel: 'minimal' } } },
      stopWhen: [isStepCount(MAX_STEPS), () => outcome !== undefined],
      onStepEnd: (step) => {
        steps++
        const served = step.response?.modelId
        if (served) run.steps.model = served
        if (steps === 1) {
          const calls = step.toolCalls?.map((c) => c.toolName).join(' → ')
          think.ok(calls ? `chose ${calls}` : 'decided', { model: served })
        }
      },
    })
    if (steps === 0) think.ok()
    return { outcome: finalOutcome(), reply: replyText, steps }
  } catch (e) {
    const msg = String((e as Error)?.message ?? e)
    think.error(msg.slice(0, 200))
    return { outcome: outcome || flagged || proposed ? finalOutcome() : 'failed', reply: replyText, steps, error: msg }
  }
}

export const communityProfile = () => ({ name: env.COMMUNITY_NAME, about: env.COMMUNITY_ABOUT })

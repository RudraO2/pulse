import { generateText, isStepCount, tool, type LanguageModel } from 'ai'
import { z } from 'zod'
import { env } from '../config/env.js'
import { channels, post } from '../core/channels.js'
import { requestApproval, knowledgeAction } from '../core/approvals.js'
import { modsAvailable, platformLabel, postModsCard, quote } from '../core/mods.js'
import type { Run } from '../core/runs.js'
import { createPending, openAttention, savePending } from '../core/state-docs.js'
import { writeHistory, type Message } from '../conversation/memory.js'
import { getEntry, markUsed, searchKnowledge, type KbHit } from '../kb/knowledge.js'
import type { InboundMessage, RunOutcome } from '../shared/events.js'
import { markAnswered } from '../store/repo.js'
import { redact } from '../swy/redact.js'
import { clampReply } from './format.js'
import { communityInstructions } from './prompts.js'

// The Community Agent: one tool loop per message batch. It decides whether
// the community needs an answer (from Notion), the organizers (Slack #mods),
// a welcome, a flag, a knowledge proposal, or silence. All effects go through
// Swytchcode via the channel/approval layers.

const MAX_STEPS = 5

export interface MemberSignal {
  msgId: string
  frustration: number
  repeatOf?: { text: string; userName: string; answered: boolean }
  asksToday: number
  isNew: boolean
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

export function buildContext(input: Omit<CommunityRunInput, 'run' | 'model'>, hits: KbHit[]): string {
  const hist = input.history
    .slice(-30, -input.batch.length || undefined)
    .map((m) => `${m.ts ? `${fmtTime(m.ts)} ` : ''}${m.sender}: ${redact(m.text).slice(0, 300)}`)
  const batch = input.batch.map((m) => {
    const s = input.signals.find((x) => x.msgId === m.msgId)
    const tags = [
      m.joined ? 'JOINED' : '',
      m.addressed ? 'addressed to Pulse' : '',
      s?.isNew ? 'new member' : '',
      s && s.frustration >= 0.3 ? `frustration≈${s.frustration.toFixed(1)}` : '',
      s && s.asksToday >= 2 ? `asked ${s.asksToday}× today` : '',
      s?.repeatOf ? `REPEAT of "${s.repeatOf.text.slice(0, 80)}" (asked by ${s.repeatOf.userName}${s.repeatOf.answered ? ', answered before' : ''})` : '',
      m.replyToId ? `reply to msg ${m.replyToId}` : '',
    ].filter(Boolean)
    return `[${m.msgId}] ${m.userName}${tags.length ? ` {${tags.join('; ')}}` : ''}: ${redact(m.text).slice(0, 800)}`
  })
  return [
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
  run.steps.record(
    'context',
    'Read the conversation',
    'ok',
    `${batch.length} new message(s), ${input.history.length} in memory · ${hits.length} knowledge match${hits.length === 1 ? '' : 'es'}`,
    { knowledge: hits.map((h) => ({ q: h.entry.question, score: h.score })), signals: input.signals },
  )

  let outcome: RunOutcome | undefined
  let replyText: string | undefined
  const usedKb = new Set<string>()

  const sendToChat = async (text: string, step: ReturnType<Run['steps']['begin']>) => {
    const res = await post(platform, chatId, clampReply(text), {
      runId: run.id,
      replyToId: platform === 'telegram' && !target.joined ? target.msgId : undefined,
      threadTs: threadRoot,
      simulated,
    })
    step.tools([platform === 'telegram' ? 'telegram_v5_0.sendmessage.create' : 'slack.chat.postmessage.create'])
    if (res.ok) {
      writeHistory(input.chatKey, { sender: 'Pulse', text, ts: Date.now() })
      if (platform === 'slack' && threadRoot && !simulated) channels.slack?.watchThread(chatId, threadRoot)
    }
    return res
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
        step.ok(found.length ? `${found.length} match(es): ${found[0]!.entry.question}` : 'nothing relevant', { results: found.map((h) => ({ id: h.entry.id, q: h.entry.question, score: h.score })) })
        return found.length
          ? found.map((h) => ({ kb_id: h.entry.id, question: h.entry.question, answer: h.entry.answer.slice(0, 700), relevance: h.score }))
          : 'No matching entries. If this is a community-specific question, use ask_mods.'
      },
    }),

    reply: tool({
      description: 'Post your answer in the chat (as a reply to the member). Pass kb_ids of the knowledge entries you used.',
      inputSchema: z.object({
        text: z.string().describe('the message, markdown allowed, 1–4 sentences'),
        kb_ids: z.array(z.string()).default([]).describe('ids of KNOWLEDGE entries the answer is based on'),
      }),
      execute: async ({ text, kb_ids }) => {
        if (outcome) return 'Already handled this batch.'
        const valid = kb_ids.filter((id) => !!getEntry(id))
        const step = run.steps.begin('reply', 'Reply in the chat', valid.length ? `answered from ${valid.length} knowledge entr${valid.length === 1 ? 'y' : 'ies'}` : 'answered')
        const full = text.trim() + sourcesFooter(valid)
        const res = await sendToChat(full, step)
        if (!res.ok) {
          if (res.blocked) step.blocked(`Swytchcode policy ${res.blocked.policyId ?? res.blocked.kind} blocked the post: ${res.blocked.message}`)
          else step.error(res.error ?? 'send failed')
          return res.blocked ? `BLOCKED by guardrail (${res.blocked.message}). Rephrase without the offending content and call reply again.` : `Send failed: ${res.error}`
        }
        step.ok(full.slice(0, 200), { text: full, kb: valid.map((id) => getEntry(id)?.question) })
        for (const id of valid) {
          usedKb.add(id)
          markUsed(id, run.id)
        }
        markAnswered(platform, chatId, questionIds, 'bot', run.id)
        outcome = 'answered'
        replyText = full
        return 'Posted.'
      },
    }),

    welcome: tool({
      description: 'Welcome a member who just joined, with 1–2 useful pointers from the knowledge base and an invitation to ask anything.',
      inputSchema: z.object({ text: z.string() }),
      execute: async ({ text }) => {
        if (outcome) return 'Already handled this batch.'
        const step = run.steps.begin('welcome', 'Welcome the newcomer')
        const res = await sendToChat(text, step)
        if (!res.ok) {
          step.error(res.blocked?.message ?? res.error ?? 'send failed')
          return `Failed: ${res.blocked?.message ?? res.error}`
        }
        step.ok(text.slice(0, 200), { text })
        outcome = 'welcomed'
        replyText = text
        return 'Posted.'
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
        const step = run.steps.begin('mods', 'Ask the organizers', question)
        if (!modsAvailable()) {
          step.error('Slack #mods is not configured')
          return 'Organizers channel unavailable. Reply honestly that you do not know yet.'
        }
        const pending = createPending({ platform, chatId, msgId: target.msgId, userName: target.userName, question, simulated })
        const card = await postModsCard(
          `❓ **${target.userName} asked something Pulse doesn't know yet**  ·  ${platformLabel(platform)}${target.chatTitle && platform === 'telegram' ? ` · ${target.chatTitle}` : ''}\n${quote(question)}${context ? `\n_${context}_` : ''}\n\nReply in this thread. Pulse will answer ${target.userName.split(' ')[0]} and save it to the knowledge base.`,
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
          await postModsCard(
            `${kind === 'frustrated' ? '😤' : kind === 'ignored' ? '⏳' : '🙋'} **${m.userName} needs a human**  ·  ${platformLabel(platform)}\n${quote(m.text)}\n_${reason}_`,
            { runId: run.id },
          )
          step.tools(['slack.chat.postmessage.create'])
        }
        step.ok(`organizers notified (${kind})`, { attention: item.id })
        if (!outcome) outcome = 'escalated'
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
        if (!outcome) outcome = 'proposed'
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
        if (!outcome) outcome = 'silent'
        run.steps.record('silent', 'Stay silent', 'ok', reason)
        return 'OK.'
      },
    }),
  }

  let steps = 0
  const now = new Date().toLocaleString('en-IN', { weekday: 'short', hour: '2-digit', minute: '2-digit', timeZone: 'Asia/Kolkata' })
  const think = run.steps.begin('think', 'Decide what the community needs')
  try {
    await generateText({
      model: input.model,
      instructions: communityInstructions({ platform: platformLabel(platform), chatTitle: target.chatTitle, now }),
      prompt: buildContext(input, hits),
      tools,
      toolChoice: 'required',
      maxRetries: 0,
      providerOptions: { groq: { reasoningEffort: 'low' }, google: { thinkingConfig: { thinkingLevel: 'minimal' } } },
      stopWhen: [isStepCount(MAX_STEPS), () => outcome !== undefined && outcome !== 'escalated' && outcome !== 'proposed'],
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
    return { outcome: outcome ?? 'silent', reply: replyText, steps }
  } catch (e) {
    const msg = String((e as Error)?.message ?? e)
    think.error(msg.slice(0, 200))
    return { outcome: outcome ?? 'failed', reply: replyText, steps, error: msg }
  }
}

export const communityProfile = () => ({ name: env.COMMUNITY_NAME, about: env.COMMUNITY_ABOUT })

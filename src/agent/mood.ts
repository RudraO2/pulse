import { generateText, tool, type LanguageModel } from 'ai'
import { z } from 'zod'
import type { Emotion, InboundMessage } from '../shared/events.js'
import { redact } from '../swy/redact.js'
import { heuristicFrustration, wantsHuman } from './triage.js'

// Reads how each member feels, per message. A small fast model does it (with
// the recent conversation, so "thanks, works now" after a fix reads as solved);
// the old keyword scorer is the instant fallback when no model answers in time.

export interface MoodReading {
  msgId: string
  /** -1 (very upset) … +1 (delighted) */
  score: number
  emotion: Emotion
  /** the member is stuck / something isn't working / they need help beyond a quick fact */
  problem: boolean
  /** the member says their problem is solved */
  resolved: boolean
  wantsHuman: boolean
  /** the problem in a few words, when there is one */
  topic?: string
  via: 'llm' | 'keywords'
}

export interface MoodContext {
  /** recent lines of the chat, oldest first */
  history: Array<{ sender: string; text: string }>
  /** open problems per member name, so follow-ups are read in context */
  openCases: Array<{ userName: string; topic: string; mood: number }>
}

const EMOTIONS = ['happy', 'grateful', 'calm', 'confused', 'anxious', 'annoyed', 'angry', 'desperate'] as const

const POSITIVE = /\b(thanks|thank you|thx|ty|works now|working now|it works|fixed|solved|sorted|got it|perfect|awesome|great|legend|appreciate)\b|🙏|🎉|❤️|🙌/i
const SOLVED = /\b(works now|working now|it works|it'?s working|fixed( it)?|solved|sorted|got it working|all good now|that did it|that worked)\b/i
const PROBLEM = /\b(error|broken|not working|doesn'?t work|isn'?t working|fails?|failing|failed|stuck|can'?t|cannot|won'?t|hangs?|crash\w*|timeout|timed out|still)\b/i

/** Instant, model-free reading. Good enough to escalate the obvious cases. */
export function keywordMood(m: InboundMessage, recentAsks = 0): MoodReading {
  const frustration = Math.max(heuristicFrustration(m.text, recentAsks), wantsHuman(m.text) ? 0.5 : 0)
  const solved = SOLVED.test(m.text) && frustration < 0.3
  const positive = POSITIVE.test(m.text) && frustration < 0.3
  const problem = !solved && (frustration >= 0.3 || PROBLEM.test(m.text))
  const score = solved ? 0.6 : positive ? 0.4 : problem ? -Math.max(0.25, frustration) : -frustration
  const emotion: Emotion = solved || positive ? 'grateful' : frustration >= 0.9 ? 'angry' : frustration >= 0.3 ? 'annoyed' : problem ? 'confused' : 'calm'
  return { msgId: m.msgId, score: round(score), emotion, problem, resolved: solved, wantsHuman: wantsHuman(m.text), via: 'keywords' }
}

const ASK_FOR_PERSON = /\b(real person|a human|talk to (a |an |the )?(human|person|organi[sz]er|admin|team|someone)|speak to (a |an |the )?(human|person|organi[sz]er|admin|someone))\b/i

const round = (n: number) => Math.max(-1, Math.min(1, Number(n.toFixed(2))))

const INSTRUCTIONS = `You read the mood of community members for a community manager. For EACH new message return one rating via rate_messages.
- score: -1 (furious/desperate) … 0 (neutral) … +1 (delighted). Plain questions are about 0. Mild confusion ≈ -0.2. Annoyed ≈ -0.5. Caps, "wasted an hour", "nothing works" ≈ -0.8.
- problem: true if the member is stuck, something is broken for them, or they're unhappy with the community/organizers. A simple info question ("what time is lunch?") is NOT a problem.
- resolved: true only if they say their problem is fixed / it works now / they're sorted (a thank-you after help counts).
- wants_human: they ask for a person, an organizer or the team.
- topic: the problem in 3-7 words (only when problem or resolved).
Read each message in context: the recent conversation and any open problem that member already has. Sarcasm ("great, broken again") is negative.`

/** Rate a batch of messages. Falls back to keywords if the model is missing, slow or fails. */
export async function readMood(batch: InboundMessage[], ctx: MoodContext, opts: { model?: LanguageModel; timeoutMs?: number; recentAsks?: (m: InboundMessage) => number } = {}): Promise<MoodReading[]> {
  const fallback = () => batch.map((m) => keywordMood(m, opts.recentAsks?.(m) ?? 0))
  if (!opts.model || !batch.length) return fallback()

  const lines = batch.map((m) => `[${m.msgId}] ${m.userName}: ${redact(m.text).slice(0, 500)}`)
  const cases = ctx.openCases.length ? `OPEN PROBLEMS:\n${ctx.openCases.map((c) => `- ${c.userName}: ${c.topic} (mood ${c.mood.toFixed(1)})`).join('\n')}\n\n` : ''
  const hist = ctx.history.slice(-8).map((h) => `${h.sender}: ${redact(h.text).slice(0, 200)}`)
  let rated: MoodReading[] | undefined
  try {
    await generateText({
      model: opts.model,
      instructions: INSTRUCTIONS,
      prompt: `${cases}RECENT CONVERSATION:\n${hist.join('\n') || '(none)'}\n\nNEW MESSAGES:\n${lines.join('\n')}`,
      tools: {
        rate_messages: tool({
          description: 'Return one rating per new message.',
          inputSchema: z.object({
            ratings: z.array(
              z.object({
                msg_id: z.string(),
                score: z.number(),
                emotion: z.enum(EMOTIONS),
                problem: z.boolean(),
                resolved: z.boolean(),
                wants_human: z.boolean(),
                topic: z.string().optional(),
              }),
            ),
          }),
          execute: async ({ ratings }) => {
            rated = ratings.map((r) => ({
              msgId: r.msg_id,
              score: round(r.score),
              emotion: r.emotion,
              problem: r.problem,
              resolved: r.resolved,
              wantsHuman: r.wants_human,
              topic: r.topic?.trim() || undefined,
              via: 'llm' as const,
            }))
            return 'ok'
          },
        }),
      },
      toolChoice: 'required',
      maxRetries: 0,
      abortSignal: AbortSignal.timeout(opts.timeoutMs ?? 3500),
      providerOptions: { groq: { reasoningEffort: 'low' }, google: { thinkingConfig: { thinkingLevel: 'minimal' } } },
      stopWhen: () => !!rated,
    })
  } catch {
    return fallback()
  }
  if (!rated) return fallback()
  // Keep the model's reading per message; anything it skipped gets the keyword reading.
  // An unmistakable request for a person is never lost, whatever the model said.
  return batch.map((m) => {
    const r = rated!.find((x) => x.msgId === m.msgId)
    return r ? { ...r, wantsHuman: r.wantsHuman || ASK_FOR_PERSON.test(m.text) } : keywordMood(m, opts.recentAsks?.(m) ?? 0)
  })
}

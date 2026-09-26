import { quotesReplies, sendTools } from '../channels/platforms.js'
import { bus } from '../bus.js'
import { env } from '../config/env.js'
import { post, replyMode } from '../core/channels.js'
import { modsAvailable, platformLabel, postModsCard, quote } from '../core/mods.js'
import { startRun } from '../core/runs.js'
import { createPending, openAttention, savePending } from '../core/state-docs.js'
import { sweepCases } from '../core/cases.js'
import { markUsed, searchKnowledge } from '../kb/knowledge.js'
import { watchModsThread } from '../pipeline.js'
import { markAnswered, markEscalated, unansweredQuestions, type StoredMessage } from '../store/repo.js'
import { sendDigest } from './digest.js'

// Periodic care: questions nobody answered get revived. If the knowledge
// base answers them, Pulse replies; otherwise it nudges the organizers once
// and flags the member as "ignored". Plus the weekly digest.

let sweepTimer: ReturnType<typeof setInterval> | undefined
let digestTimer: ReturnType<typeof setInterval> | undefined
let sweeping = false

export interface SweepOptions {
  olderThanMs?: number
  includeScripted?: boolean
  onlyScripted?: boolean
}

export async function runSweep(opts: SweepOptions = {}): Promise<{ checked: number; answered: number; nudged: number }> {
  if (sweeping) return { checked: 0, answered: 0, nudged: 0 }
  sweeping = true
  try {
    const olderThan = opts.olderThanMs ?? env.IGNORED_AFTER_MIN * 60_000
    const items = unansweredQuestions(olderThan, 6 * 3600_000).filter((m) => (opts.onlyScripted ? m.simulated : opts.includeScripted || !m.simulated))
    if (!items.length) return { checked: 0, answered: 0, nudged: 0 }
    const run = startRun('sweep', `${items.length} unanswered question(s) older than ${Math.round(olderThan / 60_000)} min`, { simulated: items.every((m) => m.simulated) })
    run.steps.record('context', 'Find ignored questions', 'ok', items.map((m) => `${m.userName}: ${m.text.slice(0, 60)}`).join(' · '))
    let answered = 0
    let nudged = 0
    for (const m of items.slice(0, 8)) {
      const hit = searchKnowledge(m.text, 1)[0]
      // WhatsApp chats not on auto: organizers decide, so nudge them instead of answering.
      if (hit && hit.score >= 4 && replyMode(m.platform, m.chatId) === 'auto') {
        const step = run.steps.begin('reply', `Answer ${m.userName} from the knowledge base`, hit.entry.question, undefined, sendTools(m.platform))
        const res = await post(m.platform, m.chatId, `Sorry for the wait, ${m.userName.split(' ')[0]}! ${hit.entry.answer}\n\n📎 [${hit.entry.question}](${hit.entry.url})`, {
          runId: run.id,
          replyToId: quotesReplies(m.platform) ? m.msgId : undefined,
          threadTs: m.platform === 'slack' ? m.threadTs ?? m.msgId : undefined,
          simulated: m.simulated,
        })
        if (res.ok) {
          markUsed(hit.entry.id, run.id)
          markAnswered(m.platform, m.chatId, [m.msgId], 'bot', run.id)
          step.ok('answered')
          answered++
        } else step.error(res.blocked?.message ?? res.error ?? 'failed')
        continue
      }
      await nudge(m, run.id, run.steps)
      nudged++
    }
    run.end(answered ? 'answered' : 'escalated', { summary: `${answered} answered from knowledge, ${nudged} sent to organizers` })
    return { checked: items.length, answered, nudged }
  } finally {
    sweeping = false
  }
}

async function nudge(m: StoredMessage, runId: string, steps: ReturnType<typeof startRun>['steps']): Promise<void> {
  const mins = Math.round((Date.now() - m.ts) / 60_000)
  const step = steps.begin('flag', `Nudge organizers about ${m.userName}`, `unanswered for ${mins} min`, undefined, ['slack.chat.postmessage.create'])
  openAttention({ kind: 'ignored', platform: m.platform, chatId: m.chatId, msgId: m.msgId, userId: m.userId, userName: m.userName, text: m.text, reason: `No answer for ${mins} min`, simulated: m.simulated })
  markEscalated(m.platform, m.chatId, m.msgId)
  if (!modsAvailable()) {
    step.ok('flagged on the dashboard (no #mods channel)')
    return
  }
  const pending = createPending({ platform: m.platform, chatId: m.chatId, msgId: m.msgId, userName: m.userName, question: m.text, simulated: m.simulated })
  const card = await postModsCard(
    `⏳ **${m.userName} has been waiting ${mins} min**  ·  ${platformLabel(m.platform)}\n${quote(m.text)}\nNobody has answered and it isn't in the knowledge base. Reply in this thread and Pulse will answer and remember it.`,
    { runId },
  )
  if (card.ts) {
    savePending({ ...pending, modsThreadTs: card.ts })
    if (!m.simulated) watchModsThread(card.ts)
    step.waiting('organizers nudged in #mods')
  } else step.error(card.error ?? 'could not post')
}

export function startScheduler(): void {
  if (!sweepTimer) {
    sweepTimer = setInterval(() => {
      void runSweep().catch((e) => bus.emit({ type: 'log', level: 'error', text: `sweep: ${(e as Error).message}` }))
      // Upset members left waiting get a human; quiet cases close themselves.
      void sweepCases().catch((e) => bus.emit({ type: 'log', level: 'error', text: `case sweep: ${(e as Error).message}` }))
    }, env.SWEEP_EVERY_MIN * 60_000)
    sweepTimer.unref?.()
  }
  if (!digestTimer) {
    // Weekly digest: Monday 09:00 IST, checked every 10 minutes.
    digestTimer = setInterval(() => {
      const ist = new Date(Date.now() + 5.5 * 3600_000)
      if (ist.getUTCDay() === 1 && ist.getUTCHours() === 9 && ist.getUTCMinutes() < 10) void sendDigest({ trigger: 'weekly' })
    }, 10 * 60_000)
    digestTimer.unref?.()
  }
}

export function stopScheduler(): void {
  if (sweepTimer) clearInterval(sweepTimer)
  if (digestTimer) clearInterval(digestTimer)
  sweepTimer = digestTimer = undefined
}

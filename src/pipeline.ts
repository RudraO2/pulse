import { bus } from './bus.js'
import { runCommunityAgent, type MemberSignal } from './agent/community.js'
import { handleModReply } from './agent/learn.js'
import { communityModel, consoleModel } from './agent/models.js'
import { directedAt, heuristicFrustration, isNoise, isQuestionLike, wantsHuman } from './agent/triage.js'
import { createBatcher, type Batcher } from './conversation/batcher.js'
import { readHistory } from './conversation/memory.js'
import { channels, post } from './core/channels.js'
import { modsChannel } from './core/mods.js'
import { startRun } from './core/runs.js'
import { openAttention, pendingByThread, waitingQuestions } from './core/state-docs.js'
import { modsAvailable, platformLabel, postModsCard, quote } from './core/mods.js'
import { markUsed, searchKnowledge } from './kb/knowledge.js'
import type { InboundMessage } from './shared/events.js'
import { getDb } from './store/db.js'
import { insertMessage, insertQuestion, markAnswered, searchQuestions } from './store/repo.js'

// Inbound → store → batch window → Community Agent. The batching, backlog
// drain and per-chat serial lanes are the WhatsApp bot's patterns (batcher.ts).

let batcher: Batcher | undefined

function asksToday(m: InboundMessage): number {
  const since = Date.now() - 12 * 3600_000
  const r = getDb()
    .prepare('SELECT COUNT(*) AS n FROM messages WHERE platform = ? AND user_id = ? AND question_like = 1 AND ts >= ? AND simulated = ?')
    .get(m.platform, m.userId, since, m.simulated ? 1 : 0) as { n: number }
  return Number(r.n)
}

function isNewMember(m: InboundMessage): boolean {
  if (m.joined) return true
  const r = getDb()
    .prepare('SELECT COUNT(*) AS n FROM messages WHERE platform = ? AND user_id = ? AND simulated = ?')
    .get(m.platform, m.userId, m.simulated ? 1 : 0) as { n: number }
  return Number(r.n) <= 1
}

function signalsFor(batch: InboundMessage[], history: Array<{ sender: string; text: string }>): MemberSignal[] {
  return batch.map((m) => {
    const aimed = directedAt(m.text)
    // An @reply to someone who recently asked a question, that isn't itself a question, is probably an answer.
    const asker = aimed
      ? [...history].reverse().slice(0, 12).find((h) => h.sender.toLowerCase().startsWith(aimed.toLowerCase()) && isQuestionLike(h.text))?.sender
      : undefined
    const asks = asksToday(m)
    const past = isQuestionLike(m.text) ? searchQuestions(m.text, { limit: 3 }).filter((q) => q.msgId !== m.msgId && q.score > 3) : []
    const top = past[0]
    return {
      msgId: m.msgId,
      frustration: Math.max(heuristicFrustration(m.text, asks), wantsHuman(m.text) ? 0.5 : 0),
      asksToday: asks,
      isNew: isNewMember(m),
      repeatOf: top ? { text: top.text, userName: top.userName, answered: false } : undefined,
      directedAt: aimed,
      answersQuestionOf: asker && !isQuestionLike(m.text) ? asker : undefined,
    }
  })
}

/** Watch a #mods thread; the first organizer reply feeds the learning loop. */
export function watchModsThread(ts: string): void {
  const slack = channels.slack
  const channel = modsChannel()
  if (!slack || !channel) return
  slack.watchThread(
    channel,
    ts,
    (reply) => {
      const p = pendingByThread(ts)
      if (p) void handleModReply(p.id, { userName: reply.userName, text: reply.text }).catch((e) => bus.emit({ type: 'log', level: 'error', text: `learning loop: ${(e as Error).message}` }))
    },
    24 * 3600_000,
  )
}

async function fallbackAnswer(batch: InboundMessage[], runId: string): Promise<'answered' | 'silent'> {
  // No LLM configured/available: answer only confident knowledge-base hits.
  const target = batch[batch.length - 1]!
  if (!isQuestionLike(target.text)) return 'silent'
  const hit = searchKnowledge(target.text, 1)[0]
  if (!hit || hit.score < 4) return 'silent'
  const res = await post(target.platform, target.chatId, `${hit.entry.answer}\n\n📎 [${hit.entry.question}](${hit.entry.url})`, {
    runId,
    replyToId: target.platform === 'telegram' ? target.msgId : undefined,
    threadTs: target.platform === 'slack' ? target.threadTs ?? target.msgId : undefined,
    simulated: target.simulated,
  })
  if (res.ok) {
    markUsed(hit.entry.id, runId)
    markAnswered(target.platform, target.chatId, [target.msgId], 'bot', runId)
    return 'answered'
  }
  return 'silent'
}

async function onBatch(key: string, batch: InboundMessage[]): Promise<void> {
  const relevant = batch.filter((m) => m.joined || !isNoise(m.text) || m.addressed)
  if (!relevant.length) return
  const target = relevant[relevant.length - 1]!
  // Scripted demo runs use the most reliable chain (Claude first); real traffic stays on the fast free chain.
  const model = target.simulated ? consoleModel() ?? communityModel() : communityModel()

  // Feedback while thinking: Telegram "typing…", Slack 👀 on the question.
  if (!target.simulated && (target.addressed || isQuestionLike(target.text))) {
    if (target.platform === 'telegram') void channels.telegram?.typing(target.chatId)
    if (target.platform === 'slack') void channels.slack?.ack(target.chatId, target.msgId, 'eyes')
  }

  const run = startRun('community', relevant.map((m) => `${m.userName}: ${m.text}`).join('\n'), {
    platform: target.platform,
    chatId: target.chatId,
    userName: target.userName,
    simulated: target.simulated,
  })
  try {
    if (!model) {
      const outcome = await fallbackAnswer(relevant, run.id)
      run.end(outcome, { summary: 'no LLM configured: knowledge-base fallback' })
      return
    }
    const waiting = waitingQuestions()
      .filter((p) => p.chatId === target.chatId && p.platform === target.platform)
      .map((p) => p.question)
    const history = readHistory(key, 40)
    const signals = signalsFor(relevant, history)

    // A question aimed at another member is theirs to answer: Pulse stays out of it
    // (the care sweep revives it if nobody replies).
    if (!target.addressed && relevant.every((m) => signals.find((x) => x.msgId === m.msgId)?.directedAt && isQuestionLike(m.text))) {
      run.steps.record('silent', 'Stay silent', 'ok', `question aimed at @${signals[0]?.directedAt}, not Pulse; the care sweep will follow up if nobody answers`)
      run.end('silent')
      return
    }

    const result = await runCommunityAgent({
      run,
      model,
      chatKey: key,
      batch: relevant,
      history,
      signals,
      waiting,
      onModReplyWatch: (ts) => {
        if (!target.simulated) watchModsThread(ts)
      },
    })
    if (result.error && result.outcome === 'failed') {
      const outcome = await fallbackAnswer(relevant, run.id)
      run.end(outcome === 'answered' ? 'answered' : 'failed', { summary: `model error: ${result.error.slice(0, 120)}` })
      return
    }
    // Safety net in code: strong frustration or a request for a human always reaches the organizers.
    let outcome = result.outcome
    if (outcome !== 'escalated') {
      const upset = relevant.find((m) => {
        const sig = signals.find((x) => x.msgId === m.msgId)
        return (sig?.frustration ?? 0) >= 0.6 || wantsHuman(m.text)
      })
      if (upset) {
        const reason = wantsHuman(upset.text) ? 'asked for a human' : 'strong frustration signals'
        openAttention({ kind: wantsHuman(upset.text) ? 'needs_human' : 'frustrated', platform: upset.platform, chatId: upset.chatId, msgId: upset.msgId, userId: upset.userId, userName: upset.userName, text: upset.text, reason, simulated: upset.simulated })
        if (modsAvailable()) await postModsCard(`😤 **${upset.userName} needs a human**  ·  ${platformLabel(upset.platform)}\n${quote(upset.text)}\n_${reason} (safety net)_`, { runId: run.id })
        run.steps.record('flag', `Flag ${upset.userName} for the organizers`, 'ok', `${reason} (code safety net)`, undefined, modsAvailable() ? ['slack.chat.postmessage.create'] : undefined)
        outcome = 'escalated'
      }
    }
    run.end(outcome, { reply: result.reply })
  } catch (e) {
    run.end('failed', { summary: String((e as Error).message).slice(0, 160) })
  }
}

export function ingest(msg: InboundMessage): void {
  const questionLike = !msg.joined && isQuestionLike(msg.text)
  const fresh = insertMessage(msg, questionLike)
  if (!fresh) return
  if (questionLike) insertQuestion({ platform: msg.platform, chatId: msg.chatId, msgId: msg.msgId, userName: msg.userName, text: msg.text, ts: msg.ts, simulated: msg.simulated })
  bus.emit({ type: 'message.in', msg })
  batcher?.push(msg)
}

export function createPipeline(opts: { groupCollectMs?: number; dmCollectMs?: number } = {}): Batcher {
  batcher = createBatcher({
    onBatch: (key, batch) => onBatch(key, batch),
    groupCollectMs: opts.groupCollectMs ?? 3000,
    dmCollectMs: opts.dmCollectMs ?? 2000,
    groupMaxWaitMs: 12_000,
    dmMaxWaitMs: 12_000,
  })
  return batcher
}

/** Re-attach thread watchers for questions still waiting on organizers (after a restart). */
export function rewatchPending(): void {
  for (const p of waitingQuestions()) if (p.modsThreadTs && !p.simulated) watchModsThread(p.modsThreadTs)
}

export const pipelineBatcher = (): Batcher | undefined => batcher

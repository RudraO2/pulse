import { quotesReplies } from './channels/platforms.js'
import { bus } from './bus.js'
import { runCommunityAgent, type MemberSignal } from './agent/community.js'
import { handleModReply } from './agent/learn.js'
import { communityModel, consoleModel, lightModel } from './agent/models.js'
import { readMood, type MoodReading } from './agent/mood.js'
import { directedAt, isNoise, isQuestionLike } from './agent/triage.js'
import { activeCases, caseOf, escalate, fmtMood, getCase, moodTrend, noteReply, observe, shouldEscalate } from './core/cases.js'
import type { Run } from './core/runs.js'
import { createBatcher, type Batcher } from './conversation/batcher.js'
import { readHistory } from './conversation/memory.js'
import { channels, post } from './core/channels.js'
import { modsChannel } from './core/mods.js'
import { startRun } from './core/runs.js'
import { pendingByThread, waitingQuestions } from './core/state-docs.js'
import { markUsed, searchKnowledge } from './kb/knowledge.js'
import type { InboundMessage, MemberCase, RunOutcome } from './shared/events.js'
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

function signalsFor(batch: InboundMessage[], history: Array<{ sender: string; text: string }>, readings: MoodReading[]): MemberSignal[] {
  return batch.map((m) => {
    const r = readings.find((x) => x.msgId === m.msgId)
    const c = caseOf(m.platform, m.userId, !!m.simulated)
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
      frustration: r ? Math.max(0, -r.score) : 0,
      mood: r ? { score: r.score, emotion: r.emotion, wantsHuman: r.wantsHuman } : undefined,
      case: c ? { topic: c.topic, trend: moodTrend(c), status: c.status, pulseReplies: c.pulseReplies } : undefined,
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
    replyToId: quotesReplies(target.platform) ? target.msgId : undefined,
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

/** Feed mood readings into member cases; one visible step says what Pulse noticed. */
function trackMood(run: Run, batch: InboundMessage[], readings: MoodReading[]): MemberCase[] {
  const touched = new Map<string, MemberCase>()
  const notes: string[] = []
  for (const m of batch) {
    const r = readings.find((x) => x.msgId === m.msgId)
    if (!r) continue
    const res = observe(m, r)
    if (res.case) touched.set(res.case.id, res.case)
    const who = m.userName.split(' ')[0]
    const tag = res.opened ? `, case opened: ${res.case!.topic}` : res.resolved ? ', sorted: case closed' : res.case ? `, case mood ${fmtMood(res.case.mood)}` : ''
    if (res.case || r.score <= -0.2 || r.wantsHuman) notes.push(`${who} ${fmtMood(r.score)} ${r.emotion}${tag}`)
  }
  if (notes.length) {
    const via = readings.some((r) => r.via === 'llm') ? 'mood model' : 'keywords'
    run.steps.record('mood', 'Read the mood', 'ok', notes.join(' · '), { readings, via })
  }
  return [...touched.values()]
}

/** After the agent acted: count its answer toward open cases, then let the case rules decide on a human. */
async function followUpCases(run: Run, touched: MemberCase[], target: InboundMessage, outcome: RunOutcome, reply?: string): Promise<RunOutcome> {
  let next = outcome
  for (const t of touched) {
    let c = getCase(t.id)
    if (!c || c.status === 'resolved') continue
    if (outcome === 'answered' && reply && c.userId === target.userId) c = noteReply(c, 'pulse', reply)
    if (c.status !== 'open') continue
    const e = shouldEscalate(c)
    if (!e) continue
    const step = run.steps.begin('flag', `Bring in a human for ${c.userName.split(' ')[0]}`, e.reason, undefined, ['slack.chat.postmessage.create'])
    await escalate(c, e, run.id)
    step.ok(`${e.reason} · mood ${moodTrend(c, 4).map(fmtMood).join(' → ')}`, { case: c.id })
    next = 'escalated'
  }
  return next
}

async function onBatch(key: string, batch: InboundMessage[]): Promise<void> {
  const relevant = batch.filter((m) => m.joined || !isNoise(m.text) || m.addressed)
  // Members with an open case: even "ok thanks" matters (it may mean it's solved).
  const followed = batch.filter((m) => !m.joined && !relevant.includes(m) && caseOf(m.platform, m.userId, !!m.simulated))
  if (!relevant.length && !followed.length) return
  const lead = relevant.length ? relevant : followed
  const target = lead[lead.length - 1]!
  // Scripted demo runs use the most reliable chain (Claude first); real traffic stays on the fast free chain.
  const model = target.simulated ? consoleModel() ?? communityModel() : communityModel()
  const history = readHistory(key, 40)

  // Mood is read while the agent gets ready: a fast small model, keywords if it's slow.
  const moodBatch = [...relevant.filter((m) => !m.joined), ...followed]
  const openHere = activeCases().filter((c) => c.chatId === target.chatId && !!c.simulated === !!target.simulated)
  const moodP = readMood(moodBatch, { history, openCases: openHere.map((c) => ({ userName: c.userName, topic: c.topic, mood: c.mood })) }, { model: lightModel(), recentAsks: asksToday })

  // Feedback while thinking: Telegram "typing…", Slack 👀 on the question.
  if (relevant.length && !target.simulated && (target.addressed || isQuestionLike(target.text))) {
    if (target.platform === 'telegram') void channels.telegram?.typing(target.chatId)
    if (target.platform === 'whatsapp') void channels.whatsapp?.typing(target.chatId)
    if (target.platform === 'slack') void channels.slack?.ack(target.chatId, target.msgId, 'eyes')
  }

  const run = startRun('community', lead.map((m) => `${m.userName}: ${m.text}`).join('\n'), {
    platform: target.platform,
    chatId: target.chatId,
    userName: target.userName,
    simulated: target.simulated,
  })
  try {
    const readings = await moodP
    const touched = trackMood(run, moodBatch, readings)

    // Only case follow-ups ("thanks!", "ok"): no agent needed, the case rules decide.
    if (!relevant.length) {
      const outcome = await followUpCases(run, touched, target, 'silent')
      run.end(outcome, { summary: touched.some((c) => getCase(c.id)?.status === 'resolved') ? 'member sorted: case closed' : 'case updated' })
      return
    }

    if (!model) {
      const outcome = await fallbackAnswer(relevant, run.id)
      run.end(await followUpCases(run, touched, target, outcome), { summary: 'no LLM configured: knowledge-base fallback' })
      return
    }
    const waiting = waitingQuestions()
      .filter((p) => p.chatId === target.chatId && p.platform === target.platform)
      .map((p) => p.question)
    const signals = signalsFor(relevant, history, readings)

    // A question aimed at another member is theirs to answer: Pulse stays out of it
    // (the care sweep revives it if nobody replies).
    if (!target.addressed && relevant.every((m) => signals.find((x) => x.msgId === m.msgId)?.directedAt && isQuestionLike(m.text))) {
      run.steps.record('silent', 'Stay silent', 'ok', `question aimed at @${signals[0]?.directedAt}, not Pulse; the care sweep will follow up if nobody answers`)
      run.end(await followUpCases(run, touched, target, 'silent'))
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
      run.end(await followUpCases(run, touched, target, outcome === 'answered' ? 'answered' : 'failed'), { summary: `model error: ${result.error.slice(0, 120)}` })
      return
    }
    // The case rules (mood trend, repeat asks, "still stuck after an answer", asking for a
    // person) decide whether organizers need to step in, whatever the agent chose.
    run.end(await followUpCases(run, touched, target, result.outcome, result.reply), { reply: result.reply })
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

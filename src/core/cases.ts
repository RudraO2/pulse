import { randomUUID } from 'node:crypto'
import { bus } from '../bus.js'
import { env } from '../config/env.js'
import type { MoodReading } from '../agent/mood.js'
import { chatKey, writeHistory } from '../conversation/memory.js'
import type { AttentionItem, InboundMessage, MemberCase, MoodPoint, Platform } from '../shared/events.js'
import { getDoc, listDocs, putDoc } from '../store/repo.js'
import { post } from './channels.js'
import { modsAvailable, platformLabel, postModsCard, quote } from './mods.js'
import { openAttention, resolveAttention, updateAttention } from './state-docs.js'

// Member cases: one per member with a problem, followed until it's solved.
// Every message moves a smoothed mood; the trend (not one angry word) decides
// when a human is needed, and a member saying "works now, thanks" closes it.
// Rules live in code so every escalation has a plain-language reason.

const MAX_POINTS = 40
/** weight of the newest message in the smoothed mood */
const ALPHA = 0.6

export interface Escalation {
  kind: AttentionItem['kind']
  reason: string
}

const firstName = (n: string) => n.split(/\s+/)[0] ?? n
export const fmtMood = (n: number) => `${n > 0 ? '+' : n < 0 ? '−' : ''}${Math.abs(n).toFixed(1)}`

function save(c: MemberCase): MemberCase {
  putDoc('case', c, c.openedAt)
  bus.emit({ type: 'case', item: c })
  return c
}

export const getCase = (id: string): MemberCase | undefined => getDoc<MemberCase>('case', id)
export const allCases = (limit = 100): MemberCase[] => listDocs<MemberCase>('case', { limit })
export const activeCases = (): MemberCase[] => [...listDocs<MemberCase>('case', { status: 'open' }), ...listDocs<MemberCase>('case', { status: 'escalated' })]

export function caseOf(platform: Platform, userId: string, simulated = false): MemberCase | undefined {
  return activeCases().find((c) => c.platform === platform && c.userId === userId && !!c.simulated === simulated)
}

/** Opens a case? A plain info question doesn't; being stuck, upset or asking for a person does. */
export function opensCase(r: MoodReading): boolean {
  return !r.resolved && ((r.problem && r.score < 0.1) || r.wantsHuman || r.score <= -0.4)
}

export function moodTrend(c: MemberCase, n = 4): number[] {
  return c.points.filter((p) => p.by === 'member').slice(-n).map((p) => p.score)
}

/**
 * Feed one member message (with its mood reading) into their case.
 * Opens a case when needed, updates mood, closes it when they say it's solved.
 */
export function observe(m: InboundMessage, r: MoodReading): { case?: MemberCase; opened?: boolean; resolved?: boolean } {
  const existing = caseOf(m.platform, m.userId, !!m.simulated)
  if (!existing && !opensCase(r)) return {}
  const now = m.ts || Date.now()
  const point: MoodPoint = { ts: now, score: r.score, emotion: r.emotion, by: 'member', text: m.text.slice(0, 280), msgId: m.msgId, via: r.via }
  const base: MemberCase = existing ?? {
    id: `cs_${randomUUID().slice(0, 8)}`,
    platform: m.platform,
    chatId: m.chatId,
    userId: m.userId,
    userName: m.userName,
    status: 'open',
    topic: r.topic ?? m.text.slice(0, 70),
    mood: r.score,
    points: [],
    asks: 0,
    pulseReplies: 0,
    humanReplies: 0,
    openedAt: now,
    updatedAt: now,
    lastMemberAt: now,
    simulated: m.simulated,
  }
  const mood = existing ? Number((existing.mood * (1 - ALPHA) + r.score * ALPHA).toFixed(2)) : r.score
  let c: MemberCase = {
    ...base,
    chatId: m.chatId,
    mood,
    points: [...base.points, point].slice(-MAX_POINTS),
    asks: base.asks + (r.problem ? 1 : 0),
    askedForHuman: base.askedForHuman || r.wantsHuman,
    topic: existing && r.topic && r.problem && existing.topic === existing.points[0]?.text.slice(0, 70) ? r.topic : base.topic,
    updatedAt: now,
    lastMemberAt: now,
    lastMsgId: m.msgId,
    threadTs: m.threadTs ?? base.threadTs,
  }

  // They say it's fixed → done. Or the worry simply passed (never escalated, mood clearly back up).
  if (existing && ((r.resolved && r.score >= 0) || (c.status === 'open' && !r.problem && c.mood >= 0.3))) {
    c = save(c)
    return { case: closeCase(c, 'member', r.resolved ? `said: “${m.text.slice(0, 80)}”` : 'mood recovered'), resolved: true }
  }
  return { case: save(c), opened: !existing }
}

/** Pulse or an organizer answered the member: counts toward "still stuck after an answer". */
export function noteReply(c: MemberCase, by: 'pulse' | 'organizer', text: string): MemberCase {
  const now = Date.now()
  return save({
    ...c,
    points: [...c.points, { ts: now, score: c.mood, by, text: text.slice(0, 280) } satisfies MoodPoint].slice(-MAX_POINTS),
    pulseReplies: c.pulseReplies + (by === 'pulse' ? 1 : 0),
    humanReplies: c.humanReplies + (by === 'organizer' ? 1 : 0),
    // A person has now answered: asking for one is satisfied (a new request sets it again).
    askedForHuman: by === 'organizer' ? false : c.askedForHuman,
    lastReplyAt: now,
    updatedAt: now,
  })
}

/** The escalation rules, in priority order. Pure: easy to test and to explain. */
export function shouldEscalate(c: MemberCase, now = Date.now(), waitMin = env.IGNORED_AFTER_MIN): Escalation | undefined {
  if (c.status !== 'open') return undefined
  const member = c.points.filter((p) => p.by === 'member')
  const last = member[member.length - 1]
  if (!last) return undefined
  const trend = moodTrend(c, 3)

  if (c.askedForHuman) return { kind: 'needs_human', reason: 'asked for a person' }
  if (c.mood <= -0.6) return { kind: 'frustrated', reason: `very upset (mood ${fmtMood(c.mood)}${last.emotion ? `, ${last.emotion}` : ''})` }
  if (c.lastReplyAt && last.ts > c.lastReplyAt && c.pulseReplies + c.humanReplies > 0 && last.score <= -0.3) {
    return { kind: 'frustrated', reason: `still stuck after ${c.humanReplies ? 'an answer' : "Pulse's answer"}` }
  }
  if (trend.length === 3 && trend[0]! > trend[1]! && trend[1]! > trend[2]! && trend[2]! <= -0.3) {
    return { kind: 'frustrated', reason: `mood getting worse (${trend.map(fmtMood).join(' → ')})` }
  }
  if (c.asks >= 3 && c.mood < -0.1) return { kind: 'frustrated', reason: `asked ${c.asks} times, still stuck` }
  const waited = (now - c.lastMemberAt) / 60_000
  if (waited >= waitMin && (!c.lastReplyAt || c.lastReplyAt < c.lastMemberAt) && c.mood <= -0.2) {
    return { kind: 'ignored', reason: `upset and waiting ${Math.round(waited)} min` }
  }
  return undefined
}

const ICON: Record<AttentionItem['kind'], string> = { frustrated: '😤', ignored: '⏳', needs_human: '🙋' }

/** Bring in a human: Inbox item + #mods card with the mood trend (+ email/push via notify). */
export async function escalate(c: MemberCase, e: Escalation, runId?: string): Promise<MemberCase> {
  const last = [...c.points].reverse().find((p) => p.by === 'member')
  // Mark first: a second batch arriving mid-escalation must not escalate again.
  let next = save({ ...c, status: 'escalated', escalatedAt: Date.now(), escalation: { reason: e.reason } })
  const item = openAttention({
    kind: e.kind,
    platform: c.platform,
    chatId: c.chatId,
    msgId: c.lastMsgId,
    userId: c.userId,
    userName: c.userName,
    text: last?.text ?? c.topic,
    reason: e.reason,
    simulated: c.simulated,
    caseId: c.id,
  })
  next = save({ ...next, escalation: { reason: e.reason, attentionId: item.id } })
  if (modsAvailable()) {
    const trend = moodTrend(c, 5).map(fmtMood).join(' → ')
    const card = await postModsCard(
      `${ICON[e.kind]} **${c.userName} needs a human**  ·  ${platformLabel(c.platform)}\n${quote(last?.text ?? c.topic)}\n_${e.reason}_\nProblem: ${c.topic}  ·  mood ${trend}${c.pulseReplies ? `  ·  Pulse answered ${c.pulseReplies}×` : ''}\n\nPulse keeps watching and posts here when ${firstName(c.userName)} is sorted.`,
      { runId },
    )
    if (card.ts) {
      updateAttention(item.id, { modsTs: card.ts })
      next = save({ ...next, escalation: { ...next.escalation!, modsTs: card.ts } })
    }
  }
  return next
}

/** Close a case. Resolves its Inbox item and tells #mods in the escalation thread. */
export function closeCase(c: MemberCase, by: string, note?: string): MemberCase {
  if (c.status === 'resolved') return c
  const wasEscalated = c.status === 'escalated'
  const next = save({ ...c, status: 'resolved', resolvedAt: Date.now(), resolvedBy: by, resolution: note })
  if (c.escalation?.attentionId) resolveAttention(c.escalation.attentionId)
  if (wasEscalated && c.escalation?.modsTs) {
    const from = c.points.find((p) => p.by === 'member')?.score ?? c.mood
    const text =
      by === 'member'
        ? `✅ ${firstName(c.userName)} is sorted${note ? ` (${note})` : ''}. Mood ${fmtMood(from)} → ${fmtMood(c.mood)}. Case closed.`
        : by === 'timeout'
          ? `⌛ No word from ${firstName(c.userName)} for a while. Case closed.`
          : `✅ Closed by ${by}.`
    void postModsCard(text, { threadTs: c.escalation.modsTs })
  }
  return next
}

export function resolveCase(id: string, by: string, note?: string): MemberCase | undefined {
  const c = getCase(id)
  return c ? closeCase(c, by, note) : undefined
}

/**
 * An organizer answers a member directly from the phone app or dashboard. Takes a
 * case id or an Inbox item id. Goes out through Swytchcode like every post.
 */
export async function replyToMember(id: string, text: string, by = 'the team'): Promise<{ ok: boolean; error?: string }> {
  const item = id.startsWith('at_') ? getDoc<AttentionItem>('attention', id) : undefined
  const c = getCase(item?.caseId ?? id)
  const target = c ?? item
  if (!target) return { ok: false, error: 'not found' }
  const replyTo = c ? c.lastMsgId : item?.msgId
  const body = `${text.trim()}\n\n_— ${by}_`
  const res = await post(target.platform, target.chatId, body, {
    replyToId: target.platform === 'telegram' ? replyTo : undefined,
    threadTs: target.platform === 'slack' ? c?.threadTs ?? replyTo : undefined,
    simulated: target.simulated,
  })
  if (!res.ok) return { ok: false, error: res.blocked ? `blocked by ${res.blocked.policyId ?? res.blocked.kind}: ${res.blocked.message}` : res.error }
  const key = chatKey(target.platform, target.chatId)
  writeHistory(target.simulated ? `sim:${key}` : key, { sender: `${by} (organizer)`, text: body, ts: Date.now() })
  if (c) noteReply(c, 'organizer', text)
  const thread = c?.escalation?.modsTs ?? item?.modsTs
  if (thread) void postModsCard(`💬 ${by} replied to ${firstName(target.userName)} from the Pulse app:\n${quote(text)}`, { threadTs: thread })
  return { ok: true }
}

/**
 * An organizer's reply went out: take it off their list, but keep following the
 * member. The case goes back to "watching"; if they're still stuck, the rules
 * bring a human in again ("still stuck after an answer").
 */
export function handedOff(member: { caseId?: string; attentionId?: string; reply?: string }, by = 'the team'): void {
  let c = member.caseId ? getCase(member.caseId) : undefined
  if (c && c.status !== 'resolved') {
    c = noteReply(c, 'organizer', member.reply ?? '')
    save({ ...c, status: 'open', escalation: c.escalation ? { ...c.escalation, attentionId: undefined } : undefined })
  }
  if (member.attentionId) resolveAttention(member.attentionId)
  if (c?.escalation?.modsTs) void postModsCard(`💬 ${by} replied to ${firstName(c.userName)} (approved from the Pulse app). Pulse keeps watching.`, { threadTs: c.escalation.modsTs })
}

/** Periodic: upset members left waiting get a human; quiet cases close themselves. */
export async function sweepCases(now = Date.now()): Promise<{ escalated: number; closed: number }> {
  let escalated = 0
  let closed = 0
  for (const c of activeCases()) {
    const idleH = (now - c.updatedAt) / 3600_000
    if ((c.status === 'open' && idleH >= 6) || (c.status === 'escalated' && idleH >= 24)) {
      closeCase(c, 'timeout')
      closed++
      continue
    }
    const e = shouldEscalate(c, now)
    if (e) {
      await escalate(c, e)
      escalated++
    }
  }
  return { escalated, closed }
}

// Links escalations made elsewhere (the agent's flag_member tool) to the member's
// case, and closes the case when an organizer resolves the Inbox item.
let linked = false
export function linkCasesToAttention(): void {
  if (linked) return
  linked = true
  bus.on((ev) => {
    if (ev.type !== 'attention') return
    const a = ev.item
    if (a.status === 'open' && !a.caseId) {
      const c = caseOf(a.platform, a.userId, !!a.simulated)
      if (!c) return
      updateAttention(a.id, { caseId: c.id })
      if (c.status === 'open') save({ ...c, status: 'escalated', escalatedAt: Date.now(), escalation: { reason: a.reason, attentionId: a.id, modsTs: a.modsTs } })
    } else if (a.status === 'open' && a.caseId && a.modsTs) {
      const c = getCase(a.caseId)
      if (c && c.escalation?.attentionId === a.id && !c.escalation.modsTs) save({ ...c, escalation: { ...c.escalation, modsTs: a.modsTs } })
    } else if (a.status === 'resolved' && a.caseId) {
      // Only an item that still belongs to the case closes it (a handed-off reply detaches it first).
      const c = getCase(a.caseId)
      if (c && c.status !== 'resolved' && c.escalation?.attentionId === a.id) closeCase(c, 'Organizer')
    }
  })
}

import { env } from '../config/env.js'
import { liveEntries, allEntries } from '../kb/knowledge.js'
import { getDb } from '../store/db.js'
import { topClusters, clusterSamples, topHelpers, unansweredQuestions } from '../store/repo.js'
import { pendingApprovals } from './approvals.js'
import { openAttentionItems, waitingQuestions } from './state-docs.js'

// Community numbers for the Console agent and the digest. Real traffic only
// unless `includeScripted` (the demo community) is set.

export interface CommunityStats {
  window: string
  messages: number
  questions: number
  answeredByPulse: number
  answeredByHumans: number
  unanswered: Array<{ userName: string; text: string; platform: string; minutesAgo: number }>
  activeMembers: number
  topAskers: Array<{ userName: string; questions: number }>
  topTopics: Array<{ label: string; size: number; samples: string[] }>
  knowledge: { live: number; learned: number; learnedInWindow: Array<{ question: string; source: string; learnedFrom?: string }>; mostUsed: Array<{ question: string; used: number }> }
  waitingOnOrganizers: Array<{ userName: string; question: string; minutesWaiting: number }>
  needsAttention: Array<{ userName: string; kind: string; reason: string }>
  pendingApprovals: Array<{ id: string; title: string }>
  helpers: Array<{ userName: string; answers: number }>
}

export function communityStats(opts: { sinceMs?: number; includeScripted?: boolean } = {}): CommunityStats {
  const since = Date.now() - (opts.sinceMs ?? 24 * 3600_000)
  const sim = opts.includeScripted ? [0, 1] : [0]
  const d = getDb()
  const inSim = `simulated IN (${sim.join(',')})`
  const one = (sql: string, ...args: Array<string | number>) => Number((d.prepare(sql).get(...args) as { n: number }).n ?? 0)
  const now = Date.now()
  const learned = allEntries().filter((e) => e.source !== 'Seed' && e.type === 'FAQ' && (opts.includeScripted || !e.scripted))
  return {
    window: `${Math.round((Date.now() - since) / 3600_000)}h`,
    messages: one(`SELECT COUNT(*) AS n FROM messages WHERE ts >= ? AND ${inSim}`, since),
    questions: one(`SELECT COUNT(*) AS n FROM messages WHERE ts >= ? AND question_like = 1 AND ${inSim}`, since),
    answeredByPulse: one(`SELECT COUNT(*) AS n FROM messages WHERE ts >= ? AND answered_by = 'bot' AND ${inSim}`, since),
    answeredByHumans: one(`SELECT COUNT(*) AS n FROM messages WHERE ts >= ? AND answered_by = 'human' AND ${inSim}`, since),
    unanswered: unansweredQuestions(env.IGNORED_AFTER_MIN * 60_000, now - since)
      .filter((m) => opts.includeScripted || !m.simulated)
      .slice(-10)
      .map((m) => ({ userName: m.userName, text: m.text.slice(0, 160), platform: m.platform, minutesAgo: Math.round((now - m.ts) / 60_000) })),
    activeMembers: one(`SELECT COUNT(DISTINCT platform || user_id) AS n FROM messages WHERE ts >= ? AND ${inSim}`, since),
    topAskers: (d
      .prepare(`SELECT user_name, COUNT(*) AS n FROM messages WHERE ts >= ? AND question_like = 1 AND ${inSim} GROUP BY platform, user_id ORDER BY n DESC LIMIT 5`)
      .all(since) as Array<{ user_name: string; n: number }>).map((r) => ({ userName: r.user_name, questions: Number(r.n) })),
    topTopics: topClusters(5, since).map((c) => ({ label: c.label, size: c.size, samples: clusterSamples(c.id, 3) })),
    knowledge: {
      live: liveEntries().length,
      learned: learned.length,
      learnedInWindow: learned.filter((e) => e.createdAt >= since).map((e) => ({ question: e.question, source: e.source, learnedFrom: e.learnedFrom })),
      mostUsed: [...liveEntries()].sort((a, b) => b.used - a.used).slice(0, 5).filter((e) => e.used > 0).map((e) => ({ question: e.question, used: e.used })),
    },
    waitingOnOrganizers: waitingQuestions()
      .filter((p) => opts.includeScripted || !p.simulated)
      .map((p) => ({ userName: p.userName, question: p.question, minutesWaiting: Math.round((now - p.askedAt) / 60_000) })),
    needsAttention: openAttentionItems()
      .filter((a) => opts.includeScripted || !a.simulated)
      .map((a) => ({ userName: a.userName, kind: a.kind, reason: a.reason })),
    pendingApprovals: pendingApprovals().map((a) => ({ id: a.id, title: a.title })),
    helpers: topHelpers(5)
      .filter((h) => opts.includeScripted || !h.simulated)
      .map((h) => ({ userName: h.userName, answers: h.answers })),
  }
}

import { env } from '../config/env.js'
import { isQuestionLike } from '../agent/triage.js'
import { bus } from '../bus.js'
import { allEntries } from '../kb/knowledge.js'
import { allApprovals } from '../core/approvals.js'
import { allAttention, allPending } from '../core/state-docs.js'
import { allCases } from '../core/cases.js'
import { notifyState } from '../core/notify.js'
import { whatsappState } from '../core/channels.js'
import { getDb } from '../store/db.js'
import { kvGetJson, kvSetJson, recentMessages, recentRuns, topHelpers, upsertRun } from '../store/repo.js'
import type {
  Counters,
  GtEvent,
  InboundMessage,
  RunSummary,
  ScenarioState,
  SequencedEvent,
  ServiceName,
  ServiceStatus,
  StateSnapshot,
} from '../shared/events.js'

// Folds the event stream into the dashboard snapshot. Durable things
// (approvals, attention, pending questions, helpers, knowledge) are read from
// their stores at snapshot time; the stream-only things (runs in flight,
// swy calls, guardrail hits) are folded here. Counters survive restarts via
// kv, split into real vs scripted traffic.

const MAX_MESSAGES = 300
const MAX_RUNS = 80
const MAX_CALLS = 200
const MAX_GUARDRAILS = 100
const RING_SIZE = 3000
const SERVICES: ServiceName[] = ['telegram', 'slack', 'whatsapp', 'notion', 'resend', 'llm', 'swytchcode']

type Mode = StateSnapshot['mode']
type Ev<T extends GtEvent['type']> = Extract<GtEvent, { type: T }>

export const zeroCounters = (): Counters => ({
  messages: 0, questions: 0, answered: 0, answeredFromKb: 0, askedMods: 0, learned: 0, escalations: 0, guardrailBlocks: 0, swyCalls: 0, members: 0,
})

interface Persisted {
  real: Counters
  scripted: Counters
  byProvider: Record<string, number>
  policyBlocks: number
  dryRuns: number
  total: number
}

export interface StateStoreOptions {
  persist?: boolean
  mode?: Mode
  links?: StateSnapshot['links']
  channels?: StateSnapshot['channels']
}

export interface StateStore {
  snapshot(): StateSnapshot
  apply(ev: SequencedEvent): void
  eventsSince(seq: number): SequencedEvent[]
  waitForEvents(since: number, timeoutMs: number, signal?: AbortSignal): Promise<SequencedEvent[]>
  setChannels(channels: StateSnapshot['channels']): void
  setLinks(links: Partial<StateSnapshot['links']>): void
  /** drop scripted traffic from memory (demo reset) */
  clearScripted(): void
  stop(): void
}

export function providerOf(tool: string): string {
  const head = tool.split('.')[0] ?? tool
  return head.replace(/_v\d.*$/, '').replace(/^(discover|list|add|help):.*/, 'swytchcode').toLowerCase() || 'swytchcode'
}

function memberCounts(): { real: number; scripted: number } {
  try {
    const rows = getDb().prepare('SELECT simulated, COUNT(DISTINCT platform || user_id) AS n FROM messages GROUP BY simulated').all() as Array<{ simulated: number; n: number }>
    return { real: Number(rows.find((r) => !r.simulated)?.n ?? 0), scripted: Number(rows.find((r) => r.simulated)?.n ?? 0) }
  } catch {
    return { real: 0, scripted: 0 }
  }
}

export function createStateStore(opts: StateStoreOptions = {}): StateStore {
  const persist = opts.persist ?? true
  const mode: Mode = opts.mode ?? env.MODE
  const startedAt = Date.now()
  let links: StateSnapshot['links'] = opts.links ?? {
    telegramJoinUrl: env.TELEGRAM_JOIN_URL,
    slackInviteUrl: env.SLACK_INVITE_URL,
    notionUrl: env.NOTION_DATABASE_ID ? `https://www.notion.so/${env.NOTION_DATABASE_ID.replace(/-/g, '')}` : undefined,
  }
  let channelList: StateSnapshot['channels'] = opts.channels ?? []

  const services = Object.fromEntries(SERVICES.map((s) => [s, { state: 'disabled', at: 0 } satisfies ServiceStatus])) as Record<ServiceName, ServiceStatus>
  const saved = persist ? kvGetJson<Persisted>('dashboard.stats') : undefined
  const stats: Persisted = saved ?? { real: zeroCounters(), scripted: zeroCounters(), byProvider: {}, policyBlocks: 0, dryRuns: 0, total: 0 }
  let messages: InboundMessage[] = persist ? recentMessages(MAX_MESSAGES) : []
  let outgoing: Array<Ev<'message.out'>> = []
  const runs = new Map<string, RunSummary>()
  if (persist) for (const r of recentRuns(MAX_RUNS).reverse()) runs.set(r.runId, r)
  let guardrails: Array<Ev<'guardrail'>> = []
  let selftest: StateSnapshot['selftest'] = []
  let calls: Array<Ev<'swy.call'>> = []
  const callStart = new Map<string, Ev<'swy.call'>>()
  let scenario: ScenarioState = { status: 'idle', beat: 0, beats: 0, speed: 1 }
  let ring: SequencedEvent[] = []
  let dirty = false

  const simulatedRun = (runId?: string) => (runId ? !!runs.get(runId)?.simulated : false)
  const bucket = (simulated: boolean) => (simulated ? stats.scripted : stats.real)
  const bump = (simulated: boolean, key: keyof Counters, by = 1) => {
    bucket(simulated)[key] += by
    dirty = true
  }

  const waiters = new Set<() => void>()

  function trimRuns(): void {
    while (runs.size > MAX_RUNS) {
      const oldest = runs.keys().next().value
      if (oldest === undefined) break
      runs.delete(oldest)
    }
  }

  function apply(ev: SequencedEvent): void {
    ring.push(ev)
    if (ring.length > RING_SIZE) ring = ring.slice(-RING_SIZE)
    switch (ev.type) {
      case 'message.in': {
        messages = [...messages, ev.msg].slice(-MAX_MESSAGES)
        const sim = !!ev.msg.simulated
        if (!ev.msg.joined) bump(sim, 'messages')
        if (!ev.msg.joined && isQuestionLike(ev.msg.text)) bump(sim, 'questions')
        break
      }
      case 'message.out':
        outgoing = [...outgoing, ev].slice(-MAX_MESSAGES)
        break
      case 'run.start': {
        runs.set(ev.runId, {
          runId: ev.runId, origin: ev.origin, platform: ev.platform, chatId: ev.chatId, userName: ev.userName, input: ev.input,
          simulated: ev.simulated, startedAt: ev.ts, steps: [],
        })
        trimRuns()
        break
      }
      case 'run.step': {
        const run = runs.get(ev.runId)
        if (!run) break
        const i = run.steps.findIndex((s) => s.index === ev.step.index)
        if (i >= 0) run.steps[i] = { ...run.steps[i], ...ev.step }
        else run.steps.push(ev.step)
        if (ev.step.model) run.model = ev.step.model
        break
      }
      case 'run.end': {
        const run = runs.get(ev.runId)
        if (!run) break
        Object.assign(run, { outcome: ev.outcome, summary: ev.summary, reply: ev.reply, durationMs: ev.durationMs, model: ev.model ?? run.model })
        const sim = !!run.simulated
        if (ev.outcome === 'answered' && run.origin === 'community') bump(sim, 'answered')
        if (ev.outcome === 'asked_mods') bump(sim, 'askedMods')
        if (ev.outcome === 'escalated') bump(sim, 'escalations')
        if (persist) upsertRun(run)
        break
      }
      case 'swy.call': {
        if (ev.status === 'start') {
          callStart.set(ev.callId, ev)
          break
        }
        const start = callStart.get(ev.callId)
        callStart.delete(ev.callId)
        const full: Ev<'swy.call'> = { ...ev, argsPreview: ev.argsPreview ?? start?.argsPreview, runId: ev.runId ?? start?.runId }
        calls = [...calls, full].slice(-MAX_CALLS)
        if (!ev.cached) {
          stats.total++
          stats.byProvider[providerOf(ev.tool)] = (stats.byProvider[providerOf(ev.tool)] ?? 0) + 1
          if (ev.command === 'dry-run') stats.dryRuns++
          if (ev.category === 'policy_denied' || ev.category === 'rate_limit') stats.policyBlocks++
          bump(simulatedRun(full.runId), 'swyCalls')
        }
        break
      }
      case 'guardrail':
        guardrails = [ev, ...guardrails].slice(0, MAX_GUARDRAILS)
        bump(simulatedRun(ev.runId), 'guardrailBlocks')
        break
      case 'kb':
        if (ev.action === 'used' && ev.entry) bump(false, 'answeredFromKb')
        if (ev.action === 'added' && ev.entry && ev.entry.source !== 'Seed' && ev.entry.type === 'FAQ') bump(ev.entry.scripted, 'learned')
        break
      case 'attention':
        break
      case 'status':
        services[ev.service] = ev.status
        break
      case 'selftest':
        selftest = ev.results
        break
      case 'scenario':
        scenario = ev.state
        break
      default:
        break
    }
    for (const w of waiters) w()
  }

  const unsubscribe = bus.on(apply)
  const flushTimer = setInterval(() => {
    if (persist && dirty) {
      kvSetJson('dashboard.stats', stats)
      dirty = false
    }
  }, 2000)
  flushTimer.unref?.()

  function snapshot(): StateSnapshot {
    const members = memberCounts()
    const answeredRuns = [...runs.values()].filter((r) => r.origin === 'community' && !r.simulated && r.outcome === 'answered' && r.durationMs)
    const durations = answeredRuns.map((r) => r.durationMs!).sort((a, b) => a - b)
    const p50 = (xs: number[]) => (xs.length ? xs[Math.floor(xs.length / 2)] : undefined)
    const callDurations = calls.filter((c) => !c.cached && c.durationMs !== undefined).map((c) => c.durationMs!).sort((a, b) => a - b)
    return {
      seq: bus.currentSeq,
      mode,
      startedAt,
      community: { name: env.COMMUNITY_NAME, about: env.COMMUNITY_ABOUT },
      services,
      counters: { ...stats.real, members: members.real },
      scripted: { ...stats.scripted, members: members.scripted },
      medianResponseMs: p50(durations),
      messages,
      outgoing,
      runs: [...runs.values()].reverse(),
      kb: allEntries(),
      approvals: persist ? allApprovals(100) : [],
      attention: persist ? allAttention(100) : [],
      pending: persist ? allPending(100) : [],
      cases: persist ? allCases(100) : [],
      notify: notifyState(),
      whatsapp: whatsappState(),
      helpers: persist ? topHelpers(10) : [],
      guardrails,
      selftest,
      swyCalls: calls.slice(-120),
      swyStats: { byProvider: stats.byProvider, p50Ms: p50(callDurations) ?? 0, policyBlocks: stats.policyBlocks, dryRuns: stats.dryRuns, total: stats.total },
      scenario,
      links,
      channels: channelList,
    }
  }

  function eventsSince(seq: number): SequencedEvent[] {
    return ring.filter((e) => e.seq > seq)
  }

  function waitForEvents(since: number, timeoutMs: number, signal?: AbortSignal): Promise<SequencedEvent[]> {
    const ready = eventsSince(since)
    if (ready.length) return Promise.resolve(ready)
    return new Promise((resolve) => {
      let done = false
      const finish = () => {
        if (done) return
        done = true
        clearTimeout(timer)
        waiters.delete(onEvent)
        signal?.removeEventListener('abort', finish)
        resolve(eventsSince(since))
      }
      const onEvent = () => {
        // small coalescing window so bursts arrive together
        setTimeout(finish, 40)
      }
      const timer = setTimeout(finish, timeoutMs)
      waiters.add(onEvent)
      signal?.addEventListener('abort', finish, { once: true })
    })
  }

  return {
    snapshot,
    apply,
    eventsSince,
    waitForEvents,
    setChannels: (c) => {
      channelList = c
    },
    setLinks: (l) => {
      links = { ...links, ...l }
    },
    clearScripted: () => {
      messages = messages.filter((m) => !m.simulated)
      outgoing = outgoing.filter((m) => !m.simulated)
      for (const [id, r] of runs) if (r.simulated) runs.delete(id)
      stats.scripted = zeroCounters()
      dirty = true
    },
    stop: () => {
      unsubscribe()
      clearInterval(flushTimer)
      if (persist && dirty) kvSetJson('dashboard.stats', stats)
    },
  }
}

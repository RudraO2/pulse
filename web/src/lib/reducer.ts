import type { Counters, GtEvent, SequencedEvent, StateSnapshot } from '@shared/events'

// Client state = the server snapshot + every live event folded in.
// Pure functions; store.ts owns the instance.

export type Connection = 'connecting' | 'sse' | 'poll' | 'offline' | 'locked'

export interface Toast {
  id: number
  tone: 'info' | 'ok' | 'warn' | 'bad'
  text: string
}

export interface ClientState extends StateSnapshot {
  loaded: boolean
  connection: Connection
  toasts: Toast[]
}

const zero = (): Counters => ({ messages: 0, questions: 0, answered: 0, answeredFromKb: 0, askedMods: 0, learned: 0, escalations: 0, guardrailBlocks: 0, swyCalls: 0, members: 0 })

export function initialState(): ClientState {
  return {
    loaded: false,
    connection: 'connecting',
    toasts: [],
    seq: 0,
    mode: 'live',
    startedAt: Date.now(),
    community: { name: 'Pulse', about: '' },
    services: {
      telegram: { state: 'disabled', at: 0 },
      slack: { state: 'disabled', at: 0 },
      whatsapp: { state: 'disabled', at: 0 },
      notion: { state: 'disabled', at: 0 },
      resend: { state: 'disabled', at: 0 },
      llm: { state: 'disabled', at: 0 },
      swytchcode: { state: 'disabled', at: 0 },
    },
    counters: zero(),
    scripted: zero(),
    messages: [],
    outgoing: [],
    runs: [],
    kb: [],
    approvals: [],
    attention: [],
    pending: [],
    cases: [],
    notify: { email: false, devices: 0, queued: 0, tunnel: 'off' },
    whatsapp: { status: 'off', groups: [], dms: true, dmsAuto: false, paused: false },
    helpers: [],
    guardrails: [],
    selftest: [],
    swyCalls: [],
    swyStats: { byProvider: {}, p50Ms: 0, policyBlocks: 0, dryRuns: 0, total: 0 },
    scenario: { status: 'idle', beat: 0, beats: 0, speed: 1 },
    links: {},
    channels: [],
  }
}

export function hydrate(prev: ClientState, snap: StateSnapshot): ClientState {
  return { ...prev, ...snap, loaded: true, seq: Math.max(prev.seq, snap.seq) }
}

let toastId = 0
export function pushToast(s: ClientState, tone: Toast['tone'], text: string): ClientState {
  return { ...s, toasts: [...s.toasts.slice(-3), { id: ++toastId, tone, text }] }
}

const upsertBy = <T,>(list: T[], item: T, key: (x: T) => string, max = 200, front = true): T[] => {
  const k = key(item)
  const i = list.findIndex((x) => key(x) === k)
  if (i >= 0) {
    const next = list.slice()
    next[i] = item
    return next
  }
  return (front ? [item, ...list] : [...list, item]).slice(0, max)
}

type Ev<T extends GtEvent['type']> = Extract<SequencedEvent, { type: T }>

export function applyEvent(s: ClientState, ev: SequencedEvent): ClientState {
  if (ev.seq && ev.seq <= s.seq && ev.type !== 'status') return s
  const next: ClientState = { ...s, seq: Math.max(s.seq, ev.seq ?? 0) }
  switch (ev.type) {
    case 'message.in': {
      const m = ev.msg
      if (next.messages.some((x) => x.platform === m.platform && x.chatId === m.chatId && x.msgId === m.msgId)) return next
      next.messages = [...next.messages, m].slice(-400)
      return next
    }
    case 'message.out':
      next.outgoing = [...next.outgoing, ev].slice(-400)
      return next
    case 'run.start':
      next.runs = upsertBy(
        next.runs,
        { runId: ev.runId, origin: ev.origin, platform: ev.platform, chatId: ev.chatId, userName: ev.userName, input: ev.input, simulated: ev.simulated, startedAt: ev.ts, steps: [] },
        (r) => r.runId,
        150,
      )
      return next
    case 'run.step': {
      next.runs = next.runs.map((r) => {
        if (r.runId !== ev.runId) return r
        const i = r.steps.findIndex((x) => x.index === ev.step.index)
        const steps = i >= 0 ? r.steps.map((x, j) => (j === i ? { ...x, ...ev.step } : x)) : [...r.steps, ev.step]
        return { ...r, steps, model: ev.step.model ?? r.model }
      })
      return next
    }
    case 'run.end':
      next.runs = next.runs.map((r) => (r.runId === ev.runId ? { ...r, outcome: ev.outcome, summary: ev.summary, reply: ev.reply, durationMs: ev.durationMs, model: ev.model ?? r.model } : r))
      return next
    case 'swy.call': {
      if (ev.status === 'start') return next
      next.swyCalls = [...next.swyCalls, ev as Ev<'swy.call'>].slice(-200)
      if (!ev.cached) {
        const provider = ev.tool.split('.')[0]!.replace(/_v\d.*$/, '')
        next.swyStats = {
          ...next.swyStats,
          total: next.swyStats.total + 1,
          dryRuns: next.swyStats.dryRuns + (ev.command === 'dry-run' ? 1 : 0),
          policyBlocks: next.swyStats.policyBlocks + (ev.category === 'policy_denied' || ev.category === 'rate_limit' ? 1 : 0),
          byProvider: { ...next.swyStats.byProvider, [provider]: (next.swyStats.byProvider[provider] ?? 0) + 1 },
        }
      }
      return next
    }
    case 'guardrail':
      next.guardrails = [ev as Ev<'guardrail'>, ...next.guardrails].slice(0, 120)
      return pushToast(next, 'warn', `Blocked by Swytchcode policy${ev.policyId ? ` “${ev.policyId}”` : ''}: ${ev.detail}`)
    case 'kb':
      if (ev.action === 'synced' && ev.entries) next.kb = ev.entries
      else if (ev.entry) {
        if (ev.action === 'archived') next.kb = next.kb.filter((e) => e.id !== ev.entry!.id)
        else next.kb = upsertBy(next.kb, ev.entry, (e) => e.id, 1000)
        if (ev.action === 'added' && ev.entry.type === 'FAQ' && ev.entry.source !== 'Seed') return pushToast(next, 'ok', `Learned: “${ev.entry.question}”`)
      }
      return next
    case 'approval': {
      const isNew = !next.approvals.some((a) => a.id === ev.approval.id)
      next.approvals = upsertBy(next.approvals, ev.approval, (a) => a.id)
      if (isNew && ev.approval.status === 'pending') return pushToast(next, 'info', `Approval needed: ${ev.approval.title}`)
      if (ev.approval.status === 'executed') return pushToast(next, 'ok', `Executed: ${ev.approval.title}`)
      return next
    }
    case 'attention':
      next.attention = upsertBy(next.attention, ev.item, (a) => a.id)
      return next
    case 'pending':
      next.pending = upsertBy(next.pending, ev.item, (p) => p.id)
      return next
    case 'case':
      next.cases = upsertBy(next.cases ?? [], ev.item, (c) => c.id)
      return next
    case 'notify':
      next.notify = ev.state
      if (ev.sent?.channel === 'email') return pushToast(next, ev.sent.ok ? 'ok' : 'bad', ev.sent.ok ? `Emailed you: ${ev.sent.detail.split(' → ')[0]}` : `Email: ${ev.sent.detail}`)
      return next
    case 'whatsapp':
      next.whatsapp = ev.state
      return next
    case 'status':
      next.services = { ...next.services, [ev.service]: ev.status }
      return next
    case 'selftest':
      next.selftest = ev.results
      return next
    case 'scenario':
      next.scenario = ev.state
      return next
    case 'digest':
      return pushToast(next, ev.status === 'sent' ? 'ok' : 'bad', ev.status === 'sent' ? 'Digest emailed via Resend' : `Digest: ${ev.detail}`)
    default:
      return next
  }
}

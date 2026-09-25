import { bus } from '../bus.js'
import { env } from '../config/env.js'
import { runConsole } from '../agent/console.js'
import { handleModReply } from '../agent/learn.js'
import { decide, pendingApprovals } from '../core/approvals.js'
import { channels } from '../core/channels.js'
import { modsChannel } from '../core/mods.js'
import { waitingQuestions } from '../core/state-docs.js'
import { archiveScripted } from '../kb/knowledge.js'
import { sendDigest } from '../jobs/digest.js'
import { runSweep } from '../jobs/scheduler.js'
import { ingest, pipelineBatcher } from '../pipeline.js'
import type { ScenarioState } from '../shared/events.js'
import type { StateStore } from '../server/state.js'
import { deleteSimulatedRows } from '../store/repo.js'
import { swyExec } from '../swy/exec.js'
import { PERSONAS, SCENARIOS, type Beat, type Persona, type Scenario } from './scenarios.js'

// Plays a scenario: persona lines are posted to the real Slack channel under
// the persona's name/avatar (chat:write.customize) and injected into the
// pipeline as simulated messages. Everything Pulse does in response is real.

let state: ScenarioState = { status: 'idle', beat: 0, beats: 0, speed: 1 }
let token = 0
let resumeGate: (() => void) | undefined
const activeRuns = new Set<string>()

bus.on((ev) => {
  if (ev.type === 'run.start') activeRuns.add(ev.runId)
  if (ev.type === 'run.end') activeRuns.delete(ev.runId)
})

function emit(patch: Partial<ScenarioState>): void {
  state = { ...state, ...patch }
  bus.emit({ type: 'scenario', state })
}

export const listScenarios = () => SCENARIOS.map((s) => ({ id: s.id, title: s.title, description: s.description, shows: s.shows, beats: s.beats.length }))
export const scenarioState = (): ScenarioState => state

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

async function waitWhilePaused(my: number): Promise<void> {
  while (state.status === 'paused' && my === token) await new Promise<void>((r) => (resumeGate = r))
}

async function delay(ms: number, my: number): Promise<void> {
  const end = Date.now() + ms / state.speed
  while (Date.now() < end && my === token) {
    await sleep(Math.min(200, end - Date.now()))
    await waitWhilePaused(my)
  }
}

/** Wait until batch windows are closed and no agent run is in flight. */
async function settle(my: number, timeoutMs = 60_000): Promise<void> {
  const deadline = Date.now() + timeoutMs
  await sleep(400)
  while (Date.now() < deadline && my === token) {
    const busy = (pipelineBatcher()?.pendingChats().length ?? 0) > 0 || activeRuns.size > 0
    if (!busy) return
    await sleep(300)
  }
}

let seq = 0
async function say(p: Persona, text: string, opts: { joined?: boolean } = {}): Promise<void> {
  const channel = env.SLACK_GENERAL_CHANNEL_ID
  let ts: string | undefined
  if (channels.slack && channel && !opts.joined) {
    try {
      ts = await channels.slack.postRaw({ channel, text, username: p.name, icon_url: p.avatar })
    } catch (e) {
      bus.emit({ type: 'log', level: 'warn', text: `demo: could not post persona line to Slack (${(e as Error).message})` })
    }
  }
  ingest({
    platform: 'slack',
    chatId: channel ?? 'demo',
    chatType: 'group',
    chatTitle: '#general',
    userId: `sim_${p.id}`,
    userName: p.name,
    text: opts.joined ? `${p.name} joined the channel` : text,
    msgId: ts ?? `sim_${Date.now()}_${++seq}`,
    addressed: /\bpulse\b/i.test(text),
    ts: Date.now(),
    simulated: true,
    avatarUrl: p.avatar,
    joined: opts.joined,
  })
}

async function modReply(p: Persona, text: string): Promise<void> {
  const pending = waitingQuestions().filter((q) => q.simulated).sort((a, b) => b.askedAt - a.askedAt)[0]
  if (!pending) {
    bus.emit({ type: 'log', level: 'warn', text: 'demo: no scripted question is waiting on organizers' })
    return
  }
  const channel = modsChannel()
  if (channels.slack && channel && pending.modsThreadTs) {
    await channels.slack.postRaw({ channel, text, thread_ts: pending.modsThreadTs, username: `${p.name} (organizer)`, icon_url: p.avatar }).catch(() => undefined)
  }
  await handleModReply(pending.id, { userName: p.name, text, simulated: true })
}

async function approveLatest(p: Persona): Promise<void> {
  const a = pendingApprovals().sort((x, y) => y.createdAt - x.createdAt)[0]
  if (!a) {
    bus.emit({ type: 'log', level: 'warn', text: 'demo: nothing is waiting for approval' })
    return
  }
  const channel = modsChannel()
  if (channels.slack && channel && a.slackTs) {
    await swyExec('slack.reactions.add.create', { body: { channel, timestamp: a.slackTs, name: 'white_check_mark' } }).catch(() => undefined)
  }
  await decide(a.id, 'approve', p.name)
}

async function runBeat(b: Beat, my: number): Promise<void> {
  if ('caption' in b) emit({ caption: b.caption })
  else if ('join' in b) await say(PERSONAS[b.join]!, '', { joined: true })
  else if ('say' in b) {
    if (b.wait) await delay(b.wait, my)
    await say(PERSONAS[b.say]!, b.text)
  } else if ('settle' in b) await settle(my)
  else if ('modReply' in b) await modReply(PERSONAS[b.modReply]!, b.text)
  else if ('approve' in b) await approveLatest(PERSONAS[b.approve]!)
  else if ('console' in b) await runConsole(b.console)
  else if ('sweep' in b) await runSweep({ olderThanMs: 0, onlyScripted: true })
  else if ('digest' in b) await sendDigest({ trigger: 'demo' })
  else if ('pause' in b) await delay(b.pause, my)
}

async function play(s: Scenario, my: number): Promise<void> {
  emit({ id: s.id, title: s.title, status: 'running', beat: 0, beats: s.beats.length, caption: undefined })
  for (let i = 0; i < s.beats.length; i++) {
    if (my !== token) return
    await waitWhilePaused(my)
    emit({ beat: i + 1 })
    try {
      await runBeat(s.beats[i]!, my)
    } catch (e) {
      bus.emit({ type: 'log', level: 'error', text: `demo beat ${i + 1} failed: ${(e as Error).message}` })
    }
    await delay(700, my)
  }
  if (my === token) emit({ status: 'done', caption: 'Scenario complete' })
}

export async function resetDemo(store?: StateStore): Promise<{ archived: number }> {
  token++
  resumeGate?.()
  const archived = await archiveScripted()
  deleteSimulatedRows()
  store?.clearScripted()
  emit({ id: undefined, title: undefined, status: 'idle', beat: 0, beats: 0, caption: 'Demo data cleared' })
  return { archived }
}

export async function demo(action: 'play' | 'pause' | 'resume' | 'stop' | 'reset' | 'speed', body: Record<string, unknown>, store?: StateStore): Promise<unknown> {
  switch (action) {
    case 'play': {
      const s = SCENARIOS.find((x) => x.id === body.id)
      if (!s) return { error: 'unknown scenario' }
      if (typeof body.speed === 'number') state.speed = Math.min(Math.max(body.speed, 0.5), 3)
      const my = ++token
      void play(s, my)
      return { ok: true, id: s.id }
    }
    case 'pause':
      if (state.status === 'running') emit({ status: 'paused' })
      return state
    case 'resume':
      if (state.status === 'paused') {
        emit({ status: 'running' })
        resumeGate?.()
      }
      return state
    case 'stop':
      token++
      resumeGate?.()
      emit({ status: 'idle', caption: undefined })
      return state
    case 'speed':
      emit({ speed: typeof body.speed === 'number' ? Math.min(Math.max(body.speed, 0.5), 3) : 1 })
      return state
    case 'reset':
      return resetDemo(store)
  }
}

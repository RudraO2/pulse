import { randomUUID } from 'node:crypto'
import { bus } from '../bus.js'
import { StepEmitter } from '../agent/steps.js'
import type { Platform, RunOrigin, RunOutcome } from '../shared/events.js'

// One agent run = one visible unit on the dashboard: run.start → run.step* → run.end.

export interface Run {
  readonly id: string
  readonly origin: RunOrigin
  readonly steps: StepEmitter
  readonly startedAt: number
  readonly simulated: boolean
  ended: boolean
  end(outcome: RunOutcome, opts?: { summary?: string; reply?: string }): void
}

export function startRun(
  origin: RunOrigin,
  input: string,
  meta: { platform?: Platform; chatId?: string; userName?: string; simulated?: boolean; runId?: string } = {},
): Run {
  const id = meta.runId ?? `${origin}_${randomUUID().slice(0, 8)}`
  const startedAt = Date.now()
  const steps = new StepEmitter(id)
  bus.emit({ type: 'run.start', runId: id, origin, input: input.slice(0, 600), platform: meta.platform, chatId: meta.chatId, userName: meta.userName, simulated: meta.simulated })
  const run: Run = {
    id,
    origin,
    steps,
    startedAt,
    simulated: !!meta.simulated,
    ended: false,
    end(outcome, opts = {}) {
      if (run.ended) return
      run.ended = true
      bus.emit({ type: 'run.end', runId: id, outcome, summary: opts.summary, reply: opts.reply, durationMs: Date.now() - startedAt, model: steps.model })
    },
  }
  return run
}

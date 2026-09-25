import { bus } from '../bus.js'
import type { RunStep, StepKind } from '../shared/events.js'
import { redactDeep } from '../swy/redact.js'

// Emits the run.step events the dashboard's pipeline graph is built from.
// Each step starts as 'start' and is later upserted (same index) with its outcome.

export interface StepHandle {
  readonly index: number
  ok(detail?: string, data?: unknown): void
  error(detail: string, data?: unknown): void
  blocked(detail: string, data?: unknown): void
  waiting(detail: string, data?: unknown): void
  /** attach the canonical Swytchcode ids this step touched */
  tools(ids: string[]): void
  /** merge more data into a finished step (e.g. discover's `picked`) */
  patch(data: Record<string, unknown>): void
}

export class StepEmitter {
  private next = 0
  model?: string

  constructor(readonly runId: string) {}

  begin(kind: StepKind, title: string, detail?: string, data?: unknown, toolIds?: string[]): StepHandle {
    const index = this.next++
    const started = Date.now()
    let lastData = data === undefined ? undefined : redactDeep(data)
    let lastStatus: RunStep['status'] = 'start'
    let tools = toolIds
    const emit = (step: Partial<RunStep> & Pick<RunStep, 'status'>) =>
      bus.emit({
        type: 'run.step',
        runId: this.runId,
        step: { index, kind, title, ...(tools?.length ? { tools } : {}), ...step, ...(this.model && kind !== 'context' ? { model: step.model ?? this.model } : {}) } as RunStep,
      })
    emit({ status: 'start', detail, data: lastData })
    const finish = (status: RunStep['status']) => (d?: string, payload?: unknown) => {
      if (payload !== undefined) lastData = redactDeep(payload)
      lastStatus = status
      emit({ status, detail: d ?? detail, data: lastData, durationMs: Date.now() - started })
    }
    return {
      index,
      ok: finish('ok'),
      error: finish('error'),
      blocked: finish('blocked'),
      waiting: finish('waiting'),
      tools: (ids) => {
        tools = [...new Set([...(tools ?? []), ...ids])]
      },
      patch: (extra) => {
        lastData = { ...((lastData as object) ?? {}), ...(redactDeep(extra) as object) }
        bus.emit({ type: 'run.step', runId: this.runId, step: { index, kind, title, status: lastStatus, data: lastData, ...(tools?.length ? { tools } : {}) } as RunStep })
      },
    }
  }

  /** one-shot step that is already finished */
  record(kind: StepKind, title: string, status: RunStep['status'], detail?: string, data?: unknown, toolIds?: string[]): StepHandle {
    const h = this.begin(kind, title, detail, data, toolIds)
    if (status === 'ok') h.ok()
    else if (status === 'error') h.error(detail ?? title)
    else if (status === 'blocked') h.blocked(detail ?? title)
    else if (status === 'waiting') h.waiting(detail ?? title)
    return h
  }
}

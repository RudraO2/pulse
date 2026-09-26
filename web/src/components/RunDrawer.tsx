import { useSyncExternalStore } from 'react'
import { mdInline, modelName, ms, ORIGIN_LABEL, OUTCOME_LABEL, clock } from '../lib/format'
import { useStore } from '../lib/store'
import { Badge, Drawer, PlatformIcon } from '../ui/primitives'
import { ApprovalCard } from './ApprovalCard'
import { RunTrace } from './RunTrace'

// A global slide-over that shows any agent run's full trace.

let current: string | undefined
const listeners = new Set<() => void>()
export function openRun(runId: string | undefined): void {
  current = runId
  for (const l of listeners) l()
}
const subscribe = (l: () => void) => {
  listeners.add(l)
  return () => listeners.delete(l)
}

export function RunDrawerHost() {
  const runId = useSyncExternalStore(subscribe, () => current)
  const run = useStore((s) => s.runs.find((r) => r.runId === runId))
  const approvals = useStore((s) => s.approvals.filter((a) => a.runId === runId))
  return (
    <Drawer
      open={!!runId}
      onClose={() => openRun(undefined)}
      title={
        <span className="flex items-center gap-2">
          {run?.platform && <PlatformIcon platform={run.platform} />}
          {run ? ORIGIN_LABEL[run.origin] : 'Run'}
          {run?.simulated && <Badge tone="ghost">Scripted</Badge>}
        </span>
      }
      subtitle={run ? `${clock(run.startedAt)} · ${run.durationMs !== undefined ? ms(run.durationMs) : 'running'}${run.model ? ` · ${modelName(run.model)}` : ''}` : undefined}
    >
      {run ? (
        <div className="space-y-6 p-5">
          <div className="rounded-[10px] bg-subtle px-4 py-3">
            <div className="label mb-1">{run.userName ?? 'Input'}</div>
            <p className="text-[13.5px] leading-relaxed whitespace-pre-wrap text-fg">{run.input}</p>
          </div>
          <div>
            <div className="label mb-3">What Pulse did</div>
            <RunTrace run={run} />
          </div>
          {approvals.map((a) => (
            <ApprovalCard key={a.id} approval={a} />
          ))}
          {run.outcome && (
            <div className="border-t border-line pt-4">
              <div className="mb-1.5 flex items-center gap-2">
                <span className="label">Outcome</span>
                <Badge tone={run.outcome === 'failed' ? 'bad' : run.outcome === 'silent' ? 'neutral' : 'ok'}>{OUTCOME_LABEL[run.outcome]}</Badge>
              </div>
              {(run.summary || run.reply) && <div className="prose-msg text-[13.5px] leading-relaxed text-fg-2" dangerouslySetInnerHTML={{ __html: mdInline(run.summary ?? run.reply ?? '') }} />}
            </div>
          )}
        </div>
      ) : (
        <div className="p-5 text-sm text-fg-3">This run is no longer in memory.</div>
      )}
    </Drawer>
  )
}

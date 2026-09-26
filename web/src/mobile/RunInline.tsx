import { CircleCheck, CircleX, Hourglass, LoaderCircle, ShieldAlert } from 'lucide-react'
import { useState } from 'react'
import type { RunStep } from '@shared/events'
import { api } from '../lib/api'
import { mdInline } from '../lib/format'
import { useStore } from '../lib/store'
import { ApprovalItem, BigButton } from './items'

// A Console run shown in place: the steps as they stream in, Pulse's summary,
// and every approval it prepared, each with its own Approve (or all at once).

export function StepLine({ s }: { s: RunStep }) {
  const icon =
    s.status === 'start' ? <LoaderCircle className="size-3.5 animate-spin text-accent" /> : s.status === 'error' ? <CircleX className="size-3.5 text-bad" /> : s.status === 'blocked' ? <ShieldAlert className="size-3.5 text-bad" /> : s.status === 'waiting' ? <Hourglass className="size-3.5 text-warn" /> : <CircleCheck className="size-3.5 text-ok" />
  return (
    <li className="flex gap-2.5 py-1.5">
      <span className="mt-0.5 shrink-0">{icon}</span>
      <div className="min-w-0">
        <div className="text-[13.5px] font-medium text-fg">{s.title}</div>
        {s.detail && <div className="line-clamp-2 text-[12.5px] text-fg-3">{s.detail}</div>}
      </div>
    </li>
  )
}

export function RunInline({ runId, compact }: { runId: string; compact?: boolean }) {
  const run = useStore((s) => s.runs.find((r) => r.runId === runId))
  const approvals = useStore((s) => s.approvals.filter((a) => a.runId === runId))
  const [busy, setBusy] = useState(false)
  const pending = approvals.filter((a) => a.status === 'pending' && !a.actions.every((x) => x.blocked))
  const steps = (run?.steps ?? []).filter((s) => s.kind !== 'context' && (!compact || s.kind !== 'think' || !run?.outcome))

  return (
    <div className="animate-fade-in">
      <ul className="divide-y divide-line rounded-[12px] border border-line bg-subtle/60 px-3.5 py-1">
        {steps.map((s) => (
          <StepLine key={s.index} s={s} />
        ))}
        {!steps.length && (
          <li className="flex items-center gap-2 py-2 text-[13px] text-fg-3">
            <LoaderCircle className="size-3.5 animate-spin" /> Pulse is thinking…
          </li>
        )}
      </ul>
      {run?.outcome && (run.summary || run.reply) && !compact && (
        <div className="mt-3 rounded-[12px] bg-subtle px-4 py-3">
          <div className="prose-msg text-[14px] leading-relaxed text-fg" dangerouslySetInnerHTML={{ __html: mdInline(run.summary ?? run.reply ?? '') }} />
        </div>
      )}
      {approvals.length > 0 && (
        <ul className="mt-3 grid gap-3">
          {approvals.map((a) => (
            <ApprovalItem key={a.id} a={a} />
          ))}
        </ul>
      )}
      {pending.length > 1 && (
        <BigButton
          tone="go"
          className="mt-3 w-full"
          loading={busy}
          onClick={async () => {
            setBusy(true)
            for (const a of pending) await api.approve(a.id)
            setBusy(false)
          }}
        >
          Approve all {pending.length}
        </BigButton>
      )}
    </div>
  )
}

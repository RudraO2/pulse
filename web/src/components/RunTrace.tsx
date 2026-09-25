import clsx from 'clsx'
import {
  BookOpen,
  Braces,
  ChartColumn,
  ChevronRight,
  Compass,
  Eye,
  Flag,
  Hand,
  LoaderCircle,
  Mail,
  MessageSquareReply,
  Play,
  ScanEye,
  Search,
  ShieldAlert,
  ShieldCheck,
  Sparkles,
  ThumbsUp,
  TriangleAlert,
  Users,
  VolumeX,
  Hourglass,
} from 'lucide-react'
import { useState, type ComponentType } from 'react'
import type { RunStep, RunSummary, StepKind } from '@shared/events'
import { ms } from '../lib/format'
import { useStore } from '../lib/store'
import { JsonBlock, ToolChip } from '../ui/primitives'

const ICON: Record<StepKind, ComponentType<{ className?: string }>> = {
  context: Eye,
  think: Sparkles,
  search: Search,
  reply: MessageSquareReply,
  mods: Users,
  knowledge: BookOpen,
  flag: Flag,
  react: ThumbsUp,
  silent: VolumeX,
  welcome: Hand,
  preview: ScanEye,
  approval: ShieldCheck,
  execute: Play,
  email: Mail,
  discover: Compass,
  inspect: Braces,
  stats: ChartColumn,
  guard: ShieldAlert,
  error: TriangleAlert,
}

function StepRow({ step: raw, last, live }: { step: RunStep; last: boolean; live: boolean }) {
  const [open, setOpen] = useState(false)
  // A step that waited on an approval reflects what happened to that approval.
  const approvalId = (raw.data as { approval?: string } | undefined)?.approval
  const approval = useStore((s) => (approvalId ? s.approvals.find((a) => a.id === approvalId) : undefined))
  const step: RunStep =
    raw.status === 'waiting' && approval && approval.status !== 'pending'
      ? {
          ...raw,
          status: approval.status === 'executed' ? 'ok' : approval.status === 'rejected' ? 'ok' : approval.status === 'failed' ? 'error' : raw.status,
          detail: `${raw.detail ?? ''} → ${approval.status === 'executed' ? `approved by ${approval.decidedBy ?? 'organizer'} and executed` : approval.status === 'rejected' ? `rejected by ${approval.decidedBy ?? 'organizer'}` : approval.status === 'failed' ? approval.result ?? 'failed' : 'running'}`,
        }
      : raw
  const Icon = ICON[step.kind] ?? Sparkles
  const running = step.status === 'start' && live
  const tone =
    step.status === 'error' ? 'text-bad border-bad/30 bg-bad-soft'
    : step.status === 'blocked' ? 'text-bad border-bad/30 bg-bad-soft'
    : step.status === 'waiting' ? 'text-warn border-warn/30 bg-warn-soft'
    : step.kind === 'think' ? 'text-accent border-accent/25 bg-accent-soft'
    : 'text-fg-2 border-line bg-surface'
  const hasData = step.data !== undefined && step.data !== null && !(typeof step.data === 'object' && Object.keys(step.data as object).length === 0)
  return (
    <li className="relative flex gap-3 pb-4 animate-fade-in">
      {!last && <span className="absolute top-8 bottom-0 left-[13px] w-px bg-line" />}
      <span className={clsx('relative z-10 grid size-7 shrink-0 place-items-center rounded-lg border', tone)}>
        {running ? <LoaderCircle className="size-3.5 animate-spin" /> : step.status === 'waiting' ? <Hourglass className="size-3.5" /> : <Icon className="size-3.5" />}
      </span>
      <div className="min-w-0 flex-1 pt-0.5">
        <button className="group flex w-full items-start justify-between gap-3 text-left" onClick={() => hasData && setOpen((o) => !o)} disabled={!hasData}>
          <div className="min-w-0">
            <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
              <span className="text-[13px] font-medium text-fg">{step.title}</span>
              {step.status === 'blocked' && <span className="text-[11px] font-medium text-bad">blocked by policy</span>}
              {step.status === 'waiting' && <span className="text-[11px] font-medium text-warn">waiting</span>}
            </div>
            {step.detail && <p className={clsx('mt-0.5 text-[12.5px] leading-relaxed', step.status === 'error' || step.status === 'blocked' ? 'text-bad' : 'text-fg-3')}>{step.detail}</p>}
            {!!step.tools?.length && (
              <div className="mt-1.5 flex flex-wrap gap-1">
                {step.tools.map((t) => (
                  <ToolChip key={t} id={t} />
                ))}
              </div>
            )}
          </div>
          <div className="flex shrink-0 items-center gap-1.5 pt-0.5 text-[11px] text-fg-4">
            {step.durationMs !== undefined && <span className="tabular-nums">{ms(step.durationMs)}</span>}
            {hasData && <ChevronRight className={clsx('size-3.5 transition-transform group-hover:text-fg-2', open && 'rotate-90')} />}
          </div>
        </button>
        {open && hasData && (
          <div className="mt-2">
            <JsonBlock value={step.data} />
          </div>
        )}
      </div>
    </li>
  )
}

export function RunTrace({ run }: { run: RunSummary }) {
  const live = !run.outcome
  const steps = [...run.steps].sort((a, b) => a.index - b.index)
  return (
    <ol className="relative">
      {steps.map((s, i) => (
        <StepRow key={s.index} step={s} last={i === steps.length - 1 && !live} live={live} />
      ))}
      {live && (
        <li className="flex items-center gap-3 pb-2 text-[12.5px] text-fg-3">
          <span className="grid size-7 place-items-center rounded-lg border border-dashed border-line-strong">
            <LoaderCircle className="size-3.5 animate-spin text-accent" />
          </span>
          Working…
        </li>
      )}
    </ol>
  )
}

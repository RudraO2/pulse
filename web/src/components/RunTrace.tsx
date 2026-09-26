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
  HeartPulse,
  Hourglass,
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
} from 'lucide-react'
import { useState, type ComponentType } from 'react'
import type { RunStep, RunSummary, StepKind } from '@shared/events'
import { mdInline, ms } from '../lib/format'
import { useStore } from '../lib/store'
import { JsonBlock, ToolChip } from '../ui/primitives'

const ICON: Record<StepKind, ComponentType<{ className?: string }>> = {
  context: Eye,
  think: Sparkles,
  mood: HeartPulse,
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
    step.status === 'error' || step.status === 'blocked' ? 'text-bad bg-bad-soft border-transparent'
    : step.status === 'waiting' ? 'text-warn bg-warn-soft border-transparent'
    : step.kind === 'think' ? 'text-accent bg-accent-soft border-transparent'
    : step.kind === 'search' || step.kind === 'knowledge' ? 'text-teal bg-teal-soft border-transparent'
    : 'text-fg-3 border-line bg-surface'
  const hasData = step.data !== undefined && step.data !== null && !(typeof step.data === 'object' && Object.keys(step.data as object).length === 0)
  const tools = step.tools ?? []
  const expandable = hasData || tools.length > 0
  return (
    <li className="relative grid animate-fade-in grid-cols-[28px_minmax(0,1fr)] gap-3 pb-4">
      {!last && <span className="absolute top-[30px] bottom-0.5 left-[13.5px] w-px bg-line" />}
      <span className={clsx('relative z-10 grid size-7 place-items-center rounded-lg border', tone)}>
        {running ? <LoaderCircle className="size-3.5 animate-spin" /> : step.status === 'waiting' ? <Hourglass className="size-3.5" /> : <Icon className="size-3.5" />}
      </span>
      <div className="min-w-0 pt-1">
        <div className="flex items-start justify-between gap-3">
          <div className="min-w-0">
            <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
              <span className="text-[13.5px] font-medium text-fg">{step.title}</span>
              {step.status === 'blocked' && <span className="text-[11.5px] font-medium text-bad">blocked by policy</span>}
              {step.status === 'waiting' && <span className="text-[11.5px] font-medium text-warn">waiting</span>}
            </div>
            {step.detail && (
              <p
                onClick={() => setOpen((o) => !o)}
                className={clsx('prose-msg mt-0.5 cursor-text text-[12.5px] leading-relaxed', !open && 'line-clamp-3', step.status === 'error' || step.status === 'blocked' ? 'text-bad' : 'text-fg-3')}
                dangerouslySetInnerHTML={{ __html: mdInline(step.detail) }}
              />
            )}
          </div>
          {step.durationMs !== undefined && <span className="shrink-0 pt-0.5 font-mono text-[11px] text-fg-4 tabular-nums">{ms(step.durationMs)}</span>}
        </div>
        {expandable && (
          <button onClick={() => setOpen((o) => !o)} aria-expanded={open} className="mt-1.5 inline-flex items-center gap-1 text-[11.5px] font-medium text-fg-4 transition-colors hover:text-fg-2">
            <ChevronRight className={clsx('size-3 transition-transform', open && 'rotate-90')} />
            {tools.length ? `${tools.length} Swytchcode call${tools.length > 1 ? 's' : ''}` : 'Details'}
            {tools.length > 0 && hasData && ' · details'}
          </button>
        )}
        {open && (
          <div className="mt-2 space-y-2 animate-fade-in">
            {tools.length > 0 && (
              <div className="flex flex-wrap gap-1">
                {tools.map((t) => (
                  <ToolChip key={t} id={t} />
                ))}
              </div>
            )}
            {hasData && <JsonBlock value={step.data} />}
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

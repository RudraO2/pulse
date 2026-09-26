import clsx from 'clsx'
import { BookOpen, ChevronRight, CircleCheck, CircleX, Flag, Hand, Hourglass, Mail, MessageSquareReply, Sparkles, SquareTerminal, Users, VolumeX } from 'lucide-react'
import type { ComponentType } from 'react'
import type { RunOutcome, RunSummary } from '@shared/events'
import { clock, ms, ORIGIN_LABEL, runHeadline } from '../lib/format'
import { Badge, PlatformIcon } from '../ui/primitives'
import { openRun } from './RunDrawer'

export const OUTCOME_STYLE: Record<RunOutcome, { icon: ComponentType<{ className?: string }>; tone: string; text: string }> = {
  answered: { icon: MessageSquareReply, tone: 'text-ok bg-ok-soft', text: 'text-ok' },
  welcomed: { icon: Hand, tone: 'text-accent bg-accent-soft', text: 'text-accent' },
  asked_mods: { icon: Users, tone: 'text-warn bg-warn-soft', text: 'text-warn' },
  escalated: { icon: Flag, tone: 'text-bad bg-bad-soft', text: 'text-bad' },
  learned: { icon: BookOpen, tone: 'text-teal bg-teal-soft', text: 'text-teal' },
  proposed: { icon: BookOpen, tone: 'text-warn bg-warn-soft', text: 'text-warn' },
  silent: { icon: VolumeX, tone: 'text-fg-4 bg-subtle', text: 'text-fg-4' },
  awaiting_approval: { icon: Hourglass, tone: 'text-warn bg-warn-soft', text: 'text-warn' },
  executed: { icon: CircleCheck, tone: 'text-ok bg-ok-soft', text: 'text-ok' },
  reported: { icon: Mail, tone: 'text-accent bg-accent-soft', text: 'text-accent' },
  failed: { icon: CircleX, tone: 'text-bad bg-bad-soft', text: 'text-bad' },
}

export function ActivityRow({ run }: { run: RunSummary }) {
  const o = run.outcome ? OUTCOME_STYLE[run.outcome] : undefined
  const Icon = o?.icon ?? (run.origin === 'console' ? SquareTerminal : Sparkles)
  return (
    <button onClick={() => openRun(run.runId)} className="grid w-full grid-cols-[28px_minmax(0,1fr)_auto] items-center gap-3 px-5 py-2.5 text-left transition-colors hover:bg-hover sm:grid-cols-[40px_28px_minmax(0,1fr)_auto]">
      <span className="hidden font-mono text-[11.5px] text-fg-4 tabular-nums sm:block">{clock(run.startedAt)}</span>
      <span className={clsx('grid size-7 place-items-center rounded-lg', o?.tone ?? 'bg-accent-soft text-accent')}>
        <Icon className={clsx('size-3.5', !run.outcome && 'animate-pulse')} />
      </span>
      <span className="min-w-0">
        <span className="block truncate text-[13.5px] text-fg">{runHeadline(run)}</span>
        <span className="mt-0.5 flex items-center gap-1.5 text-[11.5px] text-fg-4">
          {run.platform && <PlatformIcon platform={run.platform} className="size-3" />}
          <span>{ORIGIN_LABEL[run.origin]}</span>
          {run.durationMs !== undefined && (
            <>
              <span>·</span>
              <span className="tabular-nums">{ms(run.durationMs)}</span>
            </>
          )}
        </span>
      </span>
      <span className="flex items-center gap-2">
        {run.simulated && <Badge tone="ghost">Scripted</Badge>}
        <ChevronRight className="size-3.5 text-fg-4" />
      </span>
    </button>
  )
}

import clsx from 'clsx'
import QRCode from 'qrcode'
import { ArrowUpRight, BookOpen, CircleCheck, Flag, Hand, Hourglass, MessageSquareReply, ShieldCheck, Sparkles, Users, VolumeX, CircleX, Mail, SquareTerminal } from 'lucide-react'
import { useEffect, useMemo, useState, type ComponentType } from 'react'
import { Link } from 'react-router'
import type { RunSummary } from '@shared/events'
import { openRun } from '../components/RunDrawer'
import { ms, runHeadline, timeAgo, ORIGIN_LABEL } from '../lib/format'
import { useStore } from '../lib/store'
import { Badge, Card, CardHeader, EmptyState, PageHeader, PlatformIcon, Segmented } from '../ui/primitives'

function Stat({ label, value, hint, icon: Icon }: { label: string; value: string | number; hint?: string; icon: ComponentType<{ className?: string }> }) {
  return (
    <Card className="px-5 py-4">
      <div className="flex items-center justify-between">
        <span className="text-[12px] font-medium text-fg-3">{label}</span>
        <Icon className="size-4 text-fg-4" />
      </div>
      <div className="mt-2 text-[28px] leading-none font-semibold tracking-tight text-fg tabular-nums">{value}</div>
      {hint && <div className="mt-2 text-[12px] text-fg-3">{hint}</div>}
    </Card>
  )
}

const OUTCOME_ICON: Record<string, { icon: ComponentType<{ className?: string }>; tone: string }> = {
  answered: { icon: MessageSquareReply, tone: 'text-ok bg-ok-soft' },
  welcomed: { icon: Hand, tone: 'text-accent bg-accent-soft' },
  asked_mods: { icon: Users, tone: 'text-warn bg-warn-soft' },
  escalated: { icon: Flag, tone: 'text-bad bg-bad-soft' },
  learned: { icon: BookOpen, tone: 'text-ok bg-ok-soft' },
  proposed: { icon: BookOpen, tone: 'text-warn bg-warn-soft' },
  silent: { icon: VolumeX, tone: 'text-fg-4 bg-subtle' },
  awaiting_approval: { icon: Hourglass, tone: 'text-warn bg-warn-soft' },
  executed: { icon: CircleCheck, tone: 'text-ok bg-ok-soft' },
  reported: { icon: Mail, tone: 'text-accent bg-accent-soft' },
  failed: { icon: CircleX, tone: 'text-bad bg-bad-soft' },
}

export function ActivityRow({ run }: { run: RunSummary }) {
  const o = run.outcome ? OUTCOME_ICON[run.outcome] : undefined
  const Icon = o?.icon ?? (run.origin === 'console' ? SquareTerminal : Sparkles)
  return (
    <button onClick={() => openRun(run.runId)} className="flex w-full items-center gap-3 px-5 py-2.5 text-left transition-colors hover:bg-hover">
      <span className={clsx('grid size-7 shrink-0 place-items-center rounded-lg', o?.tone ?? 'bg-accent-soft text-accent')}>
        <Icon className={clsx('size-3.5', !run.outcome && 'animate-pulse')} />
      </span>
      <div className="min-w-0 flex-1">
        <div className="truncate text-[13px] text-fg">{runHeadline(run)}</div>
        <div className="mt-0.5 flex items-center gap-1.5 text-[11px] text-fg-4">
          {run.platform && <PlatformIcon platform={run.platform} className="size-3" />}
          <span>{ORIGIN_LABEL[run.origin]}</span>
          <span>·</span>
          <span>{timeAgo(run.startedAt)}</span>
          {run.durationMs !== undefined && (
            <>
              <span>·</span>
              <span className="tabular-nums">{ms(run.durationMs)}</span>
            </>
          )}
        </div>
      </div>
      {run.simulated && <Badge tone="info">Scripted</Badge>}
    </button>
  )
}

function Sparkline({ points }: { points: number[] }) {
  if (points.length < 2) return <div className="h-12" />
  const max = Math.max(...points)
  const min = Math.min(...points)
  const w = 240
  const h = 48
  const xy = points.map((p, i) => [(i / (points.length - 1)) * w, h - 4 - ((p - min) / (max - min || 1)) * (h - 8)] as const)
  const d = xy.map(([x, y], i) => `${i ? 'L' : 'M'}${x.toFixed(1)},${y.toFixed(1)}`).join(' ')
  return (
    <svg viewBox={`0 0 ${w} ${h}`} className="h-12 w-full" preserveAspectRatio="none">
      <path d={`${d} L${w},${h} L0,${h} Z`} fill="var(--accent)" opacity="0.08" />
      <path d={d} fill="none" stroke="var(--accent)" strokeWidth="1.75" vectorEffect="non-scaling-stroke" />
    </svg>
  )
}

function Qr({ url, label, platform }: { url?: string; label: string; platform: 'telegram' | 'slack' }) {
  const [src, setSrc] = useState<string>()
  useEffect(() => {
    if (url) void QRCode.toDataURL(url, { margin: 0, width: 220, color: { dark: '#18181b', light: '#ffffff' } }).then(setSrc)
  }, [url])
  if (!url) return null
  return (
    <a href={url} target="_blank" rel="noreferrer" className="group flex flex-col items-center gap-2 rounded-xl border border-line p-3 transition-colors hover:bg-hover">
      {src ? <img src={src} alt={`${label} QR`} className="size-24 rounded-md bg-white p-1.5" /> : <div className="skeleton size-24" />}
      <span className="flex items-center gap-1.5 text-[12px] font-medium text-fg-2">
        <PlatformIcon platform={platform} /> {label}
      </span>
    </a>
  )
}

export function OverviewScreen() {
  const [view, setView] = useState<'real' | 'demo'>('real')
  const s = useStore((st) => st)
  const c = view === 'real' ? s.counters : s.scripted
  const runs = s.runs.filter((r) => (view === 'real' ? !r.simulated : true)).filter((r) => r.outcome !== 'silent' || r.origin !== 'community').slice(0, 14)
  const liveKb = s.kb.filter((e) => e.status === 'Live' && e.type === 'FAQ')
  const learned = liveKb.filter((e) => e.source !== 'Seed')
  const growth = useMemo(() => {
    const sorted = [...liveKb].sort((a, b) => a.createdAt - b.createdAt)
    return sorted.map((_, i) => i + 1)
  }, [liveKb])
  const needs = {
    approvals: s.approvals.filter((a) => a.status === 'pending').length,
    waiting: s.pending.filter((p) => p.status === 'waiting').length,
    flagged: s.attention.filter((a) => a.status === 'open').length,
  }
  const answeredPct = c.questions ? Math.round((c.answered / c.questions) * 100) : 0

  return (
    <div className="animate-fade-in">
      <PageHeader
        title="Overview"
        subtitle={
          <>
            {s.community.about} <span className="text-fg-4">· live since {new Date(s.startedAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}</span>
          </>
        }
        actions={
          <Segmented
            value={view}
            onChange={setView}
            options={[
              { value: 'real', label: 'Real members' },
              { value: 'demo', label: 'Incl. scripted' },
            ]}
          />
        }
      />

      <div className="grid grid-cols-2 gap-4 lg:grid-cols-4">
        <Stat label="Active members" value={c.members} hint={`${c.messages} messages`} icon={Users} />
        <Stat label="Questions answered" value={c.answered} hint={c.questions ? `${answeredPct}% of ${c.questions} questions` : 'no questions yet'} icon={MessageSquareReply} />
        <Stat label="Median response" value={s.medianResponseMs ? ms(s.medianResponseMs) : '–'} hint="question → answer in chat" icon={Sparkles} />
        <Stat label="Answers learned" value={learned.length} hint={`${liveKb.length} entries in Notion`} icon={BookOpen} />
      </div>

      <div className="mt-6 grid gap-6 lg:grid-cols-[minmax(0,1fr)_340px]">
        <Card className="overflow-hidden">
          <CardHeader title="Live activity" subtitle="Every decision Pulse made. Click one to see the full trace." action={<Link to="/conversations" className="text-[12px] font-medium text-fg-3 hover:text-fg">Conversations →</Link>} />
          {runs.length ? (
            <div className="divide-y divide-line">
              {runs.map((r) => (
                <ActivityRow key={r.runId} run={r} />
              ))}
            </div>
          ) : (
            <EmptyState icon={<Sparkles className="size-4" />} title="Waiting for the community" hint="Messages in Telegram or Slack show up here as Pulse handles them. Try a scripted scenario from the Demo page." action={<Link to="/demo" className="text-[12px] font-medium text-accent">Open Demo →</Link>} />
          )}
        </Card>

        <div className="space-y-6">
          <Card>
            <CardHeader title="Needs you" action={<Link to="/inbox" className="text-[12px] font-medium text-fg-3 hover:text-fg">Inbox →</Link>} />
            <div className="grid grid-cols-3 divide-x divide-line">
              {[
                ['Approvals', needs.approvals],
                ['Waiting', needs.waiting],
                ['Flagged', needs.flagged],
              ].map(([label, n]) => (
                <Link to="/inbox" key={label} className="px-4 py-4 text-center hover:bg-hover">
                  <div className={clsx('text-xl font-semibold tabular-nums', Number(n) ? 'text-fg' : 'text-fg-4')}>{n}</div>
                  <div className="mt-0.5 text-[11px] text-fg-3">{label}</div>
                </Link>
              ))}
            </div>
          </Card>

          <Card>
            <CardHeader title="Knowledge base" subtitle="Notion, kept in sync every minute" action={<Link to="/knowledge" className="text-[12px] font-medium text-fg-3 hover:text-fg">Open →</Link>} />
            <div className="px-5 pt-4 pb-3">
              <div className="flex items-baseline gap-2">
                <span className="text-2xl font-semibold tabular-nums">{liveKb.length}</span>
                <span className="text-[12px] text-fg-3">entries · {learned.length} learned from the community</span>
              </div>
              <Sparkline points={growth} />
              <div className="mt-2 space-y-1.5">
                {learned.slice(0, 3).map((e) => (
                  <div key={e.id} className="flex items-center gap-2 text-[12px]">
                    <Badge tone={e.source === 'Mod' ? 'ok' : e.source === 'Member' ? 'warn' : 'accent'}>{e.source}</Badge>
                    <span className="truncate text-fg-2">{e.question}</span>
                  </div>
                ))}
              </div>
            </div>
          </Card>

          <Card>
            <CardHeader title="Swytchcode" subtitle="Every external action runs through it" icon={<ShieldCheck className="size-4" />} action={<Link to="/guardrails" className="text-[12px] font-medium text-fg-3 hover:text-fg">Guardrails →</Link>} />
            <div className="grid grid-cols-3 divide-x divide-line">
              {[
                ['Calls', s.swyStats.total],
                ['Dry-runs', s.swyStats.dryRuns],
                ['Blocked', s.guardrails.length],
              ].map(([label, n]) => (
                <div key={label} className="px-4 py-4 text-center">
                  <div className="text-xl font-semibold tabular-nums">{n}</div>
                  <div className="mt-0.5 text-[11px] text-fg-3">{label}</div>
                </div>
              ))}
            </div>
          </Card>

          {(s.links.telegramJoinUrl || s.links.slackInviteUrl) && (
            <Card>
              <CardHeader title="Join the community" subtitle="Scan and ask Pulse anything" icon={<ArrowUpRight className="size-4" />} />
              <div className="grid grid-cols-2 gap-3 p-4">
                <Qr url={s.links.telegramJoinUrl} label="Telegram" platform="telegram" />
                <Qr url={s.links.slackInviteUrl} label="Slack" platform="slack" />
              </div>
            </Card>
          )}
        </div>
      </div>
    </div>
  )
}

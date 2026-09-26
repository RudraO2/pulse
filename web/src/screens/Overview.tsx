import clsx from 'clsx'
import QRCode from 'qrcode'
import { ArrowRight, BookOpen, Flag, Repeat, HelpCircle, MessagesSquare, QrCode, Search, ShieldCheck, Sparkles, Users, X, Zap, type LucideIcon } from 'lucide-react'
import { useEffect, useMemo, useState, type ReactNode } from 'react'
import { Link } from 'react-router'
import type { Counters } from '@shared/events'
import { ActivityRow } from '../components/ActivityRow'
import { DecisionButtons } from '../components/ApprovalCard'
import { clock, ms, timeAgo } from '../lib/format'
import { useStore } from '../lib/store'
import { Button, Card, CardHeader, EmptyState, Metrics, PageHeader, PlatformIcon, Segmented, ShowMore } from '../ui/primitives'

const sum = (a: Counters, b: Counters): Counters => Object.fromEntries(Object.keys(a).map((k) => [k, a[k as keyof Counters] + b[k as keyof Counters]])) as unknown as Counters

function HeaderLink({ to, children }: { to: string; children: ReactNode }) {
  return (
    <Link to={to} className="inline-flex shrink-0 items-center gap-1 text-[12.5px] font-medium text-fg-3 hover:text-accent">
      {children} <ArrowRight className="size-3" />
    </Link>
  )
}

/* ── The learning loop: the product's thesis, drawn with today's numbers ── */

function LoopNode({ icon: Icon, n, label, hint, tone }: { icon: LucideIcon; n: number; label: string; hint: string; tone?: 'warn' | 'accent' | 'teal' }) {
  return (
    <li className="relative flex flex-col items-start gap-2 pr-2" title={hint}>
      <span
        className={clsx(
          'relative z-10 grid size-9 place-items-center rounded-[10px] border',
          tone === 'warn' ? 'border-transparent bg-warn-soft text-warn' : tone === 'accent' ? 'border-transparent bg-accent-soft text-accent' : tone === 'teal' ? 'border-transparent bg-teal-soft text-teal' : 'border-line bg-subtle text-fg-3',
        )}
      >
        <Icon className="size-4" />
      </span>
      <span className="display text-[24px] leading-none font-semibold text-fg tabular-nums">{n}</span>
      <span className="text-[12.5px] leading-snug text-fg-3">{label}</span>
    </li>
  )
}

function LearningLoop({ real }: { real: boolean }) {
  const s = useStore((st) => st)
  const c = real ? s.counters : sum(s.counters, s.scripted)
  const pending = s.pending.filter((p) => !real || !p.simulated)
  const answered = pending.filter((p) => p.status === 'answered')
  const waiting = pending.filter((p) => p.status === 'waiting').length
  const learned = s.kb.filter((e) => e.type === 'FAQ' && e.status === 'Live' && e.source !== 'Seed' && (!real || !e.scripted))
  const members = learned.filter((e) => e.source === 'Member').length
  const reused = learned.reduce((n, e) => n + e.used, 0)

  // the most recent full loop, told as a story
  const latest = [...answered].sort((a, b) => (b.answeredAt ?? 0) - (a.answeredAt ?? 0))[0]
  const entry = latest ? learned.find((e) => e.question.trim().toLowerCase() === latest.question.trim().toLowerCase() || (!!latest.answer && e.answer === latest.answer)) : undefined

  return (
    <Card>
      <CardHeader title="Learning loop" action={<HeaderLink to="/knowledge">Knowledge</HeaderLink>} />
      <div className="px-5 pt-5 pb-5">
        <ol className="relative grid grid-cols-2 gap-y-5 sm:grid-cols-5">
          <li className="loop-track hidden sm:block" style={{ left: 18, right: 'calc(20% - 18px)' }} role="presentation" aria-hidden />
          <LoopNode icon={MessagesSquare} n={c.questions} label="Members asked" hint="Telegram and Slack" />
          <LoopNode icon={Search} n={c.askedMods} label="Not in Notion" hint="sent to #mods, no guessing" tone="warn" />
          <LoopNode icon={Users} n={answered.length} label="Organizers answered" hint={waiting ? `${waiting} still waiting` : 'none waiting'} tone="accent" />
          <LoopNode icon={BookOpen} n={learned.length} label="Saved to Notion" hint={members ? `incl. ${members} member answer${members > 1 ? 's' : ''}` : 'organizer answers'} tone="teal" />
          <LoopNode icon={Zap} n={reused} label="Reused instantly" hint={s.medianResponseMs ? `answered in ~${ms(s.medianResponseMs)}` : 'no waiting on anyone'} tone="teal" />
        </ol>
        <div className="mt-5 flex items-center gap-3 text-teal before:flex-1 before:border-t before:border-dashed before:border-line-strong after:flex-1 after:border-t after:border-dashed after:border-line-strong" title="The next member who asks gets it instantly">
          <Repeat className="size-3.5" aria-label="Loops back: the next member gets it instantly" />
        </div>
        {latest && (
          <div className="mt-4 rounded-[10px] bg-subtle px-4 py-3">
            <div className="text-[13.5px] font-medium text-fg">
              <span className="label mr-2">Latest</span>“{latest.question}”
            </div>
            <ol className="mt-1.5 flex flex-wrap gap-x-3 gap-y-1 text-[12.5px] text-fg-3">
              <Beat t={latest.askedAt}>{latest.userName.split(' ')[0]} asked</Beat>
              <Beat t={latest.askedAt} arrow>
                asked #mods
              </Beat>
              {latest.answeredAt && (
                <Beat t={latest.answeredAt} arrow>
                  {latest.answeredBy ?? 'An organizer'} answered
                </Beat>
              )}
              {entry && (
                <Beat t={entry.createdAt} arrow>
                  saved to Notion
                </Beat>
              )}
              {entry && entry.used > 0 && (
                <Beat arrow>
                  reused {entry.used}×
                </Beat>
              )}
            </ol>
          </div>
        )}
      </div>
    </Card>
  )
}

function Beat({ t, arrow, children }: { t?: number; arrow?: boolean; children: ReactNode }) {
  return (
    <li className="flex items-center gap-1.5">
      {arrow && <ArrowRight className="size-3 text-fg-4" />}
      {t && <time className="font-mono text-[11.5px] text-fg-4">{clock(t)}</time>}
      {children}
    </li>
  )
}

/* ── Needs you: the top of the inbox, actionable in place ── */

function NeedsYou() {
  const approvals = useStore((s) => s.approvals.filter((a) => a.status === 'pending'))
  const attention = useStore((s) => s.attention.filter((a) => a.status === 'open'))
  const waiting = useStore((s) => s.pending.filter((p) => p.status === 'waiting'))
  const rows: Array<{ key: string; icon: LucideIcon; tone: string; title: string; meta: string; action?: ReactNode }> = [
    ...approvals.map((a) => ({ key: a.id, icon: ShieldCheck, tone: 'bg-warn-soft text-warn', title: a.title, meta: `${a.actions.length} request${a.actions.length === 1 ? '' : 's'} previewed · ${timeAgo(a.createdAt)}`, action: <DecisionButtons a={a} /> })),
    ...attention.map((a) => ({ key: a.id, icon: Flag, tone: a.kind === 'frustrated' ? 'bg-bad-soft text-bad' : 'bg-warn-soft text-warn', title: `${a.userName} · ${a.kind.replace('_', ' ')}`, meta: a.reason })),
    ...waiting.map((p) => ({ key: p.id, icon: HelpCircle, tone: 'bg-accent-soft text-accent', title: `“${p.question}”`, meta: `${p.userName} · waiting on organizers ${timeAgo(p.askedAt).replace(' ago', '')}` })),
  ]
  const shown = rows.slice(0, 3)
  const more = rows.length - shown.length
  return (
    <Card className="overflow-hidden">
      <CardHeader title={<span className="flex items-center gap-2">Needs you{rows.length > 0 && <span className="grid h-[18px] min-w-5 place-items-center rounded-full bg-accent px-1.5 text-[11px] font-semibold text-accent-fg tabular-nums">{rows.length}</span>}</span>} action={<HeaderLink to="/inbox">Inbox</HeaderLink>} />
      {shown.length ? (
        <ul className="divide-y divide-line">
          {shown.map((r) => (
            <li key={r.key} className="grid grid-cols-[30px_minmax(0,1fr)] gap-3 px-5 py-3.5">
              <span className={clsx('grid size-[30px] place-items-center rounded-lg', r.tone)}>
                <r.icon className="size-3.5" />
              </span>
              <div className="min-w-0">
                <div className="line-clamp-2 text-[13.5px] leading-snug font-medium text-fg">{r.title}</div>
                <div className="mt-0.5 truncate text-[12px] text-fg-3">{r.meta}</div>
                {r.action && <div className="mt-2.5">{r.action}</div>}
              </div>
            </li>
          ))}
          {more > 0 && (
            <li>
              <Link to="/inbox" className="block py-2.5 text-center text-[12.5px] font-medium text-fg-3 hover:bg-hover hover:text-fg">
                {more} more in the Inbox
              </Link>
            </li>
          )}
        </ul>
      ) : (
        <EmptyState className="!py-9" title="All clear" />
      )}
    </Card>
  )
}

/* ── Invite: QR codes live behind one button until you need them ── */

function Qr({ url, label, platform }: { url?: string; label: string; platform: 'telegram' | 'slack' }) {
  const [src, setSrc] = useState<string>()
  useEffect(() => {
    if (url) void QRCode.toDataURL(url, { margin: 0, width: 280, color: { dark: '#12151b', light: '#ffffff' } }).then(setSrc)
  }, [url])
  if (!url) return null
  return (
    <a href={url} target="_blank" rel="noreferrer" className="flex flex-col items-center gap-3 rounded-xl border border-line p-4 transition-colors hover:bg-hover">
      {src ? <img src={src} alt={`${label} QR code`} className="size-40 rounded-lg bg-white p-2" /> : <div className="skeleton size-40" />}
      <span className="flex items-center gap-1.5 text-[13px] font-medium text-fg-2">
        <PlatformIcon platform={platform} /> Join on {label}
      </span>
    </a>
  )
}

function InviteDialog({ onClose }: { onClose: () => void }) {
  const links = useStore((s) => s.links)
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && onClose()
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onClose])
  return (
    <div className="fixed inset-0 z-40 grid place-items-center p-4">
      <div className="absolute inset-0 animate-fade-in bg-[var(--scrim)]" onClick={onClose} />
      <div className="card relative w-full max-w-[520px] animate-pop p-6 shadow-[var(--shadow-lg)]" role="dialog" aria-label="Invite members">
        <button onClick={onClose} className="absolute top-4 right-4 rounded-md p-1 text-fg-3 hover:bg-hover hover:text-fg" aria-label="Close">
          <X className="size-4" />
        </button>
        <h2 className="display text-[22px] font-semibold text-fg">Scan to ask Pulse</h2>
        <div className="mt-5 grid gap-3 sm:grid-cols-2">
          <Qr url={links.telegramJoinUrl} label="Telegram" platform="telegram" />
          <Qr url={links.slackInviteUrl} label="Slack" platform="slack" />
        </div>
      </div>
    </div>
  )
}

/* ── Screen ── */

export function OverviewScreen() {
  const [view, setView] = useState<'real' | 'all'>('all')
  const [more, setMore] = useState(false)
  const [invite, setInvite] = useState(false)
  const s = useStore((st) => st)
  const real = view === 'real'
  const c = real ? s.counters : sum(s.counters, s.scripted)
  const learned = useMemo(() => s.kb.filter((e) => e.type === 'FAQ' && e.status === 'Live' && e.source !== 'Seed' && (!real || !e.scripted)), [s.kb, real])
  const reused = learned.reduce((n, e) => n + e.used, 0)
  const runs = s.runs.filter((r) => !real || !r.simulated).filter((r) => r.outcome !== 'silent' || r.origin !== 'community')
  const shownRuns = runs.slice(0, more ? 20 : 6)
  const pct = c.questions ? Math.round((c.answered / c.questions) * 100) : 0
  const canInvite = !!(s.links.telegramJoinUrl || s.links.slackInviteUrl)

  return (
    <div className="animate-fade-in">
      <PageHeader
        title="Today"
        actions={
          <>
            {canInvite && (
              <Button icon={<QrCode className="size-3.5" />} onClick={() => setInvite(true)}>
                Invite
              </Button>
            )}
            <Segmented
              value={view}
              onChange={setView}
              options={[
                { value: 'real', label: 'Real' },
                { value: 'all', label: 'All' },
              ]}
            />
          </>
        }
      />

      <Metrics
        items={[
          { label: 'Active members', value: c.members, hint: `${c.messages} messages` },
          { label: 'Answered', value: c.questions ? pct : '–', unit: c.questions ? '%' : undefined, hint: c.questions ? `${c.answered} of ${c.questions}` : undefined },
          { label: 'Median response', value: s.medianResponseMs ? (s.medianResponseMs / 1000).toFixed(1) : '–', unit: s.medianResponseMs ? 's' : undefined },
          { label: 'Learned', value: learned.length, hint: reused ? <><span className="font-medium text-ok">+{reused}</span> reused</> : undefined },
        ]}
      />

      <div className="mt-5 grid grid-cols-1 items-start gap-5 lg:grid-cols-[minmax(0,1fr)_340px]">
        <div className="grid min-w-0 grid-cols-1 gap-5">
          <LearningLoop real={real} />
          <Card className="overflow-hidden">
            <CardHeader title="Activity" action={<HeaderLink to="/conversations">Conversations</HeaderLink>} />
            {shownRuns.length ? (
              <>
                <div className="divide-y divide-line">
                  {shownRuns.map((r) => (
                    <ActivityRow key={r.runId} run={r} />
                  ))}
                </div>
                {runs.length > 6 && <ShowMore open={more} onToggle={() => setMore((m) => !m)} more={`Show ${Math.min(runs.length, 20) - 6} more`} />}
              </>
            ) : (
              <EmptyState icon={<Sparkles className="size-4" />} title="No activity yet" action={<HeaderLink to="/demo">Play a demo</HeaderLink>} />
            )}
          </Card>
        </div>

        <div className="grid min-w-0 grid-cols-1 gap-5">
          <NeedsYou />
          <Card className="overflow-hidden">
            <CardHeader title="Swytchcode" action={<HeaderLink to="/guardrails">Guardrails</HeaderLink>} />
            <div className="grid grid-cols-3 divide-x divide-line">
              {[
                ['Calls', s.swyStats.total, 'text-fg'],
                ['Dry-runs', s.swyStats.dryRuns, 'text-fg'],
                ['Blocked', s.guardrails.length, s.guardrails.length ? 'text-bad' : 'text-fg'],
              ].map(([label, n, tone]) => (
                <div key={label} className="px-4 py-3.5">
                  <div className={clsx('display text-[20px] leading-none font-semibold tabular-nums', tone)}>{n}</div>
                  <div className="mt-1 text-[11.5px] text-fg-3">{label}</div>
                </div>
              ))}
            </div>
          </Card>
        </div>
      </div>

      {invite && <InviteDialog onClose={() => setInvite(false)} />}
    </div>
  )
}

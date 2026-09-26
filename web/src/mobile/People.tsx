import clsx from 'clsx'
import { ChevronLeft, ChevronRight, HeartPulse } from 'lucide-react'
import { Fragment, type ReactNode } from 'react'
import { Link, useNavigate, useParams } from 'react-router'
import type { MemberCase, MoodPoint } from '@shared/events'
import { CASE_LABEL, CASE_TONE, MoodLine, memberScores, moodTone, moodWord, visibleCases } from '../components/Mood'
import { api } from '../lib/api'
import { timeAgo } from '../lib/format'
import { useStore } from '../lib/store'
import { Avatar, Badge, PlatformIcon, PulseMark } from '../ui/primitives'
import { MemberActions } from './Member'

// People Pulse is following: one row per member with a problem, their mood
// line, and (on tap) the whole story: what they said, how they felt, who replied.

const firstName = (n: string) => n.split(/\s+/)[0] ?? n
const DOT = { bad: 'bg-bad', warn: 'bg-warn', neutral: 'bg-fg-4', ok: 'bg-ok' }

export function PeopleScreen() {
  const cases = useStore((s) => visibleCases(s.cases, false, 6 * 3600_000))
  const escalated = cases.filter((c) => c.status === 'escalated').length
  const watching = cases.filter((c) => c.status === 'open').length
  return (
    <div className="animate-fade-in">
      <h1 className="display text-[28px] leading-tight font-semibold text-fg">People</h1>
      <p className="mt-1 text-[13.5px] text-fg-3">{cases.length ? [escalated && `${escalated} need${escalated === 1 ? 's' : ''} you`, watching && `${watching} watching`].filter(Boolean).join(' · ') || 'All sorted' : 'Nobody is stuck right now.'}</p>
      {cases.length > 0 ? (
        <ul className="card mt-5 divide-y divide-line overflow-hidden">
          {cases.map((c) => (
            <li key={c.id}>
              <Link to={`/people/${c.id}`} className="grid grid-cols-[36px_minmax(0,1fr)_auto_16px] items-center gap-3 px-4 py-3.5 active:bg-hover">
                <Avatar name={c.userName} size={36} />
                <div className="min-w-0">
                  <div className="flex items-center gap-1.5">
                    <span className="truncate text-[15px] font-semibold text-fg">{c.userName}</span>
                    <Badge tone={CASE_TONE[c.status]}>{CASE_LABEL[c.status]}</Badge>
                  </div>
                  <div className="mt-0.5 truncate text-[12.5px] text-fg-3">{c.topic}</div>
                </div>
                <MoodLine scores={memberScores(c)} width={64} />
                <ChevronRight className="size-4 text-fg-4" />
              </Link>
            </li>
          ))}
        </ul>
      ) : (
        <div className="mt-10 grid place-items-center text-center">
          <span className="grid size-12 place-items-center rounded-2xl bg-ok-soft text-ok">
            <HeartPulse className="size-5" />
          </span>
          <p className="mt-3 max-w-[260px] text-[13.5px] text-fg-3">When someone gets stuck or upset, Pulse follows them here until it's sorted.</p>
        </div>
      )}
    </div>
  )
}

function Point({ p, name }: { p: MoodPoint; name: string }) {
  if (p.by !== 'member') {
    return (
      <li className="flex justify-end">
        <div className="max-w-[85%] rounded-[14px] rounded-br-md bg-accent-soft px-3.5 py-2.5">
          <div className="mb-0.5 flex items-center gap-1 text-[11.5px] font-semibold text-accent">
            {p.by === 'pulse' ? <PulseMark className="size-3" /> : null}
            {p.by === 'pulse' ? 'Pulse' : 'You / organizer'} · {timeAgo(p.ts)}
          </div>
          <p className="line-clamp-4 text-[13.5px] leading-relaxed text-fg">{p.text}</p>
        </div>
      </li>
    )
  }
  const tone = moodTone(p.score)
  return (
    <li className="flex">
      <div className="max-w-[85%] rounded-[14px] rounded-bl-md border border-line bg-surface px-3.5 py-2.5">
        <div className="mb-0.5 flex items-center gap-1.5 text-[11.5px] text-fg-3">
          <span className="font-semibold text-fg-2">{firstName(name)}</span> · {timeAgo(p.ts)}
          <span className="ml-auto flex items-center gap-1" title={p.via === 'keywords' ? 'read from keywords' : 'read by the mood model'}>
            <span className={clsx('size-1.5 rounded-full', DOT[tone])} />
            {p.emotion ?? moodWord(p.score).toLowerCase()} {p.score > 0 ? '+' : ''}
            {p.score.toFixed(1)}
          </span>
        </div>
        <p className="text-[14px] leading-relaxed text-fg">{p.text}</p>
      </div>
    </li>
  )
}

function Marker({ tone, children }: { tone: 'bad' | 'ok'; children: ReactNode }) {
  return (
    <li className="flex items-center gap-2.5 py-1 text-[12px] text-fg-3">
      <span className="h-px flex-1 bg-line" />
      <span className={clsx('size-1.5 rounded-full', tone === 'bad' ? 'bg-bad' : 'bg-ok')} />
      <span className="max-w-[75%] truncate">{children}</span>
      <span className="h-px flex-1 bg-line" />
    </li>
  )
}

export function PersonScreen() {
  const { id } = useParams()
  const nav = useNavigate()
  const c = useStore((s) => s.cases.find((x) => x.id === id)) as MemberCase | undefined
  if (!c) {
    return (
      <div className="py-16 text-center text-[14px] text-fg-3">
        Not found.{' '}
        <Link to="/people" className="text-accent">
          Back to people
        </Link>
      </div>
    )
  }
  const active = c.status !== 'resolved'
  return (
    <div className="animate-fade-in pb-4">
      <button onClick={() => nav(-1)} className="-ml-1.5 mb-3 flex items-center gap-0.5 text-[14px] font-medium text-fg-3 active:text-fg">
        <ChevronLeft className="size-4.5" /> Back
      </button>
      <div className="flex items-center gap-3">
        <Avatar name={c.userName} size={44} />
        <div className="min-w-0">
          <h1 className="display truncate text-[22px] leading-tight font-semibold text-fg">{c.userName}</h1>
          <div className="mt-0.5 flex items-center gap-1.5 text-[12.5px] text-fg-3">
            <PlatformIcon platform={c.platform} className="size-3" />
            <Badge tone={CASE_TONE[c.status]}>{CASE_LABEL[c.status]}</Badge>
            {c.simulated && <Badge tone="ghost">demo</Badge>}
          </div>
        </div>
      </div>

      <div className="card mt-4 p-4">
        <div className="flex items-baseline justify-between gap-3">
          <span className="text-[15px] font-semibold text-fg">{moodWord(c.mood)}</span>
          <span className="text-[12px] text-fg-4 tabular-nums">mood {c.mood > 0 ? '+' : ''}{c.mood.toFixed(1)}</span>
        </div>
        <div className="mt-2">
          <MoodLine scores={memberScores(c)} width={320} height={56} className="w-full" />
        </div>
        <p className="mt-2 text-[13px] text-fg-2">{c.topic}</p>
        {(c.escalation || c.resolution) && (
          <p className="mt-1 text-[12.5px] text-fg-3">
            {c.status === 'resolved' ? `Sorted${c.resolvedBy && c.resolvedBy !== 'member' ? ` by ${c.resolvedBy}` : ''}${c.resolution ? ` · ${c.resolution}` : ''}` : `Brought in a human: ${c.escalation?.reason}`}
          </p>
        )}
      </div>

      <ul className="mt-4 space-y-2.5">
        {c.points.map((p, i) => (
          <Fragment key={i}>
            <Point p={p} name={c.userName} />
            {c.escalatedAt && p.ts <= c.escalatedAt && (c.points[i + 1]?.ts ?? Infinity) > c.escalatedAt && <Marker tone="bad">Pulse brought in a human · {c.escalation?.reason}</Marker>}
          </Fragment>
        ))}
        {c.status === 'resolved' && <Marker tone="ok">Sorted{c.resolvedBy && c.resolvedBy !== 'member' ? ` by ${c.resolvedBy}` : ''} · {timeAgo(c.resolvedAt ?? c.updatedAt)}</Marker>}
      </ul>

      {active && <MemberActions id={c.escalation?.attentionId ?? c.id} name={c.userName} platform={c.platform} onResolve={() => api.resolveCase(c.id)} resolveLabel="Mark sorted" />}
    </div>
  )
}

import clsx from 'clsx'
import { Check, CircleCheck, HelpCircle, ShieldCheck } from 'lucide-react'
import { useEffect, useState } from 'react'
import type { Approval, AttentionItem, PendingQuestion } from '@shared/events'
import { ApprovalCard, DecisionButtons, KIND_LABEL, StatusBadge } from '../components/ApprovalCard'
import { MoodLine, memberScores, moodWord } from '../components/Mood'
import { api } from '../lib/api'
import { timeAgo } from '../lib/format'
import { useStore } from '../lib/store'
import { Avatar, Badge, Button, Card, EmptyState, PageHeader, PlatformIcon, Segmented } from '../ui/primitives'

type Entry = { type: 'approval'; key: string; a: Approval } | { type: 'member'; key: string; m: AttentionItem } | { type: 'question'; key: string; p: PendingQuestion }
type Filter = 'all' | Entry['type']

function ResolveButton({ id }: { id: string }) {
  const [busy, setBusy] = useState(false)
  return (
    <Button
      size="sm"
      icon={<Check className="size-3.5" />}
      loading={busy}
      onClick={async (e) => {
        e.stopPropagation()
        setBusy(true)
        await api.resolveAttention(id)
        setBusy(false)
      }}
    >
      Resolve
    </Button>
  )
}

function EntryRow({ e, selected, onSelect }: { e: Entry; selected: boolean; onSelect: () => void }) {
  const memberCase = useStore((s) => (e.type === 'member' && e.m.caseId ? s.cases.find((c) => c.id === e.m.caseId) : undefined))
  return (
    <li
      onClick={onSelect}
      className={clsx('card cursor-pointer overflow-hidden transition-[border-color,box-shadow]', selected ? 'border-line-strong shadow-[0_0_0_3px_var(--accent-soft)]' : 'hover:border-line-strong')}
    >
      <div className="grid grid-cols-[30px_minmax(0,1fr)] items-start gap-3 px-4 py-3.5 sm:grid-cols-[30px_minmax(0,1fr)_auto]">
        {e.type === 'approval' ? (
          <span className="grid size-[30px] place-items-center rounded-lg bg-warn-soft text-warn">
            <ShieldCheck className="size-3.5" />
          </span>
        ) : e.type === 'member' ? (
          <Avatar name={e.m.userName} size={30} />
        ) : (
          <span className="grid size-[30px] place-items-center rounded-lg bg-accent-soft text-accent">
            <HelpCircle className="size-3.5" />
          </span>
        )}

        <div className="min-w-0">
          {e.type === 'approval' && (
            <>
              <div className="flex flex-wrap items-center gap-2 text-[14px] font-semibold text-fg">
                {e.a.title}
                <Badge>{KIND_LABEL[e.a.kind]}</Badge>
                {e.a.simulated && <Badge tone="ghost">Scripted</Badge>}
              </div>
              <div className="mt-0.5 text-[12px] text-fg-3">
                {e.a.requestedBy} · {timeAgo(e.a.createdAt)} · {e.a.actions.length} dry-run request{e.a.actions.length === 1 ? '' : 's'}
              </div>
            </>
          )}
          {e.type === 'member' && (
            <>
              <div className="flex flex-wrap items-center gap-2 text-[14px] font-semibold text-fg">
                {e.m.userName}
                <Badge tone={e.m.kind === 'frustrated' ? 'bad' : e.m.kind === 'ignored' ? 'warn' : 'accent'}>{e.m.kind.replace('_', ' ')}</Badge>
                {e.m.simulated && <Badge tone="ghost">Scripted</Badge>}
              </div>
              <p className={clsx('mt-1 text-[13px] leading-relaxed text-fg-2', !selected && 'line-clamp-1')}>“{e.m.text}”</p>
              <div className="mt-1 flex items-center gap-1.5 text-[12px] text-fg-4">
                <PlatformIcon platform={e.m.platform} className="size-3" />
                {e.m.reason} · {timeAgo(e.m.ts)}
              </div>
              {memberCase && (
                <div className="mt-2 flex items-center gap-2.5 text-[12px] text-fg-3" title="Mood per message, oldest → newest">
                  <MoodLine scores={memberScores(memberCase)} width={96} />
                  <span className="min-w-0 truncate">
                    {moodWord(memberCase.mood)} · {memberCase.topic}
                    {memberCase.pulseReplies ? ` · Pulse answered ${memberCase.pulseReplies}×` : ''}
                  </span>
                </div>
              )}
            </>
          )}
          {e.type === 'question' && (
            <>
              <div className="text-[14px] font-semibold text-fg">“{e.p.question}”</div>
              <div className="mt-1 flex items-center gap-1.5 text-[12px] text-fg-3">
                <PlatformIcon platform={e.p.platform} className="size-3" />
                {e.p.userName} · waiting {timeAgo(e.p.askedAt).replace(' ago', '')}
                {e.p.simulated && <Badge tone="ghost">Scripted</Badge>}
              </div>
              {selected && <p className="mt-2 text-[12.5px] text-fg-3">Reply in the #mods thread to teach Pulse.</p>}
            </>
          )}
        </div>

        <div className="col-span-2 flex justify-start sm:col-span-1 sm:justify-end" onClick={(ev) => ev.stopPropagation()}>
          {e.type === 'approval' && <DecisionButtons a={e.a} />}
          {e.type === 'member' && <ResolveButton id={e.m.id} />}
        </div>
      </div>
      {selected && e.type === 'approval' && (
        <div className="border-t border-line" onClick={(ev) => ev.stopPropagation()}>
          <ApprovalCard approval={e.a} bare />
        </div>
      )}
    </li>
  )
}

function History() {
  const approvals = useStore((s) => s.approvals.filter((a) => a.status !== 'pending').slice(0, 25))
  const resolved = useStore((s) => s.attention.filter((a) => a.status === 'resolved'))
  const answered = useStore((s) => s.pending.filter((p) => p.status === 'answered'))
  const rows = [
    ...approvals.map((a) => ({ key: a.id, ts: a.decidedAt ?? a.createdAt, title: a.title, meta: `${KIND_LABEL[a.kind]}${a.decidedBy ? ` · ${a.status === 'rejected' ? 'rejected' : 'approved'} by ${a.decidedBy}` : ''}`, badge: <StatusBadge a={a} /> })),
    ...resolved.map((a) => ({ key: a.id, ts: a.ts, title: `${a.userName} · ${a.kind.replace('_', ' ')}`, meta: a.reason, badge: <Badge tone="ok">Resolved</Badge> })),
    ...answered.map((p) => ({ key: p.id, ts: p.answeredAt ?? p.askedAt, title: `“${p.question}”`, meta: `answered by ${p.answeredBy ?? 'an organizer'}`, badge: <Badge tone="teal">Learned</Badge> })),
  ].sort((a, b) => b.ts - a.ts)
  if (!rows.length) return <Card><EmptyState title="No decisions yet" /></Card>
  return (
    <Card className="overflow-hidden">
      <ul className="divide-y divide-line">
        {rows.map((r) => (
          <li key={r.key} className="flex items-center gap-3 px-5 py-3">
            <div className="min-w-0 flex-1">
              <div className="truncate text-[13.5px] font-medium text-fg">{r.title}</div>
              <div className="truncate text-[12px] text-fg-3">
                {r.meta} · {timeAgo(r.ts)}
              </div>
            </div>
            {r.badge}
          </li>
        ))}
      </ul>
    </Card>
  )
}

export function InboxScreen() {
  const approvals = useStore((s) => s.approvals)
  const attention = useStore((s) => s.attention)
  const pending = useStore((s) => s.pending)
  const [view, setView] = useState<'open' | 'history'>('open')
  const [filter, setFilter] = useState<Filter>('all')
  const [sel, setSel] = useState(0)

  const all: Entry[] = [
    ...approvals.filter((a) => a.status === 'pending').map((a) => ({ type: 'approval' as const, key: a.id, a })),
    ...attention.filter((m) => m.status === 'open').map((m) => ({ type: 'member' as const, key: m.id, m })),
    ...pending.filter((p) => p.status === 'waiting').map((p) => ({ type: 'question' as const, key: p.id, p })),
  ]
  const count = (t: Entry['type']) => all.filter((e) => e.type === t).length
  const entries = all.filter((e) => filter === 'all' || e.type === filter)
  const current = Math.min(sel, Math.max(0, entries.length - 1))

  // J/K move, A approve, R reject, E resolve
  useEffect(() => {
    if (view !== 'open') return
    const onKey = (ev: KeyboardEvent) => {
      const el = document.activeElement
      if (el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement || ev.ctrlKey || ev.metaKey || ev.altKey || document.querySelector('[role="dialog"]')) return
      const k = ev.key.toLowerCase()
      const e = entries[current]
      if (k === 'j') setSel(Math.min(entries.length - 1, current + 1))
      else if (k === 'k') setSel(Math.max(0, current - 1))
      else if (k === 'a' && e?.type === 'approval' && !e.a.actions.every((x) => !!x.blocked)) void api.approve(e.a.id)
      else if (k === 'r' && e?.type === 'approval') void api.reject(e.a.id)
      else if (k === 'e' && e?.type === 'member') void api.resolveAttention(e.m.id)
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [view, entries, current])

  return (
    <div className="animate-fade-in">
      <PageHeader
        title="Inbox"
        actions={
          <Segmented
            value={view}
            onChange={setView}
            options={[
              { value: 'open', label: 'Open', count: all.length },
              { value: 'history', label: 'History' },
            ]}
          />
        }
      />

      {view === 'history' ? (
        <History />
      ) : (
        <>
          {all.length > 3 && (
            <div className="mb-4">
              <Segmented
                value={filter}
                onChange={(v) => {
                  setFilter(v)
                  setSel(0)
                }}
                options={[
                  { value: 'all', label: 'All', count: all.length },
                  { value: 'approval', label: 'Approvals', count: count('approval') },
                  { value: 'member', label: 'Members', count: count('member') },
                  { value: 'question', label: 'Questions', count: count('question') },
                ]}
              />
            </div>
          )}
          {entries.length ? (
            <>
              <ul className="grid gap-2.5" title="Keys: J/K move · A approve · R reject · E resolve">
                {entries.map((e, i) => (
                  <EntryRow key={e.key} e={e} selected={i === current} onSelect={() => setSel(i)} />
                ))}
              </ul>
            </>
          ) : (
            <div className="flex items-center gap-3 rounded-xl border border-dashed border-line-strong px-5 py-4 text-[13.5px] text-fg-3">
              <CircleCheck className="size-5 text-ok" />
              All caught up
            </div>
          )}
        </>
      )}
    </div>
  )
}

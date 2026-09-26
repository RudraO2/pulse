import clsx from 'clsx'
import { Check, ChevronDown, ChevronRight, CircleCheck, CircleX, ShieldAlert, ShieldCheck, X } from 'lucide-react'
import { useState } from 'react'
import type { Approval } from '@shared/events'
import { api } from '../lib/api'
import { mdInline, providerOf, timeAgo } from '../lib/format'
import { Avatar, Badge, Button, JsonBlock, PlatformIcon } from '../ui/primitives'

export const KIND_LABEL: Record<Approval['kind'], string> = {
  announcement: 'Announcement',
  knowledge: 'Knowledge',
  poll: 'Poll',
  email: 'Email',
  capability: 'Swytchcode action',
  pin: 'Pin',
  post: 'Post',
}

const PREVIEW_LABEL: Record<Approval['kind'], string> = {
  announcement: 'What members will see',
  post: 'What members will see',
  poll: 'The poll',
  knowledge: 'The FAQ entry',
  email: 'The email',
  capability: 'The action',
  pin: 'The action',
}

export function StatusBadge({ a }: { a: Approval }) {
  if (a.status === 'pending') return <Badge tone="warn">Needs approval</Badge>
  if (a.status === 'executed') return <Badge tone="ok">Executed</Badge>
  if (a.status === 'approved') return <Badge tone="accent">Running…</Badge>
  if (a.status === 'rejected') return <Badge>Rejected</Badge>
  return <Badge tone="bad">Failed</Badge>
}

/** Approve / reject with a busy state. Shared by the card and the Inbox rows. */
export function useDecision(a: Approval) {
  const [busy, setBusy] = useState<'approve' | 'reject' | undefined>()
  const act = async (d: 'approve' | 'reject') => {
    setBusy(d)
    await (d === 'approve' ? api.approve(a.id) : api.reject(a.id))
    setBusy(undefined)
  }
  const allBlocked = a.actions.length > 0 && a.actions.every((x) => !!x.blocked)
  return { busy, act, allBlocked }
}

export function DecisionButtons({ a }: { a: Approval }) {
  const { busy, act, allBlocked } = useDecision(a)
  if (a.status !== 'pending') return null
  return (
    <div className="flex items-center gap-1.5">
      <Button size="sm" variant="ghost" icon={<X className="size-3.5" />} loading={busy === 'reject'} onClick={() => void act('reject')}>
        Reject
      </Button>
      <Button size="sm" variant="go" icon={<Check className="size-3.5" />} loading={busy === 'approve'} onClick={() => void act('approve')} disabled={allBlocked}>
        Approve &amp; run
      </Button>
    </div>
  )
}

/**
 * An approval reads like a receipt: what people will see first, then (on
 * demand) the exact Swytchcode dry-run requests behind it.
 */
export function ApprovalCard({ approval: a, compact, bare }: { approval: Approval; compact?: boolean; bare?: boolean }) {
  const [showRequests, setShowRequests] = useState(false)
  const [openIdx, setOpenIdx] = useState<number | undefined>()
  const blocked = a.actions.filter((x) => !!x.blocked)
  const targets = [...new Set(a.actions.map((x) => providerOf(x.tool)))]
  const social = a.kind === 'announcement' || a.kind === 'post'

  return (
    <div className={clsx(!bare && 'card overflow-hidden', !bare && a.status === 'pending' && 'border-[color-mix(in_oklab,var(--warn)_40%,var(--line))] shadow-[0_0_0_4px_var(--warn-soft)]')}>
      {!bare && (
        <div className="flex items-start justify-between gap-3 px-4 pt-3.5 pb-3">
          <div className="min-w-0">
            <div className="flex flex-wrap items-center gap-2">
              <ShieldCheck className="size-4 text-fg-3" />
              <span className="text-[14px] font-semibold text-fg">{a.title}</span>
              {a.simulated && <Badge tone="ghost">Scripted</Badge>}
            </div>
            <p className="mt-1 text-[12px] text-fg-3">
              {KIND_LABEL[a.kind]} · requested by {a.requestedBy} · {timeAgo(a.createdAt)}
            </p>
          </div>
          <StatusBadge a={a} />
        </div>
      )}

      {!compact && a.summary && (
        <div className={clsx('mx-4 mb-3.5 overflow-hidden rounded-[10px] border border-line', bare && 'mt-3.5')}>
          <div className="flex items-center gap-2 border-b border-line bg-subtle px-3 py-1.5 text-[11.5px] text-fg-3">
            <span className="flex-1">{PREVIEW_LABEL[a.kind]}</span>
            <span className="flex items-center gap-1">
              {targets.map((t) => (
                <PlatformIcon key={t} platform={t} className="size-3" />
              ))}
            </span>
          </div>
          <div className="flex gap-2.5 p-3">
            {social && <Avatar name="Pulse" pulse size={24} />}
            <div className="min-w-0 flex-1">
              {social && <div className="mb-0.5 text-[12.5px] font-semibold text-accent">Pulse</div>}
              <div className="prose-msg line-clamp-8 text-[13.5px] leading-relaxed text-fg" dangerouslySetInnerHTML={{ __html: mdInline(a.summary) }} />
            </div>
          </div>
        </div>
      )}

      {!compact && a.actions.length > 0 && (
        <div className="border-t border-line bg-subtle/60">
          <button onClick={() => setShowRequests((o) => !o)} aria-expanded={showRequests} className="flex w-full items-center gap-2 px-4 py-2.5 text-left transition-colors hover:bg-hover">
            {blocked.length ? <ShieldAlert className="size-3.5 text-bad" /> : <CircleCheck className="size-3.5 text-ok" />}
            <span className="min-w-0 flex-1 text-[12.5px] text-fg-2">
              {a.actions.length} Swytchcode dry-run request{a.actions.length === 1 ? '' : 's'}
              <span className="text-fg-4"> · {blocked.length ? `${blocked.length} blocked by policy` : 'passed policy checks'}</span>
            </span>
            <ChevronDown className={clsx('size-3.5 text-fg-4 transition-transform', showRequests && 'rotate-180')} />
          </button>
          {showRequests && (
            <ul className="animate-fade-in divide-y divide-line border-t border-line">
              {a.actions.map((x, i) => (
                <li key={i} className="px-4 py-2">
                  <button className="flex w-full items-center gap-2 text-left" onClick={() => setOpenIdx(openIdx === i ? undefined : i)} aria-expanded={openIdx === i}>
                    <PlatformIcon platform={providerOf(x.tool)} />
                    <span className="min-w-0 flex-1 truncate text-[12.5px] text-fg">{x.label}</span>
                    {x.ok === true && <CircleCheck className="size-3.5 text-ok" />}
                    {x.ok === false && <CircleX className="size-3.5 text-bad" />}
                    {x.blocked && <Badge tone="bad">blocked</Badge>}
                    {x.preview && <span className="hidden font-mono text-[11px] text-fg-4 sm:inline">{x.preview.method}</span>}
                    <ChevronRight className={clsx('size-3.5 text-fg-4 transition-transform', openIdx === i && 'rotate-90')} />
                  </button>
                  {openIdx === i && (
                    <div className="mt-2 animate-fade-in space-y-2 pl-6">
                      <div className="font-mono text-[11px] text-fg-3">{x.tool}</div>
                      {x.preview && (
                        <div className="rounded-lg border border-line bg-surface">
                          <div className="truncate border-b border-line px-3 py-1.5 font-mono text-[11px] text-fg-2">
                            <span className="font-semibold text-accent">{x.preview.method}</span> {x.preview.url}
                          </div>
                          {x.preview.body !== undefined && (
                            <div className="p-2">
                              <JsonBlock value={x.preview.body} maxHeight={200} />
                            </div>
                          )}
                        </div>
                      )}
                      {x.blocked && <p className="text-[12px] text-bad">{x.blocked}</p>}
                      {x.result && <p className={clsx('text-[12px]', x.ok === false ? 'text-bad' : 'text-fg-3')}>Result: {x.result}</p>}
                    </div>
                  )}
                </li>
              ))}
            </ul>
          )}
        </div>
      )}

      {(!bare || a.status !== 'pending') && (
        <div className="flex flex-wrap items-center justify-between gap-3 border-t border-line px-4 py-2.5">
          <span className="text-[11.5px] text-fg-4">
            {a.status === 'pending'
              ? a.slackTs
                ? 'Also in Slack #mods · react ✅ to approve'
                : 'Nothing has been sent yet'
              : `${a.decidedBy ? `${a.status === 'rejected' ? 'Rejected' : 'Approved'} by ${a.decidedBy}` : ''}${a.result ? `${a.decidedBy ? ' · ' : ''}${a.result}` : ''}`}
          </span>
          {!bare && <DecisionButtons a={a} />}
        </div>
      )}
    </div>
  )
}

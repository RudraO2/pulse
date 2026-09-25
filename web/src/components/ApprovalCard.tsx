import clsx from 'clsx'
import { Check, ChevronRight, CircleCheck, CircleX, ShieldCheck, X } from 'lucide-react'
import { useState } from 'react'
import type { Approval } from '@shared/events'
import { api } from '../lib/api'
import { mdInline, providerOf, timeAgo } from '../lib/format'
import { Badge, Button, JsonBlock, PlatformIcon } from '../ui/primitives'

const KIND_LABEL: Record<Approval['kind'], string> = {
  announcement: 'Announcement',
  knowledge: 'Knowledge',
  poll: 'Poll',
  email: 'Email',
  capability: 'Swytchcode action',
  pin: 'Pin',
  post: 'Post',
}

function StatusBadge({ a }: { a: Approval }) {
  if (a.status === 'pending') return <Badge tone="warn">Waiting for approval</Badge>
  if (a.status === 'executed') return <Badge tone="ok">Executed</Badge>
  if (a.status === 'approved') return <Badge tone="info">Running…</Badge>
  if (a.status === 'rejected') return <Badge>Rejected</Badge>
  return <Badge tone="bad">Failed</Badge>
}

export function ApprovalCard({ approval: a, compact }: { approval: Approval; compact?: boolean }) {
  const [busy, setBusy] = useState<'approve' | 'reject' | undefined>()
  const [openIdx, setOpenIdx] = useState<number | undefined>(compact ? undefined : 0)
  const act = async (d: 'approve' | 'reject') => {
    setBusy(d)
    await (d === 'approve' ? api.approve(a.id) : api.reject(a.id))
    setBusy(undefined)
  }
  return (
    <div className={clsx('card overflow-hidden', a.status === 'pending' && 'border-warn/40 shadow-[0_0_0_3px_var(--warn-soft)]')}>
      <div className="flex items-start justify-between gap-3 px-4 pt-3.5 pb-3">
        <div className="min-w-0">
          <div className="flex flex-wrap items-center gap-2">
            <ShieldCheck className="size-4 text-fg-3" />
            <span className="text-[13px] font-semibold text-fg">{a.title}</span>
            <Badge>{KIND_LABEL[a.kind]}</Badge>
            {a.simulated && <Badge tone="info">Scripted</Badge>}
          </div>
          {a.summary && <div className="prose-msg mt-1.5 line-clamp-4 text-[12.5px] leading-relaxed text-fg-2" dangerouslySetInnerHTML={{ __html: mdInline(a.summary) }} />}
        </div>
        <StatusBadge a={a} />
      </div>

      <div className="border-t border-line bg-subtle/60">
        <div className="px-4 pt-2.5 pb-1 text-[11px] font-medium text-fg-3">Swytchcode dry-run preview · {a.actions.length} action{a.actions.length === 1 ? '' : 's'}</div>
        <ul className="divide-y divide-line">
          {a.actions.map((x, i) => (
            <li key={i} className="px-4 py-2">
              <button className="flex w-full items-center gap-2 text-left" onClick={() => setOpenIdx(openIdx === i ? undefined : i)}>
                <PlatformIcon platform={providerOf(x.tool)} />
                <span className="min-w-0 flex-1 truncate text-[12.5px] text-fg">{x.label}</span>
                {x.ok === true && <CircleCheck className="size-3.5 text-ok" />}
                {x.ok === false && <CircleX className="size-3.5 text-bad" />}
                {x.blocked && <Badge tone="bad">blocked</Badge>}
                {x.preview && <span className="hidden font-mono text-[11px] text-fg-3 sm:inline">{x.preview.method}</span>}
                <ChevronRight className={clsx('size-3.5 text-fg-4 transition-transform', openIdx === i && 'rotate-90')} />
              </button>
              {openIdx === i && (
                <div className="mt-2 space-y-2 pl-6">
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
      </div>

      <div className="flex items-center justify-between gap-3 border-t border-line px-4 py-2.5">
        <span className="text-[11px] text-fg-4">
          {a.status === 'pending'
            ? `Requested by ${a.requestedBy} · ${timeAgo(a.createdAt)}${a.slackTs ? ' · also in Slack #mods (✅ to approve)' : ''}`
            : `${a.decidedBy ? `${a.status === 'rejected' ? 'Rejected' : 'Approved'} by ${a.decidedBy}` : ''}${a.result ? ` · ${a.result}` : ''}`}
        </span>
        {a.status === 'pending' && (
          <div className="flex items-center gap-2">
            <Button size="sm" variant="ghost" icon={<X className="size-3.5" />} loading={busy === 'reject'} onClick={() => act('reject')}>
              Reject
            </Button>
            <Button size="sm" variant="primary" icon={<Check className="size-3.5" />} loading={busy === 'approve'} onClick={() => act('approve')} disabled={a.actions.every((x) => !!x.blocked)}>
              Approve &amp; run
            </Button>
          </div>
        )}
      </div>
    </div>
  )
}

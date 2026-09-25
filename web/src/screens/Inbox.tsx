import { Check, Flag, Hourglass, Inbox, Users } from 'lucide-react'
import { useState } from 'react'
import { ApprovalCard } from '../components/ApprovalCard'
import { api } from '../lib/api'
import { timeAgo } from '../lib/format'
import { useStore } from '../lib/store'
import { Avatar, Badge, Button, Card, CardHeader, EmptyState, PageHeader, PlatformIcon, Segmented } from '../ui/primitives'

export function InboxScreen() {
  const approvals = useStore((s) => s.approvals)
  const attention = useStore((s) => s.attention)
  const pending = useStore((s) => s.pending)
  const [view, setView] = useState<'open' | 'history'>('open')
  const [busy, setBusy] = useState<string>()

  const openApprovals = approvals.filter((a) => a.status === 'pending')
  const doneApprovals = approvals.filter((a) => a.status !== 'pending').slice(0, 20)
  const flagged = attention.filter((a) => (view === 'open' ? a.status === 'open' : a.status === 'resolved'))
  const waiting = pending.filter((p) => (view === 'open' ? p.status === 'waiting' : p.status === 'answered'))

  return (
    <div className="animate-fade-in">
      <PageHeader
        title="Inbox"
        subtitle="Everything that needs an organizer. Approvals can also be given with ✅ in Slack #mods; replying to a question thread there teaches Pulse."
        actions={
          <Segmented
            value={view}
            onChange={setView}
            options={[
              { value: 'open', label: 'Open' },
              { value: 'history', label: 'History' },
            ]}
          />
        }
      />

      <div className="grid gap-6 lg:grid-cols-[minmax(0,1fr)_380px]">
        <div className="space-y-4">
          <div className="flex items-center gap-2">
            <span className="label">Approvals</span>
            <Badge>{view === 'open' ? openApprovals.length : doneApprovals.length}</Badge>
          </div>
          {(view === 'open' ? openApprovals : doneApprovals).map((a) => (
            <ApprovalCard key={a.id} approval={a} compact={view === 'history'} />
          ))}
          {!(view === 'open' ? openApprovals : doneApprovals).length && (
            <Card>
              <EmptyState icon={<Check className="size-4" />} title={view === 'open' ? 'Nothing to approve' : 'No decisions yet'} hint="Announcements, FAQ changes, polls and emails prepared by Pulse wait here with an exact Swytchcode dry-run preview." />
            </Card>
          )}
        </div>

        <div className="space-y-6">
          <Card className="overflow-hidden">
            <CardHeader title="Waiting on organizers" subtitle="Questions Pulse didn't know. Reply in the #mods thread." icon={<Users className="size-4" />} />
            {waiting.length ? (
              <ul className="divide-y divide-line">
                {waiting.map((p) => (
                  <li key={p.id} className="px-5 py-3">
                    <div className="flex items-center gap-2 text-[12px] text-fg-3">
                      <PlatformIcon platform={p.platform} className="size-3" />
                      <span className="font-medium text-fg-2">{p.userName}</span>
                      <span>· {timeAgo(p.askedAt)}</span>
                      {p.simulated && <Badge tone="info">Scripted</Badge>}
                    </div>
                    <p className="mt-1 text-[13px] leading-relaxed text-fg">{p.question}</p>
                    {p.answer && <p className="mt-1 text-[12px] text-ok">Answered by {p.answeredBy}</p>}
                  </li>
                ))}
              </ul>
            ) : (
              <EmptyState icon={<Hourglass className="size-4" />} title={view === 'open' ? 'No one is waiting' : 'Nothing answered yet'} />
            )}
          </Card>

          <Card className="overflow-hidden">
            <CardHeader title="Members needing attention" subtitle="Frustrated, ignored, or asking for a human" icon={<Flag className="size-4" />} />
            {flagged.length ? (
              <ul className="divide-y divide-line">
                {flagged.map((a) => (
                  <li key={a.id} className="flex gap-3 px-5 py-3">
                    <Avatar name={a.userName} size={26} />
                    <div className="min-w-0 flex-1">
                      <div className="flex flex-wrap items-center gap-1.5">
                        <span className="text-[13px] font-medium text-fg">{a.userName}</span>
                        <Badge tone={a.kind === 'frustrated' ? 'bad' : a.kind === 'ignored' ? 'warn' : 'info'}>{a.kind.replace('_', ' ')}</Badge>
                        {a.simulated && <Badge tone="info">Scripted</Badge>}
                      </div>
                      <p className="mt-1 line-clamp-2 text-[12.5px] text-fg-2">“{a.text}”</p>
                      <p className="mt-0.5 text-[11.5px] text-fg-4">
                        {a.reason} · {timeAgo(a.ts)}
                      </p>
                    </div>
                    {a.status === 'open' && (
                      <Button
                        size="sm"
                        variant="ghost"
                        loading={busy === a.id}
                        onClick={async () => {
                          setBusy(a.id)
                          await api.resolveAttention(a.id)
                          setBusy(undefined)
                        }}
                      >
                        Resolve
                      </Button>
                    )}
                  </li>
                ))}
              </ul>
            ) : (
              <EmptyState icon={<Inbox className="size-4" />} title={view === 'open' ? 'Everyone is looked after' : 'Nothing resolved yet'} />
            )}
          </Card>
        </div>
      </div>
    </div>
  )
}

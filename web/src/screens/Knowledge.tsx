import { BookOpen, ExternalLink, RefreshCw, Search } from 'lucide-react'
import { useMemo, useState } from 'react'
import type { KbItem } from '@shared/events'
import { api } from '../lib/api'
import { mdInline, timeAgo } from '../lib/format'
import { useStore } from '../lib/store'
import { Badge, Button, Card, Drawer, EmptyState, PageHeader, Segmented } from '../ui/primitives'

const SOURCE_TONE = { Seed: 'neutral', Mod: 'ok', Member: 'warn', Organizer: 'accent' } as const
const SOURCE_LABEL = { Seed: 'Seed', Mod: 'Organizer answer', Member: 'Member answer', Organizer: 'Organizer' } as const

export function KnowledgeScreen() {
  const kb = useStore((s) => s.kb)
  const pending = useStore((s) => s.pending)
  const notionUrl = useStore((s) => s.links.notionUrl)
  const [tab, setTab] = useState<'all' | 'learned' | 'gaps'>('all')
  const [q, setQ] = useState('')
  const [open, setOpen] = useState<KbItem | undefined>()
  const [syncing, setSyncing] = useState(false)

  const faq = kb.filter((e) => e.type === 'FAQ' && e.status === 'Live')
  const learned = faq.filter((e) => e.source !== 'Seed')
  const rows = useMemo(() => {
    const base = tab === 'learned' ? learned : faq
    const needle = q.trim().toLowerCase()
    return base
      .filter((e) => !needle || e.question.toLowerCase().includes(needle) || e.answer.toLowerCase().includes(needle))
      .sort((a, b) => (tab === 'learned' ? b.createdAt - a.createdAt : b.used - a.used || b.updatedAt - a.updatedAt))
  }, [faq, learned, tab, q])
  const gaps = pending.filter((p) => p.status === 'waiting')
  const digests = kb.filter((e) => e.type === 'Digest')

  return (
    <div className="animate-fade-in">
      <PageHeader
        title="Knowledge"
        subtitle="The community's knowledge base lives in Notion. Organizers can edit it there directly; Pulse re-syncs every minute and adds what it learns."
        actions={
          <>
            <Button
              icon={<RefreshCw className="size-3.5" />}
              loading={syncing}
              onClick={async () => {
                setSyncing(true)
                await api.kbSync()
                setSyncing(false)
              }}
            >
              Sync
            </Button>
            {notionUrl && (
              <a href={notionUrl} target="_blank" rel="noreferrer">
                <Button variant="primary" icon={<ExternalLink className="size-3.5" />}>
                  Open in Notion
                </Button>
              </a>
            )}
          </>
        }
      />

      <div className="mb-4 grid grid-cols-3 gap-4">
        {[
          ['Entries', faq.length, 'live FAQ entries'],
          ['Learned', learned.length, 'from organizers and members'],
          ['Answers served', faq.reduce((s, e) => s + e.used, 0), 'times Pulse used an entry'],
        ].map(([label, n, hint]) => (
          <Card key={label} className="px-5 py-4">
            <div className="text-[12px] font-medium text-fg-3">{label}</div>
            <div className="mt-1.5 text-2xl font-semibold tabular-nums">{n}</div>
            <div className="mt-1 text-[12px] text-fg-4">{hint}</div>
          </Card>
        ))}
      </div>

      <Card className="overflow-hidden">
        <div className="flex flex-wrap items-center justify-between gap-3 border-b border-line px-4 py-3">
          <Segmented
            value={tab}
            onChange={setTab}
            options={[
              { value: 'all', label: `All · ${faq.length}` },
              { value: 'learned', label: `Learned · ${learned.length}` },
              { value: 'gaps', label: `Gaps · ${gaps.length}` },
            ]}
          />
          {tab !== 'gaps' && (
            <div className="flex h-8 w-64 items-center gap-2 rounded-lg border border-line bg-surface px-2.5">
              <Search className="size-3.5 text-fg-4" />
              <input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search questions and answers" className="min-w-0 flex-1 bg-transparent text-[12.5px] outline-none placeholder:text-fg-4" />
            </div>
          )}
        </div>

        {tab === 'gaps' ? (
          gaps.length ? (
            <ul className="divide-y divide-line">
              {gaps.map((p) => (
                <li key={p.id} className="flex items-start justify-between gap-4 px-5 py-3">
                  <div className="min-w-0">
                    <div className="text-[13px] font-medium text-fg">{p.question}</div>
                    <div className="mt-0.5 text-[12px] text-fg-3">
                      Asked by {p.userName} on {p.platform} · {timeAgo(p.askedAt)} · waiting on organizers in #mods
                    </div>
                  </div>
                  {p.simulated && <Badge tone="info">Scripted</Badge>}
                </li>
              ))}
            </ul>
          ) : (
            <EmptyState icon={<BookOpen className="size-4" />} title="No gaps right now" hint="Questions Pulse couldn't answer from Notion appear here until an organizer replies." />
          )
        ) : (
          <table className="w-full text-left">
            <thead>
              <tr className="border-b border-line text-[11px] text-fg-3">
                <th className="px-5 py-2 font-medium">Question</th>
                <th className="px-3 py-2 font-medium">Source</th>
                <th className="px-3 py-2 text-right font-medium">Used</th>
                <th className="px-5 py-2 text-right font-medium">Updated</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-line">
              {rows.map((e) => (
                <tr key={e.id} onClick={() => setOpen(e)} className="cursor-pointer transition-colors hover:bg-hover">
                  <td className="max-w-0 px-5 py-2.5">
                    <div className="truncate text-[13px] font-medium text-fg">{e.question}</div>
                    <div className="truncate text-[12px] text-fg-3">{e.answer}</div>
                  </td>
                  <td className="px-3 py-2.5 whitespace-nowrap">
                    <Badge tone={SOURCE_TONE[e.source]}>{SOURCE_LABEL[e.source]}</Badge>
                    {e.scripted && <Badge tone="info" className="ml-1">Scripted</Badge>}
                  </td>
                  <td className="px-3 py-2.5 text-right text-[13px] text-fg-2 tabular-nums">{e.used || '–'}</td>
                  <td className="px-5 py-2.5 text-right text-[12px] whitespace-nowrap text-fg-4">{timeAgo(e.updatedAt)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
        {tab !== 'gaps' && !rows.length && <EmptyState icon={<BookOpen className="size-4" />} title={q ? 'No matches' : 'Nothing here yet'} />}
      </Card>

      {digests.length > 0 && (
        <p className="mt-4 text-[12px] text-fg-4">
          {digests.length} digest{digests.length > 1 ? 's' : ''} archived in Notion.
        </p>
      )}

      <Drawer open={!!open} onClose={() => setOpen(undefined)} title={open?.question} subtitle={open ? `${SOURCE_LABEL[open.source]} · used ${open.used}× · updated ${timeAgo(open.updatedAt)}` : undefined}>
        {open && (
          <div className="space-y-5 p-5">
            <div>
              <div className="label mb-1.5">Answer</div>
              <div className="prose-msg text-[14px] leading-relaxed text-fg" dangerouslySetInnerHTML={{ __html: mdInline(open.answer) }} />
            </div>
            {open.learnedFrom && (
              <div>
                <div className="label mb-1.5">Learned from</div>
                <p className="text-[13px] text-fg-2">{open.learnedFrom}</p>
              </div>
            )}
            <a href={open.url} target="_blank" rel="noreferrer">
              <Button icon={<ExternalLink className="size-3.5" />}>Open page in Notion</Button>
            </a>
          </div>
        )}
      </Drawer>
    </div>
  )
}

import clsx from 'clsx'
import { BookOpen, ChevronDown, ExternalLink, RefreshCw, Search } from 'lucide-react'
import { useMemo, useState } from 'react'
import type { KbItem, PendingQuestion } from '@shared/events'
import { api } from '../lib/api'
import { clock, mdInline, timeAgo } from '../lib/format'
import { useStore } from '../lib/store'
import { Badge, Button, Card, EmptyState, PageHeader, PlatformIcon, Segmented, ShowMore } from '../ui/primitives'

const SOURCE_TONE = { Seed: 'neutral', Mod: 'accent', Member: 'teal', Organizer: 'accent' } as const
const SOURCE_LABEL = { Seed: 'Seed', Mod: 'Organizer answer', Member: 'Member answer', Organizer: 'Organizer' } as const
const PAGE = 25

/** How an entry got into the knowledge base, told from the real records we have. */
function Provenance({ e, pending }: { e: KbItem; pending?: PendingQuestion }) {
  const steps: Array<{ tone: string; t?: number; text: string }> = []
  if (pending) {
    steps.push({ tone: 'bg-warn', t: pending.askedAt, text: `${pending.userName} asked on ${pending.platform === 'telegram' ? 'Telegram' : 'Slack'}` })
    steps.push({ tone: 'bg-warn', t: pending.askedAt, text: 'Not in Notion, so Pulse asked the organizers in #mods' })
    if (pending.answeredAt) steps.push({ tone: 'bg-accent', t: pending.answeredAt, text: `${pending.answeredBy ?? 'An organizer'} answered in the thread` })
  } else if (e.learnedFrom) {
    steps.push({ tone: 'bg-accent', text: `Learned from ${e.learnedFrom}` })
  }
  if (e.source === 'Seed') steps.push({ tone: 'bg-fg-4', t: e.createdAt, text: 'Seeded by the organizers before the event' })
  else steps.push({ tone: 'bg-teal', t: e.createdAt, text: 'Saved to Notion' })
  if (e.used > 0) steps.push({ tone: 'bg-teal', t: e.updatedAt, text: `Used in ${e.used} answer${e.used === 1 ? '' : 's'} since` })
  return (
    <ol>
      {steps.map((s, i) => (
        <li key={i} className="relative grid grid-cols-[14px_minmax(0,1fr)_auto] gap-2.5 pb-2.5 text-[13px] text-fg-2">
          {i < steps.length - 1 && <span className="absolute top-3.5 bottom-0 left-[6.5px] w-px bg-line" />}
          <span className={clsx('relative mt-[5px] ml-[3px] size-2 rounded-full', s.tone)} />
          <span>{s.text}</span>
          {s.t && <time className="pt-0.5 font-mono text-[11px] text-fg-4">{clock(s.t)}</time>}
        </li>
      ))}
    </ol>
  )
}

function Row({ e, open, onToggle, pending }: { e: KbItem; open: boolean; onToggle: () => void; pending?: PendingQuestion }) {
  return (
    <li className={clsx('border-t border-line first:border-t-0', open && 'bg-subtle/50')}>
      <button onClick={onToggle} aria-expanded={open} className="grid w-full grid-cols-[minmax(0,1fr)_auto] items-center gap-4 px-5 py-2.5 text-left transition-colors hover:bg-hover sm:grid-cols-[minmax(0,1fr)_140px_44px_72px_16px]">
        <span className="min-w-0">
          <span className="flex min-w-0 items-center gap-2">
            <span className="truncate text-[13.5px] font-medium text-fg">{e.question}</span>
            {e.scripted && <Badge tone="ghost">Scripted</Badge>}
          </span>
        </span>
        <span className="hidden sm:block">
          <Badge tone={SOURCE_TONE[e.source]}>{SOURCE_LABEL[e.source]}</Badge>
        </span>
        <span className="text-right text-[13px] text-fg-2 tabular-nums">{e.used || '–'}</span>
        <span className="hidden text-right text-[12px] whitespace-nowrap text-fg-4 sm:block">{timeAgo(e.updatedAt)}</span>
        <ChevronDown className={clsx('hidden size-4 text-fg-4 transition-transform sm:block', open && 'rotate-180')} />
      </button>
      {open && (
        <div className="grid animate-fade-in gap-5 px-5 pt-1 pb-5 md:grid-cols-[minmax(0,1fr)_minmax(0,320px)]">
          <div>
            <div className="prose-msg max-w-[64ch] text-[14.5px] leading-relaxed text-fg" dangerouslySetInnerHTML={{ __html: mdInline(e.answer) }} />
            <a href={e.url} target="_blank" rel="noreferrer" className="mt-3 inline-flex items-center gap-1.5 text-[12.5px] font-medium text-fg-3 hover:text-accent">
              <ExternalLink className="size-3.5" /> Notion
            </a>
          </div>
          <div>
            <div className="label mb-2.5">Source</div>
            <Provenance e={e} pending={pending} />
          </div>
        </div>
      )}
    </li>
  )
}

export function KnowledgeScreen() {
  const kb = useStore((s) => s.kb)
  const pending = useStore((s) => s.pending)
  const notionUrl = useStore((s) => s.links.notionUrl)
  const [tab, setTab] = useState<'all' | 'learned' | 'gaps'>('all')
  const [q, setQ] = useState('')
  const [open, setOpen] = useState<string | undefined>()
  const [all, setAll] = useState(false)
  const [syncing, setSyncing] = useState(false)

  const faq = kb.filter((e) => e.type === 'FAQ' && e.status === 'Live')
  const learned = faq.filter((e) => e.source !== 'Seed')
  const served = faq.reduce((n, e) => n + e.used, 0)
  const rows = useMemo(() => {
    const base = tab === 'learned' ? learned : faq
    const needle = q.trim().toLowerCase()
    return base
      .filter((e) => !needle || e.question.toLowerCase().includes(needle) || e.answer.toLowerCase().includes(needle))
      .sort((a, b) => (tab === 'learned' ? b.createdAt - a.createdAt : b.used - a.used || b.updatedAt - a.updatedAt))
  }, [faq, learned, tab, q])
  const shown = all || q ? rows : rows.slice(0, PAGE)
  const gaps = pending.filter((p) => p.status === 'waiting')
  const digests = kb.filter((e) => e.type === 'Digest')
  const pendingFor = (e: KbItem) => pending.find((p) => p.status === 'answered' && (p.question.trim().toLowerCase() === e.question.trim().toLowerCase() || (!!p.answer && p.answer === e.answer)))

  return (
    <div className="animate-fade-in">
      <PageHeader
        title="Knowledge"
        meta={`${faq.length} answers · ${learned.length} learned · ${served} served${digests.length ? ` · ${digests.length} digest${digests.length > 1 ? 's' : ''}` : ''}`}
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
                  Notion
                </Button>
              </a>
            )}
          </>
        }
      />

      <Card className="overflow-hidden">
        <div className="flex flex-wrap items-center justify-between gap-3 border-b border-line px-4 py-3">
          <Segmented
            value={tab}
            onChange={(v) => {
              setTab(v)
              setOpen(undefined)
            }}
            options={[
              { value: 'all', label: 'All', count: faq.length },
              { value: 'learned', label: 'Learned', count: learned.length },
              { value: 'gaps', label: 'Gaps', count: gaps.length },
            ]}
          />
          {tab !== 'gaps' && (
            <label className="flex h-8 w-full items-center gap-2 rounded-lg border border-line bg-surface px-2.5 text-fg-4 focus-within:border-accent-line sm:w-64">
              <Search className="size-3.5" />
              <input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search" aria-label="Search" className="min-w-0 flex-1 bg-transparent text-[13px] text-fg outline-none placeholder:text-fg-4" />
            </label>
          )}
        </div>

        {tab === 'gaps' ? (
          gaps.length ? (
            <ul className="divide-y divide-line">
              {gaps.map((p) => (
                <li key={p.id} className="flex items-start justify-between gap-4 px-5 py-3.5">
                  <div className="min-w-0">
                    <div className="text-[14px] font-medium text-fg">{p.question}</div>
                    <div className="mt-1 flex items-center gap-1.5 text-[12.5px] text-fg-3">
                      <PlatformIcon platform={p.platform} className="size-3" />
                      {p.userName} · {timeAgo(p.askedAt)}
                    </div>
                  </div>
                  {p.simulated && <Badge tone="ghost">Scripted</Badge>}
                </li>
              ))}
            </ul>
          ) : (
            <EmptyState icon={<BookOpen className="size-4" />} title="No gaps" />
          )
        ) : shown.length ? (
          <>
            <div className="hidden grid-cols-[minmax(0,1fr)_140px_44px_72px_16px] gap-4 border-b border-line px-5 py-2 text-[11.5px] text-fg-3 sm:grid">
              <span>Question</span>
              <span>Source</span>
              <span className="text-right">Used</span>
              <span className="text-right">Updated</span>
              <span />
            </div>
            <ul>
              {shown.map((e) => (
                <Row key={e.id} e={e} open={open === e.id} onToggle={() => setOpen(open === e.id ? undefined : e.id)} pending={e.source !== 'Seed' ? pendingFor(e) : undefined} />
              ))}
            </ul>
            {!q && rows.length > PAGE && <ShowMore open={all} onToggle={() => setAll((a) => !a)} more={`Show all ${rows.length}`} />}
          </>
        ) : (
          <EmptyState icon={<BookOpen className="size-4" />} title={q ? 'No matches' : 'Nothing here yet'} />
        )}
      </Card>

    </div>
  )
}

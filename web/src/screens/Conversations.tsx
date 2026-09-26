import clsx from 'clsx'
import { CornerDownRight, Maximize2, MessagesSquare, X } from 'lucide-react'
import { useEffect, useMemo, useRef, useState } from 'react'
import type { InboundMessage, Platform, RunSummary } from '@shared/events'
import { OUTCOME_STYLE } from '../components/ActivityRow'
import { openRun } from '../components/RunDrawer'
import { RunTrace } from '../components/RunTrace'
import { clock, mdInline, modelName, ms, OUTCOME_LABEL } from '../lib/format'
import { useStore } from '../lib/store'
import { Avatar, Badge, EmptyState, PageHeader, PlatformIcon, Segmented } from '../ui/primitives'

interface Channel {
  key: string
  platform: Platform
  chatId: string
  title: string
  role: 'community' | 'mods' | 'dm'
  count: number
  last: number
}

type Item =
  | { kind: 'in'; key: string; ts: number; msg: InboundMessage; run?: RunSummary }
  | { kind: 'out'; key: string; ts: number; text: string; runId?: string; thread: boolean; simulated?: boolean }

const DECISION_LABEL: Partial<Record<string, string>> = {
  asked_mods: 'Asked the organizers',
  escalated: 'Flagged for a human',
  proposed: 'Proposed for the FAQ',
}

function DecisionChip({ run, onSelect }: { run: RunSummary; onSelect: () => void }) {
  if (!run.outcome) {
    return (
      <span className="mt-1.5 inline-flex items-center gap-1.5 text-[12px] text-accent">
        <span className="size-1.5 animate-pulse-dot rounded-full bg-accent" /> Pulse is thinking…
      </span>
    )
  }
  const d = OUTCOME_STYLE[run.outcome]
  const why = run.outcome === 'silent' ? run.steps.find((s) => s.kind === 'silent')?.detail : run.outcome === 'answered' ? run.steps.find((s) => s.kind === 'reply')?.detail : undefined
  return (
    <button
      onClick={(e) => {
        e.stopPropagation()
        onSelect()
      }}
      className="mt-1.5 inline-flex max-w-full items-center gap-1.5 rounded-md border border-line bg-surface px-2 py-[3px] text-[12px] text-fg-3 transition-colors hover:border-line-strong hover:text-fg-2"
    >
      <d.icon className={clsx('size-3 shrink-0', d.text)} />
      <span className="shrink-0 font-medium whitespace-nowrap text-fg-2">{DECISION_LABEL[run.outcome] ?? OUTCOME_LABEL[run.outcome]}</span>
      {why && <span className="truncate">· {why}</span>}
      {run.durationMs !== undefined && <span className="shrink-0 text-fg-4 tabular-nums">· {ms(run.durationMs)}</span>}
    </button>
  )
}

function Inspector({ run, onClose }: { run: RunSummary; onClose: () => void }) {
  const o = run.outcome ? OUTCOME_STYLE[run.outcome] : undefined
  return (
    <aside className="hidden w-[360px] shrink-0 animate-fade-in flex-col border-l border-line xl:flex" aria-label="Why Pulse did this">
      <div className="flex items-start justify-between gap-3 border-b border-line px-5 py-3.5">
        <div className="min-w-0">
          <div className="flex flex-wrap items-center gap-2">
            {run.outcome ? (
              <Badge tone={run.outcome === 'failed' || run.outcome === 'escalated' ? 'bad' : run.outcome === 'silent' ? 'neutral' : run.outcome === 'asked_mods' || run.outcome === 'proposed' ? 'warn' : 'ok'}>
                {o && <o.icon className="size-3" />}
                {OUTCOME_LABEL[run.outcome]}
              </Badge>
            ) : (
              <Badge tone="accent">Working</Badge>
            )}
            <span className="text-[12px] text-fg-4 tabular-nums">
              {run.durationMs !== undefined ? ms(run.durationMs) : ''}
              {run.model ? ` · ${modelName(run.model)}` : ''}
            </span>
          </div>
        </div>
        <div className="flex shrink-0 items-center gap-0.5">
          <button onClick={() => openRun(run.runId)} className="rounded-md p-1.5 text-fg-3 hover:bg-hover hover:text-fg" aria-label="Open full trace" title="Open full trace">
            <Maximize2 className="size-3.5" />
          </button>
          <button onClick={onClose} className="rounded-md p-1 text-fg-3 hover:bg-hover hover:text-fg" aria-label="Close">
            <X className="size-4" />
          </button>
        </div>
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto px-5 py-4">
        <RunTrace run={run} />
      </div>
    </aside>
  )
}

export function ConversationsScreen() {
  const [scope, setScope] = useState<'all' | 'real'>('all')
  const messages = useStore((s) => s.messages)
  const outgoing = useStore((s) => s.outgoing)
  const runs = useStore((s) => s.runs)
  const configured = useStore((s) => s.channels)
  const [active, setActive] = useState<string | undefined>()
  const [selected, setSelected] = useState<{ key: string; runId: string } | undefined>()
  const end = useRef<HTMLDivElement>(null)

  const channels = useMemo<Channel[]>(() => {
    const map = new Map<string, Channel>()
    for (const c of configured) map.set(`${c.platform}:${c.chatId}`, { key: `${c.platform}:${c.chatId}`, platform: c.platform, chatId: c.chatId, title: c.title, role: c.role, count: 0, last: 0 })
    const touch = (platform: Platform, chatId: string, ts: number, title?: string, dm?: string) => {
      const key = `${platform}:${chatId}`
      const c = map.get(key) ?? { key, platform, chatId, title: title ?? chatId, role: dm ? 'dm' : 'community', count: 0, last: 0 }
      c.count++
      c.last = Math.max(c.last, ts)
      if (dm) c.title = `DM · ${dm}`
      map.set(key, c)
    }
    for (const m of messages) if (scope === 'all' || !m.simulated) touch(m.platform, m.chatId, m.ts, m.chatTitle, m.chatType === 'dm' ? m.userName : undefined)
    for (const o of outgoing) if ((scope === 'all' || !o.simulated) && map.has(`${o.platform}:${o.chatId}`)) touch(o.platform, o.chatId, o.ts)
    const rank = { community: 0, dm: 1, mods: 2 }
    return [...map.values()].sort((a, b) => rank[a.role] - rank[b.role] || b.last - a.last)
  }, [messages, outgoing, configured, scope])

  const current = channels.find((c) => c.key === active) ?? channels[0]

  const items = useMemo<Item[]>(() => {
    if (!current) return []
    const list: Item[] = []
    for (const m of messages) {
      if (m.platform !== current.platform || m.chatId !== current.chatId) continue
      if (scope === 'real' && m.simulated) continue
      const run = runs.find((r) => r.chatId === m.chatId && r.origin === 'community' && r.input.split('\n').some((l) => l === `${m.userName}: ${m.text}`))
      list.push({ kind: 'in', key: `in-${m.msgId}`, ts: m.ts, msg: m, run })
    }
    outgoing.forEach((o, i) => {
      if (o.platform !== current.platform || o.chatId !== current.chatId) return
      if (scope === 'real' && o.simulated) return
      list.push({ kind: 'out', key: `out-${o.msgId ?? i}-${o.ts}`, ts: o.ts, text: o.text, runId: o.runId, thread: !!o.threadTs, simulated: o.simulated })
    })
    return list.sort((a, b) => a.ts - b.ts).slice(-150)
  }, [current, messages, outgoing, runs, scope])

  // show each run's decision only on the last message of its batch
  const decisionAt = useMemo(() => {
    const last = new Map<string, number>()
    items.forEach((it, i) => {
      if (it.kind === 'in' && it.run) last.set(it.run.runId, i)
    })
    return last
  }, [items])

  useEffect(() => {
    end.current?.scrollIntoView({ block: 'end' })
  }, [items.length, current?.key])

  const select = (key: string, runId?: string) => {
    if (!runId) return
    if (window.matchMedia('(max-width: 1279px)').matches) openRun(runId)
    else setSelected(selected?.key === key ? undefined : { key, runId })
  }
  const selectedRun = selected ? runs.find((r) => r.runId === selected.runId) : undefined

  return (
    <div className="animate-fade-in">
      <PageHeader
        title="Conversations"
        actions={
          <Segmented
            value={scope}
            onChange={setScope}
            options={[
              { value: 'all', label: 'All' },
              { value: 'real', label: 'Real only' },
            ]}
          />
        }
      />

      <div className="card flex h-[calc(100vh-178px)] min-h-[480px] flex-col overflow-hidden md:flex-row">
        <nav className="flex shrink-0 gap-1 overflow-x-auto border-b border-line bg-subtle/60 p-2 md:w-[210px] md:flex-col md:overflow-y-auto md:border-r md:border-b-0 md:p-2.5" aria-label="Channels">
          {channels.map((c) => (
            <button
              key={c.key}
              onClick={() => {
                setActive(c.key)
                setSelected(undefined)
              }}
              aria-pressed={c.key === current?.key}
              className={clsx('flex shrink-0 items-center gap-2.5 rounded-lg px-2.5 py-2 text-left transition-colors md:w-full', c.key === current?.key ? 'bg-surface text-fg shadow-[0_0_0_1px_var(--line)]' : 'text-fg-2 hover:bg-hover')}
            >
              <PlatformIcon platform={c.platform} />
              <span className="min-w-0 flex-1 truncate text-[13px] font-medium" title={c.role === 'mods' ? 'Organizers only' : undefined}>
                {c.title}
              </span>
              <span className="text-[11px] text-fg-4 tabular-nums">{c.count}</span>
            </button>
          ))}
          {!channels.length && <p className="px-2 text-[12px] text-fg-4">No channels connected yet.</p>}
        </nav>

        <section className="flex min-h-0 min-w-0 flex-1 flex-col">
          {current ? (
            <>
              <div className="flex items-center gap-2.5 border-b border-line px-5 py-3">
                <PlatformIcon platform={current.platform} className="size-4" />
                <span className="text-[14px] font-semibold text-fg">{current.title}</span>
                {current.role === 'mods' && <Badge tone="warn">Private</Badge>}
              </div>
              <div className="min-h-0 flex-1 overflow-y-auto py-3">
                {items.length ? (
                  <ul>
                    {items.map((it, i) => {
                      const runId = it.kind === 'in' ? it.run?.runId : it.runId
                      const isSel = selected?.key === it.key
                      return (
                        <li
                          key={it.key}
                          onClick={() => select(it.key, runId)}
                          className={clsx(
                            'relative grid animate-fade-in grid-cols-[30px_minmax(0,1fr)] gap-3 px-5 py-2',
                            runId && 'cursor-pointer hover:bg-hover',
                            isSel && '!bg-accent-soft before:absolute before:inset-y-0 before:left-0 before:w-[3px] before:bg-accent',
                            it.kind === 'out' && it.thread && 'pl-14',
                          )}
                        >
                          {it.kind === 'in' ? (
                            <>
                              <Avatar name={it.msg.userName} url={it.msg.avatarUrl} size={30} />
                              <div className="min-w-0">
                                <div className="flex flex-wrap items-baseline gap-2">
                                  <span className="text-[13.5px] font-semibold text-fg">{it.msg.userName}</span>
                                  <time className="font-mono text-[11px] text-fg-4">{clock(it.ts)}</time>
                                  {it.msg.simulated && <Badge tone="ghost">Scripted</Badge>}
                                </div>
                                <div className={clsx('prose-msg text-[14px] leading-relaxed [overflow-wrap:anywhere]', it.msg.joined ? 'text-fg-3 italic' : 'text-fg')} dangerouslySetInnerHTML={{ __html: mdInline(it.msg.text) }} />
                                {it.run && decisionAt.get(it.run.runId) === i && <DecisionChip run={it.run} onSelect={() => select(it.key, it.run!.runId)} />}
                              </div>
                            </>
                          ) : (
                            <>
                              {it.thread && <CornerDownRight className="absolute top-3 left-8 size-3.5 text-fg-4" />}
                              <Avatar name="Pulse" pulse size={30} />
                              <div className="min-w-0">
                                <div className="flex flex-wrap items-baseline gap-2">
                                  <span className="text-[13.5px] font-semibold text-accent">Pulse</span>
                                  <time className="font-mono text-[11px] text-fg-4">{clock(it.ts)}</time>
                                  {it.thread && <span className="text-[11.5px] text-fg-4">in thread</span>}
                                </div>
                                <div className="prose-msg text-[14px] leading-relaxed text-fg [overflow-wrap:anywhere]" dangerouslySetInnerHTML={{ __html: mdInline(it.text) }} />
                              </div>
                            </>
                          )}
                        </li>
                      )
                    })}
                  </ul>
                ) : (
                  <EmptyState icon={<MessagesSquare className="size-4" />} title="No messages yet"  />
                )}
                <div ref={end} />
              </div>
            </>
          ) : (
            <EmptyState icon={<MessagesSquare className="size-4" />} title="No channels connected" />
          )}
        </section>

        {selectedRun && <Inspector run={selectedRun} onClose={() => setSelected(undefined)} />}
      </div>
    </div>
  )
}

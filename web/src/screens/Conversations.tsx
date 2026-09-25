import clsx from 'clsx'
import { BookOpen, CornerDownRight, Flag, Hand, MessageSquareReply, MessagesSquare, Users, VolumeX } from 'lucide-react'
import { useEffect, useMemo, useRef, useState, type ComponentType } from 'react'
import type { InboundMessage, Platform, RunSummary } from '@shared/events'
import { openRun } from '../components/RunDrawer'
import { clock, mdInline, ms } from '../lib/format'
import { useStore } from '../lib/store'
import { Avatar, Badge, Card, EmptyState, PageHeader, PlatformIcon, Segmented } from '../ui/primitives'

interface Channel {
  key: string
  platform: Platform
  chatId: string
  title: string
  count: number
  last: number
}

type Item =
  | { kind: 'in'; ts: number; msg: InboundMessage; run?: RunSummary }
  | { kind: 'out'; ts: number; text: string; runId?: string; thread: boolean; simulated?: boolean }

const DECISION: Record<string, { icon: ComponentType<{ className?: string }>; label: string; tone: string }> = {
  answered: { icon: MessageSquareReply, label: 'Answered', tone: 'text-ok' },
  welcomed: { icon: Hand, label: 'Welcomed', tone: 'text-accent' },
  asked_mods: { icon: Users, label: 'Asked the organizers', tone: 'text-warn' },
  escalated: { icon: Flag, label: 'Flagged for a human', tone: 'text-bad' },
  proposed: { icon: BookOpen, label: 'Proposed for the FAQ', tone: 'text-warn' },
  silent: { icon: VolumeX, label: 'Stayed silent', tone: 'text-fg-4' },
  failed: { icon: Flag, label: 'Failed', tone: 'text-bad' },
}

function DecisionChip({ run }: { run: RunSummary }) {
  if (!run.outcome) {
    return (
      <button onClick={() => openRun(run.runId)} className="mt-1.5 inline-flex items-center gap-1.5 text-[11.5px] text-accent">
        <span className="size-1.5 animate-pulse-dot rounded-full bg-accent" /> Pulse is thinking…
      </button>
    )
  }
  const d = DECISION[run.outcome] ?? { icon: MessageSquareReply, label: run.outcome, tone: 'text-fg-3' }
  const silentWhy = run.outcome === 'silent' ? run.steps.find((s) => s.kind === 'silent')?.detail : undefined
  const kb = run.steps.find((s) => s.kind === 'reply')?.detail
  return (
    <button onClick={() => openRun(run.runId)} className="mt-1.5 inline-flex max-w-full items-center gap-1.5 rounded-md border border-line bg-subtle px-2 py-0.5 text-[11.5px] text-fg-3 transition-colors hover:border-line-strong hover:text-fg-2">
      <d.icon className={clsx('size-3 shrink-0', d.tone)} />
      <span className="font-medium text-fg-2">{d.label}</span>
      {silentWhy && <span className="truncate">· {silentWhy}</span>}
      {!silentWhy && kb && run.outcome === 'answered' && <span className="truncate">· {kb}</span>}
      {run.durationMs !== undefined && <span className="shrink-0 tabular-nums text-fg-4">· {ms(run.durationMs)}</span>}
    </button>
  )
}

export function ConversationsScreen() {
  const [scope, setScope] = useState<'all' | 'real'>('all')
  const messages = useStore((s) => s.messages)
  const outgoing = useStore((s) => s.outgoing)
  const runs = useStore((s) => s.runs)
  const configured = useStore((s) => s.channels)
  const [active, setActive] = useState<string | undefined>()
  const end = useRef<HTMLDivElement>(null)

  const channels = useMemo<Channel[]>(() => {
    const map = new Map<string, Channel>()
    for (const c of configured.filter((c) => c.role === 'community')) map.set(`${c.platform}:${c.chatId}`, { key: `${c.platform}:${c.chatId}`, platform: c.platform, chatId: c.chatId, title: c.title, count: 0, last: 0 })
    for (const m of messages) {
      if (scope === 'real' && m.simulated) continue
      const key = `${m.platform}:${m.chatId}`
      const c = map.get(key) ?? { key, platform: m.platform, chatId: m.chatId, title: m.chatTitle ?? m.chatId, count: 0, last: 0 }
      c.count++
      c.last = Math.max(c.last, m.ts)
      if (m.chatType === 'dm') c.title = `DM · ${m.userName}`
      map.set(key, c)
    }
    return [...map.values()].sort((a, b) => b.last - a.last)
  }, [messages, configured, scope])

  const current = channels.find((c) => c.key === active) ?? channels[0]

  const items = useMemo<Item[]>(() => {
    if (!current) return []
    const list: Item[] = []
    for (const m of messages) {
      if (m.platform !== current.platform || m.chatId !== current.chatId) continue
      if (scope === 'real' && m.simulated) continue
      const run = runs.find((r) => r.chatId === m.chatId && r.origin === 'community' && r.input.split('\n').some((l) => l === `${m.userName}: ${m.text}`))
      list.push({ kind: 'in', ts: m.ts, msg: m, run })
    }
    for (const o of outgoing) {
      if (o.platform !== current.platform || o.chatId !== current.chatId) continue
      if (scope === 'real' && o.simulated) continue
      list.push({ kind: 'out', ts: o.ts, text: o.text, runId: o.runId, thread: !!o.threadTs, simulated: o.simulated })
    }
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

  return (
    <div className="animate-fade-in">
      <PageHeader
        title="Conversations"
        subtitle="The community as Pulse sees it, with every decision annotated. Click a decision to see why."
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
      <div className="grid gap-6 lg:grid-cols-[240px_minmax(0,1fr)]">
        <div>
          <div className="label mb-2 px-1">Channels</div>
          <ul className="space-y-1">
            {channels.map((c) => (
              <li key={c.key}>
                <button
                  onClick={() => setActive(c.key)}
                  className={clsx('flex w-full items-center gap-2.5 rounded-lg px-3 py-2 text-left transition-colors', c.key === current?.key ? 'bg-surface ring-1 ring-line' : 'hover:bg-hover')}
                >
                  <PlatformIcon platform={c.platform} />
                  <span className="min-w-0 flex-1 truncate text-[13px] font-medium text-fg">{c.title}</span>
                  <span className="text-[11px] text-fg-4 tabular-nums">{c.count}</span>
                </button>
              </li>
            ))}
            {!channels.length && <li className="px-1 text-[12px] text-fg-4">No channels connected yet.</li>}
          </ul>
        </div>

        <Card className="flex h-[calc(100vh-190px)] min-h-[480px] flex-col overflow-hidden">
          {current ? (
            <>
              <div className="flex items-center gap-2.5 border-b border-line px-5 py-3">
                <PlatformIcon platform={current.platform} className="size-4" />
                <span className="text-[13px] font-semibold text-fg">{current.title}</span>
                <span className="text-[11px] text-fg-4">{current.platform === 'telegram' ? 'Telegram group' : 'Slack channel'}</span>
              </div>
              <div className="min-h-0 flex-1 overflow-y-auto px-5 py-4">
                {items.length ? (
                  <ul className="space-y-4">
                    {items.map((it, i) =>
                      it.kind === 'in' ? (
                        <li key={`in-${it.msg.msgId}`} className="flex gap-3 animate-fade-in">
                          <Avatar name={it.msg.userName} url={it.msg.avatarUrl} />
                          <div className="min-w-0 flex-1">
                            <div className="flex items-baseline gap-2">
                              <span className="text-[13px] font-semibold text-fg">{it.msg.userName}</span>
                              <span className="text-[11px] text-fg-4">{clock(it.ts)}</span>
                              {it.msg.simulated && <Badge tone="info">Scripted</Badge>}
                            </div>
                            <div className={clsx('prose-msg text-[13.5px] leading-relaxed', it.msg.joined ? 'text-fg-3 italic' : 'text-fg')} dangerouslySetInnerHTML={{ __html: mdInline(it.msg.text) }} />
                            {it.run && decisionAt.get(it.run.runId) === i && <DecisionChip run={it.run} />}
                          </div>
                        </li>
                      ) : (
                        <li key={`out-${i}-${it.ts}`} className={clsx('flex gap-3 animate-fade-in', it.thread && 'pl-8')}>
                          {it.thread && <CornerDownRight className="-ml-6 mt-1.5 size-3.5 text-fg-4" />}
                          <Avatar name="Pulse" pulse />
                          <div className="min-w-0 flex-1">
                            <div className="flex items-baseline gap-2">
                              <span className="text-[13px] font-semibold text-accent">Pulse</span>
                              <span className="text-[11px] text-fg-4">{clock(it.ts)}</span>
                              {it.thread && <span className="text-[11px] text-fg-4">in thread</span>}
                            </div>
                            <button onClick={() => it.runId && openRun(it.runId)} className="block text-left">
                              <div className="prose-msg rounded-xl rounded-tl-sm border border-accent/15 bg-accent-soft/60 px-3.5 py-2 text-[13.5px] leading-relaxed text-fg" dangerouslySetInnerHTML={{ __html: mdInline(it.text) }} />
                            </button>
                          </div>
                        </li>
                      ),
                    )}
                  </ul>
                ) : (
                  <EmptyState icon={<MessagesSquare className="size-4" />} title="No messages yet" hint="Say hi in this channel, or play a scripted scenario from the Demo page." />
                )}
                <div ref={end} />
              </div>
            </>
          ) : (
            <EmptyState icon={<MessagesSquare className="size-4" />} title="No channels" hint="Connect Telegram or Slack in .env." />
          )}
        </Card>
      </div>
    </div>
  )
}

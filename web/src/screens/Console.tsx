import clsx from 'clsx'
import { ArrowUp, CircleCheck, CircleX, Hourglass, LoaderCircle, SquareTerminal } from 'lucide-react'
import { useEffect, useRef, useState } from 'react'
import { ApprovalCard } from '../components/ApprovalCard'
import { RunTrace } from '../components/RunTrace'
import { api } from '../lib/api'
import { mdInline, ms, OUTCOME_LABEL, timeAgo } from '../lib/format'
import { useStore } from '../lib/store'
import { Badge, Card, EmptyState, Kbd, PageHeader } from '../ui/primitives'

const SUGGESTIONS = [
  'Lunch is moving to 1:30 PM today. Tell everyone on Telegram and Slack, pin it, and update the FAQ.',
  'Who has been waiting longest for an answer? Help them, and ping the organizers about anything we don’t know.',
  'Email me a summary of today: top questions, what Pulse learned, and who needs attention.',
  'Run a poll in the Telegram group: which workshop should we host next: agents, RAG, or evals?',
]

export function ConsoleScreen() {
  const runs = useStore((s) => s.runs.filter((r) => r.origin === 'console'))
  const approvals = useStore((s) => s.approvals)
  const model = useStore((s) => s.services.llm)
  const [selected, setSelected] = useState<string | undefined>()
  const [text, setText] = useState('')
  const [busy, setBusy] = useState(false)
  const box = useRef<HTMLTextAreaElement>(null)

  const run = runs.find((r) => r.runId === selected) ?? runs[0]
  const runApprovals = run ? approvals.filter((a) => a.runId === run.runId) : []

  useEffect(() => {
    // a new console run (from here or a scripted scenario) takes focus
    if (runs[0] && !runs[0].outcome) setSelected(runs[0].runId)
  }, [runs[0]?.runId])

  const submit = async (value = text) => {
    const t = value.trim()
    if (!t || busy) return
    setBusy(true)
    const res = await api.console(t)
    setBusy(false)
    if (res?.runId) {
      setSelected(res.runId)
      setText('')
    }
  }

  return (
    <div className="animate-fade-in">
      <PageHeader
        title="Console"
        subtitle="Ask Pulse in plain English. It researches, plans and prepares actions across Telegram, Slack, Notion and Resend. Anything that reaches people waits for your approval."
      />

      <div className="grid gap-6 2xl:grid-cols-[240px_minmax(0,1fr)]">
        <div className="hidden 2xl:block">
          <div className="label mb-2 px-1">History</div>
          {runs.length ? (
            <ul className="space-y-1">
              {runs.map((r) => (
                <li key={r.runId}>
                  <button
                    onClick={() => setSelected(r.runId)}
                    className={clsx('w-full rounded-lg px-3 py-2 text-left transition-colors', r.runId === run?.runId ? 'bg-surface ring-1 ring-line' : 'hover:bg-hover')}
                  >
                    <div className="line-clamp-2 text-[12.5px] leading-snug text-fg">{r.input}</div>
                    <div className="mt-1 flex items-center gap-1.5 text-[11px] text-fg-4">
                      {!r.outcome ? <LoaderCircle className="size-3 animate-spin text-accent" /> : r.outcome === 'failed' ? <CircleX className="size-3 text-bad" /> : r.outcome === 'awaiting_approval' ? <Hourglass className="size-3 text-warn" /> : <CircleCheck className="size-3 text-ok" />}
                      {timeAgo(r.startedAt)}
                      {r.simulated && <span className="text-info">· scripted</span>}
                    </div>
                  </button>
                </li>
              ))}
            </ul>
          ) : (
            <p className="px-1 text-[12px] text-fg-4">Your requests will appear here.</p>
          )}
        </div>

        <div className="min-w-0 space-y-6">
          <Card className="p-1.5">
            <div className="flex items-end gap-2">
              <textarea
                ref={box}
                value={text}
                onChange={(e) => setText(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) void submit()
                }}
                rows={2}
                placeholder="e.g. The venue changed to Hall B. Tell everyone, pin it, and update the FAQ."
                className="max-h-48 min-h-[52px] flex-1 resize-none bg-transparent px-3 py-2.5 text-[14px] leading-relaxed text-fg outline-none placeholder:text-fg-4"
              />
              <button
                onClick={() => void submit()}
                disabled={!text.trim() || busy}
                className="mb-1 mr-1 grid size-9 shrink-0 place-items-center rounded-lg bg-accent text-accent-fg transition-opacity disabled:opacity-30"
                aria-label="Run"
              >
                {busy ? <LoaderCircle className="size-4 animate-spin" /> : <ArrowUp className="size-4" />}
              </button>
            </div>
            <div className="flex flex-wrap items-center gap-1.5 border-t border-line px-2 pt-2 pb-1">
              {SUGGESTIONS.map((sug) => (
                <button key={sug} onClick={() => void submit(sug)} className="max-w-full truncate rounded-full border border-line px-2.5 py-1 text-[11.5px] text-fg-2 transition-colors hover:bg-hover hover:text-fg" title={sug}>
                  {sug.length > 62 ? `${sug.slice(0, 60)}…` : sug}
                </button>
              ))}
              <span className="ml-auto hidden items-center gap-1 pr-1 text-[11px] text-fg-4 sm:flex">
                <Kbd>Ctrl</Kbd>
                <Kbd>Enter</Kbd>
              </span>
            </div>
          </Card>

          {runs.length > 1 && (
            <div className="flex gap-2 overflow-x-auto pb-1 2xl:hidden">
              {runs.slice(0, 8).map((r) => (
                <button
                  key={r.runId}
                  onClick={() => setSelected(r.runId)}
                  className={clsx('max-w-[280px] shrink-0 truncate rounded-lg border px-3 py-1.5 text-[12px] transition-colors', r.runId === run?.runId ? 'border-line-strong bg-surface text-fg' : 'border-line text-fg-3 hover:bg-hover')}
                  title={r.input}
                >
                  {r.input}
                </button>
              ))}
            </div>
          )}

          {run ? (
            <div className="space-y-4">
              <div className="flex flex-wrap items-start justify-between gap-3">
                <div className="min-w-0">
                  <div className="label mb-1">Request</div>
                  <p className="text-[15px] leading-relaxed font-medium text-fg">{run.input}</p>
                </div>
                <div className="flex items-center gap-2">
                  {run.model && <Badge mono>{run.model}</Badge>}
                  {run.outcome ? <Badge tone={run.outcome === 'failed' ? 'bad' : run.outcome === 'awaiting_approval' ? 'warn' : 'ok'}>{OUTCOME_LABEL[run.outcome]}</Badge> : <Badge tone="accent">Working</Badge>}
                  {run.durationMs !== undefined && <span className="text-[11px] text-fg-4 tabular-nums">{ms(run.durationMs)}</span>}
                </div>
              </div>

              <div className={clsx('grid gap-6', runApprovals.length && '2xl:grid-cols-[minmax(0,1fr)_minmax(0,460px)] xl:grid-cols-[minmax(0,1fr)_minmax(0,400px)]')}>
                <Card className="p-5">
                  <div className="label mb-4">What Pulse did</div>
                  <RunTrace run={run} />
                  {run.outcome && (run.summary || run.reply) && (
                    <div className="mt-2 rounded-xl border border-line bg-subtle px-4 py-3">
                      <div className="prose-msg text-[13px] leading-relaxed text-fg" dangerouslySetInnerHTML={{ __html: mdInline(run.summary ?? run.reply ?? '') }} />
                    </div>
                  )}
                </Card>
                {runApprovals.length > 0 && (
                  <div className="space-y-4">
                    <div className="label">Waiting for you</div>
                    {runApprovals.map((a) => (
                      <ApprovalCard key={a.id} approval={a} />
                    ))}
                  </div>
                )}
              </div>
            </div>
          ) : (
            <Card>
              <EmptyState
                icon={<SquareTerminal className="size-4" />}
                title="Tell Pulse what the community needs"
                hint={`It can read the conversation history and knowledge base, prepare announcements, polls, FAQ updates and emails, and use any Swytchcode method on its allow-list. Model: ${model.detail ?? '–'}`}
              />
            </Card>
          )}
        </div>
      </div>
    </div>
  )
}

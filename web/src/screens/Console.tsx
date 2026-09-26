import clsx from 'clsx'
import { ArrowUp, CircleCheck, CircleX, Hourglass, LoaderCircle, Sparkles, SquareTerminal } from 'lucide-react'
import { useEffect, useRef, useState } from 'react'
import { ApprovalCard } from '../components/ApprovalCard'
import { RunTrace } from '../components/RunTrace'
import { api } from '../lib/api'
import { clock, mdInline, modelName, ms, OUTCOME_LABEL } from '../lib/format'
import { SUGGESTIONS } from '../lib/prefs'
import { useStore } from '../lib/store'
import { Badge, Card, CardHeader, EmptyState, PageHeader } from '../ui/primitives'

function StatusIcon({ outcome }: { outcome?: string }) {
  if (!outcome) return <LoaderCircle className="size-3.5 animate-spin text-accent" />
  if (outcome === 'failed') return <CircleX className="size-3.5 text-bad" />
  if (outcome === 'awaiting_approval') return <Hourglass className="size-3.5 text-warn" />
  return <CircleCheck className="size-3.5 text-ok" />
}

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
  const lastModel = modelName(runs.find((r) => r.model)?.model)
  const decided = runApprovals.length > 0 && runApprovals.every((a) => a.status !== 'pending' && a.status !== 'approved')
  const outcome = run?.outcome === 'awaiting_approval' && decided ? (runApprovals.some((a) => a.status === 'executed') ? 'executed' : undefined) : run?.outcome

  useEffect(() => {
    // a new console run (from here, Ctrl+K or a scripted scenario) takes focus
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
        meta={
          lastModel && (
            <span className="inline-flex items-center gap-1.5 font-mono text-[11.5px] text-fg-4" title={model.detail}>
              <Sparkles className="size-3" />
              {lastModel}
            </span>
          )
        }
      />

      <div className="card mb-5 shadow-[var(--shadow)] transition-shadow focus-within:border-accent-line focus-within:shadow-[0_0_0_4px_var(--accent-soft),var(--shadow)]">
        <div className="flex items-end gap-2.5 py-2 pr-2 pl-4">
          <textarea
            ref={box}
            value={text}
            onChange={(e) => setText(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) void submit()
            }}
            rows={2}
            placeholder="Tell Pulse what the community needs…"
            aria-label="Request for Pulse"
            className="max-h-48 min-h-[52px] flex-1 resize-none bg-transparent py-2 text-[15px] leading-relaxed text-fg outline-none placeholder:text-fg-4"
          />
          <button onClick={() => void submit()} disabled={!text.trim() || busy} className="grid size-[38px] shrink-0 place-items-center rounded-[9px] bg-accent text-accent-fg transition-opacity disabled:opacity-30" aria-label="Run">
            {busy ? <LoaderCircle className="size-4 animate-spin" /> : <ArrowUp className="size-4" />}
          </button>
        </div>
        <div className="flex flex-wrap items-center gap-1.5 border-t border-line px-3 py-2.5">
          {text.trim() ? (
            <span className="flex items-center gap-1 text-[12px] text-fg-4">
              <kbd className="kbd">Ctrl</kbd>
              <kbd className="kbd">Enter</kbd>
            </span>
          ) : (
            SUGGESTIONS.slice(0, 3).map((sug) => (
              <button key={sug} onClick={() => void submit(sug)} title={sug} className="h-7 max-w-full truncate rounded-full border border-line px-3 text-[12.5px] text-fg-2 transition-colors hover:border-line-strong hover:bg-hover hover:text-fg">
                {sug.length > 54 ? `${sug.slice(0, 52)}…` : sug}
              </button>
            ))
          )}
        </div>
      </div>

      {runs.length > 1 && (
        <div className="mb-5 flex gap-2 overflow-x-auto pb-1" role="group" aria-label="Recent requests">
          {runs.slice(0, 8).map((r) => (
            <button
              key={r.runId}
              onClick={() => setSelected(r.runId)}
              aria-pressed={r.runId === run?.runId}
              title={r.input}
              className={clsx(
                'flex h-8 max-w-[300px] shrink-0 items-center gap-2 rounded-lg border px-3 text-[12.5px] transition-colors',
                r.runId === run?.runId ? 'border-line-strong bg-surface text-fg shadow-[var(--shadow)]' : 'border-line text-fg-3 hover:bg-hover',
              )}
            >
              <StatusIcon outcome={r.outcome} />
              <span className="truncate">{r.input}</span>
            </button>
          ))}
        </div>
      )}

      {run ? (
        <div className="animate-fade-in">
          <div className="mb-4 flex flex-wrap items-start justify-between gap-3">
            <p className="max-w-[72ch] min-w-0 text-[17px] leading-snug font-medium text-fg">{run.input}</p>
            <div className="flex flex-wrap items-center gap-1.5">
              <span className="font-mono text-[11.5px] text-fg-4">{clock(run.startedAt)}</span>
              {run.simulated && <Badge tone="ghost">Scripted</Badge>}
              {outcome ? <Badge tone={outcome === 'failed' ? 'bad' : outcome === 'awaiting_approval' ? 'warn' : 'ok'}>{OUTCOME_LABEL[outcome]}</Badge> : run.outcome ? <Badge>Decided</Badge> : <Badge tone="accent">Working</Badge>}
              {run.durationMs !== undefined && <span className="text-[12px] text-fg-4 tabular-nums">{ms(run.durationMs)}</span>}
            </div>
          </div>

          <div className={clsx('grid grid-cols-1 items-start gap-5', runApprovals.length && 'xl:grid-cols-[minmax(0,1fr)_minmax(0,440px)]')}>
            <Card className="overflow-hidden">
              <CardHeader title="Steps" />
              <div className="p-5 pb-2">
                <RunTrace run={run} />
                {run.outcome && (run.summary || run.reply) && !run.steps.some((st) => st.detail && (run.summary ?? run.reply ?? '').startsWith(st.detail.slice(0, 60))) && (
                  <div className="mb-3 rounded-[10px] bg-subtle px-4 py-3">
                    <div className="prose-msg text-[13.5px] leading-relaxed text-fg" dangerouslySetInnerHTML={{ __html: mdInline(run.summary ?? run.reply ?? '') }} />
                  </div>
                )}
              </div>
            </Card>
            {runApprovals.length > 0 && (
              <div className="grid gap-4 xl:sticky xl:top-20">
                <div className="label">{runApprovals.some((a) => a.status === 'pending') ? 'Waiting for you' : 'Actions'}</div>
                {runApprovals.map((a) => (
                  <ApprovalCard key={a.id} approval={a} />
                ))}
              </div>
            )}
          </div>
        </div>
      ) : (
        <Card>
          <EmptyState icon={<SquareTerminal className="size-4" />} title="No requests yet" />
        </Card>
      )}
    </div>
  )
}

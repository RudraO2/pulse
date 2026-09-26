import { useEffect, useState } from 'react'
import { api } from '../lib/api'
import { OUTCOME_LABEL } from '../lib/format'
import { SUGGESTIONS } from '../lib/prefs'
import { useStore } from '../lib/store'
import { Badge } from '../ui/primitives'
import { Composer } from './items'
import { RunInline } from './RunInline'

// Ask Pulse from the phone: the same Console agent. Steps stream in; anything
// that reaches people comes back as an approval card right here.

export function AskScreen() {
  const runs = useStore((s) => s.runs.filter((r) => r.origin === 'console'))
  const [runId, setRunId] = useState<string>()
  const run = runs.find((r) => r.runId === runId) ?? (runId ? undefined : runs[0])
  const older = run ? runs[runs.findIndex((r) => r.runId === run.runId) + 1] : undefined

  useEffect(() => {
    if (runs[0] && !runs[0].outcome) setRunId(runs[0].runId)
  }, [runs[0]?.runId])

  const submit = async (text: string) => {
    const res = await api.console(text)
    if (res?.runId) setRunId(res.runId)
    return !!res?.runId
  }

  return (
    <div className="animate-fade-in">
      <h1 className="display text-[28px] leading-tight font-semibold text-fg">Ask Pulse</h1>
      <div className="mt-4">
        <Composer placeholder="Tell Pulse what the community needs…" hint="Anything that reaches people waits for your approval." onSend={submit} />
      </div>
      {!run && (
        <div className="mt-4 flex flex-col gap-2">
          {SUGGESTIONS.slice(0, 3).map((s) => (
            <button key={s} onClick={() => void submit(s)} className="rounded-[12px] border border-line bg-surface px-3.5 py-3 text-left text-[13.5px] leading-snug text-fg-2 active:bg-hover">
              {s}
            </button>
          ))}
        </div>
      )}

      {run && (
        <div className="mt-5 animate-fade-in">
          <div className="mb-3 flex items-start justify-between gap-3">
            <p className="text-[15px] leading-snug font-medium text-fg">{run.input}</p>
            {run.outcome ? <Badge tone={run.outcome === 'failed' ? 'bad' : run.outcome === 'awaiting_approval' ? 'warn' : 'ok'}>{OUTCOME_LABEL[run.outcome]}</Badge> : <Badge tone="accent">Working</Badge>}
          </div>
          <RunInline runId={run.runId} />
          {older && (
            <button onClick={() => setRunId(older.runId)} className="mt-4 block max-w-full truncate text-[13px] font-medium text-fg-3">
              Earlier: {older.input}
            </button>
          )}
        </div>
      )}
    </div>
  )
}

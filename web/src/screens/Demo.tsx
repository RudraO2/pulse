import clsx from 'clsx'
import { CirclePlay, Pause, Play, RotateCcw, Square } from 'lucide-react'
import { useEffect, useState } from 'react'
import { api, type ScenarioInfo } from '../lib/api'
import { useStore } from '../lib/store'
import { Badge, Button, Card, PageHeader, Segmented } from '../ui/primitives'
import { ActivityRow } from './Overview'

export function DemoScreen() {
  const [scenarios, setScenarios] = useState<ScenarioInfo[]>([])
  const [speed, setSpeed] = useState<'1' | '1.5' | '2'>('1')
  const [resetting, setResetting] = useState(false)
  const sc = useStore((s) => s.scenario)
  const runs = useStore((s) => s.runs.filter((r) => r.simulated).slice(0, 8))

  useEffect(() => {
    void api.scenarios().then((s) => s && setScenarios(s))
  }, [])

  const running = sc.status === 'running' || sc.status === 'paused'
  const pct = sc.beats ? Math.round((sc.beat / sc.beats) * 100) : 0

  return (
    <div className="animate-fade-in">
      <PageHeader
        title="Demo"
        subtitle="Scripted members post into the real Slack channel. Only the members are fake: every Pulse reaction is the real agent, real LLM, real Swytchcode calls and real Notion writes."
        actions={
          <>
            <Segmented
              value={speed}
              onChange={(v) => {
                setSpeed(v)
                void api.demo('speed', { speed: Number(v) })
              }}
              options={[
                { value: '1', label: '1×' },
                { value: '1.5', label: '1.5×' },
                { value: '2', label: '2×' },
              ]}
            />
            <Button
              icon={<RotateCcw className="size-3.5" />}
              loading={resetting}
              onClick={async () => {
                setResetting(true)
                await api.demo('reset')
                await api.refresh()
                setResetting(false)
              }}
            >
              Reset demo data
            </Button>
          </>
        }
      />

      {running || sc.status === 'done' ? (
        <Card className="mb-6 overflow-hidden">
          <div className="flex flex-wrap items-center gap-4 px-6 py-5">
            <div className="min-w-0 flex-1">
              <div className="flex items-center gap-2">
                <span className="label">{sc.status === 'done' ? 'Finished' : sc.status === 'paused' ? 'Paused' : 'Now playing'}</span>
                <Badge tone="accent">{sc.title}</Badge>
              </div>
              <p className="mt-2 text-[17px] leading-snug font-medium text-fg">{sc.caption ?? '…'}</p>
            </div>
            {running && (
              <div className="flex items-center gap-2">
                <Button icon={sc.status === 'paused' ? <Play className="size-3.5" /> : <Pause className="size-3.5" />} onClick={() => void api.demo(sc.status === 'paused' ? 'resume' : 'pause')}>
                  {sc.status === 'paused' ? 'Resume' : 'Pause'}
                </Button>
                <Button variant="ghost" icon={<Square className="size-3.5" />} onClick={() => void api.demo('stop')}>
                  Stop
                </Button>
              </div>
            )}
          </div>
          <div className="h-1 bg-subtle">
            <div className={clsx('h-full bg-accent transition-all duration-500')} style={{ width: `${pct}%` }} />
          </div>
        </Card>
      ) : null}

      <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-3">
        {scenarios.map((s) => (
          <Card key={s.id} className={clsx('flex flex-col p-5', s.id === 'full' && 'ring-1 ring-accent/30 sm:col-span-2 xl:col-span-1')}>
            <div className="flex items-start justify-between gap-2">
              <h3 className="text-[14px] font-semibold text-fg">{s.title}</h3>
              {s.id === 'full' && <Badge tone="accent">2.5 min</Badge>}
            </div>
            <p className="mt-1.5 flex-1 text-[12.5px] leading-relaxed text-fg-3">{s.description}</p>
            <div className="mt-3 flex flex-wrap gap-1">
              {s.shows.map((x) => (
                <Badge key={x}>{x}</Badge>
              ))}
            </div>
            <div className="mt-4 flex items-center justify-between">
              <span className="text-[11px] text-fg-4">{s.beats} beats</span>
              <Button size="sm" variant={s.id === 'full' ? 'primary' : 'secondary'} icon={<CirclePlay className="size-3.5" />} disabled={running} onClick={() => void api.demo('play', { id: s.id, speed: Number(speed) })}>
                Play
              </Button>
            </div>
          </Card>
        ))}
      </div>

      {runs.length > 0 && (
        <Card className="mt-6 overflow-hidden">
          <div className="border-b border-line px-5 py-3 text-[13px] font-semibold">What Pulse did in the scripted community</div>
          <div className="divide-y divide-line">
            {runs.map((r) => (
              <ActivityRow key={r.runId} run={r} />
            ))}
          </div>
        </Card>
      )}
    </div>
  )
}

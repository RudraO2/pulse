import clsx from 'clsx'
import { CircleCheck, CircleDashed, CircleX, Pause, Play, RotateCcw, Square } from 'lucide-react'
import { useEffect, useState } from 'react'
import type { ServiceName } from '@shared/events'
import { ActivityRow } from '../components/ActivityRow'
import { api, type ScenarioInfo } from '../lib/api'
import { useStore } from '../lib/store'
import { Badge, Button, Card, CardHeader, PageHeader, Segmented } from '../ui/primitives'

const CHECKS: Array<{ service: ServiceName; label: string }> = [
  { service: 'telegram', label: 'Telegram' },
  { service: 'slack', label: 'Slack' },
  { service: 'notion', label: 'Notion knowledge base' },
  { service: 'llm', label: 'Language models' },
  { service: 'swytchcode', label: 'Swytchcode' },
  { service: 'resend', label: 'Resend email' },
]

function BeforeYouPresent() {
  const services = useStore((s) => s.services)
  const selftest = useStore((s) => s.selftest)
  const passed = selftest.filter((r) => r.ok).length
  const rows = [
    ...CHECKS.map((c) => ({ label: c.label, state: services[c.service]?.state ?? 'disabled', detail: services[c.service]?.detail })),
    { label: 'Guardrail self-test', state: !selftest.length ? 'disabled' : passed === selftest.length ? 'up' : 'down', detail: selftest.length ? `${passed}/${selftest.length}` : 'not run' },
  ]
  const ready = rows.every((r) => r.state === 'up')
  return (
    <Card className="overflow-hidden">
      <CardHeader title={<span className="flex items-center gap-2">Checklist{ready && <CircleCheck className="size-4 text-ok" />}</span>} />
      <ul className="divide-y divide-line">
        {rows.map((r) => (
          <li key={r.label} className="flex items-center gap-2.5 px-5 py-2.5 text-[13px]" title={r.detail}>
            {r.state === 'up' ? <CircleCheck className="size-4 shrink-0 text-ok" /> : r.state === 'disabled' ? <CircleDashed className="size-4 shrink-0 text-fg-4" /> : <CircleX className={clsx('size-4 shrink-0', r.state === 'down' ? 'text-bad' : 'text-warn')} />}
            <span className="min-w-0 flex-1 text-fg-2">{r.label}</span>
            <span className="max-w-[45%] truncate text-[12px] text-fg-4">{r.state === 'up' ? r.detail ?? 'ready' : r.state}</span>
          </li>
        ))}
      </ul>
    </Card>
  )
}

export function DemoScreen() {
  const [scenarios, setScenarios] = useState<ScenarioInfo[]>([])
  const [speed, setSpeed] = useState<'1' | '1.5' | '2'>('1')
  const [resetting, setResetting] = useState(false)
  const sc = useStore((s) => s.scenario)
  const runs = useStore((s) => s.runs.filter((r) => r.simulated).slice(0, 5))

  useEffect(() => {
    void api.scenarios().then((s) => s && setScenarios(s))
  }, [])

  const running = sc.status === 'running' || sc.status === 'paused'
  const featured = scenarios.find((s) => s.id === 'full') ?? scenarios[0]
  const rest = scenarios.filter((s) => s !== featured)
  const play = (id: string) => void api.demo('play', { id, speed: Number(speed) })
  const stage = running || sc.status === 'done'

  return (
    <div className="animate-fade-in">
      <PageHeader
        title="Demo"
        meta="Scripted members · real agent"
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
              Reset
            </Button>
          </>
        }
      />

      {stage && (
      <section className="card mb-5 overflow-hidden">
        <div className={clsx('grid gap-5 px-6 sm:grid-cols-[minmax(0,1fr)_auto]', stage ? 'py-5' : 'items-center py-4')}>
          <div className="min-w-0">
            <div className="flex flex-wrap items-center gap-2">
              <span className="label">{sc.status === 'done' ? 'Finished' : sc.status === 'paused' ? 'Paused' : running ? 'Now playing' : 'Ready'}</span>
              {(stage ? sc.title : featured?.title) && <Badge tone="accent">{stage ? sc.title : featured?.title}</Badge>}
            </div>
            {stage && (
              <p className={clsx('display mt-2.5 text-[clamp(20px,2.4vw,28px)] leading-tight font-semibold text-fg', running && 'min-h-[2.5em]')}>
                {running ? sc.caption ?? 'Starting…' : 'Finished.'}
              </p>
            )}
          </div>
          <div className="flex flex-wrap items-start gap-2 sm:justify-end">
            {running ? (
              <>
                <Button icon={sc.status === 'paused' ? <Play className="size-3.5" /> : <Pause className="size-3.5" />} onClick={() => void api.demo(sc.status === 'paused' ? 'resume' : 'pause')}>
                  {sc.status === 'paused' ? 'Resume' : 'Pause'}
                </Button>
                <Button variant="ghost" icon={<Square className="size-3.5" />} onClick={() => void api.demo('stop')}>
                  Stop
                </Button>
              </>
            ) : (
              featured && (
                <Button variant="go" icon={<Play className="size-3.5" />} onClick={() => play(featured.id)}>
                  Play {featured.title.toLowerCase()}
                </Button>
              )
            )}
          </div>
        </div>
        {stage && sc.beats > 0 && (
          <div className="flex gap-[3px] px-6 pb-5" aria-label={`Beat ${sc.beat} of ${sc.beats}`}>
            {Array.from({ length: sc.beats }, (_, i) => (
              <span key={i} className={clsx('h-[5px] flex-1 rounded-full transition-colors duration-300', sc.status === 'done' || i < sc.beat ? 'bg-accent' : i === sc.beat && sc.status === 'running' ? 'animate-pulse-dot bg-accent/60' : 'bg-line')} />
            ))}
          </div>
        )}
      </section>
      )}

      <div className="grid grid-cols-1 items-start gap-5 lg:grid-cols-[minmax(0,1fr)_340px]">
        <div className="grid min-w-0 grid-cols-1 gap-5">
          {featured && (
            <Card className="overflow-hidden">
              <CardHeader title="Scenarios" />
              <ul className="divide-y divide-line">
                {[featured, ...rest].map((s) => (
                  <li key={s.id} className="flex items-center gap-4 px-5 py-3" title={s.description}>
                    <div className="min-w-0 flex-1">
                      <div className="flex flex-wrap items-center gap-2">
                        <span className="text-[14px] font-medium text-fg">{s.title}</span>
                        {s.id === 'full' && <Badge tone="accent">2.5 min</Badge>}
                      </div>
                    </div>
                    <span className="hidden text-[11.5px] whitespace-nowrap text-fg-4 sm:block">{s.beats} beats</span>
                    <Button size="sm" variant={s.id === 'full' ? 'go' : 'secondary'} icon={<Play className="size-3" />} disabled={running} onClick={() => play(s.id)}>
                      Play
                    </Button>
                  </li>
                ))}
              </ul>
            </Card>
          )}
          {runs.length > 0 && (
            <Card className="overflow-hidden">
              <CardHeader title="Scripted activity" />
              <div className="divide-y divide-line">
                {runs.map((r) => (
                  <ActivityRow key={r.runId} run={r} />
                ))}
              </div>
            </Card>
          )}
        </div>
        <BeforeYouPresent />
      </div>
    </div>
  )
}

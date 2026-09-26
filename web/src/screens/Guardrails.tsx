import clsx from 'clsx'
import { ArrowRight, ChevronDown, CircleCheck, CircleX, FlaskConical, Lock, ShieldAlert, ShieldCheck } from 'lucide-react'
import { useEffect, useMemo, useState } from 'react'
import { api, type GuardrailsInfo } from '../lib/api'
import { clock, ms, providerOf, timeAgo } from '../lib/format'
import { useStore } from '../lib/store'
import { Badge, Button, Card, EmptyState, Metrics, PageHeader, PlatformIcon, Segmented, ToolChip } from '../ui/primitives'

const PLAIN: Record<string, { title: string; why: string }> = {
  'no-secrets': { title: 'Never post secrets', why: 'Blocks any Telegram or Slack message that contains an API key or token pattern.' },
  'no-secrets-email': { title: 'Never email secrets', why: 'The same secret patterns, checked on every Resend email subject and body.' },
  'cooldown-telegram': { title: 'Telegram posting cooldown', why: 'A chat where Pulse posts too fast is refused until it cools down.' },
  'cooldown-slack': { title: 'Slack posting cooldown', why: 'A channel where Pulse posts too fast is refused until it cools down.' },
  'dm-members-only-telegram': { title: 'Telegram DMs: members only', why: 'Pulse can only DM people verified as members of the community group.' },
  'dm-members-only-slack': { title: 'Slack DMs: members only', why: 'Pulse can only DM verified channel members.' },
  'no-mass-mention': { title: 'No @channel or @everyone', why: 'Pulse can never mass-ping a Slack channel, whatever the prompt says.' },
  'no-shady-links': { title: 'No hidden links', why: 'Link shorteners, raw-IP and script links are refused in community posts (phishing and prompt-injection spam).' },
  'email-recipients': { title: 'Email only allow-listed people', why: 'Resend emails can only go to the organizers’ allow-listed addresses.' },
}

type Tab = 'policies' | 'blocked' | 'audit' | 'allow' | 'selftest'

export function GuardrailsScreen() {
  const [info, setInfo] = useState<GuardrailsInfo>()
  const [testing, setTesting] = useState(false)
  const [tab, setTab] = useState<Tab>('policies')
  const [openPolicy, setOpenPolicy] = useState<string>()
  const [auditFilter, setAuditFilter] = useState<'all' | 'dry' | 'blocked'>('all')
  const hits = useStore((s) => s.guardrails)
  const selftest = useStore((s) => s.selftest)
  const calls = useStore((s) => s.swyCalls)
  const stats = useStore((s) => s.swyStats)

  useEffect(() => {
    void api.guardrails().then(setInfo)
  }, [])

  const hitCount = useMemo(() => {
    const m = new Map<string, number>()
    for (const h of hits) if (h.policyId) m.set(h.policyId, (m.get(h.policyId) ?? 0) + 1)
    return m
  }, [hits])

  const byProvider = useMemo(() => {
    const m = new Map<string, string[]>()
    for (const id of info?.tooling ?? []) m.set(providerOf(id), [...(m.get(providerOf(id)) ?? []), id].sort())
    return [...m.entries()].sort()
  }, [info])

  const passed = selftest.filter((r) => r.ok).length
  const recent = [...calls]
    .reverse()
    .filter((c) => !c.cached)
    .filter((c) => auditFilter === 'all' || (auditFilter === 'dry' ? c.command === 'dry-run' : c.status !== 'ok'))
    .slice(0, 40)
  const latest = hits[0]
  const policies = [...(info?.policies.policies ?? [])].sort((a, b) => (hitCount.get(b.id) ?? 0) - (hitCount.get(a.id) ?? 0))

  return (
    <div className="animate-fade-in">
      <PageHeader
        title="Guardrails"
        meta="Every action runs through Swytchcode"
        actions={
          <Button
            icon={<FlaskConical className="size-3.5" />}
            loading={testing}
            onClick={async () => {
              setTesting(true)
              setTab('selftest')
              await api.selftest()
              setTesting(false)
            }}
          >
            Self-test
          </Button>
        }
      />

      {latest ? (
        <section className="card mb-5 grid gap-x-6 gap-y-3 border-[color-mix(in_oklab,var(--bad)_32%,var(--line))] p-5 sm:grid-cols-[minmax(0,1fr)_auto]">
          <div className="min-w-0">
            <div className="label !text-bad">Blocked · {timeAgo(latest.ts)}</div>
            <p className="mt-2 text-[15px] leading-relaxed text-fg">{latest.detail}</p>
            <div className="mt-3 flex flex-wrap items-center gap-2 text-[12.5px] text-fg-3">
              <span className="flex items-center gap-1.5">
                <PlatformIcon platform="pulse" /> Pulse
              </span>
              {latest.tool && (
                <>
                  <ArrowRight className="size-3 text-fg-4" />
                  <ToolChip id={latest.tool} />
                </>
              )}
              <ArrowRight className="size-3 text-fg-4" />
              <span className="flex items-center gap-1 font-semibold text-bad">
                <ShieldAlert className="size-3.5" /> Stopped{latest.policyId ? ` by ${latest.policyId}` : ''}
              </span>
            </div>
          </div>
          <div className="sm:text-right">
            <div className="display text-[36px] leading-none font-semibold text-bad tabular-nums">{hits.length}</div>
            <div className="mt-1 text-[12px] text-fg-3">blocked</div>
          </div>
        </section>
      ) : null}

      <Metrics
        items={[
          { label: 'Calls', value: stats.total },
          { label: 'Dry-runs', value: stats.dryRuns },
          { label: 'Median latency', value: stats.p50Ms ? ms(stats.p50Ms).replace(/ (ms|s)$/, '') : '–', unit: stats.p50Ms ? (stats.p50Ms < 1000 ? 'ms' : 's') : undefined },
          { label: 'Self-test', value: selftest.length ? passed : '–', unit: selftest.length ? `/${selftest.length}` : undefined },
        ]}
      />

      <div className="mt-6 mb-4 overflow-x-auto">
        <Segmented
          value={tab}
          onChange={setTab}
          options={[
            { value: 'policies', label: 'Policies', count: info?.policies.policies.length },
            { value: 'blocked', label: 'Blocked', count: hits.length },
            { value: 'audit', label: 'Audit log' },
            { value: 'allow', label: 'Allow-list', count: info?.tooling.length },
            { value: 'selftest', label: 'Self-test' },
          ]}
        />
      </div>

      {tab === 'policies' && (
        <Card className="overflow-hidden">
          {info ? (
            <ul className="divide-y divide-line">
              {policies.map((p) => {
                const plain = PLAIN[p.id]
                const n = hitCount.get(p.id) ?? 0
                const open = openPolicy === p.id
                return (
                  <li key={p.id}>
                    <button onClick={() => setOpenPolicy(open ? undefined : p.id)} aria-expanded={open} className="grid w-full grid-cols-[28px_minmax(0,1fr)_auto_16px] items-center gap-3 px-5 py-3 text-left transition-colors hover:bg-hover">
                      <span className={clsx('grid size-7 place-items-center rounded-lg', n ? 'bg-bad-soft text-bad' : 'bg-subtle text-fg-3')}>
                        <ShieldAlert className="size-3.5" />
                      </span>
                      <span className="min-w-0">
                        <span className="block truncate text-[13.5px] font-medium text-fg">{plain?.title ?? p.id}</span>
                      </span>
                      <span className={clsx('text-[12.5px] tabular-nums', n ? 'font-semibold text-bad' : 'text-fg-4')}>{n ? `${n} blocked` : 'no hits'}</span>
                      <ChevronDown className={clsx('size-4 text-fg-4 transition-transform', open && 'rotate-180')} />
                    </button>
                    {open && (
                      <div className="animate-fade-in px-5 pb-4 pl-[60px]">
                        <p className="text-[13px] leading-relaxed text-fg-2">{plain?.why ?? p.action.message}</p>
                        <div className="mt-2.5 flex flex-wrap items-center gap-1.5">
                          <Badge mono>{p.id}</Badge>
                          <Badge tone={p.action.type === 'RATE_LIMITED' ? 'warn' : 'neutral'}>{p.action.type === 'RATE_LIMITED' ? 'Rate limit' : 'Deny'}</Badge>
                          {p.target.map((t) => (
                            <ToolChip key={t} id={t} />
                          ))}
                        </div>
                      </div>
                    )}
                  </li>
                )
              })}
            </ul>
          ) : (
            <div className="p-5">
              <div className="skeleton h-40" />
            </div>
          )}
        </Card>
      )}

      {tab === 'blocked' && (
        <Card className="overflow-hidden">
          {hits.length ? (
            <ul className="divide-y divide-line">
              {hits.slice(0, 30).map((h, i) => (
                <li key={`${h.ts}-${i}`} className="grid grid-cols-[28px_minmax(0,1fr)] gap-3 px-5 py-3">
                  <span className="grid size-7 place-items-center rounded-lg bg-bad-soft text-bad">
                    <ShieldAlert className="size-3.5" />
                  </span>
                  <div className="min-w-0">
                    <div className="flex flex-wrap items-center gap-2">
                      <Badge tone="bad" mono>
                        {h.policyId ?? h.kind}
                      </Badge>
                      {h.tool && <span className="font-mono text-[11px] text-fg-4">{h.tool}</span>}
                      <span className="text-[11.5px] text-fg-4">{timeAgo(h.ts)}</span>
                    </div>
                    <p className="mt-1 text-[13px] text-fg-2">{h.detail}</p>
                  </div>
                </li>
              ))}
            </ul>
          ) : (
            <EmptyState icon={<ShieldCheck className="size-4" />} title="Nothing blocked yet" />
          )}
        </Card>
      )}

      {tab === 'audit' && (
        <Card className="overflow-hidden">
          <div className="flex flex-wrap items-center justify-between gap-3 border-b border-line px-5 py-3">
            <span className="text-[12.5px] text-fg-3">Auth redacted</span>
            <Segmented
              value={auditFilter}
              onChange={setAuditFilter}
              options={[
                { value: 'all', label: 'All' },
                { value: 'dry', label: 'Dry-runs' },
                { value: 'blocked', label: 'Failed' },
              ]}
            />
          </div>
          {recent.length ? (
            <div className="overflow-x-auto">
              <table className="w-full text-left">
                <thead>
                  <tr className="border-b border-line text-[11.5px] text-fg-3">
                    <th className="px-5 py-2 font-medium">Time</th>
                    <th className="px-3 py-2 font-medium">Method</th>
                    <th className="px-3 py-2 font-medium">Mode</th>
                    <th className="px-3 py-2 font-medium">Result</th>
                    <th className="px-5 py-2 text-right font-medium">Latency</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-line">
                  {recent.map((c) => (
                    <tr key={c.callId}>
                      <td className="px-5 py-2 font-mono text-[11.5px] whitespace-nowrap text-fg-4">{clock(c.ts)}</td>
                      <td className="px-3 py-2">
                        <span className="flex items-center gap-1.5 whitespace-nowrap">
                          <PlatformIcon platform={providerOf(c.tool)} className="size-3" />
                          <span className="font-mono text-[11.5px] text-fg-2">{c.tool}</span>
                        </span>
                      </td>
                      <td className="px-3 py-2">
                        <Badge tone={c.command === 'dry-run' ? 'accent' : 'neutral'}>{c.command}</Badge>
                      </td>
                      <td className="px-3 py-2 whitespace-nowrap">
                        {c.status === 'ok' ? (
                          <CircleCheck className="size-3.5 text-ok" />
                        ) : (
                          <span className="inline-flex items-center gap-1 font-mono text-[11px] text-bad">
                            <CircleX className="size-3.5" />
                            {c.category}
                          </span>
                        )}
                      </td>
                      <td className="px-5 py-2 text-right text-[12px] text-fg-3 tabular-nums">{ms(c.durationMs)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          ) : (
            <EmptyState title="No calls yet" />
          )}
        </Card>
      )}

      {tab === 'allow' && (
        <Card className="overflow-hidden">
          <div className="flex items-center gap-2 border-b border-line px-5 py-3 text-[12.5px] text-fg-3">
            <Lock className="size-3.5" /> Everything else is refused
          </div>
          <div className="grid gap-5 p-5 md:grid-cols-2">
            {byProvider.map(([provider, ids]) => (
              <div key={provider}>
                <div className="mb-2 flex items-center gap-1.5 text-[13px] font-semibold text-fg">
                  <PlatformIcon platform={provider} /> <span className="capitalize">{provider}</span> <span className="font-normal text-fg-4">· {ids.length}</span>
                </div>
                <div className="flex flex-wrap gap-1">
                  {ids.map((id) => (
                    <ToolChip key={id} id={id.split('.').slice(1).join('.')} />
                  ))}
                </div>
              </div>
            ))}
          </div>
        </Card>
      )}

      {tab === 'selftest' && (
        <Card className="overflow-hidden">
          {selftest.length ? (
            <>
              <ul className="grid divide-y divide-line md:grid-cols-2 md:divide-y-0">
                {selftest.map((r) => (
                  <li key={r.name} className="flex items-center gap-2.5 border-line px-5 py-2.5 md:border-b">
                    {r.ok ? <CircleCheck className="size-3.5 shrink-0 text-ok" /> : <CircleX className="size-3.5 shrink-0 text-bad" />}
                    <span className="min-w-0 flex-1 truncate text-[13px] text-fg-2">{r.name}</span>
                    <span className="font-mono text-[11px] text-fg-4">{r.got === 'block' ? 'blocked' : r.got === 'pass' ? 'allowed' : r.got}</span>
                  </li>
                ))}
              </ul>
            </>
          ) : (
            <EmptyState icon={<FlaskConical className="size-4" />} title="No results yet" />
          )}
        </Card>
      )}
    </div>
  )
}

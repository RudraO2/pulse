import clsx from 'clsx'
import { CircleCheck, CircleX, FlaskConical, Lock, ShieldAlert, ShieldCheck } from 'lucide-react'
import { useEffect, useMemo, useState } from 'react'
import { api, type GuardrailsInfo } from '../lib/api'
import { clock, ms, providerOf, timeAgo } from '../lib/format'
import { useStore } from '../lib/store'
import { Badge, Button, Card, CardHeader, EmptyState, PageHeader, PlatformIcon, ToolChip } from '../ui/primitives'

const PLAIN: Record<string, { title: string; why: string }> = {
  'no-secrets': { title: 'Never post secrets', why: 'Blocks any Telegram/Slack message containing an API key or token pattern.' },
  'no-secrets-email': { title: 'Never email secrets', why: 'Same secret patterns, checked on every Resend email subject and body.' },
  'cooldown-telegram': { title: 'Telegram posting cooldown', why: 'Chats where Pulse is posting too fast are refused until they cool down.' },
  'cooldown-slack': { title: 'Slack posting cooldown', why: 'Channels where Pulse is posting too fast are refused until they cool down.' },
  'dm-members-only-telegram': { title: 'Telegram DMs: members only', why: 'Pulse can only DM people verified as members of the community group.' },
  'dm-members-only-slack': { title: 'Slack DMs: members only', why: 'Pulse can only DM verified channel members.' },
  'no-mass-mention': { title: 'No @channel / @everyone', why: 'Pulse can never mass-ping a Slack channel, whatever the prompt says.' },
  'no-shady-links': { title: 'No hidden links', why: 'Link shorteners, raw-IP and script links are refused in community posts (phishing / prompt-injection spam).' },
  'email-recipients': { title: 'Email only allow-listed people', why: 'Resend emails can only go to the organizers’ allow-listed addresses.' },
}

export function GuardrailsScreen() {
  const [info, setInfo] = useState<GuardrailsInfo>()
  const [testing, setTesting] = useState(false)
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
  const recent = [...calls].reverse().filter((c) => !c.cached).slice(0, 40)

  return (
    <div className="animate-fade-in">
      <PageHeader
        title="Guardrails"
        subtitle="Pulse never calls an API directly. Every action goes through Swytchcode, where a fail-closed allow-list and policies are enforced before the request leaves the machine, whatever the model decides."
        actions={
          <Button
            icon={<FlaskConical className="size-3.5" />}
            loading={testing}
            onClick={async () => {
              setTesting(true)
              await api.selftest()
              setTesting(false)
            }}
          >
            Run self-test
          </Button>
        }
      />

      <div className="mb-6 grid grid-cols-2 gap-4 lg:grid-cols-4">
        {[
          ['Swytchcode calls', stats.total, 'since start'],
          ['Dry-run previews', stats.dryRuns, 'exact requests shown before approval'],
          ['Blocked attempts', hits.length, 'stopped by policy or allow-list'],
          ['Self-test', selftest.length ? `${passed}/${selftest.length}` : '–', 'policies proven live at boot'],
        ].map(([label, n, hint]) => (
          <Card key={label} className="px-5 py-4">
            <div className="text-[12px] font-medium text-fg-3">{label}</div>
            <div className="mt-1.5 text-2xl font-semibold tabular-nums">{n}</div>
            <div className="mt-1 text-[12px] text-fg-4">{hint}</div>
          </Card>
        ))}
      </div>

      <div className="grid gap-6 lg:grid-cols-[minmax(0,1fr)_380px]">
        <div className="space-y-6">
          <Card className="overflow-hidden">
            <CardHeader title="Policies" subtitle="Compiled into Swytchcode's policies.json and evaluated before execution" icon={<ShieldCheck className="size-4" />} />
            <ul className="divide-y divide-line">
              {(info?.policies.policies ?? []).map((p) => {
                const plain = PLAIN[p.id]
                const n = hitCount.get(p.id) ?? 0
                return (
                  <li key={p.id} className="flex items-start gap-3 px-5 py-3">
                    <span className={clsx('mt-0.5 grid size-7 shrink-0 place-items-center rounded-lg', n ? 'bg-bad-soft text-bad' : 'bg-subtle text-fg-3')}>
                      <ShieldAlert className="size-3.5" />
                    </span>
                    <div className="min-w-0 flex-1">
                      <div className="flex flex-wrap items-center gap-2">
                        <span className="text-[13px] font-medium text-fg">{plain?.title ?? p.id}</span>
                        <Badge mono>{p.id}</Badge>
                        <Badge tone={p.action.type === 'RATE_LIMITED' ? 'warn' : 'neutral'}>{p.action.type}</Badge>
                      </div>
                      <p className="mt-0.5 text-[12.5px] text-fg-3">{plain?.why ?? p.action.message}</p>
                      <div className="mt-1.5 flex flex-wrap gap-1">
                        {p.target.map((t) => (
                          <ToolChip key={t} id={t} />
                        ))}
                      </div>
                    </div>
                    <div className="text-right">
                      <div className={clsx('text-[15px] font-semibold tabular-nums', n ? 'text-bad' : 'text-fg-4')}>{n}</div>
                      <div className="text-[10.5px] text-fg-4">blocked</div>
                    </div>
                  </li>
                )
              })}
              {!info && <li className="p-5"><div className="skeleton h-24" /></li>}
            </ul>
          </Card>

          <Card className="overflow-hidden">
            <CardHeader title="Audit log" subtitle="Recent Swytchcode executions (auth redacted)" />
            {recent.length ? (
              <table className="w-full text-left">
                <thead>
                  <tr className="border-b border-line text-[11px] text-fg-3">
                    <th className="px-5 py-2 font-medium">Time</th>
                    <th className="px-3 py-2 font-medium">Canonical id</th>
                    <th className="px-3 py-2 font-medium">Mode</th>
                    <th className="px-3 py-2 font-medium">Result</th>
                    <th className="px-5 py-2 text-right font-medium">Latency</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-line">
                  {recent.map((c) => (
                    <tr key={c.callId}>
                      <td className="px-5 py-2 text-[12px] whitespace-nowrap text-fg-4 tabular-nums">{clock(c.ts)}</td>
                      <td className="max-w-0 px-3 py-2">
                        <span className="flex items-center gap-1.5">
                          <PlatformIcon platform={providerOf(c.tool)} className="size-3 shrink-0" />
                          <span className="truncate font-mono text-[11.5px] text-fg-2">{c.tool}</span>
                        </span>
                      </td>
                      <td className="px-3 py-2">
                        <Badge tone={c.command === 'dry-run' ? 'accent' : 'neutral'}>{c.command}</Badge>
                      </td>
                      <td className="px-3 py-2">
                        {c.status === 'ok' ? <CircleCheck className="size-3.5 text-ok" /> : <span className="inline-flex items-center gap-1 text-[11.5px] text-bad"><CircleX className="size-3.5" />{c.category}</span>}
                      </td>
                      <td className="px-5 py-2 text-right text-[12px] text-fg-3 tabular-nums">{ms(c.durationMs)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            ) : (
              <EmptyState title="No calls yet" />
            )}
          </Card>
        </div>

        <div className="space-y-6">
          <Card className="overflow-hidden">
            <CardHeader title="Blocked attempts" subtitle="Live, as they happen" icon={<ShieldAlert className="size-4" />} />
            {hits.length ? (
              <ul className="divide-y divide-line">
                {hits.slice(0, 12).map((h, i) => (
                  <li key={`${h.ts}-${i}`} className="px-5 py-2.5">
                    <div className="flex items-center gap-2">
                      <Badge tone="bad" mono>{h.policyId ?? h.kind}</Badge>
                      <span className="text-[11px] text-fg-4">{timeAgo(h.ts)}</span>
                    </div>
                    <p className="mt-1 line-clamp-2 text-[12px] text-fg-2">{h.detail}</p>
                  </li>
                ))}
              </ul>
            ) : (
              <EmptyState icon={<ShieldCheck className="size-4" />} title="Nothing blocked yet" hint="Try the self-test: it sends should-block payloads through the real policy engine." />
            )}
          </Card>

          {selftest.length > 0 && (
            <Card className="overflow-hidden">
              <CardHeader title="Self-test" subtitle={`${passed} of ${selftest.length} checks passed (real Swytchcode dry-runs)`} icon={<FlaskConical className="size-4" />} />
              <ul className="divide-y divide-line">
                {selftest.map((r) => (
                  <li key={r.name} className="flex items-center gap-2 px-5 py-2">
                    {r.ok ? <CircleCheck className="size-3.5 shrink-0 text-ok" /> : <CircleX className="size-3.5 shrink-0 text-bad" />}
                    <span className="min-w-0 flex-1 truncate text-[12px] text-fg-2">{r.name}</span>
                    <span className="text-[11px] text-fg-4">{r.got}</span>
                  </li>
                ))}
              </ul>
            </Card>
          )}

          <Card className="overflow-hidden">
            <CardHeader title="Allow-list" subtitle={`${info?.tooling.length ?? 0} methods Pulse may call. Everything else is refused.`} icon={<Lock className="size-4" />} />
            <div className="space-y-3 p-5">
              {byProvider.map(([provider, ids]) => (
                <div key={provider}>
                  <div className="mb-1.5 flex items-center gap-1.5 text-[12px] font-medium text-fg-2">
                    <PlatformIcon platform={provider} /> <span className="capitalize">{provider}</span> <span className="text-fg-4">· {ids.length}</span>
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
        </div>
      </div>
    </div>
  )
}

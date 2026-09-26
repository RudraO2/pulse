import clsx from 'clsx'
import { LoaderCircle, MessageCircle, RefreshCw, Search, Users, X } from 'lucide-react'
import { useEffect, useState, type ReactNode } from 'react'
import type { WhatsAppGroup } from '@shared/events'
import { api } from '../lib/api'
import { useStore } from '../lib/store'
import { Badge, Button, PlatformIcon } from '../ui/primitives'

// Link a WhatsApp number (QR, like WhatsApp Web), then control Pulse the way
// the WhatsApp bot does: one master switch, a switch per group, and per chat
// Auto (Pulse replies on its own) or Approve (every reply waits for you).

function Switch({ on, onChange, label, busy, tone = 'green' }: { on: boolean; onChange: (v: boolean) => void; label: string; busy?: boolean; tone?: 'green' | 'amber' }) {
  return (
    <button
      role="switch"
      aria-checked={on}
      aria-label={label}
      disabled={busy}
      onClick={() => onChange(!on)}
      className={clsx('relative h-5 w-9 shrink-0 rounded-full transition-colors disabled:opacity-50', on ? (tone === 'green' ? 'bg-[#25d366]' : 'bg-warn') : 'bg-line-strong')}
    >
      <span className={clsx('absolute top-0.5 size-4 rounded-full bg-white shadow transition-[left]', on ? 'left-[18px]' : 'left-0.5')} />
    </button>
  )
}

/** Auto = no approval needed; Approve = each reply waits in the Inbox (and on your phone). */
function ModePill({ auto, onChange, disabled }: { auto: boolean; onChange: (auto: boolean) => void; disabled?: boolean }) {
  const opt = (value: boolean, label: string, title: string) => (
    <button
      onClick={() => onChange(value)}
      aria-pressed={auto === value}
      disabled={disabled}
      title={title}
      className={clsx('h-6 rounded-[5px] px-2 text-[11.5px] font-medium transition-colors disabled:opacity-50', auto === value ? 'bg-surface text-fg shadow-[0_1px_2px_rgb(0_0_0/0.08)]' : 'text-fg-3 hover:text-fg')}
    >
      {label}
    </button>
  )
  return (
    <div className="inline-flex shrink-0 gap-0.5 rounded-[7px] border border-line bg-subtle p-[2px]" role="group" aria-label="Reply mode">
      {opt(true, 'Auto', 'Pulse replies on its own')}
      {opt(false, 'Approve', 'Every reply waits for your approval')}
    </div>
  )
}

function ChatRow({ icon, name, meta, enabled, auto, onEnabled, onAuto, dim }: { icon: ReactNode; name: string; meta: string; enabled: boolean; auto: boolean; onEnabled: (v: boolean) => Promise<unknown>; onAuto: (v: boolean) => Promise<unknown>; dim?: boolean }) {
  const [busy, setBusy] = useState(false)
  const act = (fn: () => Promise<unknown>) => {
    setBusy(true)
    void fn().finally(() => setBusy(false))
  }
  return (
    <li className={clsx('flex items-center gap-3 px-3 py-2.5', dim && 'opacity-60')}>
      <span className="grid size-8 shrink-0 place-items-center rounded-full bg-subtle text-fg-3">{icon}</span>
      <div className="min-w-0 flex-1">
        <div className="truncate text-[13.5px] font-medium text-fg">{name}</div>
        <div className="text-[12px] text-fg-3">{meta}</div>
      </div>
      {enabled && <ModePill auto={auto} disabled={busy} onChange={(v) => act(() => onAuto(v))} />}
      <Switch on={enabled} busy={busy} label={`Pulse in ${name}`} onChange={(v) => act(() => onEnabled(v))} />
    </li>
  )
}

function Master({ paused }: { paused: boolean }) {
  const [busy, setBusy] = useState(false)
  return (
    <div className={clsx('mt-4 flex items-center gap-3 rounded-xl border px-3.5 py-3', paused ? 'border-warn/40 bg-warn-soft' : 'border-line')}>
      <span className={clsx('size-2 shrink-0 rounded-full', paused ? 'bg-warn' : 'bg-[#25d366]')} />
      <div className="min-w-0 flex-1">
        <div className="text-[14px] font-semibold text-fg">{paused ? 'Paused' : 'Replying'}</div>
        <div className="text-[12px] text-fg-3">{paused ? 'Reading, not replying' : 'In the chats switched on below'}</div>
      </div>
      <Switch
        on={!paused}
        busy={busy}
        label="Pulse replying on WhatsApp"
        onChange={(v) => {
          setBusy(true)
          void api.waPause(!v).finally(() => setBusy(false))
        }}
      />
    </div>
  )
}

export function WhatsAppDialog({ onClose }: { onClose: () => void }) {
  const wa = useStore((s) => s.whatsapp)
  const [q, setQ] = useState('')
  const [busy, setBusy] = useState<'link' | 'logout' | 'refresh'>()

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && onClose()
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onClose])

  const run = (kind: 'link' | 'logout' | 'refresh', fn: () => Promise<unknown>) => {
    setBusy(kind)
    void fn().finally(() => setBusy(undefined))
  }

  const groups = wa.groups.filter((g) => !q || g.name.toLowerCase().includes(q.toLowerCase()))
  const on = wa.groups.filter((g) => g.enabled)
  const autoCount = on.filter((g) => g.auto).length

  return (
    <div className="fixed inset-0 z-40 grid place-items-center p-4">
      <div className="absolute inset-0 animate-fade-in bg-[var(--scrim)]" onClick={onClose} />
      <div className="card relative flex max-h-[90vh] w-full max-w-[500px] animate-pop flex-col p-6 shadow-[var(--shadow-lg)]" role="dialog" aria-label="WhatsApp">
        <button onClick={onClose} className="absolute top-4 right-4 rounded-md p-1 text-fg-3 hover:bg-hover hover:text-fg" aria-label="Close">
          <X className="size-4" />
        </button>
        <h2 className="display flex items-center gap-2 text-[22px] font-semibold text-fg">
          <PlatformIcon platform="whatsapp" className="size-5" /> WhatsApp
        </h2>

        {wa.status === 'connected' ? (
          <>
            <div className="mt-1 flex items-center gap-2 text-[13px] text-fg-3">
              <span className="min-w-0 truncate">
                {wa.me?.name ?? 'Linked'}
                {wa.me?.number ? ` · +${wa.me.number}` : ''}
              </span>
              <button onClick={() => run('logout', api.waLogout)} className="ml-auto text-[12px] text-fg-4 hover:text-bad" title="Unlink this number from Pulse">
                {busy === 'logout' ? 'Unlinking…' : 'Unlink'}
              </button>
            </div>

            <Master paused={wa.paused} />

            <div className="mt-4 flex items-center gap-2">
              <label className="flex h-9 min-w-0 flex-1 items-center gap-2 rounded-lg border border-line bg-surface px-2.5 text-[13px]">
                <Search className="size-3.5 shrink-0 text-fg-4" />
                <input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Find a group" className="min-w-0 flex-1 bg-transparent text-fg outline-none placeholder:text-fg-4" />
              </label>
              <Badge tone={on.length ? 'ok' : 'ghost'} className="shrink-0">
                {on.length} on{on.length ? ` · ${autoCount} auto` : ''}
              </Badge>
              <Button variant="ghost" icon={<RefreshCw className="size-3.5" />} loading={busy === 'refresh'} onClick={() => run('refresh', api.waRefresh)} aria-label="Reload groups" title="Reload groups" />
            </div>

            <ul className="mt-3 min-h-0 flex-1 divide-y divide-line overflow-y-auto rounded-xl border border-line">
              {groups.map((g: WhatsAppGroup) => (
                <ChatRow
                  key={g.jid}
                  icon={<Users className="size-4" />}
                  name={g.name}
                  meta={`${g.size} members`}
                  enabled={g.enabled}
                  auto={g.auto}
                  dim={wa.paused}
                  onEnabled={(v) => api.waGroup(g.jid, { enabled: v })}
                  onAuto={(v) => api.waGroup(g.jid, { auto: v })}
                />
              ))}
              {!groups.length && <li className="px-3 py-6 text-center text-[12.5px] text-fg-3">{wa.groups.length ? 'No match' : 'This number is in no groups yet'}</li>}
            </ul>

            <ul className="mt-3 rounded-xl border border-line">
              <ChatRow
                icon={<MessageCircle className="size-4" />}
                name="Direct messages"
                meta="Members of groups that are on"
                enabled={wa.dms}
                auto={wa.dmsAuto}
                dim={wa.paused}
                onEnabled={(v) => api.waDms({ enabled: v })}
                onAuto={(v) => api.waDms({ auto: v })}
              />
            </ul>
          </>
        ) : wa.status === 'qr' && wa.qr ? (
          <>
            <p className="mt-1 text-[13px] text-fg-3">WhatsApp → Settings → Linked devices → Link a device</p>
            <div className="mt-5 flex justify-center rounded-xl border border-line p-5">
              <img src={wa.qr} alt="WhatsApp link QR code" className="size-56 rounded-lg bg-white p-2" />
            </div>
          </>
        ) : wa.status === 'connecting' ? (
          <div className="mt-6 flex items-center justify-center gap-2 py-10 text-[13px] text-fg-3">
            <LoaderCircle className="size-4 animate-spin" /> Connecting…
          </div>
        ) : (
          <>
            <p className="mt-1 text-[13px] text-fg-3">{wa.status === 'logged_out' ? 'Logged out from the phone.' : 'Link the number Pulse will speak from.'}</p>
            <div className="mt-6 flex justify-center pb-2">
              <Button variant="primary" loading={busy === 'link'} onClick={() => run('link', api.waLink)}>
                Link WhatsApp
              </Button>
            </div>
          </>
        )}
      </div>
    </div>
  )
}

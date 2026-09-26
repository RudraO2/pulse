import clsx from 'clsx'
import { LoaderCircle, RefreshCw, Search, Users, X } from 'lucide-react'
import { useEffect, useState } from 'react'
import type { WhatsAppGroup } from '@shared/events'
import { api } from '../lib/api'
import { useStore } from '../lib/store'
import { Badge, Button, PlatformIcon } from '../ui/primitives'

// Link a WhatsApp number (QR, like WhatsApp Web), then turn Pulse on per
// group. Groups are off until the organizer switches them on; DMs are only
// read from members of groups that are on.

function Switch({ on, onChange, label, busy }: { on: boolean; onChange: (v: boolean) => void; label: string; busy?: boolean }) {
  return (
    <button
      role="switch"
      aria-checked={on}
      aria-label={label}
      disabled={busy}
      onClick={() => onChange(!on)}
      className={clsx('relative h-5 w-9 shrink-0 rounded-full transition-colors disabled:opacity-50', on ? 'bg-[#25d366]' : 'bg-line-strong')}
    >
      <span className={clsx('absolute top-0.5 size-4 rounded-full bg-white shadow transition-[left]', on ? 'left-[18px]' : 'left-0.5')} />
    </button>
  )
}

function GroupRow({ g }: { g: WhatsAppGroup }) {
  const [busy, setBusy] = useState(false)
  return (
    <li className="flex items-center gap-3 px-3 py-2.5">
      <span className="grid size-8 shrink-0 place-items-center rounded-full bg-subtle text-fg-3">
        <Users className="size-4" />
      </span>
      <div className="min-w-0 flex-1">
        <div className="truncate text-[13.5px] font-medium text-fg">{g.name}</div>
        <div className="text-[12px] text-fg-3">{g.size} members</div>
      </div>
      <Switch
        on={g.enabled}
        busy={busy}
        label={`Pulse in ${g.name}`}
        onChange={(v) => {
          setBusy(true)
          void api.waGroup(g.jid, v).finally(() => setBusy(false))
        }}
      />
    </li>
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
  const on = wa.groups.filter((g) => g.enabled).length

  return (
    <div className="fixed inset-0 z-40 grid place-items-center p-4">
      <div className="absolute inset-0 animate-fade-in bg-[var(--scrim)]" onClick={onClose} />
      <div className="card relative flex max-h-[88vh] w-full max-w-[460px] animate-pop flex-col p-6 shadow-[var(--shadow-lg)]" role="dialog" aria-label="WhatsApp">
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
              <Badge tone={on ? 'ok' : 'ghost'}>{on} on</Badge>
              <button onClick={() => run('logout', api.waLogout)} className="ml-auto text-[12px] text-fg-4 hover:text-bad" title="Unlink this number from Pulse">
                {busy === 'logout' ? 'Unlinking…' : 'Unlink'}
              </button>
            </div>

            <div className="mt-4 flex items-center gap-2">
              <label className="flex h-9 min-w-0 flex-1 items-center gap-2 rounded-lg border border-line bg-surface px-2.5 text-[13px]">
                <Search className="size-3.5 shrink-0 text-fg-4" />
                <input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Find a group" className="min-w-0 flex-1 bg-transparent text-fg outline-none placeholder:text-fg-4" />
              </label>
              <Button variant="ghost" icon={<RefreshCw className="size-3.5" />} loading={busy === 'refresh'} onClick={() => run('refresh', api.waRefresh)} aria-label="Reload groups" title="Reload groups" />
            </div>

            <ul className="mt-3 min-h-0 flex-1 divide-y divide-line overflow-y-auto rounded-xl border border-line">
              {groups.map((g) => (
                <GroupRow key={g.jid} g={g} />
              ))}
              {!groups.length && <li className="px-3 py-6 text-center text-[12.5px] text-fg-3">{wa.groups.length ? 'No match' : 'This number is in no groups yet'}</li>}
            </ul>

            <div className="mt-4 flex items-center gap-3 text-[13px]">
              <span className="flex-1 text-fg-2" title="Only people in a group Pulse is on in. Personal chats are never read.">
                Answer DMs from members
              </span>
              <Switch on={wa.dms} label="Answer DMs from members" onChange={(v) => void api.waDms(v)} />
            </div>
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

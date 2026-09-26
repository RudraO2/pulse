import { Check, PenLine, Sparkles } from 'lucide-react'
import { useState } from 'react'
import type { AttentionItem, MemberCase } from '@shared/events'
import { api } from '../lib/api'
import { timeAgo } from '../lib/format'
import { store } from '../lib/store'
import { Avatar, Badge, PlatformIcon } from '../ui/primitives'
import { BigButton, Composer, MoodRow, Shell } from './items'
import { RunInline } from './RunInline'

// A member who needs the organizer. The main path: tell Pulse what to do in
// your own words ("lunch is at 1:30 now, let him know") → Pulse drafts the
// reply (and an FAQ fix or announcement if you asked) → you approve → sent
// through Swytchcode, taken off your list, and Pulse keeps watching the member.

const firstName = (n: string) => n.split(/\s+/)[0] ?? n

export function MemberActions({ id, name, platform, onResolve, resolveLabel = 'Resolve' }: { id: string; name: string; platform: string; onResolve: () => Promise<unknown>; resolveLabel?: string }) {
  const [mode, setMode] = useState<'idle' | 'pulse' | 'self'>('idle')
  const [runId, setRunId] = useState<string>()
  const [busy, setBusy] = useState(false)
  const where = platform === 'telegram' ? 'Telegram' : platform === 'whatsapp' ? 'WhatsApp' : 'Slack'

  if (runId) {
    return (
      <div className="mt-3.5">
        <RunInline runId={runId} compact />
        <button onClick={() => setRunId(undefined)} className="mt-2.5 text-[12.5px] font-medium text-fg-3">
          Ask again
        </button>
      </div>
    )
  }
  if (mode === 'pulse') {
    return (
      <div className="mt-3.5">
        <Composer
          autoFocus
          placeholder={`Tell Pulse what to do, e.g. “lunch is at 1:30 now, let ${firstName(name)} know”`}
          hint="Pulse drafts it. Nothing is sent until you approve."
          onSend={async (text) => {
            const res = await api.console(text, { kind: 'member', id })
            if (res?.runId) setRunId(res.runId)
            return !!res?.runId
          }}
        />
        <button onClick={() => setMode('self')} className="mt-2 px-1 text-[12.5px] font-medium text-fg-3">
          Write it myself instead
        </button>
      </div>
    )
  }
  if (mode === 'self') {
    return (
      <div className="mt-3.5">
        <Composer
          autoFocus
          placeholder={`Reply to ${firstName(name)}…`}
          hint={`Sent now in ${where} as a reply, signed by you.`}
          onSend={async (text) => {
            const res = await api.replyCase(id, text)
            if (res?.ok) {
              store.toast('ok', `Replied to ${firstName(name)}`)
              setMode('idle')
              return true
            }
            if (res?.error) store.toast('bad', res.error)
            return false
          }}
        />
        <button onClick={() => setMode('pulse')} className="mt-2 px-1 text-[12.5px] font-medium text-fg-3">
          Let Pulse draft it
        </button>
      </div>
    )
  }
  return (
    <div className="mt-3.5 grid grid-cols-[1.4fr_1fr] gap-2">
      <BigButton tone="go" icon={<Sparkles className="size-4" />} onClick={() => setMode('pulse')}>
        Ask Pulse
      </BigButton>
      <BigButton
        icon={<Check className="size-4" />}
        loading={busy}
        onClick={async () => {
          setBusy(true)
          await onResolve()
          setBusy(false)
        }}
      >
        {resolveLabel}
      </BigButton>
      <button onClick={() => setMode('self')} className="col-span-2 flex items-center justify-center gap-1.5 pt-1 text-[12.5px] font-medium text-fg-3">
        <PenLine className="size-3.5" /> Reply in my own words
      </button>
    </div>
  )
}

export function MemberItem({ m, c, focused }: { m: AttentionItem; c?: MemberCase; focused?: boolean }) {
  return (
    <Shell id={m.id} focused={focused} urgent={m.kind !== 'ignored'}>
      <div className="flex items-start gap-3">
        <Avatar name={m.userName} size={36} />
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-1.5">
            <span className="text-[15.5px] font-semibold text-fg">{m.userName}</span>
            <Badge tone={m.kind === 'ignored' ? 'warn' : m.kind === 'needs_human' ? 'accent' : 'bad'}>{m.kind === 'needs_human' ? 'asked for you' : m.kind === 'ignored' ? 'waiting' : 'upset'}</Badge>
            {m.simulated && <Badge tone="ghost">demo</Badge>}
          </div>
          <div className="mt-0.5 flex items-center gap-1 text-[12px] text-fg-4">
            <PlatformIcon platform={m.platform} className="size-3" /> {m.reason} · {timeAgo(m.ts)}
          </div>
        </div>
      </div>
      <p className="mt-3 text-[14.5px] leading-relaxed text-fg">“{m.text}”</p>
      {c && (
        <div className="mt-2.5">
          <MoodRow c={c} />
        </div>
      )}
      <MemberActions id={m.id} name={m.userName} platform={m.platform} onResolve={() => api.resolveAttention(m.id)} />
    </Shell>
  )
}

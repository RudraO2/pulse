import clsx from 'clsx'
import { ArrowUp, Check, CircleCheck, HelpCircle, LoaderCircle, ShieldAlert, ShieldCheck, X } from 'lucide-react'
import { useState, type ReactNode } from 'react'
import type { Approval, MemberCase, PendingQuestion } from '@shared/events'
import { KIND_LABEL, useDecision } from '../components/ApprovalCard'
import { MoodLine, memberScores, moodWord } from '../components/Mood'
import { api } from '../lib/api'
import { mdInline, providerOf, timeAgo } from '../lib/format'
import { store } from '../lib/store'
import { Badge, PlatformIcon } from '../ui/primitives'

// The three things that can need an organizer, as thumb-sized cards:
// an approval (preview → Approve), a member (mood → Reply / Resolve),
// a question Pulse couldn't answer (→ type the answer, Pulse learns it).

const firstName = (n: string) => n.split(/\s+/)[0] ?? n

export function BigButton({ tone = 'secondary', loading, icon, children, className, ...rest }: React.ButtonHTMLAttributes<HTMLButtonElement> & { tone?: 'go' | 'secondary' | 'ghost'; loading?: boolean; icon?: ReactNode }) {
  return (
    <button
      className={clsx(
        'inline-flex h-11 items-center justify-center gap-2 rounded-[11px] border px-4 text-[14.5px] font-semibold transition-[opacity,background-color] active:scale-[0.985] disabled:opacity-40',
        tone === 'go' && 'border-accent bg-accent text-accent-fg',
        tone === 'secondary' && 'border-line bg-surface text-fg active:bg-hover',
        tone === 'ghost' && 'border-transparent text-fg-3 active:bg-hover',
        className,
      )}
      disabled={loading || rest.disabled}
      {...rest}
    >
      {loading ? <LoaderCircle className="size-4 animate-spin" /> : icon}
      {children}
    </button>
  )
}

export function Composer({ placeholder, hint, onSend, autoFocus }: { placeholder: string; hint?: string; onSend: (text: string) => Promise<boolean>; autoFocus?: boolean }) {
  const [text, setText] = useState('')
  const [busy, setBusy] = useState(false)
  const send = async () => {
    const t = text.trim()
    if (!t || busy) return
    setBusy(true)
    const ok = await onSend(t)
    setBusy(false)
    if (ok) setText('')
  }
  return (
    <div>
      <div className="flex items-end gap-2 rounded-[12px] border border-line bg-surface p-1.5 pl-3 focus-within:border-accent-line focus-within:shadow-[0_0_0_3px_var(--accent-soft)]">
        <textarea
          value={text}
          onChange={(e) => setText(e.target.value)}
          rows={Math.min(5, Math.max(2, text.split('\n').length))}
          placeholder={placeholder}
          autoFocus={autoFocus}
          className="min-h-[48px] flex-1 resize-none bg-transparent py-1.5 text-[15px] leading-relaxed text-fg outline-none placeholder:text-fg-4"
        />
        <button onClick={() => void send()} disabled={!text.trim() || busy} className="grid size-10 shrink-0 place-items-center rounded-[9px] bg-accent text-accent-fg disabled:opacity-30" aria-label="Send">
          {busy ? <LoaderCircle className="size-4 animate-spin" /> : <ArrowUp className="size-4" />}
        </button>
      </div>
      {hint && <p className="mt-1.5 px-1 text-[12px] text-fg-4">{hint}</p>}
    </div>
  )
}

export function Shell({ id, focused, urgent, children }: { id: string; focused?: boolean; urgent?: boolean; children: ReactNode }) {
  return (
    <li
      id={`item-${id}`}
      className={clsx(
        'card scroll-mt-20 animate-fade-in overflow-hidden p-4 transition-shadow',
        urgent && 'border-[color-mix(in_oklab,var(--bad)_35%,var(--line))]',
        focused && 'shadow-[0_0_0_4px_var(--accent-soft)] ring-1 ring-accent-line',
      )}
    >
      {children}
    </li>
  )
}

function Meta({ icon, tone, children }: { icon: ReactNode; tone: string; children: ReactNode }) {
  return (
    <div className="mb-2.5 flex items-center gap-2 text-[12.5px] text-fg-3">
      <span className={clsx('grid size-6 place-items-center rounded-md', tone)}>{icon}</span>
      {children}
    </div>
  )
}

export function ApprovalItem({ a, focused }: { a: Approval; focused?: boolean }) {
  const { busy, act, allBlocked } = useDecision(a)
  const [more, setMore] = useState(false)
  const blocked = a.actions.filter((x) => x.blocked)
  const targets = [...new Set(a.actions.map((x) => providerOf(x.tool)))]
  return (
    <Shell id={a.id} focused={focused}>
      <Meta icon={<ShieldCheck className="size-3.5" />} tone="bg-warn-soft text-warn">
        <span className="font-medium text-fg-2">{KIND_LABEL[a.kind]}</span> · {timeAgo(a.createdAt)}
        {a.simulated && <Badge tone="ghost">demo</Badge>}
      </Meta>
      <h3 className="text-[16px] leading-snug font-semibold text-fg">{a.title}</h3>
      {a.summary && (
        <button onClick={() => setMore((m) => !m)} className="mt-2.5 block w-full rounded-[10px] bg-subtle px-3.5 py-3 text-left">
          <div className={clsx('prose-msg text-[14px] leading-relaxed text-fg', !more && 'line-clamp-4')} dangerouslySetInnerHTML={{ __html: mdInline(a.summary) }} />
        </button>
      )}
      <div className="mt-2.5 flex items-center gap-1.5 text-[12px] text-fg-3">
        {targets.map((t) => (
          <PlatformIcon key={t} platform={t} className="size-3.5" />
        ))}
        {blocked.length ? (
          <span className="flex items-center gap-1 text-bad">
            <ShieldAlert className="size-3.5" /> {blocked.length} blocked by policy
          </span>
        ) : (
          <span className="flex items-center gap-1">
            <CircleCheck className="size-3.5 text-ok" /> Swytchcode dry-run passed
          </span>
        )}
      </div>
      {a.status === 'pending' ? (
        <div className="mt-3.5 grid grid-cols-[1fr_1.6fr] gap-2">
          <BigButton icon={<X className="size-4" />} loading={busy === 'reject'} onClick={() => void act('reject')}>
            Reject
          </BigButton>
          <BigButton tone="go" icon={<Check className="size-4" />} loading={busy === 'approve'} disabled={allBlocked} onClick={() => void act('approve')}>
            Approve
          </BigButton>
        </div>
      ) : (
        <p className="mt-3 text-[13px] text-fg-3">
          {a.status === 'executed' ? 'Done' : a.status === 'rejected' ? 'Rejected' : a.status === 'approved' ? 'Running…' : 'Failed'}
          {a.decidedBy ? ` · ${a.decidedBy}` : ''}
        </p>
      )}
    </Shell>
  )
}

export function MoodRow({ c }: { c: MemberCase }) {
  return (
    <div className="flex items-center gap-2.5 text-[12.5px] text-fg-3">
      <MoodLine scores={memberScores(c)} width={84} />
      <span className="min-w-0 truncate">
        <span className="font-medium text-fg-2">{moodWord(c.mood)}</span>
        {/* the topic falls back to the first message: don't repeat the quote above */}
        {c.points[0]?.text.startsWith(c.topic) ? '' : ` · ${c.topic}`}
      </span>
    </div>
  )
}

export function QuestionItem({ p, focused }: { p: PendingQuestion; focused?: boolean }) {
  return (
    <Shell id={p.id} focused={focused}>
      <Meta icon={<HelpCircle className="size-3.5" />} tone="bg-accent-soft text-accent">
        <span className="font-medium text-fg-2">{firstName(p.userName)} asked</span> · waiting {timeAgo(p.askedAt).replace(' ago', '')}
        {p.simulated && <Badge tone="ghost">demo</Badge>}
      </Meta>
      <p className="text-[16px] leading-snug font-semibold text-fg">“{p.question}”</p>
      <div className="mt-3.5">
        <Composer
          autoFocus={focused}
          placeholder="Your answer…"
          hint={`Pulse answers ${firstName(p.userName)} and saves it to the knowledge base.`}
          onSend={async (text) => {
            const res = await api.answerPending(p.id, text)
            if (res?.ok) {
              store.toast('ok', `Sending to ${firstName(p.userName)} and saving to Notion…`)
              return true
            }
            if (res?.error) store.toast('bad', res.error)
            return false
          }}
        />
      </div>
    </Shell>
  )
}

import clsx from 'clsx'
import { ChevronDown, LoaderCircle, X } from 'lucide-react'
import { useEffect, useState, type ButtonHTMLAttributes, type ReactNode } from 'react'
import type { Platform } from '@shared/events'
import { initials } from '../lib/format'

export function Card({ className, children, ...rest }: { className?: string; children: ReactNode } & React.HTMLAttributes<HTMLDivElement>) {
  return (
    <div className={clsx('card', className)} {...rest}>
      {children}
    </div>
  )
}

export function CardHeader({ title, subtitle, action, icon }: { title: ReactNode; subtitle?: ReactNode; action?: ReactNode; icon?: ReactNode }) {
  return (
    <div className="flex items-center justify-between gap-3 border-b border-line px-5 py-3.5">
      <div className="flex min-w-0 items-center gap-2.5">
        {icon && <span className="text-fg-3">{icon}</span>}
        <div className="min-w-0">
          <h2 className="truncate text-[14px] font-semibold text-fg">{title}</h2>
          {subtitle && <p className="mt-0.5 truncate text-[12.5px] text-fg-3">{subtitle}</p>}
        </div>
      </div>
      {action}
    </div>
  )
}

/** One quiet line: the title, a few facts beside it, actions on the right. */
export function PageHeader({ title, meta, actions }: { title: ReactNode; meta?: ReactNode; actions?: ReactNode }) {
  return (
    <div className="mb-5 flex min-h-9 flex-wrap items-center justify-between gap-x-6 gap-y-3">
      <div className="flex min-w-0 flex-wrap items-baseline gap-x-3 gap-y-1">
        <h1 className="display text-[22px] leading-tight font-semibold text-fg">{title}</h1>
        {meta && <span className="text-[13px] text-fg-3 tabular-nums">{meta}</span>}
      </div>
      {actions && <div className="flex flex-wrap items-center gap-2">{actions}</div>}
    </div>
  )
}

type Tone = 'neutral' | 'accent' | 'teal' | 'ok' | 'warn' | 'bad' | 'info' | 'ghost'
const toneClass: Record<Tone, string> = {
  neutral: 'bg-subtle text-fg-2 border-line',
  ghost: 'bg-transparent text-fg-3 border-line',
  accent: 'bg-accent-soft text-accent border-transparent',
  teal: 'bg-teal-soft text-teal border-transparent',
  ok: 'bg-ok-soft text-ok border-transparent',
  warn: 'bg-warn-soft text-warn border-transparent',
  bad: 'bg-bad-soft text-bad border-transparent',
  info: 'bg-info-soft text-info border-transparent',
}

export function Badge({ tone = 'neutral', children, className, mono }: { tone?: Tone; children: ReactNode; className?: string; mono?: boolean }) {
  return (
    <span className={clsx('inline-flex h-5 shrink-0 items-center gap-1 rounded-md border px-1.5 text-[11.5px] font-medium whitespace-nowrap', toneClass[tone], mono && 'font-mono text-[11px]', className)}>
      {children}
    </span>
  )
}

export function ToolChip({ id }: { id: string }) {
  return <span className="inline-flex items-center rounded-[5px] border border-line bg-subtle px-1.5 py-[3px] font-mono text-[11px] leading-none text-fg-2">{id}</span>
}

type Variant = 'primary' | 'go' | 'secondary' | 'ghost' | 'danger'
export function Button({
  variant = 'secondary',
  size = 'md',
  loading,
  icon,
  className,
  children,
  ...rest
}: ButtonHTMLAttributes<HTMLButtonElement> & { variant?: Variant; size?: 'sm' | 'md'; loading?: boolean; icon?: ReactNode }) {
  return (
    <button
      className={clsx(
        'inline-flex shrink-0 items-center justify-center gap-1.5 rounded-lg border font-medium whitespace-nowrap transition-[background-color,border-color,opacity] disabled:opacity-45',
        size === 'sm' ? 'h-7 rounded-[7px] px-2.5 text-[12.5px]' : 'h-9 px-3.5 text-[13px]',
        variant === 'primary' && 'border-fg bg-fg text-surface hover:opacity-85',
        variant === 'go' && 'border-accent bg-accent text-accent-fg hover:opacity-90',
        variant === 'secondary' && 'border-line bg-surface text-fg hover:border-line-strong hover:bg-hover',
        variant === 'ghost' && 'border-transparent text-fg-3 hover:bg-hover hover:text-fg',
        variant === 'danger' && 'border-line bg-surface text-bad hover:bg-bad-soft',
        className,
      )}
      disabled={loading || rest.disabled}
      {...rest}
    >
      {loading ? <LoaderCircle className="size-3.5 animate-spin" /> : icon}
      {children}
    </button>
  )
}

export function Dot({ state, pulse }: { state: 'up' | 'degraded' | 'down' | 'disabled' | 'busy'; pulse?: boolean }) {
  const color = { up: 'bg-ok', degraded: 'bg-warn', down: 'bg-bad', disabled: 'bg-fg-4', busy: 'bg-accent' }[state]
  return <span className={clsx('inline-block size-1.5 shrink-0 rounded-full', color, pulse && 'animate-pulse-dot')} />
}

export function Avatar({ name, url, size = 28, pulse }: { name: string; url?: string; size?: number; pulse?: boolean }) {
  if (pulse) {
    return (
      <span className="grid shrink-0 place-items-center rounded-full bg-fg text-surface" style={{ width: size, height: size }}>
        <PulseMark className="size-[58%]" />
      </span>
    )
  }
  if (url) return <img src={url} alt="" className="shrink-0 rounded-full border border-line bg-subtle object-cover" style={{ width: size, height: size }} />
  const hue = [...name].reduce((h, c) => (h * 31 + c.charCodeAt(0)) % 360, 7)
  return (
    <span className="avatar grid shrink-0 place-items-center rounded-full font-semibold" style={{ width: size, height: size, fontSize: Math.round(size * 0.39), ['--h' as string]: hue }}>
      {initials(name)}
    </span>
  )
}

export function PulseMark({ className }: { className?: string }) {
  return (
    <svg viewBox="0 0 24 24" fill="none" className={className} aria-hidden>
      <path d="M2.5 12.5h4l2.5-6 4 12 2.8-8.5 1.7 2.5h4" stroke="currentColor" strokeWidth="2.3" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  )
}

export function PlatformIcon({ platform, className }: { platform?: Platform | string; className?: string }) {
  if (platform === 'telegram')
    return (
      <svg viewBox="0 0 24 24" className={clsx('size-3.5 shrink-0', className)} aria-label="Telegram">
        <circle cx="12" cy="12" r="12" fill="#29a9eb" />
        <path d="M5.4 11.8l11.1-4.3c.5-.2 1 .1.8.9l-1.9 8.9c-.1.6-.5.8-1 .5l-2.8-2.1-1.4 1.3c-.2.2-.3.3-.6.3l.2-2.9 5.2-4.7c.2-.2 0-.3-.3-.1l-6.5 4.1-2.8-.9c-.6-.2-.6-.6.1-.9z" fill="#fff" />
      </svg>
    )
  if (platform === 'slack')
    return (
      <svg viewBox="0 0 24 24" className={clsx('size-3.5 shrink-0', className)} aria-label="Slack">
        <path d="M5 15a2 2 0 1 1-2-2h2v2zm1 0a2 2 0 1 1 4 0v5a2 2 0 1 1-4 0v-5z" fill="#e01e5a" />
        <path d="M9 5a2 2 0 1 1 2-2v2H9zm0 1a2 2 0 1 1 0 4H4a2 2 0 1 1 0-4h5z" fill="#36c5f0" />
        <path d="M19 9a2 2 0 1 1 2 2h-2V9zm-1 0a2 2 0 1 1-4 0V4a2 2 0 1 1 4 0v5z" fill="#2eb67d" />
        <path d="M15 19a2 2 0 1 1-2 2v-2h2zm0-1a2 2 0 1 1 0-4h5a2 2 0 1 1 0 4h-5z" fill="#ecb22e" />
      </svg>
    )
  if (platform === 'notion')
    return (
      <svg viewBox="0 0 24 24" className={clsx('size-3.5 shrink-0', className)} aria-label="Notion">
        <rect x="2" y="2" width="20" height="20" rx="4" fill="currentColor" className="text-fg" />
        <path d="M8 7.5v9M8 7.5l7 9M15 7.5v9" stroke="var(--surface)" strokeWidth="1.8" strokeLinecap="round" />
      </svg>
    )
  if (platform === 'resend')
    return (
      <svg viewBox="0 0 24 24" className={clsx('size-3.5 shrink-0', className)} aria-label="Resend">
        <rect x="2" y="2" width="20" height="20" rx="4" fill="currentColor" className="text-fg" />
        <path d="M8.5 7h4.2a2.8 2.8 0 0 1 0 5.6H8.5V7zm3 5.6L15.5 17" stroke="var(--surface)" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" fill="none" />
      </svg>
    )
  return <PulseMark className={clsx('size-3.5 shrink-0 text-accent', className)} />
}

export function EmptyState({ icon, title, hint, action, className }: { icon?: ReactNode; title: string; hint?: ReactNode; action?: ReactNode; className?: string }) {
  return (
    <div className={clsx('flex flex-col items-center justify-center px-6 py-12 text-center', className)}>
      {icon && <div className="mb-3 grid size-10 place-items-center rounded-xl border border-line bg-subtle text-fg-3">{icon}</div>}
      <p className="text-[14px] font-medium text-fg">{title}</p>
      {hint && <p className="mt-1 max-w-sm text-[12.5px] leading-relaxed text-fg-3">{hint}</p>}
      {action && <div className="mt-4">{action}</div>}
    </div>
  )
}

export function Segmented<T extends string>({ value, options, onChange }: { value: T; options: Array<{ value: T; label: ReactNode; count?: number }>; onChange: (v: T) => void }) {
  return (
    <div className="inline-flex gap-0.5 rounded-[9px] border border-line bg-subtle p-[3px]" role="group">
      {options.map((o) => (
        <button
          key={o.value}
          onClick={() => onChange(o.value)}
          aria-pressed={value === o.value}
          className={clsx(
            'h-7 rounded-md px-2.5 text-[12.5px] font-medium whitespace-nowrap transition-colors',
            value === o.value ? 'bg-surface text-fg shadow-[0_1px_2px_rgb(0_0_0/0.08)]' : 'text-fg-3 hover:text-fg',
          )}
        >
          {o.label}
          {o.count !== undefined && <span className="ml-1.5 text-fg-4 tabular-nums">{o.count}</span>}
        </button>
      ))}
    </div>
  )
}

export function Drawer({ open, onClose, title, subtitle, children, width = 560 }: { open: boolean; onClose: () => void; title: ReactNode; subtitle?: ReactNode; children: ReactNode; width?: number }) {
  useEffect(() => {
    if (!open) return
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && onClose()
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [open, onClose])
  if (!open) return null
  return (
    <div className="fixed inset-0 z-40">
      <div className="absolute inset-0 animate-fade-in bg-[var(--scrim)]" onClick={onClose} />
      <aside className="absolute top-0 right-0 flex h-full max-w-full animate-slide-in flex-col border-l border-line bg-surface shadow-[var(--shadow-lg)]" style={{ width }} role="dialog">
        <div className="flex items-start justify-between gap-3 border-b border-line px-5 py-4">
          <div className="min-w-0">
            <div className="truncate text-[14.5px] font-semibold text-fg">{title}</div>
            {subtitle && <div className="mt-0.5 truncate text-[12px] text-fg-3">{subtitle}</div>}
          </div>
          <button onClick={onClose} className="rounded-md p-1 text-fg-3 hover:bg-hover hover:text-fg" aria-label="Close">
            <X className="size-4" />
          </button>
        </div>
        <div className="min-h-0 flex-1 overflow-y-auto">{children}</div>
      </aside>
    </div>
  )
}

export function JsonBlock({ value, maxHeight = 260 }: { value: unknown; maxHeight?: number }) {
  const text = typeof value === 'string' ? value : JSON.stringify(value, null, 2)
  return (
    <pre className="mono overflow-auto rounded-lg border border-line bg-subtle p-3 leading-relaxed text-fg-2" style={{ maxHeight }}>
      {text}
    </pre>
  )
}

export function Kbd({ children }: { children: ReactNode }) {
  return <kbd className="kbd">{children}</kbd>
}

/** A row of headline figures, divided by hairlines. One surface, not four cards. */
export function Metrics({ items }: { items: Array<{ label: string; value: ReactNode; unit?: string; hint?: ReactNode }> }) {
  return (
    <div className={clsx('card grid grid-cols-2 overflow-hidden', items.length === 4 ? 'lg:grid-cols-4' : 'lg:grid-cols-3')}>
      {items.map((m, i) => (
        <div key={m.label} className={clsx('min-w-0 border-line px-5 py-4', i % 2 === 1 && 'border-l', i >= 2 && 'border-t lg:border-t-0', i >= 1 && 'lg:border-l')}>
          <div className="text-[12.5px] text-fg-3">{m.label}</div>
          <div className="display mt-1.5 text-[28px] leading-none font-semibold text-fg tabular-nums">
            {m.value}
            {m.unit && <span className="ml-0.5 font-sans text-[14px] font-medium tracking-normal text-fg-4">{m.unit}</span>}
          </div>
          {m.hint && <div className="mt-1.5 truncate text-[12px] text-fg-3">{m.hint}</div>}
        </div>
      ))}
    </div>
  )
}

/** Progressive disclosure: a quiet toggle that reveals more of a list or section. */
export function ShowMore({ open, onToggle, more, less = 'Show less' }: { open: boolean; onToggle: () => void; more: string; less?: string }) {
  return (
    <button onClick={onToggle} className="flex w-full items-center justify-center gap-1 border-t border-line py-2.5 text-[12.5px] font-medium text-fg-3 transition-colors hover:bg-hover hover:text-fg">
      {open ? less : more}
      <ChevronDown className={clsx('size-3.5 transition-transform', open && 'rotate-180')} />
    </button>
  )
}

/** A section that starts collapsed and says what's inside. */
export function Disclosure({ summary, children, defaultOpen = false, className }: { summary: ReactNode; children: ReactNode; defaultOpen?: boolean; className?: string }) {
  const [open, setOpen] = useState(defaultOpen)
  return (
    <div className={className}>
      <button onClick={() => setOpen((o) => !o)} aria-expanded={open} className="flex w-full items-center gap-2 text-left">
        <span className="min-w-0 flex-1">{summary}</span>
        <ChevronDown className={clsx('size-4 shrink-0 text-fg-4 transition-transform', open && 'rotate-180')} />
      </button>
      {open && <div className="animate-fade-in">{children}</div>}
    </div>
  )
}

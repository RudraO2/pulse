import clsx from 'clsx'
import { LoaderCircle, X } from 'lucide-react'
import { useEffect, type ButtonHTMLAttributes, type ReactNode } from 'react'
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
    <div className="flex items-start justify-between gap-3 border-b border-line px-5 py-3.5">
      <div className="flex min-w-0 items-center gap-2.5">
        {icon && <span className="text-fg-3">{icon}</span>}
        <div className="min-w-0">
          <h3 className="truncate text-[13px] font-semibold text-fg">{title}</h3>
          {subtitle && <p className="truncate text-xs text-fg-3">{subtitle}</p>}
        </div>
      </div>
      {action}
    </div>
  )
}

export function PageHeader({ title, subtitle, actions }: { title: string; subtitle?: ReactNode; actions?: ReactNode }) {
  return (
    <div className="mb-6 flex flex-wrap items-end justify-between gap-4">
      <div>
        <h1 className="text-[22px] font-semibold tracking-tight text-fg">{title}</h1>
        {subtitle && <p className="mt-1 text-sm text-fg-3">{subtitle}</p>}
      </div>
      {actions && <div className="flex items-center gap-2">{actions}</div>}
    </div>
  )
}

type Tone = 'neutral' | 'accent' | 'ok' | 'warn' | 'bad' | 'info'
const toneClass: Record<Tone, string> = {
  neutral: 'bg-subtle text-fg-2 border-line',
  accent: 'bg-accent-soft text-accent border-transparent',
  ok: 'bg-ok-soft text-ok border-transparent',
  warn: 'bg-warn-soft text-warn border-transparent',
  bad: 'bg-bad-soft text-bad border-transparent',
  info: 'bg-info-soft text-info border-transparent',
}

export function Badge({ tone = 'neutral', children, className, mono }: { tone?: Tone; children: ReactNode; className?: string; mono?: boolean }) {
  return (
    <span className={clsx('inline-flex shrink-0 items-center gap-1 rounded-md border px-1.5 py-0.5 text-[11px] font-medium leading-none whitespace-nowrap', toneClass[tone], mono && 'font-mono', className)}>
      {children}
    </span>
  )
}

export function ToolChip({ id }: { id: string }) {
  return <span className="inline-flex items-center rounded-md border border-line bg-subtle px-1.5 py-0.5 font-mono text-[11px] text-fg-2">{id}</span>
}

type Variant = 'primary' | 'secondary' | 'ghost' | 'danger'
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
        'inline-flex shrink-0 items-center justify-center gap-1.5 rounded-lg font-medium whitespace-nowrap transition-colors disabled:opacity-50',
        size === 'sm' ? 'h-7 px-2.5 text-xs' : 'h-9 px-3.5 text-[13px]',
        variant === 'primary' && 'bg-accent text-accent-fg hover:opacity-90',
        variant === 'secondary' && 'border border-line bg-surface text-fg hover:bg-hover',
        variant === 'ghost' && 'text-fg-2 hover:bg-hover hover:text-fg',
        variant === 'danger' && 'border border-line bg-surface text-bad hover:bg-bad-soft',
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
      <span className="grid shrink-0 place-items-center rounded-full bg-accent text-accent-fg" style={{ width: size, height: size }}>
        <PulseMark className="size-[55%]" />
      </span>
    )
  }
  if (url) return <img src={url} alt="" className="shrink-0 rounded-full border border-line bg-subtle object-cover" style={{ width: size, height: size }} />
  const hue = [...name].reduce((h, c) => (h * 31 + c.charCodeAt(0)) % 360, 7)
  return (
    <span
      className="grid shrink-0 place-items-center rounded-full text-[11px] font-semibold"
      style={{ width: size, height: size, background: `hsl(${hue} 70% 94%)`, color: `hsl(${hue} 45% 32%)` }}
    >
      {initials(name)}
    </span>
  )
}

export function PulseMark({ className }: { className?: string }) {
  return (
    <svg viewBox="0 0 24 24" fill="none" className={className} aria-hidden>
      <path d="M2.5 12.5h4l2.5-6 4 12 2.8-8.5 1.7 2.5h4" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  )
}

export function PlatformIcon({ platform, className }: { platform?: Platform | string; className?: string }) {
  if (platform === 'telegram')
    return (
      <svg viewBox="0 0 24 24" className={clsx('size-3.5', className)} aria-label="Telegram">
        <circle cx="12" cy="12" r="12" fill="#29a9eb" />
        <path d="M5.4 11.8l11.1-4.3c.5-.2 1 .1.8.9l-1.9 8.9c-.1.6-.5.8-1 .5l-2.8-2.1-1.4 1.3c-.2.2-.3.3-.6.3l.2-2.9 5.2-4.7c.2-.2 0-.3-.3-.1l-6.5 4.1-2.8-.9c-.6-.2-.6-.6.1-.9z" fill="#fff" />
      </svg>
    )
  if (platform === 'slack')
    return (
      <svg viewBox="0 0 24 24" className={clsx('size-3.5', className)} aria-label="Slack">
        <path d="M5 15a2 2 0 1 1-2-2h2v2zm1 0a2 2 0 1 1 4 0v5a2 2 0 1 1-4 0v-5z" fill="#e01e5a" />
        <path d="M9 5a2 2 0 1 1 2-2v2H9zm0 1a2 2 0 1 1 0 4H4a2 2 0 1 1 0-4h5z" fill="#36c5f0" />
        <path d="M19 9a2 2 0 1 1 2 2h-2V9zm-1 0a2 2 0 1 1-4 0V4a2 2 0 1 1 4 0v5z" fill="#2eb67d" />
        <path d="M15 19a2 2 0 1 1-2 2v-2h2zm0-1a2 2 0 1 1 0-4h5a2 2 0 1 1 0 4h-5z" fill="#ecb22e" />
      </svg>
    )
  if (platform === 'notion')
    return (
      <svg viewBox="0 0 24 24" className={clsx('size-3.5', className)} aria-label="Notion">
        <rect x="2" y="2" width="20" height="20" rx="4" fill="currentColor" className="text-fg" />
        <path d="M8 7.5v9M8 7.5l7 9M15 7.5v9" stroke="var(--surface)" strokeWidth="1.8" strokeLinecap="round" />
      </svg>
    )
  if (platform === 'resend')
    return (
      <svg viewBox="0 0 24 24" className={clsx('size-3.5', className)} aria-label="Resend">
        <rect x="2" y="2" width="20" height="20" rx="4" fill="currentColor" className="text-fg" />
        <path d="M8.5 7h4.2a2.8 2.8 0 0 1 0 5.6H8.5V7zm3 5.6L15.5 17" stroke="var(--surface)" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" fill="none" />
      </svg>
    )
  return <PulseMark className={clsx('size-3.5 text-accent', className)} />
}

export function EmptyState({ icon, title, hint, action }: { icon?: ReactNode; title: string; hint?: ReactNode; action?: ReactNode }) {
  return (
    <div className="flex flex-col items-center justify-center px-6 py-12 text-center">
      {icon && <div className="mb-3 grid size-10 place-items-center rounded-xl border border-line bg-subtle text-fg-3">{icon}</div>}
      <p className="text-sm font-medium text-fg">{title}</p>
      {hint && <p className="mt-1 max-w-sm text-xs text-fg-3">{hint}</p>}
      {action && <div className="mt-4">{action}</div>}
    </div>
  )
}

export function Segmented<T extends string>({ value, options, onChange }: { value: T; options: Array<{ value: T; label: ReactNode }>; onChange: (v: T) => void }) {
  return (
    <div className="inline-flex rounded-lg border border-line bg-subtle p-0.5">
      {options.map((o) => (
        <button
          key={o.value}
          onClick={() => onChange(o.value)}
          className={clsx(
            'rounded-md px-2.5 py-1 text-xs font-medium transition-colors',
            value === o.value ? 'bg-surface text-fg shadow-[0_1px_2px_rgba(0,0,0,0.06)]' : 'text-fg-3 hover:text-fg',
          )}
        >
          {o.label}
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
      <div className="absolute inset-0 bg-black/20 backdrop-blur-[1px] animate-fade-in" onClick={onClose} />
      <aside className="absolute top-0 right-0 flex h-full max-w-full flex-col border-l border-line bg-surface shadow-2xl animate-slide-in" style={{ width }}>
        <div className="flex items-start justify-between gap-3 border-b border-line px-5 py-4">
          <div className="min-w-0">
            <div className="truncate text-sm font-semibold text-fg">{title}</div>
            {subtitle && <div className="mt-0.5 truncate text-xs text-fg-3">{subtitle}</div>}
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
  return <kbd className="rounded border border-line bg-subtle px-1 font-mono text-[10px] text-fg-3">{children}</kbd>
}

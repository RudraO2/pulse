import clsx from 'clsx'
import { CircleAlert, CircleCheck, Info, ShieldAlert, X } from 'lucide-react'
import { useEffect } from 'react'
import { store, useStore } from '../lib/store'

const ICON = { info: Info, ok: CircleCheck, warn: ShieldAlert, bad: CircleAlert }
// Toasts sit on an ink surface in both themes, so they use fixed tints.
const TONE = { info: 'text-[#9db2ff]', ok: 'text-[#5fd393]', warn: 'text-[#f2b552]', bad: 'text-[#f58a80]' }

export function Toasts({ className = 'right-5 bottom-5' }: { className?: string }) {
  const toasts = useStore((s) => s.toasts)
  useEffect(() => {
    if (!toasts.length) return
    const t = setTimeout(() => store.dismissToast(toasts[0]!.id), 5200)
    return () => clearTimeout(t)
  }, [toasts])
  return (
    <div className={clsx('pointer-events-none fixed z-50 flex', className, 'w-[380px] max-w-[calc(100vw-2rem)] flex-col gap-2')} aria-live="polite">
      {toasts.map((t) => {
        const Icon = ICON[t.tone]
        return (
          <div key={t.id} className="pointer-events-auto flex animate-fade-in items-start gap-2.5 rounded-[10px] bg-[#12151b] px-3.5 py-3 text-[#e9ecf1] shadow-[var(--shadow-lg)] ring-1 ring-white/10">
            <Icon className={clsx('mt-0.5 size-4 shrink-0', TONE[t.tone])} />
            <p className="min-w-0 flex-1 text-[13px] leading-relaxed">{t.text}</p>
            <button onClick={() => store.dismissToast(t.id)} className="text-white/40 hover:text-white" aria-label="Dismiss">
              <X className="size-3.5" />
            </button>
          </div>
        )
      })}
    </div>
  )
}

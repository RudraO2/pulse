import clsx from 'clsx'
import { CircleAlert, CircleCheck, Info, ShieldAlert, X } from 'lucide-react'
import { useEffect } from 'react'
import { store, useStore } from '../lib/store'

const ICON = { info: Info, ok: CircleCheck, warn: ShieldAlert, bad: CircleAlert }
const TONE = { info: 'text-accent', ok: 'text-ok', warn: 'text-warn', bad: 'text-bad' }

export function Toasts() {
  const toasts = useStore((s) => s.toasts)
  useEffect(() => {
    if (!toasts.length) return
    const t = setTimeout(() => store.dismissToast(toasts[0]!.id), 5200)
    return () => clearTimeout(t)
  }, [toasts])
  return (
    <div className="pointer-events-none fixed right-5 bottom-5 z-50 flex w-[360px] max-w-[calc(100vw-2.5rem)] flex-col gap-2">
      {toasts.map((t) => {
        const Icon = ICON[t.tone]
        return (
          <div key={t.id} className="card pointer-events-auto flex items-start gap-2.5 px-3.5 py-3 shadow-lg animate-fade-in">
            <Icon className={clsx('mt-0.5 size-4 shrink-0', TONE[t.tone])} />
            <p className="min-w-0 flex-1 text-[12.5px] leading-relaxed text-fg">{t.text}</p>
            <button onClick={() => store.dismissToast(t.id)} className="text-fg-4 hover:text-fg" aria-label="Dismiss">
              <X className="size-3.5" />
            </button>
          </div>
        )
      })}
    </div>
  )
}

import clsx from 'clsx'
import { FlaskConical, Monitor, Moon, CirclePlay, RefreshCw, Sparkles, Sun } from 'lucide-react'
import { useEffect, useMemo, useRef, useState, type ComponentType } from 'react'
import { useNavigate } from 'react-router'
import { api } from '../lib/api'
import { closePalette, NAV_GROUPS, SUGGESTIONS, toggleTheme, togglePresent, usePrefs } from '../lib/prefs'
import { useStore } from '../lib/store'

interface Item {
  group: string
  label: string
  icon: ComponentType<{ className?: string }>
  hint?: string
  run: () => void
}

/**
 * Ctrl+K: ask Pulse from anywhere, or jump to a page. Requests go straight to
 * the Console agent; anything that reaches people still waits for approval.
 */
export function CommandPalette() {
  const { palette, dark } = usePrefs()
  if (!palette) return null
  return <PaletteDialog dark={dark} />
}

function PaletteDialog({ dark }: { dark: boolean }) {
  const navigate = useNavigate()
  const [q, setQ] = useState('')
  const [idx, setIdx] = useState(0)
  const input = useRef<HTMLInputElement>(null)
  const inbox = useStore((s) => s.approvals.filter((a) => a.status === 'pending').length + s.attention.filter((a) => a.status === 'open').length + s.pending.filter((p) => p.status === 'waiting').length)

  useEffect(() => input.current?.focus(), [])

  const ask = (text: string) => {
    navigate('/console')
    void api.console(text)
  }

  const items = useMemo<Item[]>(() => {
    const t = q.trim()
    const low = t.toLowerCase()
    const out: Item[] = []
    if (t) out.push({ group: 'Ask Pulse', label: `Ask Pulse: “${t}”`, icon: Sparkles, hint: 'Console', run: () => ask(t) })
    else out.push(...SUGGESTIONS.slice(0, 2).map((s) => ({ group: 'Try asking', label: s, icon: Sparkles, run: () => ask(s) })))
    const nav: Item[] = NAV_GROUPS.flatMap((g) => g.items).map((n) => ({ group: 'Go to', label: n.label, icon: n.icon, hint: n.badge === 'inbox' && inbox ? `${inbox} open` : undefined, run: () => navigate(n.to) }))
    const actions: Item[] = [
      { group: 'Actions', label: 'Play the full demo', icon: CirclePlay, run: () => { navigate('/demo'); void api.demo('play', { id: 'full', speed: 1 }) } },
      { group: 'Actions', label: 'Run the guardrail self-test', icon: FlaskConical, run: () => { navigate('/guardrails'); void api.selftest() } },
      { group: 'Actions', label: 'Sync knowledge from Notion', icon: RefreshCw, run: () => void api.kbSync() },
      { group: 'Actions', label: 'Presenter mode', icon: Monitor, hint: 'P', run: togglePresent },
      { group: 'Actions', label: dark ? 'Light theme' : 'Dark theme', icon: dark ? Sun : Moon, run: toggleTheme },
    ]
    const match = (x: Item) => !low || x.label.toLowerCase().includes(low)
    const hits = [...nav.filter(match), ...actions.filter(match)]
    // "guard" should open Guardrails; a sentence with no page match goes to Pulse
    return t && hits.length ? [...hits, ...out] : [...out, ...hits]
  }, [q, inbox, dark])

  const safeIdx = Math.min(idx, items.length - 1)
  const choose = (i: number) => {
    const it = items[i]
    closePalette()
    it?.run()
  }

  return (
    <div className="fixed inset-0 z-50" onKeyDown={(e) => {
      if (e.key === 'Escape') closePalette()
      if (e.key === 'ArrowDown') { e.preventDefault(); setIdx((safeIdx + 1) % items.length) }
      if (e.key === 'ArrowUp') { e.preventDefault(); setIdx((safeIdx - 1 + items.length) % items.length) }
      if (e.key === 'Enter') { e.preventDefault(); choose(safeIdx) }
    }}>
      <div className="absolute inset-0 animate-fade-in bg-[var(--scrim)]" onClick={closePalette} />
      <div className="absolute top-[12vh] left-1/2 w-[min(620px,calc(100vw-2rem))] -translate-x-1/2">
        <div className="animate-pop overflow-hidden rounded-[14px] border border-line bg-surface shadow-[var(--shadow-lg)]" role="dialog" aria-label="Ask Pulse">
          <div className="flex items-center gap-2.5 border-b border-line px-4 text-fg-4">
            <Sparkles className="size-4" />
            <input
              ref={input}
              value={q}
              onChange={(e) => { setQ(e.target.value); setIdx(0) }}
              placeholder="Ask Pulse to do something, or jump to a page…"
              className="h-[52px] min-w-0 flex-1 bg-transparent text-[15.5px] text-fg outline-none placeholder:text-fg-4"
              aria-label="Ask Pulse or search"
            />
            <kbd className="kbd">Esc</kbd>
          </div>
          <ul className="max-h-[50vh] overflow-y-auto p-1.5" role="listbox">
            {items.map((it, i) => (
              <li key={`${it.group}-${it.label}`}>
                {(i === 0 || items[i - 1]!.group !== it.group) && <div className="label px-2.5 pt-2.5 pb-1 !text-[10.5px] text-fg-4">{it.group}</div>}
                <button
                  onClick={() => choose(i)}
                  onMouseMove={() => setIdx(i)}
                  aria-selected={i === safeIdx}
                  className={clsx('flex w-full items-center gap-2.5 rounded-lg px-2.5 py-2 text-left text-[13.5px]', i === safeIdx ? 'bg-accent-soft text-fg' : 'text-fg-2')}
                >
                  <it.icon className={clsx('size-4 shrink-0', i === safeIdx ? 'text-accent' : 'text-fg-4')} />
                  <span className="min-w-0 flex-1 truncate">{it.label}</span>
                  {it.hint && <span className="text-[11.5px] text-fg-4">{it.hint}</span>}
                </button>
              </li>
            ))}
          </ul>
          <div className="flex flex-wrap gap-x-4 gap-y-1 border-t border-line px-4 py-2 text-[11.5px] text-fg-4">
            <span>
              <kbd className="kbd">↑</kbd> <kbd className="kbd">↓</kbd> move
            </span>
            <span>
              <kbd className="kbd">Enter</kbd> run
            </span>
            <span className="hidden sm:inline">Anything that reaches people still waits for your approval</span>
          </div>
        </div>
      </div>
    </div>
  )
}

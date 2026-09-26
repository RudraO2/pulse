import { useSyncExternalStore } from 'react'
import { BookOpen, CirclePlay, Inbox, LayoutDashboard, MessagesSquare, ShieldCheck, SquareTerminal } from 'lucide-react'
import type { ComponentType } from 'react'

// Viewer preferences (theme, presenter mode, command palette) and the shared
// navigation map. Light is the default theme; the choice is remembered.

interface Prefs {
  dark: boolean
  present: boolean
  palette: boolean
}

const read = (k: string) => {
  try {
    return localStorage.getItem(k)
  } catch {
    return null
  }
}

let prefs: Prefs = { dark: read('pulse.theme') === 'dark', present: false, palette: false }
const listeners = new Set<() => void>()
const set = (patch: Partial<Prefs>) => {
  prefs = { ...prefs, ...patch }
  for (const l of listeners) l()
}
const subscribe = (l: () => void) => {
  listeners.add(l)
  return () => listeners.delete(l)
}

export function usePrefs(): Prefs {
  return useSyncExternalStore(subscribe, () => prefs)
}

export function toggleTheme(): void {
  const dark = !prefs.dark
  document.documentElement.classList.toggle('dark', dark)
  try {
    localStorage.setItem('pulse.theme', dark ? 'dark' : 'light')
  } catch {
    /* private mode: the choice just isn't remembered */
  }
  set({ dark })
}

export function togglePresent(): void {
  const present = !prefs.present
  document.body.classList.toggle('present', present)
  set({ present })
}

export const openPalette = () => set({ palette: true })
export const closePalette = () => set({ palette: false })
export const togglePalette = () => set({ palette: !prefs.palette })

export type NavItem = { to: string; label: string; icon: ComponentType<{ className?: string }>; badge?: 'inbox' }
export const NAV_GROUPS: Array<{ label: string; items: NavItem[] }> = [
  {
    label: 'Community',
    items: [
      { to: '/', label: 'Overview', icon: LayoutDashboard },
      { to: '/conversations', label: 'Conversations', icon: MessagesSquare },
      { to: '/knowledge', label: 'Knowledge', icon: BookOpen },
    ],
  },
  {
    label: 'Act',
    items: [
      { to: '/console', label: 'Console', icon: SquareTerminal },
      { to: '/inbox', label: 'Inbox', icon: Inbox, badge: 'inbox' },
    ],
  },
  { label: 'Trust', items: [{ to: '/guardrails', label: 'Guardrails', icon: ShieldCheck }] },
  { label: 'Stage', items: [{ to: '/demo', label: 'Demo', icon: CirclePlay }] },
]

export const SUGGESTIONS = [
  'Lunch is moving to 1:30 PM today. Tell everyone on Telegram and Slack, pin it, and update the FAQ.',
  'Who has been waiting longest for an answer? Help them, and ping the organizers about anything we don’t know.',
  'Email me a summary of today: top questions, what Pulse learned, and who needs attention.',
  'Run a poll in the Telegram group: which workshop should we host next: agents, RAG, or evals?',
]

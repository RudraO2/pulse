import clsx from 'clsx'
import { BookOpen, CirclePlay, Inbox, LayoutDashboard, MessagesSquare, Moon, ShieldCheck, SquareTerminal, Sun } from 'lucide-react'
import { useEffect, useState, type ComponentType } from 'react'
import { HashRouter, NavLink, Route, Routes } from 'react-router'
import type { ServiceName } from '@shared/events'
import { RunDrawerHost } from './components/RunDrawer'
import { Toasts } from './components/Toasts'
import { api } from './lib/api'
import { useStore } from './lib/store'
import { Dot, PulseMark } from './ui/primitives'
import { ConsoleScreen } from './screens/Console'
import { ConversationsScreen } from './screens/Conversations'
import { DemoScreen } from './screens/Demo'
import { GuardrailsScreen } from './screens/Guardrails'
import { InboxScreen } from './screens/Inbox'
import { KnowledgeScreen } from './screens/Knowledge'
import { OverviewScreen } from './screens/Overview'

const NAV: Array<{ to: string; label: string; icon: ComponentType<{ className?: string }>; badge?: 'inbox' }> = [
  { to: '/', label: 'Overview', icon: LayoutDashboard },
  { to: '/console', label: 'Console', icon: SquareTerminal },
  { to: '/conversations', label: 'Conversations', icon: MessagesSquare },
  { to: '/knowledge', label: 'Knowledge', icon: BookOpen },
  { to: '/inbox', label: 'Inbox', icon: Inbox, badge: 'inbox' },
  { to: '/guardrails', label: 'Guardrails', icon: ShieldCheck },
  { to: '/demo', label: 'Demo', icon: CirclePlay },
]

const SERVICE_LABEL: Record<ServiceName, string> = {
  telegram: 'Telegram',
  slack: 'Slack',
  notion: 'Notion',
  resend: 'Resend',
  llm: 'LLM',
  swytchcode: 'Swytchcode',
}

function useTheme(): [boolean, () => void] {
  const [dark, setDark] = useState(() => localStorage.getItem('pulse.theme') === 'dark')
  useEffect(() => {
    document.documentElement.classList.toggle('dark', dark)
    localStorage.setItem('pulse.theme', dark ? 'dark' : 'light')
  }, [dark])
  return [dark, () => setDark((d) => !d)]
}

function Sidebar() {
  const [dark, toggle] = useTheme()
  const community = useStore((s) => s.community)
  const services = useStore((s) => s.services)
  const connection = useStore((s) => s.connection)
  const inbox = useStore(
    (s) => s.approvals.filter((a) => a.status === 'pending').length + s.attention.filter((a) => a.status === 'open').length + s.pending.filter((p) => p.status === 'waiting').length,
  )
  return (
    <aside className="flex h-full w-[232px] shrink-0 flex-col border-r border-line bg-surface">
      <div className="flex items-center gap-2.5 px-4 pt-4 pb-5">
        <span className="grid size-8 place-items-center rounded-lg bg-accent text-accent-fg">
          <PulseMark className="size-5" />
        </span>
        <div className="min-w-0">
          <div className="text-[15px] leading-tight font-semibold tracking-tight text-fg">Pulse</div>
          <div className="truncate text-[11px] text-fg-3" title={community.name}>
            {community.name}
          </div>
        </div>
      </div>
      <nav className="flex flex-col gap-0.5 px-2.5">
        {NAV.map((n) => (
          <NavLink
            key={n.to}
            to={n.to}
            end={n.to === '/'}
            className={({ isActive }) =>
              clsx(
                'flex items-center gap-2.5 rounded-lg px-2.5 py-[7px] text-[13px] font-medium transition-colors',
                isActive ? 'bg-subtle text-fg' : 'text-fg-3 hover:bg-hover hover:text-fg',
              )
            }
          >
            <n.icon className="size-4" />
            <span className="flex-1">{n.label}</span>
            {n.badge === 'inbox' && inbox > 0 && <span className="rounded-full bg-accent px-1.5 text-[10px] leading-4 font-semibold text-accent-fg tabular-nums">{inbox}</span>}
          </NavLink>
        ))}
      </nav>
      <div className="mt-auto px-4 pb-4">
        <div className="label mb-2">Connected</div>
        <ul className="space-y-1.5">
          {(Object.keys(SERVICE_LABEL) as ServiceName[]).map((k) => (
            <li key={k} className="flex items-center gap-2 text-[12px] text-fg-2" title={services[k]?.detail}>
              <Dot state={services[k]?.state ?? 'disabled'} />
              <span className="flex-1">{SERVICE_LABEL[k]}</span>
              <span className="text-[11px] text-fg-4">{services[k]?.state === 'up' ? '' : services[k]?.state}</span>
            </li>
          ))}
        </ul>
        <div className="mt-4 flex items-center justify-between border-t border-line pt-3">
          <span className="flex items-center gap-1.5 text-[11px] text-fg-4">
            <Dot state={connection === 'offline' ? 'down' : connection === 'connecting' ? 'degraded' : 'up'} pulse={connection !== 'offline'} />
            {connection === 'sse' ? 'Live' : connection === 'poll' ? 'Live (polling)' : connection === 'offline' ? 'Offline' : 'Connecting'}
          </span>
          <button onClick={toggle} className="rounded-md p-1.5 text-fg-3 hover:bg-hover hover:text-fg" aria-label="Toggle theme">
            {dark ? <Sun className="size-3.5" /> : <Moon className="size-3.5" />}
          </button>
        </div>
      </div>
    </aside>
  )
}

function ScenarioBanner() {
  const sc = useStore((s) => s.scenario)
  if (sc.status !== 'running' && sc.status !== 'paused') return null
  const pct = sc.beats ? Math.round((sc.beat / sc.beats) * 100) : 0
  return (
    <div className="sticky top-0 z-20 border-b border-line bg-surface/90 backdrop-blur">
      <div className="flex items-center gap-3 px-8 py-2">
        <span className="flex items-center gap-1.5 text-[11px] font-semibold tracking-wide text-accent uppercase">
          <Dot state="busy" pulse /> Scripted scenario
        </span>
        <span className="text-[12.5px] font-medium text-fg">{sc.title}</span>
        {sc.caption && <span className="truncate text-[12.5px] text-fg-3">· {sc.caption}</span>}
        <div className="ml-auto flex items-center gap-2">
          <span className="text-[11px] text-fg-4 tabular-nums">
            {sc.beat}/{sc.beats}
          </span>
          <div className="h-1 w-28 overflow-hidden rounded-full bg-subtle">
            <div className="h-full rounded-full bg-accent transition-all" style={{ width: `${pct}%` }} />
          </div>
          <button className="text-[11px] font-medium text-fg-3 hover:text-fg" onClick={() => void api.demo(sc.status === 'paused' ? 'resume' : 'pause')}>
            {sc.status === 'paused' ? 'Resume' : 'Pause'}
          </button>
        </div>
      </div>
    </div>
  )
}

export function App() {
  const loaded = useStore((s) => s.loaded)
  return (
    <HashRouter>
      <div className="flex h-full">
        <Sidebar />
        <main className="min-w-0 flex-1 overflow-y-auto">
          <ScenarioBanner />
          <div className="mx-auto max-w-[1280px] px-8 py-7">
            {loaded ? (
              <Routes>
                <Route path="/" element={<OverviewScreen />} />
                <Route path="/console" element={<ConsoleScreen />} />
                <Route path="/conversations" element={<ConversationsScreen />} />
                <Route path="/knowledge" element={<KnowledgeScreen />} />
                <Route path="/inbox" element={<InboxScreen />} />
                <Route path="/guardrails" element={<GuardrailsScreen />} />
                <Route path="/demo" element={<DemoScreen />} />
              </Routes>
            ) : (
              <div className="space-y-4">
                <div className="skeleton h-8 w-48" />
                <div className="grid grid-cols-4 gap-4">
                  {[0, 1, 2, 3].map((i) => (
                    <div key={i} className="skeleton h-24" />
                  ))}
                </div>
                <div className="skeleton h-80" />
              </div>
            )}
          </div>
        </main>
      </div>
      <RunDrawerHost />
      <Toasts />
    </HashRouter>
  )
}

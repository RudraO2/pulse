import clsx from 'clsx'
import { ChevronDown, Monitor, Moon, Pause, Play, Smartphone, Sparkles, Sun } from 'lucide-react'
import { useEffect, useState } from 'react'
import { HashRouter, NavLink, Route, Routes } from 'react-router'
import type { ServiceName } from '@shared/events'
import { CommandPalette } from './components/CommandPalette'
import { Heartbeat } from './components/Heartbeat'
import { PhoneDialog } from './components/PhoneDialog'
import { WhatsAppDialog } from './components/WhatsAppDialog'
import { RunDrawerHost } from './components/RunDrawer'
import { Toasts } from './components/Toasts'
import { api } from './lib/api'
import { NAV_GROUPS, openPalette, togglePalette, togglePresent, toggleTheme, usePrefs } from './lib/prefs'
import { useStore } from './lib/store'
import { Dot, PlatformIcon, PulseMark } from './ui/primitives'
import { ConsoleScreen } from './screens/Console'
import { ConversationsScreen } from './screens/Conversations'
import { DemoScreen } from './screens/Demo'
import { GuardrailsScreen } from './screens/Guardrails'
import { InboxScreen } from './screens/Inbox'
import { KnowledgeScreen } from './screens/Knowledge'
import { OverviewScreen } from './screens/Overview'

const SERVICE_LABEL: Record<ServiceName, string> = {
  telegram: 'Telegram',
  slack: 'Slack',
  whatsapp: 'WhatsApp',
  notion: 'Notion',
  resend: 'Resend',
  llm: 'LLM',
  swytchcode: 'Swytchcode',
}

/** Service health collapses to one line; details only when asked for. */
function SystemStatus() {
  const services = useStore((s) => s.services)
  const connection = useStore((s) => s.connection)
  const [open, setOpen] = useState(false)
  const keys = Object.keys(SERVICE_LABEL) as ServiceName[]
  const troubled = keys.filter((k) => services[k]?.state === 'down' || services[k]?.state === 'degraded')
  const summary = connection === 'offline' ? 'Dashboard offline' : connection === 'connecting' ? 'Connecting…' : troubled.length ? `${troubled.map((k) => SERVICE_LABEL[k]).join(', ')} ${troubled.length > 1 ? 'need' : 'needs'} attention` : 'All systems normal'
  const state = connection === 'offline' || troubled.some((k) => services[k]?.state === 'down') ? 'down' : troubled.length || connection === 'connecting' ? 'degraded' : 'up'
  return (
    <div className="side-label border-t border-line pt-3">
      <button onClick={() => setOpen((o) => !o)} aria-expanded={open} className="flex w-full items-center gap-2 rounded-md px-1.5 py-1 text-left text-[12px] text-fg-3 hover:text-fg">
        <Dot state={state} pulse={state === 'up'} />
        <span className="min-w-0 flex-1 truncate">{summary}</span>
        <ChevronDown className={clsx('size-3.5 text-fg-4 transition-transform', open && 'rotate-180')} />
      </button>
      {open && (
        <ul className="mt-1.5 animate-fade-in space-y-1 px-1.5">
          {keys.map((k) => (
            <li key={k} className="flex items-center gap-2 text-[12px] text-fg-2" title={services[k]?.detail}>
              <Dot state={services[k]?.state ?? 'disabled'} />
              <span className="flex-1">{SERVICE_LABEL[k]}</span>
              <span className="max-w-[90px] truncate text-[11px] text-fg-4">{services[k]?.state === 'up' ? services[k]?.detail ?? '' : services[k]?.state}</span>
            </li>
          ))}
          <li className="flex items-center gap-2 pt-1 text-[11px] text-fg-4">
            <Dot state={connection === 'offline' ? 'down' : connection === 'connecting' ? 'degraded' : 'up'} />
            {connection === 'sse' ? 'Live updates' : connection === 'poll' ? 'Live updates (polling)' : connection === 'offline' ? 'Reconnecting…' : 'Connecting…'}
          </li>
        </ul>
      )}
    </div>
  )
}

function Sidebar() {
  const community = useStore((s) => s.community)
  const inbox = useStore(
    (s) => s.approvals.filter((a) => a.status === 'pending').length + s.attention.filter((a) => a.status === 'open').length + s.pending.filter((p) => p.status === 'waiting').length,
  )
  return (
    <aside id="sidebar" className="flex shrink-0 items-center gap-2 overflow-x-auto border-b border-line bg-surface px-4 py-2 md:h-full md:w-[224px] md:flex-col md:items-stretch md:gap-0 md:overflow-visible md:border-r md:border-b-0 md:px-3 md:py-4">
      <div className="flex shrink-0 items-center gap-2.5 md:px-1.5 md:pb-5">
        <span className="grid size-8 shrink-0 place-items-center rounded-[9px] bg-fg text-surface">
          <PulseMark className="size-5" />
        </span>
        <div className="side-label hidden min-w-0 md:block">
          <div className="display text-[17px] leading-tight font-semibold text-fg">Pulse</div>
          <div className="truncate text-[11.5px] text-fg-3" title={community.name}>
            {community.name}
          </div>
        </div>
      </div>
      <nav className="flex shrink-0 gap-0.5 md:flex-col" aria-label="Main">
        {NAV_GROUPS.map((g, gi) => (
          <div key={g.label} className={clsx('flex gap-0.5 md:flex-col', gi > 0 && 'md:mt-3 md:border-t md:border-line md:pt-3')}>
            {g.items.map((n) => (
              <NavLink
                key={n.to}
                to={n.to}
                end={n.to === '/'}
                title={n.label}
                className={({ isActive }) =>
                  clsx(
                    'nav-item group relative flex items-center gap-2.5 rounded-lg px-2.5 py-[7px] text-[13.5px] font-medium whitespace-nowrap transition-colors',
                    isActive ? 'bg-subtle text-fg' : 'text-fg-3 hover:bg-hover hover:text-fg',
                  )
                }
              >
                {({ isActive }) => (
                  <>
                    <n.icon className={clsx('size-4 shrink-0', isActive && 'text-accent')} />
                    <span className="side-label flex-1">{n.label}</span>
                    {n.badge === 'inbox' && inbox > 0 && (
                      <span className="grid h-[18px] min-w-5 place-items-center rounded-full bg-accent px-1.5 text-[11px] font-semibold text-accent-fg tabular-nums">{inbox}</span>
                    )}
                  </>
                )}
              </NavLink>
            ))}
          </div>
        ))}
      </nav>
      <div className="mt-auto hidden md:block">
        <SystemStatus />
      </div>
    </aside>
  )
}

function TopBar() {
  const { dark, present } = usePrefs()
  const [phone, setPhone] = useState(false)
  const [whatsapp, setWhatsapp] = useState(false)
  const devices = useStore((s) => s.notify.devices)
  const wa = useStore((s) => s.whatsapp)
  return (
    <header className="sticky top-0 z-20 border-b border-line bg-bg/85 backdrop-blur-md">
      <div className="flex items-center gap-3 px-4 py-2.5 md:px-6 xl:px-8">
        <button
          onClick={openPalette}
          className="flex h-[38px] max-w-[560px] min-w-0 flex-1 items-center gap-2.5 rounded-[10px] border border-line bg-surface pr-2 pl-3 text-left text-[13.5px] text-fg-4 transition-[border-color,box-shadow] hover:border-line-strong hover:shadow-[var(--shadow)]"
          aria-label="Ask Pulse or jump to a page"
        >
          <Sparkles className="size-4 shrink-0 text-accent" />
          <span className="min-w-0 flex-1 truncate">Ask Pulse…</span>
          <span className="hidden items-center gap-1 sm:flex">
            <kbd className="kbd">Ctrl</kbd>
            <kbd className="kbd">K</kbd>
          </span>
        </button>
        <div className="ml-auto flex items-center gap-1">
          <Heartbeat />
          <button onClick={() => setWhatsapp(true)} className="relative ml-2 grid size-[34px] place-items-center rounded-lg text-fg-3 hover:bg-hover hover:text-fg" aria-label="WhatsApp" title={wa.status === 'connected' ? `WhatsApp: ${wa.groups.filter((g) => g.enabled).length} group(s) on` : 'Link WhatsApp'}>
            <PlatformIcon platform="whatsapp" className={clsx('size-4', wa.status !== 'connected' && 'opacity-50 grayscale')} />
          </button>
          <button onClick={() => setPhone(true)} className="relative grid size-[34px] place-items-center rounded-lg text-fg-3 hover:bg-hover hover:text-fg" aria-label="Pulse on your phone" title="Pulse on your phone">
            <Smartphone className="size-4" />
            {devices > 0 && <span className="absolute top-[7px] right-[8px] size-1.5 rounded-full bg-ok" />}
          </button>
          <button onClick={togglePresent} aria-pressed={present} className={clsx('hidden size-[34px] place-items-center rounded-lg md:grid', present ? 'bg-accent-soft text-accent' : 'text-fg-3 hover:bg-hover hover:text-fg')} aria-label="Presenter mode" title="Presenter mode (P)">
            <Monitor className="size-4" />
          </button>
          <button onClick={toggleTheme} className="grid size-[34px] place-items-center rounded-lg text-fg-3 hover:bg-hover hover:text-fg" aria-label={dark ? 'Light theme' : 'Dark theme'} title={dark ? 'Light theme' : 'Dark theme'}>
            {dark ? <Sun className="size-4" /> : <Moon className="size-4" />}
          </button>
        </div>
      </div>
      <ScenarioBanner />
      {phone && <PhoneDialog onClose={() => setPhone(false)} />}
      {whatsapp && <WhatsAppDialog onClose={() => setWhatsapp(false)} />}
    </header>
  )
}

function ScenarioBanner() {
  const sc = useStore((s) => s.scenario)
  if (sc.status !== 'running' && sc.status !== 'paused') return null
  const pct = sc.beats ? Math.round((sc.beat / sc.beats) * 100) : 0
  return (
    <div className="flex items-center gap-3 border-t border-line bg-accent-soft px-4 py-2 md:px-6 xl:px-8">
      <span className="inline-flex h-5 shrink-0 items-center gap-1.5 rounded-md bg-accent px-1.5 text-[11px] font-semibold text-accent-fg">
        <span className="size-1.5 animate-pulse-dot rounded-full bg-current" /> Scripted
      </span>
      <span className="hidden shrink-0 text-[13px] font-medium text-fg sm:inline">{sc.title}</span>
      <span className="min-w-0 flex-1 truncate text-[13px] text-fg-2">{sc.caption ?? ''}</span>
      <span className="text-[12px] text-fg-3 tabular-nums">
        {sc.beat}/{sc.beats}
      </span>
      <div className="hidden h-1 w-28 overflow-hidden rounded-full bg-line sm:block">
        <div className="h-full rounded-full bg-accent transition-all duration-500" style={{ width: `${pct}%` }} />
      </div>
      <button className="flex items-center gap-1 text-[12px] font-medium text-fg-2 hover:text-fg" onClick={() => void api.demo(sc.status === 'paused' ? 'resume' : 'pause')}>
        {sc.status === 'paused' ? <Play className="size-3" /> : <Pause className="size-3" />}
        {sc.status === 'paused' ? 'Resume' : 'Pause'}
      </button>
    </div>
  )
}

/** Ctrl+K opens the palette anywhere; `/` and `P` work when you're not typing. */
function useGlobalKeys() {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'k') {
        e.preventDefault()
        togglePalette()
        return
      }
      const el = document.activeElement
      const typing = el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement || (el as HTMLElement | null)?.isContentEditable
      if (typing || e.ctrlKey || e.metaKey || e.altKey || document.querySelector('[role="dialog"]')) return
      if (e.key === '/') {
        e.preventDefault()
        openPalette()
      } else if (e.key.toLowerCase() === 'p') {
        togglePresent()
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [])
}

export function App() {
  const loaded = useStore((s) => s.loaded)
  useGlobalKeys()
  return (
    <HashRouter>
      <div id="shell" className="flex h-full flex-col md:flex-row">
        <Sidebar />
        <main className="min-h-0 min-w-0 flex-1 overflow-y-auto">
          <TopBar />
          <div className="px-4 pt-5 pb-10 md:px-6 xl:px-8">
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
                <div className="skeleton h-9 w-96 max-w-full" />
                <div className="skeleton h-24" />
                <div className="grid gap-5 lg:grid-cols-[minmax(0,1fr)_340px]">
                  <div className="skeleton h-80" />
                  <div className="skeleton h-80" />
                </div>
              </div>
            )}
          </div>
        </main>
      </div>
      <RunDrawerHost />
      <CommandPalette />
      <Toasts />
    </HashRouter>
  )
}

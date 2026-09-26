import clsx from 'clsx'
import { BellRing, CircleCheck, Download, HeartPulse, Inbox, Moon, Settings, Smartphone, Sparkles, Sun } from 'lucide-react'
import { useEffect, useState, type ReactNode } from 'react'
import { HashRouter, NavLink, Route, Routes, useParams } from 'react-router'
import { Toasts } from '../components/Toasts'
import { api } from '../lib/api'
import { toggleTheme, usePrefs } from '../lib/prefs'
import { store, useStore } from '../lib/store'
import { Dot, PulseMark } from '../ui/primitives'
import { AskScreen } from './Ask'
import { ApprovalItem, BigButton, QuestionItem } from './items'
import { MemberItem } from './Member'
import { PeopleScreen, PersonScreen } from './People'
import { enablePush, isStandalone, useInstall, usePushStatus, type PushStatus } from './push'

// Pulse on the phone: "Needs you" (approve, answer, reply, resolve), the
// people Pulse is following, and the Console. Minimal on purpose: one thumb.

function useNeedsYou() {
  const approvals = useStore((s) => s.approvals.filter((a) => a.status === 'pending'))
  const attention = useStore((s) => s.attention.filter((a) => a.status === 'open'))
  const pending = useStore((s) => s.pending.filter((p) => p.status === 'waiting'))
  return { approvals, attention, pending, count: approvals.length + attention.length + pending.length }
}

function NeedsYouScreen() {
  const { id } = useParams()
  const cases = useStore((s) => s.cases)
  const all = useStore((s) => s)
  const { approvals, attention, pending, count } = useNeedsYou()
  const [push] = usePushStatus()

  // Deep link from a notification or email: bring that item into view.
  useEffect(() => {
    if (id) setTimeout(() => document.getElementById(`item-${id}`)?.scrollIntoView({ behavior: 'smooth', block: 'start' }), 150)
  }, [id])
  const stale = id && !approvals.some((a) => a.id === id) && !attention.some((a) => a.id === id) && !pending.some((p) => p.id === id)
  const staleWhat = stale ? all.approvals.find((a) => a.id === id)?.title ?? all.attention.find((a) => a.id === id)?.userName ?? all.pending.find((p) => p.id === id)?.question : undefined

  // Urgent first: upset members, then approvals, then questions.
  const members = [...attention].sort((a, b) => Number(a.kind === 'ignored') - Number(b.kind === 'ignored') || b.ts - a.ts)
  return (
    <div className="animate-fade-in">
      <h1 className="display text-[28px] leading-tight font-semibold text-fg">{count ? `${count} thing${count === 1 ? '' : 's'} need${count === 1 ? 's' : ''} you` : 'All clear'}</h1>
      <p className="mt-1 text-[13.5px] text-fg-3">{count ? 'Upset members first, then approvals and questions.' : "Pulse is looking after the community. You'll get a notification when something needs you."}</p>

      {stale && (
        <div className="mt-4 flex items-center gap-2.5 rounded-[12px] border border-line bg-surface px-3.5 py-3 text-[13.5px] text-fg-2">
          <CircleCheck className="size-4 shrink-0 text-ok" />
          <span className="min-w-0 truncate">Already handled{staleWhat ? `: ${staleWhat}` : ''}</span>
        </div>
      )}

      {push && push !== 'on' && push !== 'unsupported' && (
        <NavLink to="/settings" className="mt-4 flex items-center gap-3 rounded-[12px] border border-accent-line bg-accent-soft px-3.5 py-3">
          <BellRing className="size-4.5 shrink-0 text-accent" />
          <span className="flex-1 text-[13.5px] font-medium text-fg">Turn on notifications</span>
          <span className="text-[12.5px] text-accent">Set up</span>
        </NavLink>
      )}

      {count > 0 ? (
        <ul className="mt-5 grid gap-3">
          {members.map((m) => (
            <MemberItem key={m.id} m={m} c={m.caseId ? cases.find((c) => c.id === m.caseId) : undefined} focused={m.id === id} />
          ))}
          {approvals.map((a) => (
            <ApprovalItem key={a.id} a={a} focused={a.id === id} />
          ))}
          {pending.map((p) => (
            <QuestionItem key={p.id} p={p} focused={p.id === id} />
          ))}
        </ul>
      ) : (
        <div className="mt-14 grid place-items-center">
          <span className="grid size-14 place-items-center rounded-2xl bg-ok-soft text-ok">
            <CircleCheck className="size-6" />
          </span>
        </div>
      )}
    </div>
  )
}

const PUSH_TEXT: Record<PushStatus, string> = {
  on: 'On. Approve and resolve right from the notification.',
  default: 'Get a notification the moment something needs you.',
  denied: 'Blocked. Allow notifications for this site in your browser settings.',
  unsupported: 'This browser has no web push. On iPhone, add Pulse to the Home Screen first.',
  insecure: 'Needs the secure (https) link from the dashboard QR.',
}

function Row({ icon, title, children }: { icon: ReactNode; title: string; children: ReactNode }) {
  return (
    <li className="flex gap-3 px-4 py-3.5">
      <span className="mt-0.5 text-fg-3">{icon}</span>
      <div className="min-w-0 flex-1">
        <div className="text-[14.5px] font-medium text-fg">{title}</div>
        <div className="mt-0.5 text-[13px] text-fg-3">{children}</div>
      </div>
    </li>
  )
}

function SettingsScreen() {
  const [push, setPush] = usePushStatus()
  const [busy, setBusy] = useState(false)
  const { canInstall, install } = useInstall()
  const notify = useStore((s) => s.notify)
  const community = useStore((s) => s.community.name)
  const { dark } = usePrefs()
  const ios = /iphone|ipad/i.test(navigator.userAgent)
  return (
    <div className="animate-fade-in">
      <h1 className="display text-[28px] leading-tight font-semibold text-fg">Settings</h1>
      <p className="mt-1 truncate text-[13.5px] text-fg-3">{community}</p>
      <ul className="card mt-5 divide-y divide-line overflow-hidden">
        <Row icon={<BellRing className="size-4.5" />} title="Notifications">
          {push ? PUSH_TEXT[push] : '…'}
          <div className="mt-2.5 flex gap-2">
            {push === 'default' && (
              <BigButton
                tone="go"
                loading={busy}
                onClick={async () => {
                  setBusy(true)
                  const s = await enablePush()
                  setPush(s)
                  setBusy(false)
                  if (s === 'on') store.toast('ok', 'Notifications on')
                }}
              >
                Turn on
              </BigButton>
            )}
            {push === 'on' && (
              <BigButton
                onClick={async () => {
                  const r = await api.pushTest()
                  if (r) store.toast('ok', r.sent ? 'Test sent' : 'No phone registered yet')
                }}
              >
                Send a test
              </BigButton>
            )}
          </div>
        </Row>
        {!isStandalone() && (
          <Row icon={<Download className="size-4.5" />} title="Install">
            {canInstall ? 'Add Pulse to your home screen.' : ios ? 'Tap Share, then “Add to Home Screen”.' : 'Use your browser menu: “Install app” / “Add to Home screen”.'}
            {canInstall && (
              <div className="mt-2.5">
                <BigButton tone="go" onClick={() => void install()}>
                  Install Pulse
                </BigButton>
              </div>
            )}
          </Row>
        )}
        <Row icon={<Inbox className="size-4.5" />} title="Email">
          {notify.email ? `${notify.emailTo}: urgent right away, the rest bundled.` : 'Off'}
        </Row>
        <li>
          <button onClick={toggleTheme} className="flex w-full items-center gap-3 px-4 py-3.5 text-left active:bg-hover">
            <span className="text-fg-3">{dark ? <Sun className="size-4.5" /> : <Moon className="size-4.5" />}</span>
            <span className="flex-1 text-[14.5px] font-medium text-fg">{dark ? 'Light theme' : 'Dark theme'}</span>
          </button>
        </li>
      </ul>
      <button
        onClick={() => {
          localStorage.removeItem('pulse.token')
          location.reload()
        }}
        className="mt-5 w-full text-center text-[13px] font-medium text-fg-4"
      >
        Unpair this phone
      </button>
    </div>
  )
}

function Pair() {
  return (
    <div className="grid min-h-full place-items-center px-8 text-center">
      <div>
        <span className="mx-auto grid size-14 place-items-center rounded-2xl bg-fg text-surface">
          <PulseMark className="size-8" />
        </span>
        <h1 className="display mt-5 text-[26px] font-semibold text-fg">Pair your phone</h1>
        <p className="mt-2 text-[14px] leading-relaxed text-fg-3">
          On the Pulse dashboard, tap the <Smartphone className="inline size-4 align-[-3px]" /> phone icon in the top bar and scan the QR code.
        </p>
      </div>
    </div>
  )
}

function TabLink({ to, icon, label, badge }: { to: string; icon: ReactNode; label: string; badge?: number }) {
  return (
    <NavLink to={to} end={to === '/'} className={({ isActive }) => clsx('relative flex flex-1 flex-col items-center gap-0.5 pt-2 pb-1.5 text-[11px] font-medium', isActive ? 'text-accent' : 'text-fg-3')}>
      <span className="relative">
        {icon}
        {!!badge && <span className="absolute -top-1.5 -right-2.5 grid h-[17px] min-w-[17px] place-items-center rounded-full bg-accent px-1 text-[10.5px] font-semibold text-accent-fg tabular-nums">{badge}</span>}
      </span>
      {label}
    </NavLink>
  )
}

function Shell() {
  const connection = useStore((s) => s.connection)
  const loaded = useStore((s) => s.loaded)
  const { count } = useNeedsYou()

  useEffect(() => {
    document.title = count ? `(${count}) Pulse` : 'Pulse'
    const nav = navigator as Navigator & { setAppBadge?: (n: number) => Promise<void>; clearAppBadge?: () => Promise<void> }
    if (count) void nav.setAppBadge?.(count).catch(() => undefined)
    else void nav.clearAppBadge?.().catch(() => undefined)
  }, [count])

  if (connection === 'locked') return <Pair />
  return (
    <div className="flex h-full flex-col">
      <header className="sticky top-0 z-20 border-b border-line bg-bg/85 pt-[env(safe-area-inset-top)] backdrop-blur-md">
        <div className="flex h-12 items-center gap-2.5 px-4">
          <span className="grid size-7 place-items-center rounded-[8px] bg-fg text-surface">
            <PulseMark className="size-4.5" />
          </span>
          <span className="display text-[17px] font-semibold text-fg">Pulse</span>
          <span className="ml-auto flex items-center gap-1.5 text-[12px] text-fg-3">
            <Dot state={connection === 'offline' ? 'down' : connection === 'connecting' ? 'degraded' : 'up'} pulse={connection === 'sse' || connection === 'poll'} />
            {connection === 'offline' ? 'Offline' : connection === 'connecting' ? 'Connecting' : 'Live'}
          </span>
          <NavLink to="/settings" className={({ isActive }) => clsx('-mr-1.5 grid size-9 place-items-center rounded-lg', isActive ? 'text-accent' : 'text-fg-3')} aria-label="Settings">
            <Settings className="size-4.5" />
          </NavLink>
        </div>
      </header>
      <main className="min-h-0 flex-1 overflow-y-auto px-4 pt-5 pb-[calc(84px+env(safe-area-inset-bottom))]">
        {loaded ? (
          <Routes>
            <Route path="/" element={<NeedsYouScreen />} />
            <Route path="/i/:id" element={<NeedsYouScreen />} />
            <Route path="/people" element={<PeopleScreen />} />
            <Route path="/people/:id" element={<PersonScreen />} />
            <Route path="/ask" element={<AskScreen />} />
            <Route path="/settings" element={<SettingsScreen />} />
            <Route path="*" element={<NeedsYouScreen />} />
          </Routes>
        ) : (
          <div className="space-y-3">
            <div className="skeleton h-9 w-56" />
            <div className="skeleton h-40" />
            <div className="skeleton h-40" />
          </div>
        )}
      </main>
      <nav className="fixed inset-x-0 bottom-0 z-20 flex border-t border-line bg-surface/95 pb-[env(safe-area-inset-bottom)] backdrop-blur-md" aria-label="Main">
        <TabLink to="/" icon={<Inbox className="size-5" />} label="Needs you" badge={count} />
        <TabLink to="/people" icon={<HeartPulse className="size-5" />} label="People" />
        <TabLink to="/ask" icon={<Sparkles className="size-5" />} label="Ask" />
      </nav>
      <Toasts className="inset-x-4 bottom-[calc(76px+env(safe-area-inset-bottom))] mx-auto" />
    </div>
  )
}

export function MobileApp() {
  return (
    <HashRouter>
      <Shell />
    </HashRouter>
  )
}


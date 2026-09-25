import { useSyncExternalStore } from 'react'
import type { SequencedEvent, StateSnapshot } from '@shared/events'
import { applyEvent, hydrate, initialState, pushToast, type ClientState, type Connection, type Toast } from './reducer'

// Tiny external store: the transport pushes snapshots/events in,
// React components subscribe via useSyncExternalStore.

type Listener = () => void

let state: ClientState = initialState()
const listeners = new Set<Listener>()

// Coalesce bursts of events into one React render per animation frame.
let scheduled = false
function notify(): void {
  if (scheduled) return
  scheduled = true
  requestAnimationFrame(() => {
    scheduled = false
    for (const l of listeners) l()
  })
}

export const store = {
  get: (): ClientState => state,
  subscribe(l: Listener): () => void {
    listeners.add(l)
    return () => listeners.delete(l)
  },
  hydrate(snap: StateSnapshot): void {
    state = hydrate(state, snap)
    notify()
  },
  apply(ev: SequencedEvent): void {
    state = applyEvent(state, ev)
    notify()
  },
  applyMany(evs: SequencedEvent[]): void {
    for (const ev of evs) state = applyEvent(state, ev)
    notify()
  },
  setConnection(c: Connection): void {
    if (state.connection === c) return
    state = { ...state, connection: c }
    notify()
  },
  toast(tone: Toast['tone'], text: string): void {
    state = pushToast(state, tone, text)
    notify()
  },
  dismissToast(id: number): void {
    state = { ...state, toasts: state.toasts.filter((t) => t.id !== id) }
    notify()
  },
  reset(): void {
    state = initialState()
    notify()
  },
}

/**
 * Subscribe to the whole (immutable) state and select during render. The
 * snapshot is always the same object between notifications, so selectors may
 * freely return derived arrays without breaking useSyncExternalStore.
 */
export function useStore<T>(selector: (s: ClientState) => T): T {
  const snap = useSyncExternalStore(store.subscribe, () => state, () => state)
  return selector(snap)
}

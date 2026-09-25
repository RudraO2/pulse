import { EventEmitter } from 'node:events'
import type { GtEvent, SequencedEvent } from './shared/events.js'

// Single process-wide event bus (same idea as the WhatsApp bot's state.ts `bus`).
// Everything observable goes through `emit()` so the dashboard, the event log
// and the replay recorder all see the exact same stream.

type Listener = (ev: SequencedEvent) => void

class Bus {
  private ee = new EventEmitter()
  private seq = 0

  constructor() {
    this.ee.setMaxListeners(100)
  }

  /** Distributive Omit so each union member keeps its own fields. */
  emit(ev: DistributiveOmit<GtEvent, 'ts'> & { ts?: number }): SequencedEvent {
    const full = { ts: Date.now(), ...ev, seq: ++this.seq } as SequencedEvent
    this.ee.emit('event', full)
    return full
  }

  /** Re-emit an already-sequenced event (replay). Keeps seq monotonic. */
  emitRaw(ev: GtEvent): SequencedEvent {
    const full = { ...ev, seq: ++this.seq } as SequencedEvent
    this.ee.emit('event', full)
    return full
  }

  on(listener: Listener): () => void {
    this.ee.on('event', listener)
    return () => this.ee.off('event', listener)
  }

  get currentSeq(): number {
    return this.seq
  }

  /** Restore the sequence counter after hydrating from the event log. */
  setSeq(n: number): void {
    if (n > this.seq) this.seq = n
  }
}

export type DistributiveOmit<T, K extends PropertyKey> = T extends unknown ? Omit<T, K> : never

export const bus = new Bus()

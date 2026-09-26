import type { GtEvent, SequencedEvent, StateSnapshot } from '@shared/events'
import { store } from './store'

// Live transport: SSE first, automatic fallback to long-polling.
//  • Cloudflare quick tunnels (and some proxies) buffer SSE, so a stream that
//    never delivers its `hello` within HELLO_TIMEOUT_MS is treated as broken.
//  • Two SSE errors in a row → switch to polling for good (this session).
//  • Both paths resume from the last seen `seq`; the reducer dedupes overlap.

const HELLO_TIMEOUT_MS = 8_000
const POLL_BACKOFF_MAX_MS = 15_000

const EVENT_TYPES: GtEvent['type'][] = [
  'message.in',
  'message.out',
  'run.start',
  'run.step',
  'run.end',
  'swy.call',
  'guardrail',
  'kb',
  'approval',
  'attention',
  'pending',
  'status',
  'selftest',
  'digest',
  'scenario',
  'case',
  'notify',
  'log',
]

/** The admin token (phone app / tunnel): reads need it too when you're not on the Pulse laptop. */
const token = () => localStorage.getItem('pulse.token') ?? ''
const withToken = (url: string) => (token() ? `${url}${url.includes('?') ? '&' : '?'}token=${encodeURIComponent(token())}` : url)

export class LiveTransport {
  private es: EventSource | null = null
  private sseErrors = 0
  private helloTimer: ReturnType<typeof setTimeout> | null = null
  private polling = false
  private stopped = false
  private pollAbort: AbortController | null = null

  constructor(private base = '') {}

  /** Returns false when the server is unreachable. */
  async start(): Promise<boolean> {
    const ok = await this.hydrate()
    if (!ok) return false
    this.connectSse()
    // Counters and durable lists are computed server-side: refresh them quietly.
    setInterval(() => void this.hydrate(), 15_000)
    return true
  }

  stop(): void {
    this.stopped = true
    this.es?.close()
    this.pollAbort?.abort()
    if (this.helloTimer) clearTimeout(this.helloTimer)
  }

  async hydrate(): Promise<boolean> {
    try {
      const res = await fetch(withToken(`${this.base}/api/state`), { cache: 'no-store' })
      if (res.status === 401) {
        store.setConnection('locked')
        return false
      }
      if (!res.ok) return false
      const ct = res.headers.get('content-type') ?? ''
      if (!ct.includes('json')) return false
      const snap = (await res.json()) as StateSnapshot
      store.hydrate(snap)
      return true
    } catch {
      return false
    }
  }

  private onEvent = (e: MessageEvent<string>): void => {
    try {
      const ev = JSON.parse(e.data) as SequencedEvent
      if (ev && typeof ev === 'object' && 'type' in ev) store.apply(ev)
    } catch {
      /* ignore malformed frames */
    }
  }

  private connectSse(): void {
    if (this.stopped || this.polling) return
    store.setConnection('connecting')
    const since = store.get().seq
    const es = new EventSource(withToken(`${this.base}/api/events?since=${since}`))
    this.es = es

    this.helloTimer = setTimeout(() => {
      // stream is open but buffered (tunnel) → poll instead
      if (this.es === es) {
        es.close()
        this.startPolling()
      }
    }, HELLO_TIMEOUT_MS)

    es.addEventListener('hello', () => {
      if (this.helloTimer) clearTimeout(this.helloTimer)
      this.sseErrors = 0
      store.setConnection('sse')
    })
    for (const t of EVENT_TYPES) es.addEventListener(t, this.onEvent as EventListener)
    es.onmessage = this.onEvent

    es.onerror = () => {
      this.sseErrors++
      if (this.sseErrors >= 2) {
        es.close()
        if (this.helloTimer) clearTimeout(this.helloTimer)
        this.startPolling()
      } else {
        store.setConnection('connecting')
      }
    }
  }

  private async startPolling(): Promise<void> {
    if (this.polling || this.stopped) return
    this.polling = true
    store.setConnection('poll')
    let backoff = 1_000
    while (!this.stopped) {
      this.pollAbort = new AbortController()
      try {
        const since = store.get().seq
        const res = await fetch(withToken(`${this.base}/api/events/poll?since=${since}`), {
          cache: 'no-store',
          signal: this.pollAbort.signal,
        })
        if (!res.ok) throw new Error(String(res.status))
        const body = (await res.json()) as { events: SequencedEvent[]; seq: number }
        if (body.events?.length) store.applyMany(body.events)
        store.setConnection('poll')
        backoff = 1_000
        // server long-polls; if it returned instantly with nothing, pace ourselves
        if (!body.events?.length) await sleep(1_500)
      } catch {
        if (this.stopped) return
        store.setConnection('offline')
        await sleep(backoff)
        backoff = Math.min(backoff * 2, POLL_BACKOFF_MAX_MS)
        // try to re-hydrate after an outage so we don't miss dropped history
        await this.hydrate()
      }
    }
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms))
}

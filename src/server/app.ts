import fs from 'node:fs'
import path from 'node:path'
import type { AddressInfo } from 'node:net'
import { Hono, type Context } from 'hono'
import { bodyLimit } from 'hono/body-limit'
import { createAdaptorServer } from '@hono/node-server'
import { serveStatic } from '@hono/node-server/serve-static'
import { bus } from '../bus.js'
import type { StateStore } from './state.js'
import type { SequencedEvent } from '../shared/events.js'

// HTTP surface: dashboard state, the live event stream (SSE + a long-poll
// fallback for proxies that buffer SSE, e.g. Cloudflare quick tunnels), the
// Agent Console, operator actions, and the built SPA.
// Ported from the WhatsApp bot's server.ts (sseSend / ping / /api/state).

export interface AppHandlers {
  onConsole?: (text: string, about?: { kind: 'member'; id: string }) => Promise<unknown>
  onApproval?: (id: string, decision: 'approve' | 'reject', by: string) => Promise<unknown>
  onResolveAttention?: (id: string) => Promise<unknown>
  onDigest?: () => Promise<unknown>
  onSelftest?: () => Promise<unknown>
  onSweep?: () => Promise<unknown>
  onKbSync?: () => Promise<unknown>
  guardrails?: () => Promise<unknown>
  audit?: () => Promise<unknown>
  scenarios?: () => unknown
  // phone app
  onCaseResolve?: (id: string, by: string) => Promise<unknown>
  onCaseReply?: (id: string, text: string) => Promise<unknown>
  onAnswerPending?: (id: string, text: string) => Promise<unknown>
  /** phone pairing link (contains the admin token: only served to this laptop) */
  pair?: () => Promise<unknown>
  push?: {
    key: () => string
    subscribe: (sub: unknown, ua?: string) => Promise<unknown>
    unsubscribe: (endpoint: string) => Promise<unknown>
    test: () => Promise<unknown>
  }
  /** notification buttons: signed per item, no token needed */
  quick?: (id: string, action: string, sig: string) => Promise<{ ok: boolean; error?: string; status?: number } & Record<string, unknown>>
  whatsapp?: {
    link: () => Promise<unknown>
    logout: () => Promise<unknown>
    refresh: () => Promise<unknown>
    setGroup: (jid: string, enabled: boolean) => Promise<unknown>
    setDms: (enabled: boolean) => Promise<unknown>
  }
  onDemo?: (action: 'play' | 'pause' | 'resume' | 'stop' | 'reset' | 'speed', body: Record<string, unknown>) => Promise<unknown>
}

export interface AppOptions extends AppHandlers {
  store: StateStore
  /** directory with the built dashboard (index.html + assets) */
  webRoot?: string
  /** if set, operator actions (and, from outside this laptop, reads) require this token */
  adminToken?: string | (() => string | undefined)
  pollTimeoutMs?: number
  pingMs?: number
}

const SSE_HEADERS = {
  'Content-Type': 'text/event-stream; charset=utf-8',
  'Cache-Control': 'no-store, no-transform',
  Connection: 'keep-alive',
  'X-Accel-Buffering': 'no',
}

export function formatSse(ev: SequencedEvent): string {
  return `id: ${ev.seq}\nevent: ${ev.type}\ndata: ${JSON.stringify(ev)}\n\n`
}

/**
 * A request made on this laptop (not through the tunnel or a proxy). cloudflared
 * connects from localhost too, but always adds cf-* / x-forwarded-for headers.
 */
export function isLocal(c: Context): boolean {
  if (c.req.header('cf-connecting-ip') || c.req.header('cf-ray') || c.req.header('x-forwarded-for') || c.req.header('x-real-ip')) return false
  const addr = (c.env as { incoming?: { socket?: { remoteAddress?: string } } } | undefined)?.incoming?.socket?.remoteAddress ?? ''
  return addr === '127.0.0.1' || addr === '::1' || addr === '::ffff:127.0.0.1'
}

function clientId(c: Context): string {
  return (
    c.req.header('x-forwarded-for')?.split(',')[0]?.trim() ||
    c.req.header('cf-connecting-ip') ||
    c.req.header('x-real-ip') ||
    'local'
  )
}

export function createApp(opts: AppOptions): Hono {
  const { store } = opts
  const app = new Hono()
  const startedAt = Date.now()
  const pollTimeout = opts.pollTimeoutMs ?? 25_000
  const pingMs = opts.pingMs ?? 20_000
  const webRoot = opts.webRoot ?? path.resolve('dist', 'web')

  app.onError((err, c) => {
    console.error('[HTTP]', err)
    return c.json({ error: String(err?.message || err) }, 500)
  })

  app.use('/api/*', bodyLimit({ maxSize: 64 * 1024, onError: c => c.json({ error: 'body too large' }, 413) }))

  const expected = () => (typeof opts.adminToken === 'function' ? opts.adminToken() : opts.adminToken)
  const authorized = (c: Context) => {
    const want = expected()
    if (!want || isLocal(c)) return true
    return (c.req.header('x-admin-token') || c.req.query('token')) === want
  }
  const requireAdmin = async (c: Context, next: () => Promise<void>) => {
    if (!authorized(c)) return c.json({ error: 'admin token required' }, 401)
    await next()
  }
  // Community messages and approvals are private: from outside this laptop, reads need the token too.
  const requireReader = requireAdmin
  const requireLocal = async (c: Context, next: () => Promise<void>) => {
    if (!isLocal(c)) return c.json({ error: 'only available on the Pulse laptop' }, 403)
    await next()
  }

  async function readJson(c: Context): Promise<Record<string, unknown>> {
    try {
      const body = await c.req.json()
      return body && typeof body === 'object' ? (body as Record<string, unknown>) : {}
    } catch {
      return {}
    }
  }

  // ── health + state ────────────────────────────────────────────────────────

  app.get('/healthz', c => c.json({ ok: true, uptime: Math.round((Date.now() - startedAt) / 1000), seq: bus.currentSeq }))

  app.get('/api/state', requireReader, c => {
    c.header('Cache-Control', 'no-store')
    return c.json(store.snapshot())
  })

  // ── live stream (SSE) ─────────────────────────────────────────────────────

  app.get('/api/events', requireReader, c => {
    const resumeRaw = c.req.header('Last-Event-ID') ?? c.req.query('since')
    const resumeFrom = resumeRaw !== undefined && resumeRaw !== '' ? Number(resumeRaw) : NaN
    const enc = new TextEncoder()
    let cleanup = () => {}

    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        let closed = false
        const send = (s: string) => {
          if (closed) return
          try {
            controller.enqueue(enc.encode(s))
          } catch {
            cleanup()
          }
        }
        send(`retry: 3000\nevent: hello\ndata: ${JSON.stringify({ seq: bus.currentSeq })}\n\n`)
        // Resume: replay what the client missed while it was reconnecting
        if (Number.isFinite(resumeFrom)) for (const ev of store.eventsSince(resumeFrom)) send(formatSse(ev))
        const unsubscribe = bus.on(ev => send(formatSse(ev)))
        const ping = setInterval(() => send(': ping\n\n'), pingMs)
        cleanup = () => {
          if (closed) return
          closed = true
          clearInterval(ping)
          unsubscribe()
          try { controller.close() } catch { /* already closed */ }
        }
        c.req.raw.signal?.addEventListener('abort', () => cleanup(), { once: true })
      },
      cancel() {
        cleanup()
      },
    })
    return new Response(stream, { headers: SSE_HEADERS })
  })

  // ── long-poll fallback ────────────────────────────────────────────────────

  app.get('/api/events/poll', requireReader, async c => {
    const since = Number(c.req.query('since') ?? 0)
    const timeout = Math.min(Number(c.req.query('timeout') ?? pollTimeout), pollTimeout)
    if (!Number.isFinite(since)) return c.json({ error: 'since must be a number' }, 400)
    const events = await store.waitForEvents(since, Number.isFinite(timeout) ? timeout : pollTimeout, c.req.raw.signal)
    c.header('Cache-Control', 'no-store')
    return c.json({ seq: events.length ? events[events.length - 1]!.seq : Math.max(since, 0), events })
  })

  // ── operator actions ──────────────────────────────────────────────────────

  const consoleHits = new Map<string, number[]>()
  const call = async (fn: (() => Promise<unknown>) | undefined, c: Context): Promise<Response> => (fn ? c.json((await fn()) ?? { ok: true }) : c.json({ error: 'not available' }, 503))

  app.post('/api/console', requireAdmin, async c => {
    if (!opts.onConsole) return c.json({ error: 'console not available' }, 503)
    const body = await readJson(c)
    const text = typeof body.text === 'string' ? body.text.trim() : ''
    if (!text) return c.json({ error: 'text required' }, 400)
    if (text.length > 2000) return c.json({ error: 'request too long (max 2000 chars)' }, 400)
    const who = clientId(c)
    const now = Date.now()
    const hits = (consoleHits.get(who) ?? []).filter(t => now - t < 60_000)
    if (hits.length >= 10) return c.json({ error: 'slow down, try again in a minute' }, 429)
    consoleHits.set(who, [...hits, now])
    const about = body.about && typeof body.about === 'object' && typeof (body.about as { id?: unknown }).id === 'string' ? { kind: 'member' as const, id: String((body.about as { id: string }).id) } : undefined
    return c.json((await opts.onConsole(text, about)) ?? { ok: true })
  })

  app.post('/api/approvals/:id', requireAdmin, async c => {
    if (!opts.onApproval) return c.json({ error: 'not available' }, 503)
    const body = await readJson(c)
    const decision = body.decision === 'reject' ? 'reject' : 'approve'
    return c.json((await opts.onApproval((c.req.param('id') ?? ''), decision, 'Organizer (dashboard)')) ?? { ok: true })
  })

  app.post('/api/attention/:id/resolve', requireAdmin, async c => call(opts.onResolveAttention && (() => opts.onResolveAttention!((c.req.param('id') ?? ''))), c))
  app.post('/api/digest', requireAdmin, c => call(opts.onDigest, c))
  app.post('/api/selftest', requireAdmin, c => call(opts.onSelftest, c))
  app.post('/api/sweep', requireAdmin, c => call(opts.onSweep, c))
  app.post('/api/kb/sync', requireAdmin, c => call(opts.onKbSync, c))
  app.get('/api/guardrails', requireReader, c => call(opts.guardrails, c))

  // ── WhatsApp (linked device) ──────────────────────────────────────────────
  app.post('/api/whatsapp/link', requireAdmin, c => call(opts.whatsapp?.link, c))
  app.post('/api/whatsapp/logout', requireAdmin, c => call(opts.whatsapp?.logout, c))
  app.post('/api/whatsapp/refresh', requireAdmin, c => call(opts.whatsapp?.refresh, c))
  app.post('/api/whatsapp/groups', requireAdmin, async c => {
    const body = await readJson(c)
    if (typeof body.jid !== 'string' || !body.jid.endsWith('@g.us')) return c.json({ error: 'group jid required' }, 400)
    return call(opts.whatsapp && (() => opts.whatsapp!.setGroup(String(body.jid), body.enabled === true)), c)
  })
  app.post('/api/whatsapp/dms', requireAdmin, async c => {
    const body = await readJson(c)
    return call(opts.whatsapp && (() => opts.whatsapp!.setDms(body.enabled === true)), c)
  })
  app.get('/api/audit', requireReader, c => call(opts.audit, c))

  // ── phone app ─────────────────────────────────────────────────────────────

  const textBody = async (c: Context): Promise<string> => {
    const body = await readJson(c)
    return typeof body.text === 'string' ? body.text.trim().slice(0, 2000) : ''
  }
  app.get('/api/auth', c => c.json({ ok: authorized(c), local: isLocal(c) }))
  app.get('/api/pair', requireLocal, c => call(opts.pair, c))
  app.post('/api/cases/:id/resolve', requireAdmin, c => call(opts.onCaseResolve && (() => opts.onCaseResolve!(c.req.param('id') ?? '', 'Organizer (app)')), c))
  app.post('/api/cases/:id/reply', requireAdmin, async c => {
    const text = await textBody(c)
    if (!text) return c.json({ error: 'text required' }, 400)
    return call(opts.onCaseReply && (() => opts.onCaseReply!(c.req.param('id') ?? '', text)), c)
  })
  app.post('/api/pending/:id/answer', requireAdmin, async c => {
    const text = await textBody(c)
    if (!text) return c.json({ error: 'text required' }, 400)
    return call(opts.onAnswerPending && (() => opts.onAnswerPending!(c.req.param('id') ?? '', text)), c)
  })
  app.get('/api/push/key', c => (opts.push ? c.json({ key: opts.push.key() }) : c.json({ error: 'push not available' }, 503)))
  app.post('/api/push/subscribe', requireAdmin, async c => {
    if (!opts.push) return c.json({ error: 'push not available' }, 503)
    const body = await readJson(c)
    try {
      return c.json((await opts.push.subscribe(body.subscription, c.req.header('user-agent'))) ?? { ok: true })
    } catch (e) {
      return c.json({ error: String((e as Error).message) }, 400)
    }
  })
  app.post('/api/push/unsubscribe', requireAdmin, async c => {
    const body = await readJson(c)
    return call(opts.push && typeof body.endpoint === 'string' ? () => opts.push!.unsubscribe(body.endpoint as string) : undefined, c)
  })
  app.post('/api/push/test', requireAdmin, c => call(opts.push?.test, c))
  const quickHits: number[] = []
  app.post('/api/quick', async c => {
    if (!opts.quick) return c.json({ error: 'not available' }, 503)
    const now = Date.now()
    while (quickHits.length && now - quickHits[0]! > 60_000) quickHits.shift()
    if (quickHits.length >= 30) return c.json({ error: 'slow down' }, 429)
    quickHits.push(now)
    const body = await readJson(c)
    const res = await opts.quick(String(body.id ?? ''), String(body.action ?? ''), String(body.sig ?? ''))
    return c.json(res, (res.status ?? (res.ok ? 200 : 400)) as 200)
  })
  app.get('/api/scenarios', c => c.json(opts.scenarios?.() ?? []))

  app.post('/api/demo/:action', requireAdmin, async c => {
    if (!opts.onDemo) return c.json({ error: 'demo not available' }, 503)
    const action = c.req.param('action') ?? ''
    if (!['play', 'pause', 'resume', 'stop', 'reset', 'speed'].includes(action)) return c.json({ error: 'unknown action' }, 400)
    const body = await readJson(c)
    return c.json((await opts.onDemo(action as 'play', body)) ?? { ok: true })
  })

  app.all('/api/*', c => c.json({ error: 'not found' }, 404))

  // ── dashboard SPA ─────────────────────────────────────────────────────────

  const relRoot = path.relative(process.cwd(), webRoot) || '.'
  // The phone app: its own page, manifest and service worker (scope /m/).
  const phone = (c: Context) => {
    const file = path.join(webRoot, 'm.html')
    if (!fs.existsSync(file)) return c.text('Phone app not built yet: run `npm run build:web`.', 503)
    c.header('Cache-Control', 'no-store')
    return c.html(fs.readFileSync(file, 'utf-8'))
  }
  app.get('/m', c => c.redirect('/m/'))
  app.get('/m/', phone)
  app.get('/m/sw.js', async (c, next) => {
    c.header('Cache-Control', 'no-cache')
    c.header('Service-Worker-Allowed', '/m/')
    await next()
  })
  app.use('/*', serveStatic({ root: relRoot }))
  app.get('*', c => {
    const index = path.join(webRoot, 'index.html')
    if (!fs.existsSync(index)) {
      return c.text('Dashboard not built yet: run `npm run build:web` (API is live at /api/state).', 503)
    }
    c.header('Cache-Control', 'no-store')
    return c.html(fs.readFileSync(index, 'utf-8'))
  })

  return app
}

/** Listen on `port`, bumping to the next free port (up to +10) like the WhatsApp dashboard did. */
export function startServer(app: Hono, basePort: number): Promise<{ port: number; close: () => Promise<void> }> {
  return new Promise((resolve, reject) => {
    const server = createAdaptorServer({ fetch: app.fetch })
    let port = basePort
    server.on('error', (err: NodeJS.ErrnoException) => {
      if (err.code === 'EADDRINUSE' && port < basePort + 10) {
        port++
        console.log(`[HTTP] Port busy, trying ${port}...`)
        server.listen(port)
      } else {
        reject(err)
      }
    })
    server.on('listening', () => {
      const addr = server.address() as AddressInfo | null
      const actual = addr?.port ?? port
      console.log(`[HTTP] Dashboard on http://localhost:${actual}`)
      resolve({
        port: actual,
        close: () => new Promise<void>(res => server.close(() => res())),
      })
    })
    server.listen(port)
  })
}

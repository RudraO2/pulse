// Pulse phone app service worker.
//  • Push: every "needs you" item arrives as a notification. Approvals get
//    Approve / Reject buttons, members get Resolve: tapping one calls
//    /api/quick with a per-item signature (no password stored here).
//  • Offline shell: hashed assets cache-first, the page network-first.

const CACHE = 'pulse-m-v1'

self.addEventListener('install', () => self.skipWaiting())
self.addEventListener('activate', (e) => {
  e.waitUntil(
    caches
      .keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim()),
  )
})

self.addEventListener('fetch', (e) => {
  const url = new URL(e.request.url)
  if (e.request.method !== 'GET' || url.origin !== self.location.origin || url.pathname.startsWith('/api/')) return
  if (url.pathname.startsWith('/assets/')) {
    e.respondWith(
      caches.match(e.request).then(
        (hit) =>
          hit ||
          fetch(e.request).then((res) => {
            if (res.ok) {
              const copy = res.clone()
              void caches.open(CACHE).then((c) => c.put(e.request, copy))
            }
            return res
          }),
      ),
    )
  } else if (e.request.mode === 'navigate') {
    e.respondWith(
      fetch(e.request)
        .then((res) => {
          const copy = res.clone()
          void caches.open(CACHE).then((c) => c.put('/m/', copy))
          return res
        })
        .catch(() => caches.match('/m/')),
    )
  }
})

const ACTIONS = {
  approval: [
    { action: 'approve', title: '✓ Approve' },
    { action: 'reject', title: 'Reject' },
  ],
  member: [
    { action: 'open', title: 'Reply' },
    { action: 'resolve', title: 'Resolve' },
  ],
  question: [{ action: 'open', title: 'Answer' }],
}

self.addEventListener('push', (e) => {
  let data = {}
  try {
    data = e.data ? e.data.json() : {}
  } catch {
    data = { title: 'Pulse', body: e.data ? e.data.text() : '' }
  }
  e.waitUntil(
    self.registration.showNotification(data.title || 'Pulse', {
      body: data.body || '',
      tag: data.tag || data.id,
      renotify: true,
      icon: '/m/icon-192.png',
      badge: '/m/badge-96.png',
      data,
      actions: data.id && !String(data.id).startsWith('test_') ? ACTIONS[data.kind] || [] : [],
      requireInteraction: !!data.urgent,
      vibrate: data.urgent ? [120, 60, 120, 60, 240] : [80],
      timestamp: Date.now(),
    }),
  )
})

async function openApp(url) {
  const all = await self.clients.matchAll({ type: 'window', includeUncontrolled: true })
  const client = all.find((c) => new URL(c.url).pathname.startsWith('/m/'))
  if (client) {
    await client.focus()
    client.postMessage({ type: 'open', url })
    return
  }
  await self.clients.openWindow(url)
}

async function quick(data, action) {
  const labels = { approve: 'Approved ✓', reject: 'Rejected', resolve: 'Resolved ✓' }
  try {
    const res = await fetch('/api/quick', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ id: data.id, action, sig: data.sig }) })
    const body = await res.json().catch(() => ({}))
    const ok = res.ok && body.ok !== false
    await self.registration.showNotification(ok ? labels[action] : 'Pulse could not do that', {
      body: ok ? data.title : body.error || `Error ${res.status}. Open the app to try again.`,
      tag: data.tag || data.id,
      icon: '/m/icon-192.png',
      badge: '/m/badge-96.png',
      data: { ...data, done: true },
      silent: true,
    })
    if (ok) setTimeout(() => self.registration.getNotifications({ tag: data.tag || data.id }).then((ns) => ns.forEach((n) => n.close())), 4000)
  } catch {
    await openApp(data.url || '/m/')
  }
}

self.addEventListener('notificationclick', (e) => {
  const data = e.notification.data || {}
  e.notification.close()
  if (!data.done && (e.action === 'approve' || e.action === 'reject' || e.action === 'resolve')) {
    e.waitUntil(quick(data, e.action))
    return
  }
  e.waitUntil(openApp(data.url || '/m/'))
})

import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { LiveTransport } from '../lib/transport'
import { MobileApp } from './MobileApp'
import '../styles.css'

// The phone app. Pairing = the dashboard's QR opens /m/?token=…; the token is
// kept on the phone and removed from the address bar. Same live stream as the
// dashboard; a service worker adds push notifications and an offline shell.

if (localStorage.getItem('pulse.theme') === 'dark') document.documentElement.classList.add('dark')
const params = new URLSearchParams(location.search)
const token = params.get('token')
if (token) {
  localStorage.setItem('pulse.token', token)
  history.replaceState(null, '', `/m/${location.hash}`)
}

if ('serviceWorker' in navigator) {
  void navigator.serviceWorker.register('/m/sw.js', { scope: '/m/' }).catch(() => undefined)
  // A tapped notification asks the open app to go to the item.
  navigator.serviceWorker.addEventListener('message', (e: MessageEvent<{ type?: string; url?: string }>) => {
    if (e.data?.type === 'open' && e.data.url) location.hash = e.data.url.split('#')[1] ?? '/'
  })
}

async function boot(): Promise<void> {
  const transport = new LiveTransport()
  const ok = await transport.start()
  if (!ok) setTimeout(() => void boot(), 3_000)
}

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <MobileApp />
  </StrictMode>,
)

void boot()

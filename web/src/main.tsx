import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { App } from './App'
import { LiveTransport } from './lib/transport'
import './styles.css'

// Boot: hydrate from /api/state, then follow the live stream (SSE, with a
// long-poll fallback). If the server is down, keep retrying.

if (localStorage.getItem('pulse.theme') === 'dark') document.documentElement.classList.add('dark')
const token = new URLSearchParams(location.search).get('token')
if (token) localStorage.setItem('pulse.token', token)

async function boot(): Promise<void> {
  const transport = new LiveTransport()
  const ok = await transport.start()
  if (!ok) setTimeout(() => void boot(), 2_000)
}

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App />
  </StrictMode>,
)

void boot()

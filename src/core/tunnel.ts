import { spawn } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import { bus } from '../bus.js'
import { env } from '../config/env.js'
import { kvGetJson, kvSetJson } from '../store/repo.js'
import { setPublicUrl } from './notify.js'

// A Cloudflare quick tunnel: a free HTTPS address for the laptop, so the phone
// app installs as a PWA, receives push, and email links open from anywhere.
//
// The address is random per cloudflared process, and the installed phone app
// and its push subscription are tied to it. So cloudflared runs detached and
// outlives Pulse: a restart of Pulse reuses the same tunnel (same address).
// It only changes if cloudflared dies or the laptop reboots.

const LOG = path.resolve('data', 'cloudflared.log')
const URL_RE = /https:\/\/[a-z0-9-]+\.trycloudflare\.com/i
let restarts = 0
let watchdog: ReturnType<typeof setInterval> | undefined

function findBinary(): string {
  const candidates = [
    env.CLOUDFLARED_BIN,
    'C:\\Program Files (x86)\\cloudflared\\cloudflared.exe',
    'C:\\Program Files\\cloudflared\\cloudflared.exe',
    `${process.env.LOCALAPPDATA ?? ''}\\Microsoft\\WinGet\\Links\\cloudflared.exe`,
    '/usr/local/bin/cloudflared',
    '/opt/homebrew/bin/cloudflared',
    '/usr/bin/cloudflared',
  ].filter((p): p is string => !!p)
  return (
    candidates.find((p) => {
      try {
        return fs.statSync(p).isFile()
      } catch {
        return false
      }
    }) ?? 'cloudflared'
  )
}

const alive = (pid: number): boolean => {
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}

async function reachable(url: string): Promise<boolean> {
  try {
    const res = await fetch(`${url}/healthz`, { signal: AbortSignal.timeout(8000) })
    return res.ok
  } catch {
    return false
  }
}

function up(url: string, pid: number): void {
  restarts = 0
  kvSetJson('tunnel', { pid, url })
  setPublicUrl(url, 'up')
  console.log(`[Pulse] phone app: ${url}/m`)
  bus.emit({ type: 'log', level: 'info', text: `tunnel up: ${url} (phone app at /m)` })
  // If cloudflared dies, open a new one (the address will change).
  if (watchdog) clearInterval(watchdog)
  watchdog = setInterval(() => {
    if (alive(pid)) return
    clearInterval(watchdog)
    watchdog = undefined
    setPublicUrl(undefined, 'down')
    bus.emit({ type: 'log', level: 'warn', text: 'tunnel stopped, opening a new one (the phone needs the new QR)' })
    if (restarts++ < 5) void spawnTunnel(port)
  }, 15_000)
  watchdog.unref?.()
}

let port = 3210

async function spawnTunnel(p: number): Promise<void> {
  setPublicUrl(undefined, 'starting')
  fs.mkdirSync(path.dirname(LOG), { recursive: true })
  try {
    fs.writeFileSync(LOG, '')
  } catch {
    /* in use: the regex only takes a URL written after this point anyway */
  }
  const proc = spawn(findBinary(), ['tunnel', '--no-autoupdate', '--logfile', LOG, '--url', `http://localhost:${p}`], { detached: true, stdio: 'ignore', windowsHide: true })
  proc.on('error', (e) => bus.emit({ type: 'log', level: 'warn', text: `tunnel: could not start cloudflared (${e.message}). Install it or set CLOUDFLARED_BIN.` }))
  proc.unref()
  const pid = proc.pid
  if (!pid) return
  for (let i = 0; i < 60; i++) {
    await new Promise((r) => setTimeout(r, 500))
    const m = fs.existsSync(LOG) ? fs.readFileSync(LOG, 'utf-8').match(URL_RE) : null
    if (m) return up(m[0], pid)
    if (!alive(pid)) break
  }
  setPublicUrl(undefined, 'down')
  bus.emit({ type: 'log', level: 'warn', text: 'tunnel: cloudflared did not report an address' })
}

export async function startTunnel(p: number): Promise<void> {
  if (env.TUNNEL !== 'cloudflared') return
  port = p
  // Reuse the tunnel from a previous run of Pulse: same address, the installed phone app keeps working.
  const saved = kvGetJson<{ pid: number; url: string }>('tunnel')
  if (saved && alive(saved.pid)) {
    setPublicUrl(undefined, 'starting')
    if (await reachable(saved.url)) return up(saved.url, saved.pid)
    try {
      process.kill(saved.pid)
    } catch {
      /* already gone */
    }
  }
  await spawnTunnel(p)
}

/** Pulse shutting down: leave cloudflared running so the address survives a restart. */
export function stopTunnel(): void {
  if (watchdog) clearInterval(watchdog)
  watchdog = undefined
}

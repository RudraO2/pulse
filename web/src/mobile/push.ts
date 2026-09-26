import { useEffect, useState } from 'react'
import { api } from '../lib/api'

// Push on the phone: ask permission, subscribe with the server's VAPID key,
// register the subscription. Android Chrome works from the browser or the
// installed app; iOS only once the app is added to the Home Screen.

export type PushStatus = 'unsupported' | 'insecure' | 'default' | 'denied' | 'on'

function urlBase64ToUint8Array(base64: string): Uint8Array<ArrayBuffer> {
  const padding = '='.repeat((4 - (base64.length % 4)) % 4)
  const raw = atob((base64 + padding).replace(/-/g, '+').replace(/_/g, '/'))
  const out = new Uint8Array(new ArrayBuffer(raw.length))
  for (let i = 0; i < raw.length; i++) out[i] = raw.charCodeAt(i)
  return out
}

async function currentStatus(): Promise<PushStatus> {
  if (!window.isSecureContext) return 'insecure'
  if (!('serviceWorker' in navigator) || !('PushManager' in window) || !('Notification' in window)) return 'unsupported'
  if (Notification.permission === 'denied') return 'denied'
  const reg = await navigator.serviceWorker.getRegistration('/m/')
  const sub = await reg?.pushManager.getSubscription()
  return sub && Notification.permission === 'granted' ? 'on' : 'default'
}

export async function enablePush(): Promise<PushStatus> {
  const status = await currentStatus()
  if (status === 'unsupported' || status === 'insecure' || status === 'denied') return status
  const permission = await Notification.requestPermission()
  if (permission !== 'granted') return permission === 'denied' ? 'denied' : 'default'
  const reg = await navigator.serviceWorker.ready
  const key = await api.pushKey()
  if (!key?.key) return 'default'
  let sub = await reg.pushManager.getSubscription()
  if (!sub) sub = await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: urlBase64ToUint8Array(key.key) })
  const res = await api.pushSubscribe(sub.toJSON())
  return res ? 'on' : 'default'
}

export function usePushStatus(): [PushStatus | undefined, (s: PushStatus) => void] {
  const [status, setStatus] = useState<PushStatus>()
  useEffect(() => {
    void currentStatus().then(async (s) => {
      setStatus(s)
      // Re-register quietly on each open (the server may have been reset).
      if (s === 'on') {
        const reg = await navigator.serviceWorker.getRegistration('/m/')
        const sub = await reg?.pushManager.getSubscription()
        if (sub) void api.pushSubscribe(sub.toJSON())
      }
    })
  }, [])
  return [status, setStatus]
}

// ── install prompt (Android Chrome) ────────────────────────────────────────

interface InstallPromptEvent extends Event {
  prompt: () => Promise<void>
  userChoice: Promise<{ outcome: 'accepted' | 'dismissed' }>
}

let deferred: InstallPromptEvent | undefined
const listeners = new Set<() => void>()
window.addEventListener('beforeinstallprompt', (e) => {
  e.preventDefault()
  deferred = e as InstallPromptEvent
  for (const l of listeners) l()
})
window.addEventListener('appinstalled', () => {
  deferred = undefined
  for (const l of listeners) l()
})

export const isStandalone = () => window.matchMedia('(display-mode: standalone)').matches || (navigator as { standalone?: boolean }).standalone === true

export function useInstall(): { canInstall: boolean; install: () => Promise<void> } {
  const [, force] = useState(0)
  useEffect(() => {
    const l = () => force((n) => n + 1)
    listeners.add(l)
    return () => void listeners.delete(l)
  }, [])
  return {
    canInstall: !!deferred && !isStandalone(),
    install: async () => {
      if (!deferred) return
      await deferred.prompt()
      await deferred.userChoice
      deferred = undefined
      force((n) => n + 1)
    },
  }
}

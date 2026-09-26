import QRCode from 'qrcode'
import { BellRing, Copy, LoaderCircle, Mail, Smartphone, X } from 'lucide-react'
import { useEffect, useState } from 'react'
import { api, type PairInfo } from '../lib/api'
import { useStore } from '../lib/store'
import { Badge, Dot } from '../ui/primitives'

// Pair a phone: one QR (the tunnel address + the admin token), scanned once.
// The phone app keeps the token; approvals, answers and replies then work
// from anywhere, and push notifications arrive even when it's closed.

export function PhoneDialog({ onClose }: { onClose: () => void }) {
  const notify = useStore((s) => s.notify)
  const [info, setInfo] = useState<PairInfo>()
  const [qr, setQr] = useState<string>()
  const [copied, setCopied] = useState(false)

  useEffect(() => {
    void api.pair().then(setInfo)
  }, [notify.tunnel, notify.publicUrl, notify.devices])

  const url = info?.url ?? info?.lanUrl
  useEffect(() => {
    setQr(undefined)
    if (url) void QRCode.toDataURL(url, { margin: 0, width: 320, color: { dark: '#12151b', light: '#ffffff' } }).then(setQr)
  }, [url])

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && onClose()
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onClose])

  const secure = !!info?.url
  return (
    <div className="fixed inset-0 z-40 grid place-items-center p-4">
      <div className="absolute inset-0 animate-fade-in bg-[var(--scrim)]" onClick={onClose} />
      <div className="card relative w-full max-w-[440px] animate-pop p-6 shadow-[var(--shadow-lg)]" role="dialog" aria-label="Pulse on your phone">
        <button onClick={onClose} className="absolute top-4 right-4 rounded-md p-1 text-fg-3 hover:bg-hover hover:text-fg" aria-label="Close">
          <X className="size-4" />
        </button>
        <h2 className="display text-[22px] font-semibold text-fg">Pulse on your phone</h2>
        <p className="mt-1 text-[13px] text-fg-3">{secure ? 'Scan, open, then Add to Home screen.' : 'Same Wi-Fi only until the secure link is up.'}</p>

        <div className="mt-5 flex min-w-0 flex-col items-center rounded-xl border border-line p-5">
          {qr ? (
            <img src={qr} alt="Phone app QR code" className="size-52 rounded-lg bg-white p-2" />
          ) : (
            <div className="grid size-52 place-items-center text-[12.5px] text-fg-3">
              {notify.tunnel === 'starting' ? (
                <span className="flex items-center gap-2">
                  <LoaderCircle className="size-4 animate-spin" /> Opening a secure link…
                </span>
              ) : info ? (
                'No address yet'
              ) : (
                <div className="skeleton size-52" />
              )}
            </div>
          )}
          {url && (
            <button
              onClick={() => {
                void navigator.clipboard?.writeText(url)
                setCopied(true)
                setTimeout(() => setCopied(false), 1500)
              }}
              className="mt-3 flex w-full min-w-0 items-center justify-center gap-1.5 text-[12px] text-fg-3 hover:text-fg"
              title="Copy link (contains your access token)"
            >
              <Copy className="size-3.5 shrink-0" />
              <span className="min-w-0 truncate font-mono">{copied ? 'Copied' : url.replace(/token=.*/, 'token=•••')}</span>
            </button>
          )}
        </div>

        <ul className="mt-4 space-y-2 text-[13px]">
          <li className="flex items-center gap-2.5">
            <Smartphone className="size-4 text-fg-3" />
            <span className="flex-1 text-fg-2">Secure link</span>
            <Dot state={notify.tunnel === 'up' ? 'up' : notify.tunnel === 'starting' ? 'degraded' : notify.tunnel === 'down' ? 'down' : 'disabled'} />
            <span className="text-fg-3">{notify.tunnel === 'up' ? 'Cloudflare tunnel' : notify.tunnel === 'off' ? 'off (TUNNEL=cloudflared)' : notify.tunnel}</span>
          </li>
          <li className="flex items-center gap-2.5">
            <BellRing className="size-4 text-fg-3" />
            <span className="flex-1 text-fg-2">Push</span>
            <Badge tone={notify.devices ? 'ok' : 'ghost'}>
              {notify.devices} phone{notify.devices === 1 ? '' : 's'}
            </Badge>
          </li>
          <li className="flex items-center gap-2.5">
            <Mail className="size-4 text-fg-3" />
            <span className="flex-1 text-fg-2">Email</span>
            <span className="max-w-[200px] truncate text-fg-3" title="Urgent right away, the rest bundled">
              {notify.email ? notify.emailTo : 'off'}
            </span>
          </li>
        </ul>
      </div>
    </div>
  )
}

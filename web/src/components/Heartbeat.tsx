import { useEffect, useRef, useState } from 'react'
import { useStore } from '../lib/store'

// A small ECG line in the top bar. Every agent run adds one heartbeat, so the
// room can see Pulse working even when nobody is looking at a specific screen.

const N = 132
const COMPLEX = [0, 0.08, 0.12, 0, -0.1, 0.95, -0.45, 0, 0.05, 0.16, 0.2, 0.12, 0]
const WINDOW_MS = 10 * 60_000

export function Heartbeat() {
  const canvas = useRef<HTMLCanvasElement>(null)
  const queue = useRef<number[]>([])
  const latest = useStore((s) => s.runs[0]?.runId)
  const runs = useStore((s) => s.runs)
  const [now, setNow] = useState(() => Date.now())
  const seen = useRef<string | undefined>(undefined)

  // one beat per new run (skip the initial snapshot)
  useEffect(() => {
    if (seen.current !== undefined && latest && latest !== seen.current) queue.current.push(...COMPLEX)
    seen.current = latest ?? ''
  }, [latest])

  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 30_000)
    return () => clearInterval(t)
  }, [])

  useEffect(() => {
    const el = canvas.current
    const ctx = el?.getContext('2d')
    if (!el || !ctx) return
    const reduced = matchMedia('(prefers-reduced-motion: reduce)').matches
    const buf = new Array<number>(N).fill(0)
    ;[24, 78].forEach((p) => COMPLEX.forEach((v, i) => (buf[p + i] = v)))
    const draw = () => {
      const cs = getComputedStyle(document.documentElement)
      const stroke = cs.getPropertyValue('--accent').trim() || '#2d5bff'
      const faint = cs.getPropertyValue('--line').trim() || '#e2e5ea'
      const w = el.width
      const h = el.height
      const base = h * 0.62
      ctx.clearRect(0, 0, w, h)
      ctx.strokeStyle = faint
      ctx.lineWidth = 1
      ctx.beginPath()
      ctx.moveTo(0, base)
      ctx.lineTo(w, base)
      ctx.stroke()
      const grad = ctx.createLinearGradient(0, 0, w, 0)
      grad.addColorStop(0, 'transparent')
      grad.addColorStop(0.35, stroke)
      grad.addColorStop(1, stroke)
      ctx.strokeStyle = grad
      ctx.lineWidth = 3
      ctx.lineJoin = 'round'
      ctx.lineCap = 'round'
      ctx.beginPath()
      buf.forEach((v, i) => {
        const x = (i / (N - 1)) * w
        const y = base - v * h * 0.52
        if (i) ctx.lineTo(x, y)
        else ctx.moveTo(x, y)
      })
      ctx.stroke()
      ctx.fillStyle = stroke
      ctx.beginPath()
      ctx.arc(w - 3.5, base - (buf[N - 1] ?? 0) * h * 0.52, 3.5, 0, Math.PI * 2)
      ctx.fill()
    }
    if (reduced) {
      const t = setInterval(() => {
        if (!queue.current.length) return
        buf.splice(0, COMPLEX.length)
        buf.push(...COMPLEX)
        queue.current = []
        draw()
      }, 500)
      draw()
      return () => clearInterval(t)
    }
    let raf = 0
    let last = 0
    const loop = (t: number) => {
      if (t - last > 45) {
        last = t
        buf.shift()
        buf.push(queue.current.length ? queue.current.shift()! : (Math.random() - 0.5) * 0.025)
        draw()
      }
      raf = requestAnimationFrame(loop)
    }
    raf = requestAnimationFrame(loop)
    return () => cancelAnimationFrame(raf)
  }, [])

  const recent = runs.filter((r) => now - r.startedAt < WINDOW_MS).length
  return (
    <div className="hidden items-center gap-2 md:flex" title={`${recent} agent run${recent === 1 ? '' : 's'} in the last 10 minutes. Each spike is one run.`}>
      <canvas ref={canvas} width={264} height={56} className="h-7 w-[132px]" aria-hidden />
      <span className="min-w-4 text-[12px] font-semibold text-fg-2 tabular-nums">{recent}</span>
    </div>
  )
}

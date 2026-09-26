import clsx from 'clsx'
import type { MemberCase } from '@shared/events'

// Member mood, drawn small: a sparkline of the member's messages (-1 … +1),
// coloured by where it ends. Shared by the dashboard and the phone app.

export function moodWord(score: number): string {
  if (score <= -0.6) return 'Very upset'
  if (score <= -0.3) return 'Upset'
  if (score < -0.05) return 'Uneasy'
  if (score < 0.3) return 'Okay'
  return 'Happy'
}

export function moodTone(score: number): 'bad' | 'warn' | 'neutral' | 'ok' {
  if (score <= -0.45) return 'bad'
  if (score < -0.05) return 'warn'
  if (score < 0.3) return 'neutral'
  return 'ok'
}

const STROKE = { bad: 'var(--bad)', warn: 'var(--warn)', neutral: 'var(--fg-3)', ok: 'var(--ok)' }

export const memberScores = (c: MemberCase): number[] => c.points.filter((p) => p.by === 'member').map((p) => p.score)

export function MoodLine({ scores, width = 72, height = 22, className }: { scores: number[]; width?: number; height?: number; className?: string }) {
  const pts = scores.length === 1 ? [scores[0]!, scores[0]!] : scores.slice(-12)
  if (!pts.length) return null
  const pad = 3
  const x = (i: number) => pad + (i * (width - pad * 2)) / Math.max(1, pts.length - 1)
  const y = (v: number) => pad + ((1 - (Math.max(-1, Math.min(1, v)) + 1) / 2) * (height - pad * 2))
  const d = pts.map((v, i) => `${i ? 'L' : 'M'}${x(i).toFixed(1)},${y(v).toFixed(1)}`).join(' ')
  const last = pts[pts.length - 1]!
  const color = STROKE[moodTone(last)]
  return (
    <svg width={width} height={height} viewBox={`0 0 ${width} ${height}`} className={clsx('shrink-0 overflow-visible', className)} aria-label={`Mood ${moodWord(last).toLowerCase()}`} role="img">
      <line x1={pad} x2={width - pad} y1={y(0)} y2={y(0)} stroke="var(--line-strong)" strokeDasharray="2 3" strokeWidth="1" />
      <path d={d} fill="none" stroke={color} strokeWidth="1.75" strokeLinecap="round" strokeLinejoin="round" />
      <circle cx={x(pts.length - 1)} cy={y(last)} r="2.6" fill={color} />
    </svg>
  )
}

export const CASE_LABEL: Record<MemberCase['status'], string> = { open: 'Watching', escalated: 'Needs a human', resolved: 'Sorted' }
export const CASE_TONE: Record<MemberCase['status'], 'accent' | 'bad' | 'ok'> = { open: 'accent', escalated: 'bad', resolved: 'ok' }

/** Active cases first (escalated on top), then ones sorted in the last `recentMs`. */
export function visibleCases(cases: MemberCase[], real: boolean, recentMs = 30 * 60_000, now = Date.now()): MemberCase[] {
  const rank = { escalated: 0, open: 1, resolved: 2 }
  return cases
    .filter((c) => (!real || !c.simulated) && (c.status !== 'resolved' || now - (c.resolvedAt ?? 0) < recentMs))
    .sort((a, b) => rank[a.status] - rank[b.status] || b.updatedAt - a.updatedAt)
}

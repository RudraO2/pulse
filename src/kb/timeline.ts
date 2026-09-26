// Reads a schedule table out of a guide ("| 1:00 – 1:40 PM | Lunch Break | … |")
// and says, for a given moment, what is over, what is on and what is next.
// Done in code so the model never has to do time arithmetic.

export interface Slot {
  /** minutes since midnight, local time */
  start: number
  end: number
  title: string
  detail: string
}

const TZ = 'Asia/Kolkata'
const plain = (s: string) => s.replace(/\*\*|__|<\/?u>/g, '').trim()

function minutes(t: string, meridiem?: string): number | undefined {
  const m = /^(\d{1,2})(?::(\d{2}))?$/.exec(t.trim())
  if (!m) return undefined
  let h = Number(m[1])
  const min = Number(m[2] ?? 0)
  if (h > 23 || min > 59) return undefined
  if (meridiem) {
    const pm = /p/i.test(meridiem)
    if (h === 12) h = pm ? 12 : 0
    else if (pm) h += 12
  }
  return h * 60 + min
}

/** "9:00 – 9:50 AM", "10:15 AM – 12:50 PM", "12:50 – 1:00 PM", "3:30 PM" → [start, end] in minutes. */
export function parseRange(cell: string): [number, number] | undefined {
  const s = plain(cell).replace(/\s+/g, ' ')
  const m = /^(\d{1,2}(?::\d{2})?)\s*(am|pm|a\.m\.|p\.m\.)?\s*(?:[–—-]|to)\s*(\d{1,2}(?::\d{2})?)\s*(am|pm|a\.m\.|p\.m\.)$/i.exec(s)
  if (m) {
    const end = minutes(m[3]!, m[4])
    if (end === undefined) return undefined
    let start = minutes(m[1]!, m[2] ?? m[4])
    if (start === undefined) return undefined
    // "11:30 – 1:00 PM": the shared PM can't apply to a start after the end.
    if (!m[2] && start > end) start = minutes(m[1]!, /p/i.test(m[4]!) ? 'am' : 'pm') ?? start
    return [start, end]
  }
  const one = /^(\d{1,2}(?::\d{2})?)\s*(am|pm|a\.m\.|p\.m\.)$/i.exec(s)
  if (one) {
    const t = minutes(one[1]!, one[2])
    return t === undefined ? undefined : [t, t]
  }
  return undefined
}

/** Every markdown table row whose first cell is a time or time range. */
export function parseSchedule(md: string): Slot[] {
  const out: Slot[] = []
  for (const line of md.split(/\r?\n/)) {
    if (!line.trim().startsWith('|')) continue
    const cells = line.split('|').slice(1, -1).map((c) => c.trim())
    if (cells.length < 2) continue
    const range = parseRange(cells[0]!)
    if (!range) continue
    out.push({ start: range[0], end: range[1], title: plain(cells[1]!), detail: plain(cells.slice(2).join(' · ')) })
  }
  return out.sort((a, b) => a.start - b.start)
}

export function fmtClock(min: number): string {
  const h = Math.floor(min / 60) % 24
  const m = min % 60
  return `${h % 12 || 12}:${String(m).padStart(2, '0')} ${h < 12 ? 'AM' : 'PM'}`
}

const fmtSlot = (s: Slot) => (s.start === s.end ? `${s.title} at ${fmtClock(s.start)}` : `${s.title} (${fmtClock(s.start)}–${fmtClock(s.end)})`)

function fmtIn(mins: number): string {
  if (mins < 60) return `${mins} min`
  const h = Math.floor(mins / 60)
  const m = mins % 60
  return m ? `${h} h ${m} min` : `${h} h`
}

/** Local minutes since midnight for a Date, in the event's time zone. */
export function localMinutes(now: Date, timeZone = TZ): number {
  const parts = new Intl.DateTimeFormat('en-GB', { hour: '2-digit', minute: '2-digit', hourCycle: 'h23', timeZone }).formatToParts(now)
  const h = Number(parts.find((p) => p.type === 'hour')?.value ?? 0)
  const m = Number(parts.find((p) => p.type === 'minute')?.value ?? 0)
  return h * 60 + m
}

/** The "right now" block for the prompt: what's done, on, and next, with the current time. */
export function describeNow(slots: Slot[], now: Date, timeZone = TZ): string | undefined {
  if (!slots.length) return undefined
  const t = localMinutes(now, timeZone)
  const clock = now.toLocaleString('en-IN', { weekday: 'short', day: 'numeric', month: 'short', hour: 'numeric', minute: '2-digit', hour12: true, timeZone })
  const on = slots.filter((s) => s.start <= t && t < s.end)
  const done = slots.filter((s) => (s.end > s.start ? s.end <= t : s.start < t))
  const next = slots.filter((s) => s.start > t)
  const lines = [`RIGHT NOW: ${clock} (IST). Computed from the guide's schedule and the clock, so trust it over your own arithmetic.`]
  if (on.length) lines.push(`Happening now: ${on.map((s) => `${fmtSlot(s)}, ends in ${fmtIn(s.end - t)}${s.detail ? `: ${s.detail}` : ''}`).join('; ')}`)
  else if (next.length && done.length) lines.push('Happening now: nothing scheduled this minute (between sessions).')
  if (!done.length) lines.push(`The day hasn't started yet: first up is ${fmtSlot(next[0]!)}, in ${fmtIn(next[0]!.start - t)}.`)
  else lines.push(`Already done today: ${done.map(fmtSlot).join(' · ')}`)
  if (next.length) lines.push(`Coming up: ${next.map((s) => `${fmtSlot(s)} in ${fmtIn(s.start - t)}`).join(' · ')}`)
  else lines.push("Everything on today's schedule is over: the event has wrapped up.")
  return lines.join('\n')
}

import { describe, expect, it } from 'vitest'
import { describeNow, parseRange, parseSchedule } from '../../src/kb/timeline.js'

const MD = `| Time | Session | Key Activities |
|---|---|---|
| 9:00 – 9:50 AM | Registration | Check-in and setup. |
| 12:50 – 1:00 PM | Check-in | Progress updates. |
| 1:00 – 1:40 PM | Lunch Break | Lunch for all. |
| 1:40 – 3:30 PM | Build Session II | Final development. |
| **3:30 PM** | **Deadline** | **Submit on Commudle**. |
| 3:50 – 4:20 PM | Final Jury Round | 2.5-minute demo. |`

// 26 Sep 2026 in IST (UTC+5:30)
const at = (hhmm: string) => new Date(`2026-09-26T${hhmm}:00+05:30`)

describe('schedule timeline', () => {
  it('parses time ranges, a shared AM/PM and noon correctly', () => {
    expect(parseRange('9:00 – 9:50 AM')).toEqual([540, 590])
    expect(parseRange('10:15 AM – 12:50 PM')).toEqual([615, 770])
    expect(parseRange('12:50 – 1:00 PM')).toEqual([770, 780])
    expect(parseRange('11:30 – 1:00 PM')).toEqual([690, 780])
    expect(parseRange('**3:30 PM**')).toEqual([930, 930])
    expect(parseRange('Session')).toBeUndefined()
  })

  it('reads only the time rows of a table', () => {
    expect(parseSchedule(MD).map((s) => s.title)).toEqual(['Registration', 'Check-in', 'Lunch Break', 'Build Session II', 'Deadline', 'Final Jury Round'])
  })

  it('says lunch is over, what is on, and what is next', () => {
    const now = describeNow(parseSchedule(MD), at('15:16'))!
    expect(now).toContain('3:16')
    expect(now).toMatch(/Happening now: Build Session II \(1:40 PM–3:30 PM\), ends in 14 min/)
    expect(now).toMatch(/Already done today:.*Lunch Break \(1:00 PM–1:40 PM\)/)
    expect(now).toMatch(/Coming up: Deadline at 3:30 PM in 14 min · Final Jury Round \(3:50 PM–4:20 PM\) in 34 min/)
  })

  it('knows before the start and after the end', () => {
    expect(describeNow(parseSchedule(MD), at('08:30'))).toMatch(/hasn't started yet: first up is Registration .* in 30 min/)
    expect(describeNow(parseSchedule(MD), at('17:30'))).toMatch(/event has wrapped up/)
    expect(describeNow(parseSchedule(MD), at('15:40'))).toMatch(/between sessions/)
  })
})

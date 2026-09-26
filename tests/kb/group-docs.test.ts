import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { guideFor, guideOutline, searchGuide, setGuide, splitGuide } from '../../src/kb/group-docs.js'
import { closeDb, openDb } from '../../src/store/db.js'

const GUIDE = `# Hack Day :: Participant Information
Solo event. Build an AI agent with at least 3 APIs.

# **Event Schedule**
09:30 Check-in
13:00 Lunch

### Important Deadline
Final submission is due at **3:30 PM** on Commudle.

# Evaluation Process

### Track 3 – AI Community Agent
Agents that run communities on Telegram, Slack or Discord.

### Track 6 – AI Business Operator
Agents that run payments and invoices.
`

let file: string

beforeEach(() => {
  openDb(':memory:')
  file = path.join(mkdtempSync(path.join(tmpdir(), 'guide-')), 'Hack Day Guide.md')
  writeFileSync(file, GUIDE)
})
afterEach(() => closeDb())

describe('chat guides', () => {
  it('splits a guide into heading sections, nested under their top heading', () => {
    const titles = splitGuide(GUIDE).map((s) => s.title)
    expect(titles).toEqual([
      'Hack Day :: Participant Information',
      'Event Schedule',
      'Event Schedule › Important Deadline',
      'Evaluation Process › Track 3 – AI Community Agent',
      'Evaluation Process › Track 6 – AI Business Operator',
    ])
  })

  it('finds the section that answers a question, including numbered ones', () => {
    setGuide('g1@g.us', file)
    expect(searchGuide('g1@g.us', 'what is the submission deadline?')[0]?.section.title).toBe('Event Schedule › Important Deadline')
    expect(searchGuide('g1@g.us', 'what is track 3 about')[0]?.section.title).toContain('Track 3')
    expect(searchGuide('g1@g.us', 'tell me about track 6')[0]?.section.title).toContain('Track 6')
  })

  it('belongs to one chat only', () => {
    setGuide('g1@g.us', file)
    expect(guideFor('g1@g.us')).toEqual({ name: 'Hack Day Guide', sections: 5 })
    expect(guideFor('other@g.us')).toBeUndefined()
    expect(searchGuide('other@g.us', 'deadline')).toEqual([])
    expect(guideOutline('g1@g.us')).toContain('Event Schedule')
    setGuide('g1@g.us')
    expect(guideFor('g1@g.us')).toBeUndefined()
  })

  it('refuses a missing file', () => {
    expect(() => setGuide('g1@g.us', path.join(tmpdir(), 'nope-404.md'))).toThrow(/not found/)
  })
})

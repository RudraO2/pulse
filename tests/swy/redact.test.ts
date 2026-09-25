import { describe, expect, it } from 'vitest'
import { containsSecret, preview, redact, redactDeep, SECRET_REGEX_SOURCE } from '../../src/swy/redact.js'

// Built at runtime so the test file itself never contains secret-shaped literals.
const j = (...parts: string[]) => parts.join('')
const samples = {
  github: j('ghp', '_', 'a'.repeat(36)),
  githubPat: j('github_pat_', 'A'.repeat(30)),
  swy: j('swy_key_', 'abcdef123456'),
  slack: j('xoxb-', '1234567890-', 'abcdefghij'),
  openai: j('sk-', 'x'.repeat(40)),
  resend: j('re_', 'B'.repeat(28)),
  google: j('AIza', 'C'.repeat(35)),
  groq: j('gsk_', 'D'.repeat(40)),
  notion: j('ntn_', 'E'.repeat(40)),
  telegram: j('123456789', ':', 'F'.repeat(35)),
}

describe('redact', () => {
  for (const [name, secret] of Object.entries(samples)) {
    it(`redacts ${name}`, () => {
      const out = redact(`here: ${secret} end`)
      expect(out).not.toContain(secret)
      expect(out).toContain('[REDACTED]')
      expect(containsSecret(`x ${secret} y`)).toBe(true)
    })
  }

  it('redacts Telegram tokens embedded in bot API URLs', () => {
    const url = `https://api.telegram.org/bot${samples.telegram}/sendMessage`
    expect(redact(url)).toBe('https://api.telegram.org/bot[REDACTED]/sendMessage')
  })

  it('redacts bearer tokens of any shape', () => {
    expect(redact('Authorization: Bearer abc.def.ghijklmnop')).toBe('Authorization: Bearer [REDACTED]')
  })

  it('leaves normal text alone', () => {
    const text = 'Use slack.chat.postmessage.create with body.channel = C123 and chat_id -1001234567890'
    expect(redact(text)).toBe(text)
    expect(containsSecret(text)).toBe(false)
  })

  it('redacts deeply and masks sensitive keys', () => {
    const out = redactDeep({ Authorization: 'Bearer zzz', nested: [{ text: `leak ${samples.slack}` }], n: 5 })
    expect(out.Authorization).toBe('[REDACTED]')
    expect(JSON.stringify(out)).not.toContain(samples.slack)
    expect(out.n).toBe(5)
  })

  it('truncates previews after redacting', () => {
    const p = preview({ big: 'x'.repeat(2000), s: samples.github }, 100)
    expect(p.length).toBeLessThan(130)
    expect(p).not.toContain(samples.github)
  })

  it('keeps the policy regex under the CLI limit (512 chars)', () => {
    expect(SECRET_REGEX_SOURCE.length).toBeLessThanOrEqual(512)
  })
})

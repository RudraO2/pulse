// Secret-like strings that must never leave the process: not to the dashboard,
// not to the LLM, not to Notion, not to a public channel. The same patterns
// feed the Swytchcode `no-secrets` policy (see guardrails.config.ts), so the
// app-side redaction and the execution-layer guard agree.

export const SECRET_PATTERNS: Array<{ name: string; source: string }> = [
  { name: 'github', source: 'gh[pousr]_[A-Za-z0-9]{20,}' },
  { name: 'github_pat', source: 'github_pat_[A-Za-z0-9_]{20,}' },
  { name: 'swytchcode', source: 'swy_key_[A-Za-z0-9_-]{8,}' },
  { name: 'slack', source: 'xox[abposr]-[A-Za-z0-9-]{8,}' },
  { name: 'slack_app', source: 'xapp-[A-Za-z0-9-]{8,}' },
  { name: 'openai', source: 'sk-[A-Za-z0-9_-]{20,}' },
  { name: 'resend', source: 're_[A-Za-z0-9_]{20,}' },
  { name: 'google', source: 'AIza[A-Za-z0-9_-]{30,}' },
  { name: 'groq', source: 'gsk_[A-Za-z0-9]{20,}' },
  { name: 'notion', source: '(?:secret|ntn)_[A-Za-z0-9]{30,}' },
  { name: 'telegram_bot', source: '[0-9]{8,10}:[A-Za-z0-9_-]{35}' },
]

/** One alternation, used both here and (as a string) in policies.json. */
export const SECRET_REGEX_SOURCE = `(${SECRET_PATTERNS.map((p) => p.source).join('|')})`

const secretRe = () => new RegExp(SECRET_REGEX_SOURCE, 'g')
// Telegram tokens embedded in bot API URLs (…/bot<id>:<secret>/method)
const botUrlRe = /\/bot[0-9]{6,12}:[A-Za-z0-9_-]{20,}/g
const bearerRe = /(Bearer\s+)[A-Za-z0-9._~+/=-]{12,}/gi

export function containsSecret(text: string): boolean {
  return secretRe().test(text) || /\/bot[0-9]{6,12}:[A-Za-z0-9_-]{20,}/.test(text)
}

export function redact(text: string): string {
  if (!text) return text
  return text
    .replace(botUrlRe, '/bot[REDACTED]')
    .replace(secretRe(), (m) => `${m.slice(0, 4)}…[REDACTED]`)
    .replace(bearerRe, '$1[REDACTED]')
}

const SENSITIVE_KEYS = /^(authorization|token|api[_-]?key|secret|password|cookie)$/i

export function redactDeep<T>(value: T): T {
  return walk(value, 0) as T
}

function walk(v: unknown, depth: number): unknown {
  if (depth > 20) return '[DEPTH]'
  if (typeof v === 'string') return redact(v)
  if (Array.isArray(v)) return v.map((x) => walk(x, depth + 1))
  if (v && typeof v === 'object') {
    const out: Record<string, unknown> = {}
    for (const [k, val] of Object.entries(v as Record<string, unknown>)) {
      out[k] = SENSITIVE_KEYS.test(k) && typeof val === 'string' ? '[REDACTED]' : walk(val, depth + 1)
    }
    return out
  }
  return v
}

/** Redact then truncate for event previews. */
export function preview(value: unknown, max = 600): string {
  let s: string
  try {
    s = typeof value === 'string' ? value : JSON.stringify(redactDeep(value))
  } catch {
    s = String(value)
  }
  s = redact(s)
  return s.length > max ? `${s.slice(0, max)}…(+${s.length - max})` : s
}

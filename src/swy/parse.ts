// Pure parsers for swytchcode CLI output. The CLI mixes Go log lines,
// human banners ("🔐 Running live…", "Telemetry is disabled…") and JSON on the
// same streams, so we never JSON.parse a whole stream blindly.

export interface SwyErrorPayload {
  error: string
  category?: string
  suggested_action?: string
  docs_url?: string
  reference_id?: string
  retryable?: boolean
}

export interface DryRunRequest {
  method: string
  url: string
  headers?: Record<string, string>
  body?: unknown
}

const GO_LOG = /^\d{4}\/\d{2}\/\d{2} \d{2}:\d{2}:\d{2} /
const NOISE = [/^Telemetry is disabled/i, /^🔐/u, /^running in demo mode/i, /^Fetching /i, /^\s*run: /i, /^×/, /^\s*(Reference ID|This reference ID|hint):/i]

export function isNoiseLine(line: string): boolean {
  const l = line.trim()
  return !l || GO_LOG.test(l) || NOISE.some((re) => re.test(l))
}

/** Every top-level JSON object/array found on its own line(s), in order. */
export function jsonLines(text: string): unknown[] {
  const out: unknown[] = []
  for (const line of text.split(/\r?\n/)) {
    const l = line.trim()
    if (!(l.startsWith('{') || l.startsWith('['))) continue
    try {
      out.push(JSON.parse(l))
    } catch {
      /* not a complete JSON line */
    }
  }
  if (out.length) return out
  // Pretty-printed (multi-line) JSON: try the span from the first brace to the end.
  const start = text.search(/[{[]/)
  if (start >= 0) {
    try {
      out.push(JSON.parse(text.slice(start)))
    } catch {
      /* give up */
    }
  }
  return out
}

/** The CLI's structured error object from stderr (or stdout), if any. */
export function parseErrorPayload(stderr: string, stdout = ''): SwyErrorPayload | undefined {
  for (const obj of [...jsonLines(stderr), ...jsonLines(stdout)]) {
    if (obj && typeof obj === 'object' && !Array.isArray(obj) && typeof (obj as SwyErrorPayload).error === 'string') {
      return obj as SwyErrorPayload
    }
  }
  // Plain-text errors, e.g. `error: canonical ID "x" not found in any fetched providers`
  for (const line of `${stdout}\n${stderr}`.split(/\r?\n/)) {
    const m = /^error:\s*(.+)$/i.exec(line.trim())
    if (m?.[1]) return { error: m[1], category: /not found/i.test(m[1]) ? 'not_found' : undefined }
  }
  const failed = /failed tool=\S+ exit_code=\d+ error=(.+)$/m.exec(stderr)
  if (failed?.[1]) return { error: failed[1].trim() }
  return undefined
}

/**
 * The CLI's result on stdout. Whole-payload first: pretty-printed output
 * (e.g. `discover --json`) can contain inner lines that are valid JSON on their
 * own, so line-by-line parsing is only the last resort.
 */
export function parseStdout(stdout: string): unknown {
  const text = stdout.trim()
  if (!text) return undefined
  try {
    return JSON.parse(text)
  } catch {
    /* noise around the JSON */
  }
  const start = text.search(/[{[]/)
  const end = Math.max(text.lastIndexOf('}'), text.lastIndexOf(']'))
  if (start >= 0 && end > start) {
    try {
      return JSON.parse(text.slice(start, end + 1))
    } catch {
      /* several JSON values */
    }
  }
  const all = jsonLines(text)
  return all.length ? all[0] : undefined
}

export function isDryRunRequest(v: unknown): v is DryRunRequest {
  return !!v && typeof v === 'object' && typeof (v as DryRunRequest).url === 'string' && typeof (v as DryRunRequest).method === 'string'
}

export function extractAuditIds(text: string): string[] {
  return [...new Set(text.match(/\b(?:pol|nw)_[a-f0-9]{8,}\b/g) ?? [])]
}

/** `blocked by policy "no-secrets": message` → { policyId, message } */
export function parsePolicyBlock(error: string): { policyId?: string; message?: string } {
  const m = /blocked by policy "([^"]+)":?\s*(.*)$/i.exec(error)
  return m ? { policyId: m[1], message: m[2] || undefined } : {}
}

export function parseVersion(text: string): string | undefined {
  return /version\s+v?(\d+\.\d+\.\d+)/i.exec(text)?.[1]
}

export function inferCategory(exitCode: number, message: string): string {
  if (/not found|not configured/i.test(message)) return 'not_found'
  if (/credential|auth/i.test(message)) return 'auth'
  if (/polic/i.test(message)) return 'policy_denied'
  if (/validation|missing required/i.test(message)) return 'validation'
  if (exitCode === 4 || /network|timeout|ECONN/i.test(message)) return 'network'
  return 'unknown'
}

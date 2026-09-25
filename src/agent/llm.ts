import { createAnthropic } from '@ai-sdk/anthropic'
import { createGoogleGenerativeAI } from '@ai-sdk/google'
import { createGroq } from '@ai-sdk/groq'
import {
  APICallError,
  type LanguageModelV4,
  type LanguageModelV4CallOptions,
  type LanguageModelV4GenerateResult,
  type LanguageModelV4StreamResult,
} from '@ai-sdk/provider'
import { bus } from '../bus.js'

// Free-tier LLMs die in interesting ways: per-minute 429s, daily quota walls,
// a model that rejects a tool schema. A retry of the whole generateText would
// repeat tool calls (and swy side effects), so fallback happens PER STEP:
// ModelChain is itself a LanguageModel whose doGenerate walks the chain.

export interface ModelSpec {
  provider: 'google' | 'groq' | 'anthropic'
  modelId: string
}

export function parseChain(spec: string | undefined, fallback: string): ModelSpec[] {
  return (spec?.trim() ? spec : fallback)
    .split(',')
    .map(s => s.trim())
    .filter(Boolean)
    .map(s => {
      const i = s.indexOf(':')
      const provider = s.slice(0, i) as ModelSpec['provider']
      const modelId = s.slice(i + 1)
      if ((provider !== 'google' && provider !== 'groq' && provider !== 'anthropic') || !modelId) throw new Error(`bad model spec "${s}"`)
      return { provider, modelId }
    })
}

type Cooldown = { until: number; reason: string }

/** Why/how long to bench a model after an error. */
export function classifyLlmError(err: unknown, now = Date.now()): Cooldown {
  const msg = String((err as Error)?.message ?? err).toLowerCase()
  const status = APICallError.isInstance(err) ? err.statusCode : undefined
  const retryAfter = APICallError.isInstance(err) ? Number(err.responseHeaders?.['retry-after']) : NaN

  if (status === 429 || msg.includes('rate limit') || msg.includes('resource_exhausted') || msg.includes('quota')) {
    const daily = /per ?day|daily|requests per day|rpd|tokens per day|tpd/.test(msg)
    if (daily) return { until: nextPacificMidnight(now), reason: 'daily quota exhausted' }
    const secs = Number.isFinite(retryAfter) && retryAfter > 0 ? retryAfter : 60
    return { until: now + Math.min(secs, 300) * 1000, reason: 'rate limited' }
  }
  if (status === 400 || status === 404 || status === 422) return { until: now + 10 * 60_000, reason: `rejected request (${status})` }
  if (status === 401 || status === 403) return { until: now + 60 * 60_000, reason: `auth failed (${status})` }
  return { until: now + 30_000, reason: status ? `upstream ${status}` : 'network error' }
}

function nextPacificMidnight(now: number): number {
  // Gemini free quotas reset at midnight America/Los_Angeles. PDT = UTC-7.
  const d = new Date(now - 7 * 3600_000)
  d.setUTCHours(24, 0, 0, 0)
  return d.getTime() + 7 * 3600_000
}

/** Make the served model visible upstream (step.response.modelId) as "provider:model". */
function stampModel(result: unknown, label: string): void {
  const r = result as { response?: { modelId?: string } }
  if (r && typeof r === 'object') r.response = { ...(r.response ?? {}), modelId: label }
}

/** Known free-tier tokens-per-minute caps. Unknown models are not pre-throttled. */
export function tpmLimit(label: string): number {
  if (label.startsWith('groq:')) return Number(process.env.GROQ_TPM_LIMIT ?? 8000)
  return Infinity
}

export class AllModelsFailedError extends Error {
  constructor(readonly attempts: Array<{ model: string; reason: string }>) {
    super(`all models failed: ${attempts.map(a => `${a.model} (${a.reason})`).join(', ')}`)
  }
}

export class ModelChain implements LanguageModelV4 {
  readonly specificationVersion = 'v4' as const
  readonly provider = 'pulse-chain'
  readonly supportedUrls = {}
  private cooldowns = new Map<string, Cooldown>()
  /** sliding 60 s window of tokens spent per model (Groq free tier: 8K TPM each) */
  private spent = new Map<string, Array<{ at: number; tokens: number }>>()
  private lastSize = new Map<string, number>()

  constructor(
    readonly modelId: string,
    private readonly models: LanguageModelV4[],
    private readonly now: () => number = Date.now,
  ) {}

  private label(m: LanguageModelV4): string {
    return `${m.provider.split('.')[0]}:${m.modelId}`
  }

  available(): LanguageModelV4[] {
    const t = this.now()
    return this.models.filter(m => (this.cooldowns.get(this.label(m))?.until ?? 0) <= t && this.hasBudget(m, t))
  }

  private windowTokens(label: string, t: number): number {
    const w = (this.spent.get(label) ?? []).filter(e => t - e.at < 60_000)
    this.spent.set(label, w)
    return w.reduce((s, e) => s + e.tokens, 0)
  }

  /** Skip a model whose next request would likely blow its per-minute token cap (saves a 429 round-trip). */
  private hasBudget(m: LanguageModelV4, t: number): boolean {
    const limit = tpmLimit(this.label(m))
    if (!Number.isFinite(limit)) return true
    const next = this.lastSize.get(this.label(m)) ?? 0
    return this.windowTokens(this.label(m), t) + next <= limit * 0.95
  }

  private recordUsage(label: string, result: unknown): void {
    const u = (result as { usage?: { inputTokens?: { total?: number }; outputTokens?: { total?: number } } })?.usage
    const tokens = (u?.inputTokens?.total ?? 0) + (u?.outputTokens?.total ?? 0)
    if (!tokens) return
    this.spent.set(label, [...(this.spent.get(label) ?? []), { at: this.now(), tokens }])
    this.lastSize.set(label, tokens)
  }

  /** The model that will be tried first right now (for the dashboard pill). */
  get active(): string | undefined {
    const m = this.available()[0]
    return m && this.label(m)
  }

  private async walk<R>(call: (m: LanguageModelV4) => PromiseLike<R>): Promise<R> {
    const attempts: Array<{ model: string; reason: string }> = []
    let candidates = this.available()
    // Everything benched: try the one that recovers soonest rather than refusing outright.
    if (!candidates.length && this.models.length) {
      candidates = [...this.models].sort(
        (a, b) => (this.cooldowns.get(this.label(a))?.until ?? 0) - (this.cooldowns.get(this.label(b))?.until ?? 0),
      ).slice(0, 1)
    }
    for (const m of candidates) {
      try {
        const result = await call(m)
        stampModel(result, this.label(m))
        this.recordUsage(this.label(m), result)
        if (attempts.length) this.report('degraded', `fell back to ${this.label(m)}`)
        else this.report('up', this.label(m))
        return result
      } catch (err) {
        if ((err as Error)?.name === 'AbortError') throw err
        const cd = classifyLlmError(err, this.now())
        this.cooldowns.set(this.label(m), cd)
        attempts.push({ model: this.label(m), reason: cd.reason })
        bus.emit({ type: 'log', level: 'warn', text: `LLM ${this.label(m)} benched: ${cd.reason}` })
      }
    }
    this.report('down', 'all models unavailable')
    throw new AllModelsFailedError(attempts)
  }

  private lastReported = ''
  private report(state: 'up' | 'degraded' | 'down', detail: string): void {
    const key = `${state}|${detail}`
    if (key === this.lastReported) return
    this.lastReported = key
    bus.emit({ type: 'status', service: 'llm', status: { state, detail, at: this.now() } })
  }

  doGenerate(options: LanguageModelV4CallOptions): Promise<LanguageModelV4GenerateResult> {
    return this.walk(m => m.doGenerate(options))
  }

  // Streaming can only fall back before the first chunk; doStream resolving
  // means the connection was accepted, which is the failure point we care about.
  doStream(options: LanguageModelV4CallOptions): Promise<LanguageModelV4StreamResult> {
    return this.walk(m => m.doStream(options))
  }
}

export function buildModels(specs: ModelSpec[], keys: { google?: string; groq?: string; anthropic?: string }): LanguageModelV4[] {
  const google = keys.google ? createGoogleGenerativeAI({ apiKey: keys.google }) : undefined
  const groq = keys.groq ? createGroq({ apiKey: keys.groq }) : undefined
  const anthropic = keys.anthropic ? createAnthropic({ apiKey: keys.anthropic }) : undefined
  const out: LanguageModelV4[] = []
  for (const s of specs) {
    if (s.provider === 'google' && google) out.push(google(s.modelId) as LanguageModelV4)
    if (s.provider === 'groq' && groq) out.push(groq(s.modelId) as LanguageModelV4)
    if (s.provider === 'anthropic' && anthropic) out.push(anthropic(s.modelId) as LanguageModelV4)
  }
  return out
}

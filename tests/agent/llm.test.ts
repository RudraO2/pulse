import { describe, expect, it } from 'vitest'
import { APICallError, type LanguageModelV4 } from '@ai-sdk/provider'
import { AllModelsFailedError, ModelChain, classifyLlmError, parseChain } from '../../src/agent/llm.js'

function apiError(status: number, message: string, headers: Record<string, string> = {}) {
  return new APICallError({ message, url: 'x', requestBodyValues: {}, statusCode: status, responseHeaders: headers, isRetryable: false })
}

function fake(id: string, behavior: () => unknown): LanguageModelV4 & { calls: number } {
  const m = {
    specificationVersion: 'v4' as const,
    provider: 'fake.chat',
    modelId: id,
    supportedUrls: {},
    calls: 0,
    async doGenerate() {
      m.calls++
      const r = behavior()
      if (r instanceof Error) throw r
      return r as never
    },
    async doStream() {
      throw new Error('unused')
    },
  }
  return m
}

const OK = { content: [{ type: 'text', text: 'hi' }], finishReason: 'stop', usage: {}, warnings: [] }

describe('parseChain', () => {
  it('parses provider:model lists and falls back to default', () => {
    expect(parseChain('google:a, groq:openai/gpt-oss-120b', 'x:y')).toEqual([
      { provider: 'google', modelId: 'a' },
      { provider: 'groq', modelId: 'openai/gpt-oss-120b' },
    ])
    expect(parseChain('', 'groq:b')).toEqual([{ provider: 'groq', modelId: 'b' }])
    expect(() => parseChain('openai:gpt', 'x')).toThrow()
  })
})

describe('classifyLlmError', () => {
  const now = Date.UTC(2026, 8, 26, 5, 0, 0)
  it('benches per-minute 429s briefly, honouring Retry-After', () => {
    expect(classifyLlmError(apiError(429, 'Rate limit reached', { 'retry-after': '12' }), now).until).toBe(now + 12_000)
  })
  it('benches daily quota until the next Pacific midnight', () => {
    const cd = classifyLlmError(apiError(429, 'Quota exceeded: requests per day'), now)
    expect(cd.reason).toBe('daily quota exhausted')
    expect(cd.until).toBeGreaterThan(now + 3600_000)
  })
  it('treats 400s as a longer bench (e.g. tool schema rejected)', () => {
    expect(classifyLlmError(apiError(400, 'bad schema'), now).until).toBe(now + 600_000)
  })
})

describe('ModelChain', () => {
  it('falls through to the next model on failure and benches the failed one', async () => {
    let t = 1_000
    const a = fake('a', () => apiError(429, 'rate limit'))
    const b = fake('b', () => OK)
    const chain = new ModelChain('agent', [a, b], () => t)
    await chain.doGenerate({} as never)
    expect(a.calls).toBe(1)
    expect(b.calls).toBe(1)
    // a is benched now: next call goes straight to b
    await chain.doGenerate({} as never)
    expect(a.calls).toBe(1)
    expect(b.calls).toBe(2)
    expect(chain.active).toBe('fake:b')
    // after the cooldown a is tried again
    t += 61_000
    expect(chain.active).toBe('fake:a')
  })

  it('throws AllModelsFailedError listing every attempt', async () => {
    const chain = new ModelChain('agent', [fake('a', () => new Error('boom')), fake('b', () => apiError(500, 'x'))])
    await expect(chain.doGenerate({} as never)).rejects.toBeInstanceOf(AllModelsFailedError)
  })

  it('still tries the soonest-recovering model when everything is benched', async () => {
    let t = 0
    let fail = true
    const a = fake('a', () => (fail ? apiError(503, 'down') : OK))
    const chain = new ModelChain('agent', [a], () => t)
    await expect(chain.doGenerate({} as never)).rejects.toThrow()
    fail = false
    await expect(chain.doGenerate({} as never)).resolves.toBeTruthy()
    expect(a.calls).toBe(2)
  })
})

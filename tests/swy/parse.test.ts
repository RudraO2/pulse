import { readFileSync } from 'node:fs'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import {
  extractAuditIds,
  inferCategory,
  isDryRunRequest,
  isNoiseLine,
  parseErrorPayload,
  parsePolicyBlock,
  parseStdout,
  parseVersion,
} from '../../src/swy/parse.js'

const fixture = (name: string) => readFileSync(path.join(import.meta.dirname, 'fixtures', name), 'utf8')

describe('parseErrorPayload', () => {
  it('finds the JSON error among Go log lines and banners', () => {
    const err = parseErrorPayload(fixture('stderr-policy-block.txt'))
    expect(err?.category).toBe('policy_denied')
    expect(err?.error).toMatch(/blocked by policy "no-secrets-in-posts"/)
  })

  it('returns the FIRST error when several policies fire (rate limit wins)', () => {
    const err = parseErrorPayload(fixture('stderr-rate-limit.txt'))
    expect(err?.category).toBe('rate_limit')
    expect(err?.retryable).toBe(true)
  })

  it('handles the not-allow-listed flow with fetch noise', () => {
    const err = parseErrorPayload(fixture('stderr-not-allowlisted.txt'))
    expect(err?.category).toBe('not_found')
  })

  it('parses plain-text "error:" lines (swy info on unknown id)', () => {
    const err = parseErrorPayload('', 'error: canonical ID "github.issue.create" not found in any fetched providers or installed workflows\n')
    expect(err?.category).toBe('not_found')
  })

  it('falls back to the Go "failed … error=" line', () => {
    const err = parseErrorPayload('2026/09/25 23:37:32 [swytchcode exec] failed tool=x exit_code=4 error=dial tcp: timeout')
    expect(err?.error).toBe('dial tcp: timeout')
  })

  it('returns undefined when there is nothing error-like', () => {
    expect(parseErrorPayload('Telemetry is disabled.\n')).toBeUndefined()
  })
})

describe('stdout parsing', () => {
  it('parses a live call envelope', () => {
    const out = parseStdout(fixture('stdout-live-slack-invalid-auth.txt')) as { data: { ok: boolean }; status_code: number }
    expect(out.status_code).toBe(200)
    expect(out.data.ok).toBe(false)
  })

  it('recognises a dry-run request preview', () => {
    const req = parseStdout('{"body":{"a":1},"headers":{"Authorization":"[REDACTED]"},"method":"POST","url":"https://slack.com/api/chat.postMessage"}')
    expect(isDryRunRequest(req)).toBe(true)
  })

  it('parses pretty-printed multi-line JSON', () => {
    expect(parseStdout('{\n  "capabilities": [\n    {"canonical_id": "a"}\n  ]\n}')).toEqual({ capabilities: [{ canonical_id: 'a' }] })
  })

  it('parses info arrays', () => {
    const info = parseStdout(fixture('info-notion-query.json')) as Array<{ canonical_id: string }>
    expect(info[0]?.canonical_id).toBe('notion.query.create')
  })
})

describe('helpers', () => {
  it('classifies noise lines', () => {
    expect(isNoiseLine('2026/09/25 23:37:32 [swytchcode exec] request tool=x')).toBe(true)
    expect(isNoiseLine('Telemetry is disabled. Run `swytchcode login`')).toBe(true)
    expect(isNoiseLine('🔐 Running live - Slack (production)')).toBe(true)
    expect(isNoiseLine('{"error":"x"}')).toBe(false)
  })

  it('extracts audit ids', () => {
    expect(extractAuditIds('ok pol_c1f012fd25e8 and nw_cdc7cb1f908c, pol_c1f012fd25e8')).toEqual(['pol_c1f012fd25e8', 'nw_cdc7cb1f908c'])
  })

  it('parses policy block messages', () => {
    expect(parsePolicyBlock('blocked by policy "cooldown-telegram": cooling down')).toEqual({ policyId: 'cooldown-telegram', message: 'cooling down' })
    expect(parsePolicyBlock('something else')).toEqual({})
  })

  it('parses the CLI version', () => {
    expect(parseVersion('swytchcode version 2.23.7\n')).toBe('2.23.7')
  })

  it('infers categories when the CLI gives none', () => {
    expect(inferCategory(2, 'tool not configured')).toBe('not_found')
    expect(inferCategory(3, 'missing credentials for Telegram')).toBe('auth')
    expect(inferCategory(4, 'boom')).toBe('network')
    expect(inferCategory(1, 'input validation failed: missing required field')).toBe('validation')
  })
})

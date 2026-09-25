import { bus } from '../bus.js'
import { guardrails } from '../../guardrails.config.js'
import type { SlackAdapter } from '../channels/slack.js'
import type { TelegramAdapter } from '../channels/telegram.js'
import type { SendOptions } from '../channels/types.js'
import type { GuardrailKind, Platform } from '../shared/events.js'
import { SwyError } from '../swy/exec.js'
import { setCooldownChats, type PolicyPlatform } from '../swy/policies.js'

// Every outbound community post goes through here:
//   app-side rate window → (feeds) Swytchcode cooldown policy
//   → adapter.send (idempotent outbox) → swy exec (policies enforced pre-execution)
// Policy blocks are surfaced as guardrail events, never retried.

export const channels: { telegram?: TelegramAdapter; slack?: SlackAdapter } = {}

export interface PostOptions extends SendOptions {
  simulated?: boolean
}

export interface PostResult {
  ok: boolean
  msgId?: string
  duplicate?: boolean
  blocked?: { kind: GuardrailKind; policyId?: string; message: string }
  error?: string
}

export function guardKind(policyId: string | undefined, category: string): GuardrailKind {
  const id = policyId ?? ''
  if (id.startsWith('no-secrets')) return 'secret'
  if (id.startsWith('cooldown')) return 'rate_limit'
  if (id.startsWith('dm-members-only')) return 'dm_non_member'
  if (id === 'no-mass-mention') return 'mass_mention'
  if (id === 'no-shady-links') return 'link'
  if (id === 'email-recipients') return 'email_recipient'
  if (category === 'not_found') return 'allowlist'
  if (category === 'rate_limit') return 'rate_limit'
  return 'policy'
}

/** Turn a SwyError into a guardrail event (+ result) if it was a policy/allow-list block. */
export function reportBlock(err: unknown, ctx: { platform?: Platform; chatId?: string; runId?: string }): PostResult['blocked'] | undefined {
  if (!(err instanceof SwyError)) return undefined
  if (!(err.isPolicy || err.category === 'not_found' || (err.category === 'rate_limit' && err.policyId))) return undefined
  const kind = guardKind(err.policyId, err.category)
  const message = err.policyMessage ?? err.message
  bus.emit({ type: 'guardrail', kind, policyId: err.policyId, auditId: err.auditIds[0], platform: ctx.platform, chatId: ctx.chatId, tool: err.tool, detail: message, runId: ctx.runId })
  return { kind, policyId: err.policyId, message }
}

// ── rate window → cooldown policy ───────────────────────────────────────────

const sends = new Map<string, number[]>()
const hot = { telegram: new Map<string, number>(), slack: new Map<string, number>() }

async function recordSend(platform: PolicyPlatform, chatId: string): Promise<void> {
  const now = Date.now()
  const key = `${platform}:${chatId}`
  const w = (sends.get(key) ?? []).filter((t) => now - t < 60_000)
  w.push(now)
  sends.set(key, w)
  const map = hot[platform]
  for (const [id, until] of map) if (until <= now) map.delete(id)
  if (w.length > guardrails.rateLimit.perChatPerMinute && !map.has(chatId)) {
    map.set(chatId, now + guardrails.rateLimit.cooldownMs)
    bus.emit({ type: 'log', level: 'warn', text: `${platform} ${chatId} is cooling down (${w.length} posts/min)` })
    setTimeout(() => void refreshCooldowns(platform), guardrails.rateLimit.cooldownMs + 50).unref?.()
  }
  await setCooldownChats(platform, [...map.keys()])
}

async function refreshCooldowns(platform: PolicyPlatform): Promise<void> {
  const now = Date.now()
  for (const [id, until] of hot[platform]) if (until <= now) hot[platform].delete(id)
  await setCooldownChats(platform, [...hot[platform].keys()])
}

// ── post ────────────────────────────────────────────────────────────────────

export async function post(platform: Platform, chatId: string, text: string, opts: PostOptions = {}): Promise<PostResult> {
  const adapter = platform === 'telegram' ? channels.telegram : platform === 'slack' ? channels.slack : undefined
  if (!adapter) return { ok: false, error: `${platform} is not connected` }
  try {
    await recordSend(platform as PolicyPlatform, chatId)
    const res = await adapter.send(chatId, text, opts)
    if (!res.duplicate || res.msgId) {
      bus.emit({ type: 'message.out', platform, chatId, text, runId: opts.runId, replyToId: opts.replyToId, threadTs: opts.threadTs, msgId: res.msgId, simulated: opts.simulated })
    }
    return { ok: true, msgId: res.msgId, duplicate: res.duplicate }
  } catch (e) {
    const blocked = reportBlock(e, { platform, chatId, runId: opts.runId })
    if (blocked) return { ok: false, blocked }
    return { ok: false, error: String((e as Error).message).slice(0, 200) }
  }
}

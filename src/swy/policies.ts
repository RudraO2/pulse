import { renameSync, rmSync, writeFileSync } from 'node:fs'
import { guardrails as defaultGuardrails, type Guardrails } from '../../guardrails.config.js'
import { env } from '../config/env.js'
import { swyPolicyValidate } from './exec.js'
import { policyLock } from './lock.js'
import { policiesPath } from './runtime-dir.js'

// Compiles guardrails.config.ts (+ live, API-derived state) into Swytchcode's
// policies.json. Dynamic state (which chats are cooling down, who is a verified
// member) comes from Telegram/Slack API output and is re-compiled on change,
// so the execution layer always enforces the current picture.

export type PolicyPlatform = 'telegram' | 'slack'

interface Condition {
  field: string
  operator: string
  value: unknown
}
interface Group {
  operator: 'all' | 'any' | 'not'
  conditions: Array<Condition | Group>
}
export interface PolicyRule {
  id: string
  target: string[]
  when: Condition | Group
  action: { type: 'POLICY_BLOCKED' | 'RATE_LIMITED' | 'REQUIRES_APPROVAL'; message: string }
}
export interface PoliciesFile {
  defaults: { on_violation: 'fail'; evaluation: 'pre_execution' }
  policies: PolicyRule[]
}

export interface DynamicPolicyState {
  cooldown: Record<PolicyPlatform, string[]>
  members: Record<PolicyPlatform, string[]>
}

const state: DynamicPolicyState = {
  cooldown: { telegram: [], slack: [] },
  members: { telegram: [], slack: [] },
}

/**
 * Canary ids are compiled into every dynamic rule so the guardrail self-test
 * can prove each rule is live without touching real chats or live state.
 * They are fake ids that no real chat can have.
 */
export const CANARY = {
  telegram: { cooldownChat: '-1000000000001', member: '1000000001', nonMember: '1000000002', cleanGroup: '-1000000000099' },
  slack: { cooldownChannel: 'C0CANARYHOT', member: 'D0CANARYMEMBER', nonMember: 'D0CANARYOTHER', cleanChannel: 'C0CANARYOK' },
} as const

/** Telegram ids are numeric; keep them numeric in JSON when they look numeric. */
function asIds(platform: PolicyPlatform, ids: string[]): Array<string | number> {
  return ids.map((id) => (platform === 'telegram' && /^-?\d+$/.test(id) ? Number(id) : id))
}

/** Organizer addresses Pulse may email (single-recipient `to` strings). */
export function emailAllowlist(g: Guardrails = defaultGuardrails): string[] {
  return [...new Set([g.emailRecipients.canary, env.DIGEST_TO, ...(env.EMAIL_ALLOWLIST?.split(',') ?? [])].map((s) => s?.trim()).filter((s): s is string => !!s))]
}

export function compilePolicies(dyn: DynamicPolicyState, g: Guardrails = defaultGuardrails): PoliciesFile {
  const policies: PolicyRule[] = [
    {
      id: 'no-secrets',
      target: [...g.noSecrets.chatTargets],
      when: { field: 'text', operator: 'matches', value: g.noSecrets.regex },
      action: { type: 'POLICY_BLOCKED', message: g.noSecrets.message },
    },
    {
      id: 'no-secrets-email',
      target: [g.noSecrets.emailTarget],
      when: {
        operator: 'any',
        conditions: g.noSecrets.emailFields.map((field) => ({ field, operator: 'matches', value: g.noSecrets.regex })),
      },
      action: { type: 'POLICY_BLOCKED', message: g.noSecrets.message },
    },
  ]

  policies.push({
    id: 'no-mass-mention',
    target: [...g.noMassMention.targets],
    when: { field: 'text', operator: 'matches', value: g.noMassMention.regex },
    action: { type: 'POLICY_BLOCKED', message: g.noMassMention.message },
  })
  policies.push({
    id: 'no-shady-links',
    target: [...g.noShadyLinks.targets],
    when: { field: 'text', operator: 'matches', value: g.noShadyLinks.regex },
    action: { type: 'POLICY_BLOCKED', message: g.noShadyLinks.message },
  })
  policies.push({
    id: 'email-recipients',
    target: [g.emailRecipients.target],
    when: { field: 'to', operator: 'not_in', value: emailAllowlist(g) },
    action: { type: 'POLICY_BLOCKED', message: g.emailRecipients.message },
  })

  // Swytchcode human approval: the call is held until a mod clicks Approve in
  // Slack, then Swytchcode runs it. Off unless the workspace has a HITL provider.
  if (env.SWYTCHCODE_HITL) {
    policies.push({
      id: 'mod-approves-pins',
      target: [...g.modApproval.targets],
      when: {
        operator: 'any',
        conditions: [
          { field: 'chat_id', operator: 'exists', value: null },
          { field: 'channel', operator: 'exists', value: null },
        ],
      },
      action: { type: 'REQUIRES_APPROVAL', message: g.modApproval.message },
    })
  }

  policies.push({
    id: 'cooldown-telegram',
    target: [...g.cooldown.telegramTargets],
    when: { field: 'chat_id', operator: 'in', value: asIds('telegram', [CANARY.telegram.cooldownChat, ...dyn.cooldown.telegram]) },
    action: { type: 'RATE_LIMITED', message: g.cooldown.message },
  })
  policies.push({
    id: 'cooldown-slack',
    target: [...g.cooldown.slackTargets],
    when: { field: 'channel', operator: 'in', value: [CANARY.slack.cooldownChannel, ...dyn.cooldown.slack] },
    action: { type: 'RATE_LIMITED', message: g.cooldown.message },
  })

  // Members-only DMs are always on: with no verified members, every DM is
  // blocked (fail-closed). Telegram DM chat ids are positive, groups negative.
  policies.push({
    id: 'dm-members-only-telegram',
    target: [...g.dmMembersOnly.telegramTargets],
    when: {
      operator: 'all',
      conditions: [
        { field: 'chat_id', operator: '>', value: 0 },
        { field: 'chat_id', operator: 'not_in', value: asIds('telegram', [CANARY.telegram.member, ...dyn.members.telegram]) },
      ],
    },
    action: { type: 'POLICY_BLOCKED', message: g.dmMembersOnly.message },
  })
  // Slack DM channel ids start with "D".
  policies.push({
    id: 'dm-members-only-slack',
    target: [...g.dmMembersOnly.slackTargets],
    when: {
      operator: 'all',
      conditions: [
        { field: 'channel', operator: 'starts_with', value: 'D' },
        { field: 'channel', operator: 'not_in', value: [CANARY.slack.member, ...dyn.members.slack] },
      ],
    },
    action: { type: 'POLICY_BLOCKED', message: g.dmMembersOnly.message },
  })

  return { defaults: { on_violation: 'fail', evaluation: 'pre_execution' }, policies }
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

/**
 * Atomic write under the policy write lock. On Windows the Go binary opens the
 * file without delete-sharing, so a rename can hit EPERM/EBUSY if anything
 * still holds it — retry briefly.
 */
async function writeAtomic(file: string, content: string): Promise<void> {
  const tmp = `${file}.${process.pid}.tmp`
  writeFileSync(tmp, content)
  for (let attempt = 0; ; attempt++) {
    try {
      renameSync(tmp, file)
      return
    } catch (e) {
      const code = (e as NodeJS.ErrnoException).code
      if (attempt >= 10 || !(code === 'EPERM' || code === 'EBUSY' || code === 'EACCES')) {
        rmSync(tmp, { force: true })
        throw e
      }
      await sleep(50 * (attempt + 1))
    }
  }
}

let lastWritten = ''

/** Compile the current state and write policies.json (no-op if unchanged). */
export async function applyPolicies(opts: { validate?: boolean; force?: boolean } = {}): Promise<{ changed: boolean; policies: PoliciesFile; warnings: string[] }> {
  const policies = compilePolicies(state)
  const content = JSON.stringify(policies, null, 2)
  if (!opts.force && content === lastWritten) return { changed: false, policies, warnings: [] }

  return policyLock.write(async () => {
    await writeAtomic(policiesPath(), content)
    lastWritten = content
    if (opts.validate === false) return { changed: true, policies, warnings: [] }
    const result = await swyPolicyValidate()
    if (!result.valid) throw new Error(`policies.json rejected by swytchcode: ${result.output}`)
    // "field X is not an input of the target tool(s)" is a known false warning
    // in 2.23.7: the rules do enforce (verified). Surface only other warnings.
    const warnings = result.warnings.filter((w) => !/is not an input of the target tool/.test(w))
    return { changed: true, policies, warnings }
  })
}

function setList(kind: keyof DynamicPolicyState, platform: PolicyPlatform, ids: string[]): boolean {
  const next = [...new Set(ids.map(String))].sort()
  const prev = state[kind][platform]
  if (next.length === prev.length && next.every((v, i) => v === prev[i])) return false
  state[kind][platform] = next
  return true
}

/** Replace the set of chats Swytchcode must refuse to post into (RATE_LIMITED). */
export async function setCooldownChats(platform: PolicyPlatform, ids: string[]): Promise<boolean> {
  if (!setList('cooldown', platform, ids)) return false
  await applyPolicies({ validate: false })
  return true
}

/** Replace the verified-member allowlist for DMs (derived from getChatMember / conversations.members). */
export async function setDmMembers(platform: PolicyPlatform, ids: string[]): Promise<boolean> {
  if (!setList('members', platform, ids)) return false
  await applyPolicies({ validate: false })
  return true
}

export async function addDmMember(platform: PolicyPlatform, id: string): Promise<boolean> {
  return setDmMembers(platform, [...state.members[platform], id])
}

export function getPolicyState(): DynamicPolicyState {
  return structuredClone(state)
}

/** Tests only. */
export function resetPolicyState(): void {
  state.cooldown = { telegram: [], slack: [] }
  state.members = { telegram: [], slack: [] }
  lastWritten = ''
}

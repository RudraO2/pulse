import { bus } from '../bus.js'
import type { SelfTestResult } from '../shared/events.js'
import { TOOLS } from '../../guardrails.config.js'
import { SwyError, swyExec, type SwyArgs } from './exec.js'
import { CANARY } from './policies.js'

// Proves every guardrail is live by running should-block / should-pass payloads
// through the REAL Swytchcode policy engine with --dry-run (free, no network
// for allow-listed tools). Uses canary ids compiled into each dynamic rule.

interface Case {
  name: string
  expect: 'block' | 'pass'
  tool: string
  args: SwyArgs
}

// Assembled at runtime so this file never contains a literal secret-shaped string.
const FAKE_GH = ['ghp', 'Z'.repeat(36)].join('_')
const FAKE_SLACK = ['xoxb', '000000000000', 'SELFTESTSELFTEST'].join('-')

export const SELFTEST_CASES: Case[] = [
  { name: 'Secret in Telegram post is blocked', expect: 'block', tool: TOOLS.telegramSend, args: { body: { chat_id: Number(CANARY.telegram.cleanGroup), text: `my token is ${FAKE_GH}` } } },
  { name: 'Secret in Slack post is blocked', expect: 'block', tool: TOOLS.slackPost, args: { body: { channel: CANARY.slack.cleanChannel, text: `use ${FAKE_SLACK} here` } } },
  { name: 'Secret in Telegram edit is blocked', expect: 'block', tool: TOOLS.telegramEdit, args: { body: { chat_id: Number(CANARY.telegram.cleanGroup), message_id: 1, text: FAKE_GH } } },
  { name: 'Secret in digest email is blocked', expect: 'block', tool: TOOLS.resendEmail, args: { body: { from: 'a@example.com', to: 'canary@pulse.invalid', subject: 'digest', html: `<p>${FAKE_GH}</p>` } } },
  { name: 'Clean Telegram post passes', expect: 'pass', tool: TOOLS.telegramSend, args: { body: { chat_id: Number(CANARY.telegram.cleanGroup), text: 'Answer ✅' } } },
  { name: 'Clean Slack post passes', expect: 'pass', tool: TOOLS.slackPost, args: { body: { channel: CANARY.slack.cleanChannel, text: 'Verified snippet ✅' } } },
  { name: 'Cooling-down Telegram chat is rate-limited', expect: 'block', tool: TOOLS.telegramSend, args: { body: { chat_id: Number(CANARY.telegram.cooldownChat), text: 'hello' } } },
  { name: 'Cooling-down Slack channel is rate-limited', expect: 'block', tool: TOOLS.slackPost, args: { body: { channel: CANARY.slack.cooldownChannel, text: 'hello' } } },
  { name: 'Telegram DM to non-member is blocked', expect: 'block', tool: TOOLS.telegramSend, args: { body: { chat_id: Number(CANARY.telegram.nonMember), text: 'hi' } } },
  { name: 'Telegram DM to verified member passes', expect: 'pass', tool: TOOLS.telegramSend, args: { body: { chat_id: Number(CANARY.telegram.member), text: 'hi' } } },
  { name: 'Slack DM to non-member is blocked', expect: 'block', tool: TOOLS.slackPost, args: { body: { channel: CANARY.slack.nonMember, text: 'hi' } } },
  { name: 'Slack DM to verified member passes', expect: 'pass', tool: TOOLS.slackPost, args: { body: { channel: CANARY.slack.member, text: 'hi' } } },
  { name: 'Slack @channel mass-mention is blocked', expect: 'block', tool: TOOLS.slackPost, args: { body: { channel: CANARY.slack.cleanChannel, text: '<!channel> lunch is ready' } } },
  { name: 'Shortened link in Telegram post is blocked', expect: 'block', tool: TOOLS.telegramSend, args: { body: { chat_id: Number(CANARY.telegram.cleanGroup), text: 'free credits: https://bit.ly/3xYz' } } },
  { name: 'Normal link in Telegram post passes', expect: 'pass', tool: TOOLS.telegramSend, args: { body: { chat_id: Number(CANARY.telegram.cleanGroup), text: 'Docs: https://www.notion.so/pulse-faq' } } },
  { name: 'Email to a stranger is blocked', expect: 'block', tool: TOOLS.resendEmail, args: { body: { from: 'a@example.com', to: 'stranger@example.com', subject: 'hi', html: '<p>hi</p>' } } },
  { name: 'Email to an allow-listed organizer passes', expect: 'pass', tool: TOOLS.resendEmail, args: { body: { from: 'a@example.com', to: 'canary@pulse.invalid', subject: 'digest', html: '<p>ok</p>' } } },
  { name: 'Tool outside the allow-list is refused', expect: 'block', tool: 'telegram_v5_0.deletemessage.create', args: { body: { chat_id: Number(CANARY.telegram.cleanGroup), message_id: 1 } } },
]

async function runCase(c: Case): Promise<SelfTestResult> {
  try {
    await swyExec(c.tool, c.args, { dryRun: true, runId: 'selftest', timeoutMs: 45_000 })
    return { name: c.name, expect: c.expect, got: 'pass', ok: c.expect === 'pass' }
  } catch (e) {
    if (e instanceof SwyError && (e.isPolicy || e.category === 'rate_limit' || e.category === 'not_found')) {
      return {
        name: c.name,
        expect: c.expect,
        got: 'block',
        ok: c.expect === 'block',
        policyId: e.policyId ?? (e.category === 'not_found' ? 'allow-list' : undefined),
        detail: e.policyMessage ?? e.category,
      }
    }
    return { name: c.name, expect: c.expect, got: 'error', ok: false, detail: (e as Error).message }
  }
}

export async function runGuardrailSelfTest(cases: Case[] = SELFTEST_CASES): Promise<SelfTestResult[]> {
  const results = await Promise.all(cases.map(runCase))
  bus.emit({ type: 'selftest', results })
  return results
}

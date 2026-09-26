// Source of truth for Pulse's public-posting guardrails.
// Compiled by src/swy/policies.ts into Swytchcode's policies.json, so every rule
// is enforced by the execution layer *before* the HTTP call — no matter what the
// model decides. Verified against swytchcode 2.23.7 with real dry-runs:
//   • bare field names only (`text`, `chat_id`, `channel`); `body.text` is a schema error
//   • `in` / `not_in` / `>` / `starts_with` / `matches` and `all` groups all enforce
//   • chat_id compares correctly whether sent as number or string
//   • RATE_LIMITED surfaces as category `rate_limit`; POLICY_BLOCKED as `policy_denied`
//   • `swy policy validate` falsely warns "field … is not an input" for body fields

import { SECRET_REGEX_SOURCE } from './src/swy/redact.js'

export const TOOLS = {
  telegramSend: 'telegram_v5_0.sendmessage.create',
  telegramEdit: 'telegram_v5_0.editmessagetext.create',
  slackPost: 'slack.chat.postmessage.create',
  slackUpdate: 'slack.chat.update.create',
  resendEmail: 'resend.email.create',
  telegramPin: 'telegram_v5_0.pinchatmessage.create',
  slackPin: 'slack.pins.add.create',
} as const

export const guardrails = {
  noSecrets: {
    /** Public/outbound text must never contain secret-like strings. */
    regex: SECRET_REGEX_SOURCE,
    chatTargets: [TOOLS.telegramSend, TOOLS.telegramEdit, TOOLS.slackPost, TOOLS.slackUpdate],
    emailTarget: TOOLS.resendEmail,
    emailFields: ['subject', 'html', 'text'],
    message: 'Outbound message contains a secret-like token (API key / bot token). Redact it before posting.',
  },
  cooldown: {
    telegramTargets: [TOOLS.telegramSend],
    slackTargets: [TOOLS.slackPost],
    message: 'This chat is cooling down: the agent exceeded its posting rate here.',
  },
  dmMembersOnly: {
    telegramTargets: [TOOLS.telegramSend],
    slackTargets: [TOOLS.slackPost],
    message: 'DMs are only allowed to verified community members.',
  },
  noMassMention: {
    /** Slack's special mentions ping everyone in a channel. */
    regex: '<!(channel|everyone|here)>|(^|\s)@(channel|everyone|here)\b',
    targets: [TOOLS.slackPost, TOOLS.slackUpdate],
    message: 'Pulse may never mass-mention a channel (@channel / @everyone / @here).',
  },
  noShadyLinks: {
    /** Link shorteners, raw IPs and script URIs hide where a link goes (phishing / prompt-injection spam). */
    regex: '(?i)(https?://(bit\.ly|tinyurl\.com|t\.co|goo\.gl|is\.gd|ow\.ly|rb\.gy|cutt\.ly|shorturl\.at|[0-9]{1,3}(\.[0-9]{1,3}){3})(/|\b))|javascript:|data:text/html',
    targets: [TOOLS.telegramSend, TOOLS.telegramEdit, TOOLS.slackPost, TOOLS.slackUpdate],
    message: 'Shortened, raw-IP or script links are not allowed in community posts.',
  },
  emailRecipients: {
    target: TOOLS.resendEmail,
    /** Always allowed in addition to DIGEST_TO / EMAIL_ALLOWLIST (self-test canary). */
    canary: 'canary@pulse.invalid',
    message: 'Pulse can only email allow-listed organizer addresses.',
  },
  modApproval: {
    /**
     * REQUIRES_APPROVAL (Swytchcode Business, SWYTCHCODE_HITL=true): a pin
     * shows a message to everyone for days, so Swytchcode itself holds it and
     * asks a mod in Slack. Pulse can't skip this, whatever the prompt says.
     */
    targets: [TOOLS.telegramPin, TOOLS.slackPin],
    message: 'Pinning shows a message to everyone. A mod must approve it in Slack.',
  },
  /** App-side token bucket that feeds the cooldown policy. */
  rateLimit: {
    perChatPerMinute: 6,
    globalPerMinute: 30,
    cooldownMs: 60_000,
  },
} as const

export type Guardrails = typeof guardrails

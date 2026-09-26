import { z } from 'zod'

// Every field is optional with a safe default so the app boots in mock mode
// with an empty environment. Empty strings are treated as "not set".

const opt = z
  .string()
  .optional()
  .transform((v) => (v && v.trim() ? v.trim() : undefined))

const bool = (def: boolean) =>
  z
    .string()
    .optional()
    .transform((v) => (v === undefined || v.trim() === '' ? def : /^(1|true|yes|on)$/i.test(v.trim())))

const schema = z.object({
  MODE: z
    .string()
    .optional()
    .transform((v) => (v === 'live' || v === 'replay' || v === 'mock' ? v : undefined)),
  PORT: z
    .string()
    .optional()
    .transform((v) => (v && Number.isFinite(Number(v)) ? Number(v) : 3210)),
  POLLER_ENABLED: bool(true),
  PUBLIC_URL: opt,

  SWYTCHCODE_BIN: opt,
  SWYTCHCODE_TOKEN: opt,
  /**
   * Swytchcode human approval (Business plan): pins need a mod's Approve in
   * Slack before they run. Needs a HITL provider on the workspace
   * (app.swytchcode.com → Settings → Workspaces → HITL Notifications).
   */
  SWYTCHCODE_HITL: bool(false),

  GOOGLE_GENERATIVE_AI_API_KEY: opt,
  GROQ_API_KEY: opt,
  ANTHROPIC_API_KEY: opt,
  LLM_CHAIN: z
    .string()
    .optional()
    .transform(
      (v) =>
        v?.trim() ||
        'groq:openai/gpt-oss-120b,groq:qwen/qwen3.8-27b,groq:openai/gpt-oss-20b,google:gemini-3.5-flash-lite,google:gemini-3.1-flash-lite,anthropic:claude-haiku-4-5-20251001',
    ),
  CONSOLE_CHAIN: z
    .string()
    .optional()
    .transform((v) => v?.trim() || 'anthropic:claude-haiku-4-5-20251001,groq:openai/gpt-oss-120b,google:gemini-3.5-flash-lite'),
  TRIAGE_CHAIN: z
    .string()
    .optional()
    .transform((v) => v?.trim() || 'groq:openai/gpt-oss-20b,groq:qwen/qwen3.8-27b,google:gemini-3.5-flash-lite'),

  TELEGRAM_BOT_TOKEN: opt,
  TELEGRAM_COMMUNITY_CHAT_ID: opt,
  TELEGRAM_JOIN_URL: opt,

  SLACK_BOT_TOKEN: opt,
  SLACK_GENERAL_CHANNEL_ID: opt,
  SLACK_ESCALATION_CHANNEL_ID: opt,
  SLACK_SOCIAL_CHANNEL_ID: opt,
  SLACK_INVITE_URL: opt,
  /** Scripted demo scenarios post here (defaults to SLACK_GENERAL_CHANNEL_ID). */
  DEMO_SLACK_CHANNEL_ID: opt,

  NOTION_TOKEN: opt,
  NOTION_DATABASE_ID: opt,

  RESEND_API_KEY: opt,
  DIGEST_TO: opt,
  DIGEST_FROM: z
    .string()
    .optional()
    .transform((v) => v?.trim() || 'Pulse <onboarding@resend.dev>'),
  /** Extra recipients the agent may email (comma-separated). DIGEST_TO is always allowed. */
  EMAIL_ALLOWLIST: opt,

  // ── Community profile (what Pulse knows about the community it serves) ──
  COMMUNITY_NAME: z
    .string()
    .optional()
    .transform((v) => v?.trim() || 'Build with Swytchcode · Gurgaon'),
  COMMUNITY_ABOUT: z
    .string()
    .optional()
    .transform(
      (v) =>
        v?.trim() ||
        'A one-day solo buildathon at Thoughtworks Gurgaon where developers build AI agents on Swytchcode APIs.',
    ),
  /** Domains Pulse may link to (links-allowlist policy). */
  ALLOWED_LINK_DOMAINS: z
    .string()
    .optional()
    .transform((v) =>
      (v?.trim() || 'notion.so,notion.site,t.me,slack.com,swytchcode.com,commudle.com,github.com,forms.gle,resend.com')
        .split(',')
        .map((d) => d.trim().toLowerCase())
        .filter(Boolean),
    ),
  /** Minutes before an unanswered question counts as ignored. */
  IGNORED_AFTER_MIN: z
    .string()
    .optional()
    .transform((v) => (v && Number.isFinite(Number(v)) ? Number(v) : 10)),
  SWEEP_EVERY_MIN: z
    .string()
    .optional()
    .transform((v) => (v && Number.isFinite(Number(v)) ? Number(v) : 5)),
  /** If set, write actions on the dashboard (console, approvals, demo) need this token. */
  ADMIN_TOKEN: opt,

  // ── Organizer notifications + phone app ──
  /** Email the organizer (DIGEST_TO) whenever something needs them. */
  NOTIFY_EMAIL: bool(true),
  /** Minutes between bundled "needs you" emails (urgent ones go out right away). */
  NOTIFY_BUNDLE_MIN: z
    .string()
    .optional()
    .transform((v) => (v && Number.isFinite(Number(v)) && Number(v) > 0 ? Number(v) : 3)),
  /** Also notify for scripted demo traffic (so the phone buzzes on stage). */
  NOTIFY_SCRIPTED: bool(true),
  /** Name shown when an organizer replies to a member from the Pulse app. */
  ORGANIZER_NAME: z
    .string()
    .optional()
    .transform((v) => v?.trim() || 'the team'),
  /** `cloudflared`: open a free HTTPS tunnel so the phone app works anywhere. */
  TUNNEL: z
    .string()
    .optional()
    .transform((v) => (v?.trim().toLowerCase() === 'cloudflared' ? 'cloudflared' : undefined)),
  CLOUDFLARED_BIN: opt,
})

export type Env = z.infer<typeof schema> & { MODE: 'live' | 'replay' | 'mock' }

function load(source: NodeJS.ProcessEnv): Env {
  const parsed = schema.parse(source)
  const hasAnyLLM = !!(parsed.GOOGLE_GENERATIVE_AI_API_KEY || parsed.GROQ_API_KEY || parsed.ANTHROPIC_API_KEY)
  // Default: live when an LLM key exists, otherwise mock (offline-safe boot).
  const MODE = parsed.MODE ?? (hasAnyLLM ? 'live' : 'mock')
  return { ...parsed, MODE }
}

export let env: Env = load(process.env)

/** Tests only: re-read the environment (e.g. after mutating process.env). */
export function reloadEnv(source: NodeJS.ProcessEnv = process.env): Env {
  env = load(source)
  return env
}

export const hasTelegram = (): boolean => !!env.TELEGRAM_BOT_TOKEN
export const hasSlack = (): boolean => !!env.SLACK_BOT_TOKEN
export const hasNotion = (): boolean => !!(env.NOTION_TOKEN && env.NOTION_DATABASE_ID)
export const hasResend = (): boolean => !!(env.RESEND_API_KEY && env.DIGEST_TO)
export const hasLLM = (): boolean => !!(env.GOOGLE_GENERATIVE_AI_API_KEY || env.GROQ_API_KEY || env.ANTHROPIC_API_KEY)

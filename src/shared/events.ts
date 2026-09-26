// Shared contract between the Pulse server and the dashboard.
// Every event the server emits on the bus is one of these, and the dashboard
// renders purely from this stream plus the /api/state snapshot.

export type Platform = 'telegram' | 'slack' | 'whatsapp' | 'web'
export type ChatType = 'group' | 'dm' | 'web'

export interface InboundMessage {
  platform: Platform
  chatId: string
  chatType: ChatType
  chatTitle?: string
  userId: string
  userName: string
  text: string
  msgId: string
  replyToId?: string
  threadTs?: string
  /** true when the message mentions / replies to the bot or is a DM */
  addressed: boolean
  ts: number
  /** posted by a scripted demo persona (never counted as real traffic) */
  simulated?: boolean
  avatarUrl?: string
  /** new member joined (Telegram service message) */
  joined?: boolean
}

/** What started an agent run. */
export type RunOrigin = 'community' | 'mod' | 'console' | 'sweep' | 'digest' | 'approval'

export type StepKind =
  | 'context'
  | 'think'
  | 'mood'
  | 'search'
  | 'reply'
  | 'mods'
  | 'knowledge'
  | 'flag'
  | 'react'
  | 'silent'
  | 'welcome'
  | 'preview'
  | 'approval'
  | 'execute'
  | 'email'
  | 'discover'
  | 'inspect'
  | 'stats'
  | 'guard'
  | 'error'

export type StepStatus = 'start' | 'ok' | 'error' | 'blocked' | 'waiting'

export interface RunStep {
  index: number
  kind: StepKind
  status: StepStatus
  title: string
  /** short human sentence: what happened / why the agent chose this */
  detail?: string
  /** redacted structured payload (tool args, swy request, result preview …) */
  data?: unknown
  /** canonical Swytchcode ids touched by this step */
  tools?: string[]
  durationMs?: number
  model?: string
}

export type RunOutcome =
  | 'answered'
  | 'asked_mods'
  | 'escalated'
  | 'silent'
  | 'welcomed'
  | 'learned'
  | 'proposed'
  | 'awaiting_approval'
  | 'executed'
  | 'reported'
  | 'failed'

export interface RunSummary {
  runId: string
  origin: RunOrigin
  platform?: Platform
  chatId?: string
  userName?: string
  input: string
  simulated?: boolean
  startedAt: number
  steps: RunStep[]
  outcome?: RunOutcome
  summary?: string
  reply?: string
  durationMs?: number
  model?: string
}

export type ServiceName = 'telegram' | 'slack' | 'whatsapp' | 'notion' | 'resend' | 'llm' | 'swytchcode'
export interface ServiceStatus {
  state: 'up' | 'degraded' | 'down' | 'disabled'
  detail?: string
  at: number
}

export interface Counters {
  messages: number
  questions: number
  answered: number
  answeredFromKb: number
  askedMods: number
  learned: number
  escalations: number
  guardrailBlocks: number
  swyCalls: number
  members: number
}

export interface SelfTestResult {
  name: string
  expect: 'block' | 'pass' | 'approval'
  got: 'block' | 'pass' | 'approval' | 'error'
  ok: boolean
  policyId?: string
  detail?: string
}

export type GuardrailKind = 'secret' | 'rate_limit' | 'dm_non_member' | 'allowlist' | 'mass_mention' | 'link' | 'email_recipient' | 'quota' | 'policy'

export type KbSourceKind = 'Seed' | 'Mod' | 'Member' | 'Organizer'
export interface KbItem {
  id: string
  url: string
  question: string
  answer: string
  type: 'FAQ' | 'Announcement' | 'Digest'
  source: KbSourceKind
  status: 'Live' | 'Pending' | 'Archived'
  used: number
  learnedFrom?: string
  thread?: string
  scripted: boolean
  updatedAt: number
  createdAt: number
}

export interface DryRunPreview {
  method: string
  url: string
  body?: unknown
}

export interface ApprovalAction {
  tool: string
  label: string
  args: unknown
  preview?: DryRunPreview
  /** policy that blocked the dry-run, if any: the action cannot run */
  blocked?: string
  /** Telegram/Slack post: pin the message after sending */
  pin?: boolean
  /** executor hints (e.g. the knowledge entry to create) */
  meta?: Record<string, unknown>
  /** filled after execution */
  result?: string
  ok?: boolean
  /** Swytchcode human approval on this action's pin (REQUIRES_APPROVAL, Business plan) */
  hold?: SwyHold
}

export interface SwyHold {
  tool: string
  /** required = dry-run says a mod must approve; pending = waiting in Slack; failed = Swytchcode couldn't open the request */
  status: 'required' | 'pending' | 'approved' | 'rejected' | 'expired' | 'failed'
  /** Swytchcode audit id (`swy audit policy --info <id>`) */
  auditId?: string
  message?: string
  requestedAt?: number
  resolvedAt?: number
}

export type ApprovalKind = 'announcement' | 'knowledge' | 'poll' | 'email' | 'capability' | 'pin' | 'post'
export interface Approval {
  id: string
  runId?: string
  kind: ApprovalKind
  title: string
  summary: string
  actions: ApprovalAction[]
  status: 'pending' | 'approved' | 'rejected' | 'executed' | 'failed'
  requestedBy: string
  createdAt: number
  decidedAt?: number
  decidedBy?: string
  result?: string
  slackTs?: string
  simulated?: boolean
}

export interface AttentionItem {
  id: string
  kind: 'frustrated' | 'ignored' | 'needs_human'
  platform: Platform
  chatId: string
  msgId?: string
  userId: string
  userName: string
  text: string
  reason: string
  status: 'open' | 'resolved'
  ts: number
  simulated?: boolean
  /** the member's case (mood tracking) this escalation belongs to */
  caseId?: string
  /** the #mods card, so follow-ups land in the same thread */
  modsTs?: string
}

// ── member mood + cases ─────────────────────────────────────────────────────

export type Emotion = 'happy' | 'grateful' | 'calm' | 'confused' | 'anxious' | 'annoyed' | 'angry' | 'desperate'

export interface MoodPoint {
  ts: number
  /** -1 (very upset) … +1 (delighted) */
  score: number
  emotion?: Emotion
  by: 'member' | 'pulse' | 'organizer'
  text: string
  msgId?: string
  /** how the score was read: the mood model, or the keyword fallback */
  via?: 'llm' | 'keywords'
}

/**
 * A member with a problem, followed until it is solved. Opened when someone is
 * stuck or upset; each message moves their mood; Pulse brings in a human when
 * the trend says so; it closes when the member is happy again or a mod closes it.
 */
export interface MemberCase {
  id: string
  platform: Platform
  chatId: string
  userId: string
  userName: string
  status: 'open' | 'escalated' | 'resolved'
  /** what the problem is, in a few words */
  topic: string
  /** smoothed mood, -1 … +1 */
  mood: number
  points: MoodPoint[]
  /** member messages about the problem */
  asks: number
  pulseReplies: number
  humanReplies: number
  /** they asked for a person at some point */
  askedForHuman?: boolean
  openedAt: number
  updatedAt: number
  lastMemberAt: number
  lastReplyAt?: number
  lastMsgId?: string
  threadTs?: string
  escalatedAt?: number
  escalation?: { reason: string; attentionId?: string; modsTs?: string }
  resolvedAt?: number
  /** 'member' (they said it works), 'timeout', or the organizer's name */
  resolvedBy?: string
  resolution?: string
  simulated?: boolean
}

// ── organizer notifications (email + phone push) ───────────────────────────

export interface NotifyState {
  /** "needs you" emails go to this address (via Swytchcode → Resend) */
  emailTo?: string
  email: boolean
  /** phones subscribed to push */
  devices: number
  /** items waiting for the next bundled email */
  queued: number
  lastEmailAt?: number
  /** public HTTPS address (Cloudflare tunnel), used in email links and the phone QR */
  publicUrl?: string
  tunnel: 'off' | 'starting' | 'up' | 'down'
}

// ── WhatsApp (linked device via Baileys) ────────────────────────────────────

export interface WhatsAppGroup {
  jid: string
  name: string
  size: number
  /** Pulse only listens and replies in groups the organizer turned on */
  enabled: boolean
}

export interface WhatsAppState {
  status: 'off' | 'connecting' | 'qr' | 'connected' | 'logged_out'
  /** pairing QR as a data URL, while status is 'qr' */
  qr?: string
  /** the linked account (Pulse speaks as this number) */
  me?: { name?: string; number?: string }
  groups: WhatsAppGroup[]
  /** answer DMs from members of an enabled group */
  dms: boolean
}

export interface PendingQuestion {
  id: string
  platform: Platform
  chatId: string
  msgId: string
  userName: string
  question: string
  draft?: string
  modsThreadTs?: string
  status: 'waiting' | 'answered'
  askedAt: number
  answeredAt?: number
  answeredBy?: string
  answer?: string
  simulated?: boolean
}

export interface ScenarioState {
  id?: string
  title?: string
  status: 'idle' | 'running' | 'paused' | 'done'
  beat: number
  beats: number
  speed: number
  caption?: string
}

export type GtEvent =
  | { type: 'message.in'; ts: number; msg: InboundMessage }
  | { type: 'message.out'; ts: number; platform: Platform; chatId: string; text: string; runId?: string; replyToId?: string; threadTs?: string; msgId?: string; simulated?: boolean }
  | { type: 'run.start'; ts: number; runId: string; origin: RunOrigin; platform?: Platform; chatId?: string; userName?: string; input: string; simulated?: boolean }
  | { type: 'run.step'; ts: number; runId: string; step: RunStep }
  | { type: 'run.end'; ts: number; runId: string; outcome: RunOutcome; summary?: string; reply?: string; durationMs: number; model?: string }
  | {
      type: 'swy.call'
      ts: number
      callId: string
      runId?: string
      tool: string
      command: 'exec' | 'dry-run' | 'discover' | 'info' | 'list' | 'policy' | 'audit' | 'help'
      status: 'start' | 'ok' | 'error'
      durationMs?: number
      category?: string
      auditIds?: string[]
      argsPreview?: string
      resultPreview?: string
      cached?: boolean
    }
  | { type: 'guardrail'; ts: number; kind: GuardrailKind; policyId?: string; auditId?: string; platform?: Platform; chatId?: string; tool?: string; detail: string; runId?: string }
  | { type: 'kb'; ts: number; action: 'synced' | 'added' | 'used' | 'updated' | 'archived'; entry?: KbItem; entries?: KbItem[] }
  | { type: 'approval'; ts: number; approval: Approval }
  | { type: 'attention'; ts: number; item: AttentionItem }
  | { type: 'pending'; ts: number; item: PendingQuestion }
  | { type: 'status'; ts: number; service: ServiceName; status: ServiceStatus }
  | { type: 'selftest'; ts: number; results: SelfTestResult[] }
  | { type: 'digest'; ts: number; status: 'sent' | 'skipped' | 'error'; detail: string; runId?: string }
  | { type: 'scenario'; ts: number; state: ScenarioState }
  | { type: 'case'; ts: number; item: MemberCase }
  | { type: 'notify'; ts: number; state: NotifyState; sent?: { channel: 'email' | 'push'; ok: boolean; detail: string } }
  | { type: 'whatsapp'; ts: number; state: WhatsAppState }
  | { type: 'log'; ts: number; level: 'info' | 'warn' | 'error'; text: string }

/** Monotonic id attached by the server so clients can resume (poll transport). */
export type SequencedEvent = GtEvent & { seq: number }

export interface Helper {
  userName: string
  platform: Platform
  answers: number
  simulated?: boolean
}

export interface StateSnapshot {
  seq: number
  mode: 'live' | 'mock' | 'replay'
  startedAt: number
  community: { name: string; about: string }
  services: Record<ServiceName, ServiceStatus>
  /** real traffic only */
  counters: Counters
  /** scripted demo traffic */
  scripted: Counters
  medianResponseMs?: number
  messages: InboundMessage[]
  outgoing: Array<Extract<GtEvent, { type: 'message.out' }>>
  runs: RunSummary[]
  kb: KbItem[]
  approvals: Approval[]
  attention: AttentionItem[]
  pending: PendingQuestion[]
  cases: MemberCase[]
  notify: NotifyState
  whatsapp: WhatsAppState
  helpers: Helper[]
  guardrails: Array<Extract<GtEvent, { type: 'guardrail' }>>
  selftest: SelfTestResult[]
  swyCalls: Array<Extract<GtEvent, { type: 'swy.call' }>>
  swyStats: { byProvider: Record<string, number>; p50Ms: number; policyBlocks: number; dryRuns: number; total: number }
  scenario: ScenarioState
  links: { telegramJoinUrl?: string; slackInviteUrl?: string; telegramBotUsername?: string; notionUrl?: string }
  channels: Array<{ platform: Platform; chatId: string; title: string; role: 'community' | 'mods' }>
}

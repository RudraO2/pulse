import os from 'node:os'
import path from 'node:path'
import type { PushSubscription } from 'web-push'
import { bus } from './bus.js'
import { env, hasLLM, hasNotion, hasResend, hasSlack, hasTelegram } from './config/env.js'
import { registerLearningFollowUps } from './agent/learn.js'
import { SlackAdapter } from './channels/slack.js'
import { TelegramAdapter } from './channels/telegram.js'
import { WhatsAppAdapter } from './channels/whatsapp.js'
import { decide, startApprovalWatcher } from './core/approvals.js'
import { channels } from './core/channels.js'
import { getPending, resolveAttention } from './core/state-docs.js'
import { getCase, handedOff, linkCasesToAttention, replyToMember, resolveCase } from './core/cases.js'
import { onApprovalExecuted } from './core/approvals.js'
import { postModsCard, quote } from './core/mods.js'
import { addDevice, adminToken, ensureAdminToken, notifyState, pushToDevices, removeDevice, startNotifier, vapidPublicKey, verifyItem } from './core/notify.js'
import { startTunnel, stopTunnel } from './core/tunnel.js'
import { handleModReply } from './agent/learn.js'
import { startKnowledgeSync, syncKnowledge } from './kb/knowledge.js'
import { createPipeline, ingest, rewatchPending } from './pipeline.js'
import { createApp, startServer } from './server/app.js'
import { createStateStore } from './server/state.js'
import { openDb } from './store/db.js'
import { sweepStalePending } from './store/outbox.js'
import { swyAuditNetwork, swyAuditPolicy, swyListTooling, swyVersion } from './swy/exec.js'
import { addDmMember, applyPolicies, getPolicyState } from './swy/policies.js'
import { prepareRuntimeDir } from './swy/runtime-dir.js'
import { runGuardrailSelfTest } from './swy/selftest.js'
import { runConsole } from './agent/console.js'
import { sendDigest } from './jobs/digest.js'
import { runSweep, startScheduler } from './jobs/scheduler.js'
import { demo, listScenarios } from './demo/engine.js'

// Pulse: boot order matters. Swytchcode runtime + policies first (so nothing
// can post before the guardrails are live), then knowledge, then channels.

const log = (text: string) => {
  console.log(`[Pulse] ${text}`)
  bus.emit({ type: 'log', level: 'info', text })
}

async function main(): Promise<void> {
  prepareRuntimeDir()
  openDb()
  const stale = sweepStalePending()
  const store = createStateStore()

  // ── Swytchcode ────────────────────────────────────────────────────────────
  const version = await swyVersion().catch(() => 'unknown')
  const { warnings } = await applyPolicies({ force: true })
  const tooling = await swyListTooling().catch(() => [])
  bus.emit({ type: 'status', service: 'swytchcode', status: { state: 'up', detail: `v${version} · ${tooling.length} tools allowed · policies live`, at: Date.now() } })
  log(`swytchcode ${version}: ${tooling.length} allow-listed tools, policies applied${warnings.length ? ` (${warnings.length} warnings)` : ''}${stale ? `, ${stale} stale sends quarantined` : ''}`)
  void runGuardrailSelfTest().then((r) => log(`guardrail self-test: ${r.filter((x) => x.ok).length}/${r.length} passed`))

  bus.emit({ type: 'status', service: 'llm', status: { state: hasLLM() ? 'up' : 'disabled', detail: hasLLM() ? 'model chains ready' : 'no LLM key', at: Date.now() } })
  bus.emit({ type: 'status', service: 'resend', status: { state: hasResend() ? 'up' : 'disabled', detail: hasResend() ? `digest → ${env.DIGEST_TO}` : 'RESEND_API_KEY / DIGEST_TO not set', at: Date.now() } })

  // ── knowledge ─────────────────────────────────────────────────────────────
  if (hasNotion()) {
    const n = await syncKnowledge()
    startKnowledgeSync()
    log(`knowledge base: ${n} entries from Notion`)
  }

  // ── agents ────────────────────────────────────────────────────────────────
  const batcher = createPipeline()
  registerLearningFollowUps()
  // Cases first: an escalation gets linked to its case before the notifier describes it.
  linkCasesToAttention()
  // An approved reply to a member (from their card) takes it off the organizer's list; Pulse keeps watching.
  onApprovalExecuted('post', (a) => {
    const m = a.actions[0]?.meta?.member as { caseId?: string; attentionId?: string; reply?: string } | undefined
    if (m) handedOff(m, env.ORGANIZER_NAME)
  })
  startNotifier({ caseOf: (id) => (id ? getCase(id) : undefined) })
  // Anything reachable through the tunnel needs a token; this laptop stays trusted.
  if (env.TUNNEL) ensureAdminToken()

  const onMessage = async (msg: Parameters<typeof ingest>[0]) => {
    // Telegram DMs: verify membership through Swytchcode; the answer feeds the DM policy.
    if (msg.platform === 'telegram' && msg.chatType === 'dm' && channels.telegram) {
      const member = await channels.telegram.isMember(msg.userId)
      if (member) await addDmMember('telegram', msg.chatId)
    }
    ingest(msg)
  }

  // ── channels ──────────────────────────────────────────────────────────────
  const channelList: Parameters<typeof store.setChannels>[0] = []
  if (hasTelegram() && env.POLLER_ENABLED) {
    const tg = new TelegramAdapter({
      onMessage: (m) => void onMessage(m),
      beginBacklog: () => batcher.beginBacklog('telegram'),
      endBacklog: () => batcher.endBacklog('telegram'),
    })
    channels.telegram = tg
    try {
      await tg.start()
      if (tg.botUsername) store.setLinks({ telegramBotUsername: tg.botUsername })
      if (env.TELEGRAM_COMMUNITY_CHAT_ID) channelList.push({ platform: 'telegram', chatId: env.TELEGRAM_COMMUNITY_CHAT_ID, title: 'Telegram group', role: 'community' })
      log(`telegram: @${tg.botUsername} polling`)
    } catch (e) {
      bus.emit({ type: 'status', service: 'telegram', status: { state: 'down', detail: String((e as Error).message).slice(0, 120), at: Date.now() } })
      channels.telegram = undefined
    }
  }
  if (hasSlack() && env.POLLER_ENABLED) {
    // The mods channel is never a community channel, even if misconfigured to the same id.
    const community = [...new Set([env.SLACK_GENERAL_CHANNEL_ID, env.SLACK_SOCIAL_CHANNEL_ID])].filter((x): x is string => !!x && x !== env.SLACK_ESCALATION_CHANNEL_ID)
    const slack = new SlackAdapter(
      { onMessage: (m) => void onMessage(m), beginBacklog: () => batcher.beginBacklog('slack'), endBacklog: () => batcher.endBacklog('slack') },
      community.map((id) => ({ id, role: 'community' as const })),
    )
    channels.slack = slack
    try {
      await slack.start()
      if (env.SLACK_GENERAL_CHANNEL_ID) channelList.push({ platform: 'slack', chatId: env.SLACK_GENERAL_CHANNEL_ID, title: '#general', role: 'community' })
      if (env.SLACK_SOCIAL_CHANNEL_ID && community.includes(env.SLACK_SOCIAL_CHANNEL_ID)) channelList.push({ platform: 'slack', chatId: env.SLACK_SOCIAL_CHANNEL_ID, title: '#social', role: 'community' })
      if (env.SLACK_ESCALATION_CHANNEL_ID) channelList.push({ platform: 'slack', chatId: env.SLACK_ESCALATION_CHANNEL_ID, title: '#mods', role: 'mods' })
      log(`slack: polling ${community.length} community channel(s)`)
      startApprovalWatcher()
      rewatchPending()
    } catch (e) {
      bus.emit({ type: 'status', service: 'slack', status: { state: 'down', detail: String((e as Error).message).slice(0, 120), at: Date.now() } })
      channels.slack = undefined
    }
  }
  if (env.WHATSAPP_ENABLED && env.POLLER_ENABLED) {
    // Linked device: reconnects by itself if this laptop was linked before, else waits for a QR scan.
    const wa = new WhatsAppAdapter({
      onMessage: (m) => void onMessage(m),
      beginBacklog: () => batcher.beginBacklog('whatsapp'),
      endBacklog: () => batcher.endBacklog('whatsapp'),
    })
    channels.whatsapp = wa
    await wa.start().catch((e) => bus.emit({ type: 'status', service: 'whatsapp', status: { state: 'down', detail: String((e as Error).message).slice(0, 120), at: Date.now() } }))
    log(`whatsapp: ${wa.state().status === 'off' ? 'not linked (scan the QR in the dashboard)' : 'linked device reconnecting'}`)
  }
  store.setChannels(channelList)
  startScheduler()

  // ── HTTP ──────────────────────────────────────────────────────────────────
  const app = createApp({
    store,
    webRoot: path.resolve('dist', 'web'),
    adminToken: () => adminToken(),
    onConsole: (text, about) => runConsole(text, { about }),
    onApproval: (id, decision, by) => decide(id, decision, by),
    onResolveAttention: async (id) => resolveAttention(id),
    onDigest: () => sendDigest({ trigger: 'manual' }),
    onSelftest: () => runGuardrailSelfTest(),
    onSweep: () => runSweep(),
    onKbSync: async () => ({ entries: await syncKnowledge() }),
    guardrails: async () => ({ policies: (await applyPolicies()).policies, state: getPolicyState(), tooling: await swyListTooling().catch(() => []) }),
    audit: async () => ({ network: await swyAuditNetwork(60).catch(() => []), policy: await swyAuditPolicy(60).catch(() => []) }),
    scenarios: () => listScenarios(),
    onDemo: (action, body) => demo(action, body, store),
    whatsapp: channels.whatsapp
      ? {
          link: () => channels.whatsapp!.link(),
          logout: () => channels.whatsapp!.logout(),
          refresh: () => channels.whatsapp!.refreshGroups(),
          setGroup: async (jid, enabled) => channels.whatsapp!.setGroup(jid, enabled),
          setDms: async (enabled) => channels.whatsapp!.setDms(enabled),
        }
      : undefined,
    onCaseResolve: async (id, by) => (id.startsWith('at_') ? resolveAttention(id) : resolveCase(id, by)) ?? { error: 'not found' },
    onCaseReply: (id, text) => replyToMember(id, text, env.ORGANIZER_NAME),
    onAnswerPending: async (id, text) => {
      const p = getPending(id)
      if (!p || p.status !== 'waiting') return { error: 'already answered' }
      const by = env.ORGANIZER_NAME === 'the team' ? 'An organizer' : env.ORGANIZER_NAME
      if (p.modsThreadTs) void postModsCard(`💬 ${by} answered from the Pulse app:\n${quote(text)}`, { threadTs: p.modsThreadTs })
      void handleModReply(id, { userName: by, text }).catch((e) => bus.emit({ type: 'log', level: 'error', text: `learning loop: ${(e as Error).message}` }))
      return { ok: true }
    },
    pair: async () => {
      const token = ensureAdminToken()
      const n = notifyState()
      const lan = Object.values(os.networkInterfaces())
        .flat()
        .find((i) => i && i.family === 'IPv4' && !i.internal && !i.address.startsWith('169.254'))?.address
      return {
        tunnel: n.tunnel,
        publicUrl: n.publicUrl,
        url: n.publicUrl ? `${n.publicUrl}/m/?token=${token}` : undefined,
        lanUrl: lan ? `http://${lan}:${server.port}/m/?token=${token}` : undefined,
        devices: n.devices,
      }
    },
    push: {
      key: vapidPublicKey,
      subscribe: async (sub, ua) => addDevice(sub as PushSubscription, ua),
      unsubscribe: async (endpoint) => removeDevice(endpoint),
      test: async () => ({
        sent: await pushToDevices({ id: `test_${Date.now()}`, kind: 'member', title: 'Pulse is connected', body: 'Anything that needs you will show up here.', urgent: false, at: Date.now() }),
      }),
    },
    quick: async (id, action, sig) => {
      if (!verifyItem(id, sig)) return { ok: false, error: 'bad signature', status: 403 }
      if (id.startsWith('ap_') && (action === 'approve' || action === 'reject')) {
        const a = await decide(id, action, 'Organizer (phone)')
        return { ok: !!a, result: a?.status }
      }
      if (id.startsWith('at_') && action === 'resolve') return { ok: !!resolveAttention(id) }
      return { ok: false, error: 'unsupported action', status: 400 }
    },
  })
  const server = await startServer(app, env.PORT)
  log(`dashboard on http://localhost:${server.port} (mode ${env.MODE})`)
  void startTunnel(server.port)

  const shutdown = async () => {
    log('shutting down')
    stopTunnel()
    await Promise.allSettled([channels.telegram?.stop(), channels.slack?.stop(), channels.whatsapp?.stop()])
    batcher.stop()
    store.stop()
    await server.close()
    process.exit(0)
  }
  process.on('SIGINT', () => void shutdown())
  process.on('SIGTERM', () => void shutdown())
}

main().catch((e) => {
  console.error('[Pulse] fatal', e)
  process.exit(1)
})

// Live spike: every Telegram call goes through Swytchcode (token patched into
// the runtime manifest). Prints chat ids so TELEGRAM_COMMUNITY_CHAT_ID can be set.
import { prepareRuntimeDir } from '../src/swy/runtime-dir.js'
import { swyExec } from '../src/swy/exec.js'
import { env } from '../src/config/env.js'

const unwrap = (d: any) => (d && typeof d === 'object' && 'ok' in d ? d.result : d)

async function main() {
  if (!env.TELEGRAM_BOT_TOKEN) throw new Error('TELEGRAM_BOT_TOKEN missing')
  prepareRuntimeDir()

  const me = unwrap((await swyExec('telegram_v5_0.getme.create', { body: {} })).data)
  console.log(`✓ getMe → @${me.username} (id ${me.id})`)

  const updates: any[] = unwrap((await swyExec('telegram_v5_0.getupdate.create', { body: { timeout: 0, limit: 100 } })).data) ?? []
  console.log(`✓ getUpdates → ${updates.length} pending update(s)`)
  const chats = new Map<string, { title: string; type: string; lastFrom?: any; lastMsg?: number }>()
  for (const u of updates) {
    const m = u.message ?? u.edited_message ?? u.my_chat_member
    if (!m?.chat) continue
    chats.set(String(m.chat.id), { title: m.chat.title ?? m.chat.username ?? m.chat.first_name, type: m.chat.type, lastFrom: m.from, lastMsg: m.message_id })
  }
  for (const [id, c] of chats) console.log(`   chat ${id}  type=${c.type}  title="${c.title}"`)

  const group = [...chats.entries()].find(([, c]) => c.type === 'group' || c.type === 'supergroup')
  const target = env.TELEGRAM_COMMUNITY_CHAT_ID ?? group?.[0]
  if (!target) {
    console.log('✗ no group message seen yet: send "hello @' + me.username + '" in the group and re-run')
    return
  }
  console.log(`→ using community chat ${target}`)

  const sent = unwrap((await swyExec('telegram_v5_0.sendmessage.create', {
    body: { chat_id: target, text: '🔎 <b>Ground Truth</b> spike: verifying Telegram round-trip through Swytchcode…', parse_mode: 'HTML' },
  })).data)
  console.log(`✓ sendMessage → message_id ${sent.message_id}`)

  await swyExec('telegram_v5_0.sendchataction.create', { body: { chat_id: target, action: 'typing' } })
  console.log('✓ sendChatAction typing')

  await swyExec('telegram_v5_0.editmessagetext.create', {
    body: { chat_id: target, message_id: sent.message_id, text: '✅ <b>Ground Truth</b> is live: send, edit and read all go through Swytchcode.', parse_mode: 'HTML' },
  })
  console.log('✓ editMessageText')

  const from = group?.[1].lastFrom
  if (from) {
    const member = unwrap((await swyExec('telegram_v5_0.getchatmember.create', { body: { chat_id: target, user_id: from.id } })).data)
    console.log(`✓ getChatMember(${from.first_name}) → ${member.status}`)
    const botMember = unwrap((await swyExec('telegram_v5_0.getchatmember.create', { body: { chat_id: target, user_id: me.id } })).data)
    console.log(`✓ bot status in group → ${botMember.status}${botMember.status === 'administrator' ? '' : '  ⚠ make the bot an admin'}`)
  }

  // Guardrail: a secret-looking reply must be blocked by the Swytchcode policy before it reaches Telegram.
  try {
    await swyExec('telegram_v5_0.sendmessage.create', { body: { chat_id: target, text: 'leak test ghp_' + 'a'.repeat(36) } })
    console.log('✗ secret was NOT blocked (policies not applied?)')
  } catch (e: any) {
    console.log(`✓ secret blocked by policy → category=${e.category} policy=${e.policyId ?? '?'}`)
  }
  console.log(`\nTELEGRAM_COMMUNITY_CHAT_ID=${target}`)
}

main().catch(e => {
  console.error('✗ spike failed:', e.category ?? '', e.message)
  process.exit(1)
})

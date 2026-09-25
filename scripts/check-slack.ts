// Checks the bot can read each configured Slack channel and has the scopes Pulse needs.
//   npx tsx --env-file-if-exists=.env scripts/check-slack.ts
import { env } from '../src/config/env.js'
import { swyExec } from '../src/swy/exec.js'
import { prepareRuntimeDir } from '../src/swy/runtime-dir.js'

prepareRuntimeDir()
const chans = { general: env.SLACK_GENERAL_CHANNEL_ID, social: env.SLACK_SOCIAL_CHANNEL_ID, mods: env.SLACK_ESCALATION_CHANNEL_ID }
for (const [name, id] of Object.entries(chans)) {
  if (!id) { console.log(`${name}: not set`); continue }
  try {
    const info = await swyExec<{ channel?: { name?: string; is_private?: boolean; is_member?: boolean } }>('slack.conversations.info.list', { params: { channel: id } })
    const c = info.data.channel
    let read = 'ok'
    try { await swyExec('slack.conversations.history.list', { params: { channel: id, limit: 1 } }) } catch (e) { read = (e as Error).message.replace(/.*\(/, '(') }
    console.log(`${name}: #${c?.name} private=${c?.is_private} member=${c?.is_member} history=${read}`)
  } catch (e) {
    console.log(`${name}: ${(e as Error).message}`)
  }
}

import { generateText, tool } from 'ai'
import { z } from 'zod'
import { bus } from '../bus.js'
import { env, hasResend } from '../config/env.js'
import { lightModel } from '../agent/models.js'
import { digestInstructions } from '../agent/prompts.js'
import { reportBlock } from '../core/channels.js'
import { modsAvailable, postModsCard } from '../core/mods.js'
import { startRun } from '../core/runs.js'
import { communityStats, type CommunityStats } from '../core/stats.js'
import { addKnowledge } from '../kb/knowledge.js'
import { swyExec } from '../swy/exec.js'

// The community digest: stats → the agent writes it → Resend email to the
// organizers (idempotency key per day/trigger) → short summary in #mods →
// a Digest page in Notion so there's a history.

interface Digest {
  subject: string
  headline: string
  sections: Array<{ title: string; bullets: string[] }>
}

function fallbackDigest(s: CommunityStats): Digest {
  return {
    subject: `${env.COMMUNITY_NAME}: ${s.questions} questions, ${s.knowledge.learnedInWindow.length} new answers learned`,
    headline: `${s.activeMembers} members sent ${s.messages} messages in the last ${s.window}. Pulse answered ${s.answeredByPulse} questions; organizers answered ${s.answeredByHumans}.`,
    sections: [
      { title: 'Top questions', bullets: s.knowledge.mostUsed.map((k) => `${k.question} (${k.used}×)`) },
      { title: 'What Pulse learned', bullets: s.knowledge.learnedInWindow.map((k) => `${k.question}, from ${k.learnedFrom ?? k.source}`) },
      { title: 'Knowledge gaps', bullets: [...s.waitingOnOrganizers.map((w) => `${w.question} (${w.userName}, waiting ${w.minutesWaiting} min)`), ...s.unanswered.map((u) => `${u.text} (${u.userName})`)] },
      { title: 'People to thank', bullets: s.helpers.map((h) => `${h.userName}: ${h.answers} answer(s) saved`) },
      { title: 'Needs attention', bullets: s.needsAttention.map((a) => `${a.userName}: ${a.reason}`) },
    ].filter((x) => x.bullets.length),
  }
}

function renderHtml(d: Digest, s: CommunityStats): string {
  const esc = (t: string) => t.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
  const stat = (label: string, value: number | string) =>
    `<td style="padding:12px 16px;border:1px solid #e4e4e7;border-radius:8px"><div style="font-size:22px;font-weight:600;color:#18181b">${value}</div><div style="font-size:12px;color:#71717a">${label}</div></td>`
  return `<div style="font-family:Inter,Segoe UI,Helvetica,sans-serif;max-width:620px;margin:0 auto;color:#18181b;line-height:1.55">
  <p style="font-size:12px;letter-spacing:.08em;text-transform:uppercase;color:#6366f1;margin:0 0 4px">Pulse digest</p>
  <h1 style="font-size:20px;margin:0 0 8px">${esc(env.COMMUNITY_NAME)}</h1>
  <p style="font-size:15px;color:#3f3f46;margin:0 0 20px">${esc(d.headline)}</p>
  <table style="border-collapse:separate;border-spacing:8px;margin:0 -8px 12px"><tr>${stat('messages', s.messages)}${stat('questions', s.questions)}${stat('answered by Pulse', s.answeredByPulse)}${stat('answers learned', s.knowledge.learnedInWindow.length)}</tr></table>
  ${d.sections
    .map(
      (sec) =>
        `<h2 style="font-size:14px;margin:22px 0 6px;color:#18181b">${esc(sec.title)}</h2><ul style="margin:0;padding-left:18px;font-size:14px;color:#3f3f46">${sec.bullets.map((b) => `<li style="margin:3px 0">${esc(b)}</li>`).join('')}</ul>`,
    )
    .join('\n')}
  <p style="font-size:12px;color:#a1a1aa;margin-top:28px">Sent by Pulse via Swytchcode → Resend. Knowledge lives in your Notion database.</p>
</div>`
}

export async function sendDigest(opts: { trigger: 'manual' | 'weekly' | 'demo'; includeScripted?: boolean } = { trigger: 'manual' }): Promise<{ ok: boolean; detail: string; runId: string }> {
  const includeScripted = opts.includeScripted ?? opts.trigger === 'demo'
  const run = startRun('digest', `${opts.trigger} digest`, { simulated: opts.trigger === 'demo' })
  const s = communityStats({ sinceMs: opts.trigger === 'weekly' ? 7 * 24 * 3600_000 : 24 * 3600_000, includeScripted })
  run.steps.record('stats', 'Collect community stats', 'ok', `${s.messages} messages · ${s.questions} questions · ${s.knowledge.learnedInWindow.length} learned`, s)

  let digest = fallbackDigest(s)
  const model = lightModel()
  if (model) {
    const step = run.steps.begin('think', 'Write the digest')
    try {
      let composed: Digest | undefined
      await generateText({
        model,
        instructions: digestInstructions(),
        prompt: `DATA:\n${JSON.stringify(s, null, 1)}`,
        tools: {
          compose_digest: tool({
            description: 'Return the finished digest.',
            inputSchema: z.object({
              subject: z.string(),
              headline: z.string(),
              sections: z.array(z.object({ title: z.string(), bullets: z.array(z.string()) })),
            }),
            execute: async (d) => {
              composed = d
              return 'ok'
            },
          }),
        },
        toolChoice: 'required',
        maxRetries: 0,
        stopWhen: () => !!composed,
      })
      if (composed) digest = { ...composed, sections: composed.sections.filter((x) => x.bullets.length) }
      step.ok(digest.subject)
    } catch (e) {
      step.error(`model unavailable, using template (${String((e as Error).message).slice(0, 80)})`)
    }
  }

  let ok = false
  let detail = 'Resend not configured'
  if (hasResend() && env.DIGEST_TO) {
    const step = run.steps.begin('email', `Email the digest to ${env.DIGEST_TO}`, digest.subject, undefined, ['resend.email.create'])
    try {
      const key = `digest-${new Date().toISOString().slice(0, 13)}-${opts.trigger}-${run.id}`
      const r = await swyExec<{ id?: string }>(
        'resend.email.create',
        { body: { from: env.DIGEST_FROM, to: env.DIGEST_TO, subject: digest.subject, html: renderHtml(digest, s) }, headers: { 'Idempotency-Key': key } },
        { runId: run.id },
      )
      ok = true
      detail = `sent (${r.data?.id ?? 'ok'})`
      step.ok(detail)
    } catch (e) {
      const blocked = reportBlock(e, { runId: run.id })
      detail = blocked ? `blocked by ${blocked.policyId}` : String((e as Error).message).slice(0, 160)
      step.error(detail)
    }
  }

  if (modsAvailable()) {
    await postModsCard(`🗞️ **Digest sent** to ${env.DIGEST_TO ?? 'organizers'}: ${digest.headline}`, { runId: run.id })
  }
  try {
    await addKnowledge(
      {
        question: `Digest · ${new Date().toLocaleDateString('en-IN', { day: 'numeric', month: 'short', timeZone: 'Asia/Kolkata' })} · ${digest.subject}`,
        answer: [digest.headline, ...digest.sections.map((x) => `${x.title}: ${x.bullets.join('; ')}`)].join('\n'),
        type: 'Digest',
        source: 'Organizer',
        learnedFrom: 'Pulse digest',
        scripted: opts.trigger === 'demo',
      },
      run.id,
    )
    run.steps.record('knowledge', 'Archive the digest in Notion', 'ok', undefined, undefined, ['notion.page.create'])
  } catch {
    /* archive is best-effort */
  }

  bus.emit({ type: 'digest', status: ok ? 'sent' : 'error', detail, runId: run.id })
  run.end(ok ? 'reported' : 'failed', { summary: `${digest.subject}: ${detail}` })
  return { ok, detail, runId: run.id }
}

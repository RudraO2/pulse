import { generateText, isStepCount, tool } from 'ai'
import { z } from 'zod'
import { chatKey, writeHistory } from '../conversation/memory.js'
import { onApprovalExecuted } from '../core/approvals.js'
import { post } from '../core/channels.js'
import { platformLabel, postModsCard } from '../core/mods.js'
import { startRun } from '../core/runs.js'
import { getPending, savePending, waitingQuestions } from '../core/state-docs.js'
import { addKnowledge } from '../kb/knowledge.js'
import type { KbItem, PendingQuestion, Platform } from '../shared/events.js'
import { Bm25Index } from '../store/bm25.js'
import { creditHelper, markAnswered } from '../store/repo.js'
import { communityModel } from './models.js'
import { learnInstructions } from './prompts.js'

// The learning loop. An organizer answers once in Slack #mods; Pulse relays it
// to the member, turns it into a reusable Notion FAQ entry, and answers anyone
// else still waiting on the same question. Next time: instant answer.

export interface ModReply {
  userName: string
  text: string
  simulated?: boolean
}

const firstName = (n: string) => n.split(/\s+/)[0] ?? n

async function relay(p: PendingQuestion, text: string, runId: string): Promise<boolean> {
  const res = await post(p.platform, p.chatId, text, {
    runId,
    replyToId: p.platform === 'telegram' ? p.msgId : undefined,
    threadTs: p.platform === 'slack' ? p.msgId : undefined,
    simulated: p.simulated,
  })
  if (res.ok) {
    writeHistory(chatKey(p.platform, p.chatId), { sender: 'Pulse', text, ts: Date.now() })
    markAnswered(p.platform, p.chatId, [p.msgId], 'human', runId)
  }
  return res.ok
}

export async function handleModReply(pendingId: string, reply: ModReply): Promise<void> {
  const p = getPending(pendingId)
  if (!p || p.status !== 'waiting') return
  const model = communityModel()
  const run = startRun('mod', reply.text, { platform: p.platform, chatId: p.chatId, userName: reply.userName, simulated: p.simulated })
  run.steps.record('context', 'Organizer replied in #mods', 'ok', `${reply.userName}: “${reply.text.slice(0, 160)}”`, { question: p.question, member: p.userName })

  let relayed = false
  let saved: KbItem | undefined
  let notAnswer = false

  const doRelay = async (text: string): Promise<string> => {
    const step = run.steps.begin('reply', `Answer ${firstName(p.userName)} in ${platformLabel(p.platform)}`, undefined, undefined, [
      p.platform === 'telegram' ? 'telegram_v5_0.sendmessage.create' : 'slack.chat.postmessage.create',
    ])
    relayed = await relay(p, text, run.id)
    if (relayed) {
      step.ok(text.slice(0, 200), { text })
      savePending({ ...p, status: 'answered', answeredAt: Date.now(), answeredBy: reply.userName, answer: text })
    } else step.error('could not post to the member')
    return relayed ? 'Relayed.' : 'Failed to relay.'
  }

  const doSave = async (question: string, answer: string): Promise<string> => {
    const step = run.steps.begin('knowledge', 'Save to the knowledge base', question, undefined, ['notion.page.create'])
    try {
      saved = await addKnowledge({ question, answer, source: 'Mod', learnedFrom: `${reply.userName} (organizer)`, scripted: p.simulated }, run.id)
      step.ok(`added “${question}”`, { url: saved.url })
      return 'Saved.'
    } catch (e) {
      step.error(String((e as Error).message).slice(0, 160))
      return 'Save failed.'
    }
  }

  const tools = {
    relay_answer: tool({
      description: 'Post the answer to the member who asked, in their original chat.',
      inputSchema: z.object({ text: z.string() }),
      execute: async ({ text }) => doRelay(text),
    }),
    save_knowledge: tool({
      description: 'Save a reusable FAQ entry (general question + standalone answer) to the Notion knowledge base.',
      inputSchema: z.object({ question: z.string(), answer: z.string() }),
      execute: async ({ question, answer }) => doSave(question, answer),
    }),
    not_an_answer: tool({
      description: 'The organizer message is not an answer (e.g. "checking", a question back).',
      inputSchema: z.object({ reason: z.string() }),
      execute: async ({ reason }) => {
        notAnswer = true
        run.steps.record('silent', 'Not an answer yet', 'ok', reason)
        return 'OK.'
      },
    }),
  }

  if (!model) {
    // No LLM: relay verbatim and save as-is. The loop still works.
    await doRelay(`${reply.text}

_— ${firstName(reply.userName)} from the team_`)
    await doSave(p.question, reply.text)
  } else {
    try {
      await generateText({
        model,
        instructions: learnInstructions(),
        prompt: `MEMBER QUESTION (from ${p.userName} on ${platformLabel(p.platform)}): ${p.question}\n\nORGANIZER ${reply.userName} REPLIED: ${reply.text}`,
        tools,
        toolChoice: 'required',
        maxRetries: 0,
        providerOptions: { groq: { reasoningEffort: 'low' } },
        stopWhen: [isStepCount(4), () => notAnswer || (relayed && !!saved)],
        onStepEnd: (s) => {
          if (s.response?.modelId) run.steps.model = s.response.modelId
        },
      })
    } catch (e) {
      run.steps.record('error', 'Model unavailable, relaying verbatim', 'error', String((e as Error).message).slice(0, 160))
      if (!relayed) await doRelay(`${reply.text}

_— ${firstName(reply.userName)} from the team_`)
      if (!saved) await doSave(p.question, reply.text)
    }
  }

  if (notAnswer) {
    run.end('silent', { summary: 'organizer reply was not an answer; still waiting' })
    return
  }

  // Anyone else waiting on the same question gets the answer too.
  let alsoAnswered = 0
  if (saved) {
    const others = waitingQuestions().filter((o) => o.id !== p.id)
    if (others.length) {
      const idx = new Bm25Index<PendingQuestion>((o) => o.question)
      for (const o of others) idx.add(o)
      for (const hit of idx.search(`${saved.question} ${p.question}`, 5, 2.5)) {
        const o = hit.doc
        const ok = await relay(o, `Good news ${firstName(o.userName)}, the team just answered this: ${saved.answer}\n\n📎 [${saved.question}](${saved.url})`, run.id)
        if (ok) {
          alsoAnswered++
          savePending({ ...o, status: 'answered', answeredAt: Date.now(), answeredBy: reply.userName, answer: saved.answer })
          run.steps.record('reply', `Also answered ${firstName(o.userName)}`, 'ok', 'was waiting on the same question')
        }
      }
    }
  }

  if (p.modsThreadTs) {
    await postModsCard(
      `✅ Sent to ${firstName(p.userName)}${alsoAnswered ? ` (+${alsoAnswered} other${alsoAnswered > 1 ? 's' : ''} waiting)` : ''}${saved ? ` and saved to the knowledge base: <${saved.url}|${saved.question}>` : ''}. Next time Pulse answers this instantly.`,
      { threadTs: p.modsThreadTs, runId: run.id },
    )
  }
  run.end(saved ? 'learned' : relayed ? 'answered' : 'failed', {
    summary: saved ? `learned “${saved.question}” from ${reply.userName}` : relayed ? 'relayed the answer' : 'could not relay',
  })
}

/** Member answers approved by organizers: credit the helper and thank them in the chat. */
export function registerLearningFollowUps(): void {
  onApprovalExecuted('knowledge', async (a) => {
    const meta = a.actions[0]?.meta as { helper?: string; platform?: Platform; chatId?: string; msgId?: string; threadTs?: string } | undefined
    if (!meta?.helper || !meta.platform || !meta.chatId) return
    creditHelper(meta.platform, meta.helper, a.simulated)
    await post(meta.platform, meta.chatId, `📚 Saved ${firstName(meta.helper)}'s answer to the community FAQ, thanks ${firstName(meta.helper)}!`, {
      runId: a.runId,
      replyToId: meta.platform === 'telegram' ? meta.msgId : undefined,
      threadTs: meta.platform === 'slack' ? meta.threadTs ?? meta.msgId : undefined,
      simulated: a.simulated,
    })
  })
}

// Cheap, deterministic signals computed before the agent runs. They are fed
// to the agent as context (it makes the decision); they also let obvious
// noise skip the LLM entirely so free-tier quota goes to real conversations.

const FRUSTRATION = [
  /still (broken|not working|failing|waiting)/i,
  /\?{3,}/,
  /!{3,}/,
  /\b(wtf|ffs|useless|ridiculous|annoying|frustrat\w*|fed up|nobody (answers|replies|helps))\b/i,
  /nothing works/i,
  /\b[A-Z]{6,}\b/,
  /(hello\?+|anyone\?+)\s*$/i,
]
const HUMAN = /\b(human|real person|someone from (the )?team|organi[sz]er|admin|support)\b/i
const QUESTION = /\?|^(how|what|why|where|when|which|who|can|could|does|do|is|are|should|will|would|help|anyone|any)\b/i
const NOISE = /^(ok(ay)?|k|thanks?( you)?|thx|ty|lol|haha+|nice|cool|great|done|yes|no|yep|nope|\+1|👍|🙏|🔥|❤️|😂|🎉)[.!\s]*$/i

export function heuristicFrustration(text: string, recentAsksBySameUser = 0): number {
  let score = FRUSTRATION.reduce((s, re) => s + (re.test(text) ? 0.3 : 0), 0)
  if (recentAsksBySameUser >= 2) score += 0.3
  return Math.min(1, Number(score.toFixed(2)))
}

export const wantsHuman = (text: string): boolean => HUMAN.test(text)

export function isQuestionLike(text: string): boolean {
  const t = text.trim()
  return t.length >= 6 && QUESTION.test(t)
}

/** Messages that never need the agent (acks, emoji, one-word banter). */
export function isNoise(text: string): boolean {
  const t = text.trim()
  return !t || t.length <= 2 || NOISE.test(t)
}

/** "@Meera how did you…" → "Meera" (the member a message is aimed at), ignoring Pulse itself. */
export function directedAt(text: string): string | undefined {
  const m = text.trim().match(/^@([A-Za-z][\w.-]*)/)
  if (!m || /^pulse$/i.test(m[1]!)) return undefined
  return m[1]
}

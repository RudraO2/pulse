import type { Platform } from '../shared/events.js'

// The agent writes markdown. Telegram's MarkdownV2 needs brutal escaping and
// fails the whole message on one stray char, so we send HTML there; Slack's
// mrkdwn already understands fences and backticks, it only needs bold fixed.

const escapeHtml = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')

export function toTelegramHtml(md: string): string {
  const parts: string[] = []
  const fence = /```([a-zA-Z0-9_-]*)\n?([\s\S]*?)```/g
  let last = 0
  for (const m of md.matchAll(fence)) {
    parts.push(inlineHtml(md.slice(last, m.index)))
    const lang = m[1] ? ` class="language-${m[1]}"` : ''
    parts.push(`<pre><code${lang}>${escapeHtml((m[2] ?? '').replace(/\n$/, ''))}</code></pre>`)
    last = (m.index ?? 0) + m[0].length
  }
  parts.push(inlineHtml(md.slice(last)))
  return parts.join('').replace(/\n{3,}/g, '\n\n').trim()
}

function inlineHtml(text: string): string {
  const codeSpans: string[] = []
  let s = text.replace(/`([^`\n]+)`/g, (_, c: string) => {
    codeSpans.push(`<code>${escapeHtml(c)}</code>`)
    return `\u0000${codeSpans.length - 1}\u0000`
  })
  s = escapeHtml(s)
    .replace(/\*\*([^*\n]+)\*\*/g, '<b>$1</b>')
    .replace(/(^|[\s(])_([^_\n]+)_(?=[\s).,!?]|$)/g, '$1<i>$2</i>')
    .replace(/\[([^\]]+)\]\((https?:\/\/[^)\s]+)\)/g, '<a href="$2">$1</a>')
    .replace(/^#{1,6}\s+(.+)$/gm, '<b>$1</b>')
  return s.replace(/\u0000(\d+)\u0000/g, (_, i: string) => codeSpans[Number(i)] ?? '')
}

export function toSlackMrkdwn(md: string): string {
  const parts: string[] = []
  let last = 0
  for (const m of md.matchAll(/```[a-zA-Z0-9_-]*\n?([\s\S]*?)```/g)) {
    parts.push(inlineSlack(md.slice(last, m.index)))
    parts.push('```' + (m[1] ?? '').replace(/\n$/, '') + '```')
    last = (m.index ?? 0) + m[0].length
  }
  parts.push(inlineSlack(md.slice(last)))
  return parts.join('').trim()
}

function inlineSlack(text: string): string {
  return text
    .replace(/\*\*([^*\n]+)\*\*/g, '*$1*')
    .replace(/\[([^\]]+)\]\((https?:\/\/[^)\s]+)\)/g, '<$2|$1>')
    .replace(/^#{1,6}\s+(.+)$/gm, '*$1*')
}

/** WhatsApp: *bold*, _italic_, ```mono``` work as-is; links can't have labels. */
export function toWhatsApp(md: string): string {
  const parts: string[] = []
  let last = 0
  for (const m of md.matchAll(/```[a-zA-Z0-9_-]*\n?([\s\S]*?)```/g)) {
    parts.push(inlineWhatsApp(md.slice(last, m.index)))
    parts.push('```' + (m[1] ?? '').replace(/\n$/, '') + '```')
    last = (m.index ?? 0) + m[0].length
  }
  parts.push(inlineWhatsApp(md.slice(last)))
  return parts.join('').replace(/\n{3,}/g, '\n\n').trim()
}

function inlineWhatsApp(text: string): string {
  return text
    .replace(/\*\*([^*\n]+)\*\*/g, '*$1*')
    .replace(/\[([^\]]+)\]\((https?:\/\/[^)\s]+)\)/g, (_, label: string, url: string) => (label === url ? url : `${label}: ${url}`))
    .replace(/^#{1,6}\s+(.+)$/gm, '*$1*')
}

export function formatFor(platform: Platform, md: string): string {
  if (platform === 'telegram') return toTelegramHtml(md)
  if (platform === 'slack') return toSlackMrkdwn(md)
  if (platform === 'whatsapp') return toWhatsApp(md)
  return md
}

/** Telegram hard limit is 4096 chars; Slack ~40k but keep replies readable. */
export function clampReply(md: string, max = 3500): string {
  if (md.length <= max) return md
  const cut = md.slice(0, max)
  const openFences = (cut.match(/```/g) ?? []).length % 2
  return cut + (openFences ? '\n```' : '') + '\n…'
}

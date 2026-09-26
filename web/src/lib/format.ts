import type { RunOutcome, RunSummary } from '@shared/events'

export function timeAgo(ts: number, now = Date.now()): string {
  const s = Math.max(0, Math.round((now - ts) / 1000))
  if (s < 10) return 'just now'
  if (s < 60) return `${s}s ago`
  const m = Math.round(s / 60)
  if (m < 60) return `${m}m ago`
  const h = Math.round(m / 60)
  if (h < 24) return `${h}h ago`
  return `${Math.round(h / 24)}d ago`
}

export function clock(ts: number): string {
  return new Date(ts).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', hourCycle: 'h23' })
}

export function ms(n?: number): string {
  if (n === undefined || n === null) return '–'
  if (n < 1000) return `${Math.round(n)} ms`
  if (n < 60_000) return `${(n / 1000).toFixed(n < 10_000 ? 1 : 0)} s`
  return `${Math.floor(n / 60_000)}m ${Math.round((n % 60_000) / 1000)}s`
}

/** "anthropic:claude-haiku-4-5-20251001" → "claude-haiku-4-5-20251001" */
export const modelName = (m?: string) => m?.replace(/^[a-z-]+:/i, '')

export function initials(name: string): string {
  const parts = name.trim().split(/\s+/)
  return ((parts[0]?.[0] ?? '') + (parts[1]?.[0] ?? '')).toUpperCase() || '?'
}

export function providerOf(tool: string): string {
  return (tool.split('.')[0] ?? tool).replace(/_v\d.*$/, '').replace(/^(discover|list|add|help):.*/, 'swytchcode')
}

export const OUTCOME_LABEL: Record<RunOutcome, string> = {
  answered: 'Answered',
  asked_mods: 'Asked organizers',
  escalated: 'Escalated',
  silent: 'Stayed silent',
  welcomed: 'Welcomed',
  learned: 'Learned',
  proposed: 'Proposed for FAQ',
  awaiting_approval: 'Awaiting approval',
  executed: 'Executed',
  reported: 'Reported',
  failed: 'Failed',
}

export const ORIGIN_LABEL: Record<RunSummary['origin'], string> = {
  community: 'Community',
  mod: 'Organizer reply',
  console: 'Console',
  sweep: 'Care sweep',
  digest: 'Digest',
  approval: 'Approval',
}

/** One human line describing a run, for feeds. */
export function runHeadline(r: RunSummary): string {
  const who = r.userName ? r.userName.split(' ')[0] : undefined
  const firstLine = r.input.split('\n').pop() ?? r.input
  const said = firstLine.includes(': ') ? firstLine.slice(firstLine.indexOf(': ') + 2) : firstLine
  switch (r.origin) {
    case 'console':
      return r.input
    case 'mod':
      return r.summary ?? `${who ?? 'An organizer'} replied in #mods`
    case 'sweep':
    case 'digest':
      return r.summary ?? r.input
    default:
      if (!r.outcome) return `${who ?? 'Someone'}: ${said}`
      if (r.outcome === 'silent') return `${who}: “${said}”`
      return `${OUTCOME_LABEL[r.outcome]} ${who ?? ''}${r.outcome === 'answered' || r.outcome === 'asked_mods' ? ` · “${said}”` : ''}`
  }
}

/** Very small markdown → HTML for message bodies (links, bold, code). Escapes first. */
export function mdInline(text: string): string {
  const esc = text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
  return esc
    .replace(/`([^`\n]+)`/g, '<code>$1</code>')
    .replace(/\*\*([^*\n]+)\*\*/g, '<strong>$1</strong>')
    .replace(/(^|\s)_([^_\n]+)_(?=\s|$|[.,!?])/g, '$1<em>$2</em>')
    .replace(/\[([^\]]+)\]\((https?:\/\/[^)\s]+)\)/g, '<a href="$2" target="_blank" rel="noreferrer">$1</a>')
    .replace(/&lt;(https?:\/\/[^|&]+)\|([^&]+)&gt;/g, '<a href="$1" target="_blank" rel="noreferrer">$2</a>')
    .replace(/\n/g, '<br/>')
}

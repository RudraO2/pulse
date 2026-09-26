import type { StateSnapshot } from '@shared/events'
import { store } from './store'

// Thin fetch helpers for operator actions. Errors surface as toasts.

const token = () => new URLSearchParams(location.search).get('token') ?? localStorage.getItem('pulse.token') ?? ''

async function request<T>(method: 'GET' | 'POST', url: string, body?: unknown): Promise<T | undefined> {
  try {
    const res = await fetch(url, {
      method,
      headers: { 'Content-Type': 'application/json', ...(token() ? { 'x-admin-token': token() } : {}) },
      body: body === undefined ? undefined : JSON.stringify(body),
    })
    const data = (await res.json().catch(() => ({}))) as T & { error?: string }
    if (!res.ok) {
      store.toast('bad', data?.error ?? `Request failed (${res.status})`)
      return undefined
    }
    return data
  } catch (e) {
    store.toast('bad', `Network error: ${(e as Error).message}`)
    return undefined
  }
}

export const api = {
  console: (text: string, about?: { kind: 'member'; id: string }) => request<{ runId: string }>('POST', '/api/console', { text, ...(about ? { about } : {}) }),
  approve: (id: string) => request('POST', `/api/approvals/${id}`, { decision: 'approve' }),
  reject: (id: string) => request('POST', `/api/approvals/${id}`, { decision: 'reject' }),
  resolveAttention: (id: string) => request('POST', `/api/attention/${id}/resolve`),
  digest: () => request<{ ok: boolean; detail: string }>('POST', '/api/digest'),
  selftest: () => request('POST', '/api/selftest'),
  sweep: () => request<{ checked: number; answered: number; nudged: number }>('POST', '/api/sweep'),
  kbSync: () => request<{ entries: number }>('POST', '/api/kb/sync'),
  guardrails: () => request<GuardrailsInfo>('GET', '/api/guardrails'),
  audit: () => request<AuditInfo>('GET', '/api/audit'),
  scenarios: () => request<ScenarioInfo[]>('GET', '/api/scenarios'),
  demo: (action: 'play' | 'pause' | 'resume' | 'stop' | 'reset' | 'speed', body: Record<string, unknown> = {}) => request('POST', `/api/demo/${action}`, body),
  // phone app
  pair: () => request<PairInfo>('GET', '/api/pair'),
  resolveCase: (id: string) => request('POST', `/api/cases/${id}/resolve`),
  replyCase: (id: string, text: string) => request<{ ok: boolean; error?: string }>('POST', `/api/cases/${id}/reply`, { text }),
  answerPending: (id: string, text: string) => request<{ ok?: boolean; error?: string }>('POST', `/api/pending/${id}/answer`, { text }),
  pushKey: () => request<{ key: string }>('GET', '/api/push/key'),
  pushSubscribe: (subscription: PushSubscriptionJSON) => request<{ devices: number }>('POST', '/api/push/subscribe', { subscription }),
  pushTest: () => request<{ sent: number }>('POST', '/api/push/test'),
  // WhatsApp (linked device)
  waLink: () => request('POST', '/api/whatsapp/link'),
  waLogout: () => request('POST', '/api/whatsapp/logout'),
  waRefresh: () => request('POST', '/api/whatsapp/refresh'),
  waGroup: (jid: string, patch: { enabled?: boolean; auto?: boolean }) => request('POST', '/api/whatsapp/groups', { jid, ...patch }),
  waDms: (patch: { enabled?: boolean; auto?: boolean }) => request('POST', '/api/whatsapp/dms', patch),
  waPause: (paused: boolean) => request('POST', '/api/whatsapp/pause', { paused }),
  refresh: async () => {
    const snap = await request<StateSnapshot>('GET', '/api/state')
    if (snap) store.hydrate(snap)
  },
}

export interface PairInfo {
  tunnel: 'off' | 'starting' | 'up' | 'down'
  publicUrl?: string
  url?: string
  lanUrl?: string
  devices: number
}

export interface PolicyRule {
  id: string
  target: string[]
  when: unknown
  action: { type: string; message: string }
}

export interface GuardrailsInfo {
  policies: { policies: PolicyRule[] }
  state: { cooldown: Record<string, string[]>; members: Record<string, string[]> }
  tooling: string[]
}

export interface AuditInfo {
  network: Array<{ id: string; tool: string; host: string; method: string; status: number; durationMs: number; timestamp: string }>
  policy: Array<{ id: string; tool: string; policyId: string; status: string; requestedAt: number; resolvedAt?: number }>
}

export interface ScenarioInfo {
  id: string
  title: string
  description: string
  shows: string[]
  beats: number
}

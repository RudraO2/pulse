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
  console: (text: string) => request<{ runId: string }>('POST', '/api/console', { text }),
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
  refresh: async () => {
    const snap = await request<StateSnapshot>('GET', '/api/state')
    if (snap) store.hydrate(snap)
  },
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
  policy: Array<{ id: string; tool: string; policyId: string; status: string; requestedAt: number }>
}

export interface ScenarioInfo {
  id: string
  title: string
  description: string
  shows: string[]
  beats: number
}

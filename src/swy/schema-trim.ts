import type { ToolInfo } from './exec.js'

// `swy info` returns full, deeply nested schemas (Telegram sendMessage alone is
// several KB, and composite types render as {_COMPOSITION, variant_0, …}). The
// model only needs: where each argument goes, its type, and whether it's
// required. Groq's free tier is 8K tokens/min, so this matters.

export interface TrimmedSchema {
  canonical_id: string
  http_method?: string
  endpoint?: string
  summary?: string
  /** dotted paths into the swy args object, e.g. "body.chat_id", "params.channel" */
  required: string[]
  fields: Record<string, string>
  truncated?: number
}

interface SchemaNode {
  type?: string
  required?: boolean | string[]
  properties?: Record<string, SchemaNode>
  items?: SchemaNode
}

interface InputSpec {
  LOCATION?: string
  REQUIRED?: boolean
  TYPE?: string
  DEFAULT?: unknown
  schema?: SchemaNode
}

const MAX_FIELDS = 40

/** "variant_0: integer, variant_1: string" → "integer|string" */
function typeOf(node: SchemaNode | undefined): string {
  if (!node) return 'any'
  const props = node.properties
  if (props && '_COMPOSITION' in props) {
    const variants = Object.entries(props)
      .filter(([k]) => k.startsWith('variant_'))
      .map(([, v]) => typeOf(v))
    return [...new Set(variants)].join('|') || 'any'
  }
  if (node.type === 'array') return `${typeOf(node.items)}[]`
  if (props && Object.keys(props).length === 1 && props.value?.type === 'any') return 'object'
  return (node.type ?? (props ? 'object' : 'any')).toLowerCase()
}

function normalizeScalar(t: string | undefined): string {
  const v = (t ?? 'any').toUpperCase()
  if (v === 'INT' || v === 'INTEGER') return 'integer'
  if (v === 'FLOAT' || v === 'NUMBER') return 'number'
  if (v === 'BOOL' || v === 'BOOLEAN') return 'boolean'
  if (v.startsWith('[]')) return `${normalizeScalar(v.slice(2))}[]`
  return v.toLowerCase()
}

export function trimSchema(info: ToolInfo): TrimmedSchema {
  const required: string[] = []
  const fields: Record<string, string> = {}
  let dropped = 0
  const add = (path: string, type: string, isRequired: boolean) => {
    if (Object.keys(fields).length >= MAX_FIELDS) {
      dropped++
      if (isRequired) required.push(path)
      return
    }
    fields[path] = type
    if (isRequired) required.push(path)
  }

  for (const input of (info.inputs ?? []) as Array<Record<string, InputSpec>>) {
    for (const [name, spec] of Object.entries(input)) {
      const loc = (spec.LOCATION ?? '').toLowerCase()
      if (loc === 'header') continue // auth/version headers are injected by the wrapper
      if (loc === 'body' && spec.schema?.properties) {
        const req = new Set(Array.isArray(spec.schema.required) ? spec.schema.required : [])
        for (const [prop, node] of Object.entries(spec.schema.properties)) {
          const isReq = req.has(prop) || node.required === true
          add(`body.${prop}`, typeOf(node), isReq)
        }
        continue
      }
      if (loc === 'body') {
        // Field-style body inputs (form-data bundles list each field separately)
        add(`body.${name}`, spec.schema ? typeOf(spec.schema) : normalizeScalar(spec.TYPE), !!spec.REQUIRED)
        continue
      }
      // path + query parameters go under `params`
      add(`params.${name}`, normalizeScalar(spec.TYPE), !!spec.REQUIRED)
    }
  }

  const out: TrimmedSchema = {
    canonical_id: info.canonical_id,
    http_method: info.http_method,
    endpoint: info.endpoint,
    summary: info.summary,
    required,
    fields,
  }
  if (dropped) out.truncated = dropped
  return out
}

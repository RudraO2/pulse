import { readFileSync } from 'node:fs'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import type { ToolInfo } from '../../src/swy/exec.js'
import { trimSchema } from '../../src/swy/schema-trim.js'

const info = (name: string) => (JSON.parse(readFileSync(path.join(import.meta.dirname, 'fixtures', name), 'utf8')) as ToolInfo[])[0]!

describe('trimSchema', () => {
  it('collapses composite types and keeps required body fields (Telegram sendMessage)', () => {
    const t = trimSchema(info('info-telegram-sendmessage.json'))
    expect(t.canonical_id).toBe('telegram_v5_0.sendmessage.create')
    expect(t.http_method).toBe('POST')
    expect(t.fields['body.chat_id']).toBe('integer|string')
    expect(t.fields['body.text']).toBe('string')
    expect(t.required).toContain('body.text')
    // a 31 KB schema must shrink to something the model can afford
    expect(JSON.stringify(t).length).toBeLessThan(2500)
  })

  it('maps path/query inputs to params and drops headers (Notion query)', () => {
    const t = trimSchema(info('info-notion-query.json'))
    expect(t.fields['params.data_source_id']).toBe('string')
    expect(t.required).toContain('params.data_source_id')
    expect(Object.keys(t.fields).some((k) => k.includes('Notion-Version'))).toBe(false)
    expect(t.fields['body.page_size']).toBe('integer')
  })

  it('normalises scalar types for query params (Slack history)', () => {
    const t = trimSchema(info('info-slack-history.json'))
    expect(t.fields['params.channel']).toBe('string')
    expect(t.fields['params.limit']).toBe('integer')
    expect(t.fields['params.inclusive']).toBe('boolean')
    expect(t.fields['params.oldest']).toBe('number')
  })

  it('marks Slack postMessage channel as required', () => {
    const t = trimSchema(info('info-slack-postmessage.json'))
    expect(t.required).toContain('body.channel')
  })
})

import { describe, expect, it } from 'vitest'
import { formatFor, toWhatsApp } from '../../src/agent/format.js'
import { platformLabel, quotesReplies, sendTools } from '../../src/channels/platforms.js'
import { postAction, previewAction } from '../../src/core/approvals.js'

describe('WhatsApp formatting', () => {
  it('turns markdown into WhatsApp markup', () => {
    expect(toWhatsApp('Lunch is at **1:30**')).toBe('Lunch is at *1:30*')
    expect(toWhatsApp('## Schedule\nsee [the FAQ](https://x.dev/faq)')).toBe('*Schedule*\nsee the FAQ: https://x.dev/faq')
    expect(toWhatsApp('[https://x.dev](https://x.dev)')).toBe('https://x.dev')
  })

  it('leaves code blocks alone', () => {
    expect(toWhatsApp('run:\n```\nnpm i **x**\n```')).toBe('run:\n```npm i **x**```')
  })

  it('is used for the whatsapp platform', () => {
    expect(formatFor('whatsapp', '**hi**')).toBe('*hi*')
  })
})

describe('platform helpers', () => {
  it('quotes replies on Telegram and WhatsApp, threads on Slack', () => {
    expect(quotesReplies('whatsapp')).toBe(true)
    expect(quotesReplies('telegram')).toBe(true)
    expect(quotesReplies('slack')).toBe(false)
  })

  it('has no Swytchcode send tool for WhatsApp', () => {
    expect(sendTools('whatsapp')).toEqual([])
    expect(sendTools('slack')).toEqual(['slack.chat.postmessage.create'])
    expect(platformLabel('whatsapp')).toBe('WhatsApp')
  })
})

describe('WhatsApp approvals', () => {
  it('previews the message itself, without a Swytchcode dry-run', async () => {
    const a = await previewAction(postAction('whatsapp', '1203@g.us', 'Lunch at **1:30**', 'Post to WhatsApp'))
    expect(a.tool).toBe('whatsapp.send')
    expect(a.preview?.method).toBe('SEND')
    expect((a.preview?.body as { text: string }).text).toContain('Lunch at *1:30*')
    expect(a.blocked).toBeUndefined()
  })

  it('blocks a message with a secret before it can be approved', () => {
    const a = postAction('whatsapp', '1203@g.us', 'token ghp_abcdefghijklmnopqrstuvwxyz1234', 'Post')
    expect(a.blocked).toMatch(/secret/)
  })
})

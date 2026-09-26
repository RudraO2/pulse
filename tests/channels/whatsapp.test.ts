import { beforeEach, describe, expect, it } from 'vitest'
import { WhatsAppAdapter } from '../../src/channels/whatsapp.js'
import { channels, replyMode } from '../../src/core/channels.js'
import { closeDb, openDb } from '../../src/store/db.js'
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

describe('WhatsApp switches', () => {
  const G = '120363111@g.us'
  const hooks = { onMessage: () => {}, beginBacklog: () => {}, endBacklog: async () => {} }

  beforeEach(() => {
    closeDb()
    openDb(':memory:')
    channels.whatsapp = undefined
  })

  it('every reply needs approval until a chat is put on auto', () => {
    const wa = new WhatsAppAdapter(hooks)
    wa.setGroup(G, { enabled: true })
    expect(wa.replyMode(G)).toBe('approve')
    expect(wa.replyMode('91999@s.whatsapp.net')).toBe('approve')
    wa.setGroup(G, { auto: true })
    wa.setDms({ auto: true })
    expect(wa.replyMode(G)).toBe('auto')
    expect(wa.replyMode('91999@s.whatsapp.net')).toBe('auto')
  })

  it('the master switch pauses every chat and survives a restart', () => {
    const wa = new WhatsAppAdapter(hooks)
    wa.setGroup(G, { enabled: true, auto: true })
    wa.setPaused(true)
    expect(wa.replyMode(G)).toBe('paused')
    const again = new WhatsAppAdapter(hooks)
    expect(again.paused).toBe(true)
    expect(again.state().groups).toEqual([])
    expect(again.replyMode(G)).toBe('paused')
  })

  it('refuses to send on its own while paused, but not an organizer message', async () => {
    const wa = new WhatsAppAdapter(hooks)
    wa.setGroup(G, { enabled: true })
    wa.setPaused(true)
    await expect(wa.send(G, 'hello')).rejects.toThrow(/paused/)
    // organizer messages get past the pause (and then fail only because nothing is linked in tests)
    await expect(wa.send(G, 'hello', { byOrganizer: true })).rejects.toThrow(/not connected/)
  })

  it('routes replies by chat: Telegram/Slack always auto', () => {
    channels.whatsapp = new WhatsAppAdapter(hooks)
    expect(replyMode('telegram', '-100')).toBe('auto')
    expect(replyMode('whatsapp', G)).toBe('approve')
    channels.whatsapp = undefined
    expect(replyMode('whatsapp', G)).toBe('paused')
  })
})

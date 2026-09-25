import { describe, expect, it } from 'vitest'
import { CANARY, compilePolicies } from '../../src/swy/policies.js'

describe('compilePolicies', () => {
  it('matches the golden policies.json for empty dynamic state', async () => {
    const out = compilePolicies({ cooldown: { telegram: [], slack: [] }, members: { telegram: [], slack: [] } })
    await expect(JSON.stringify(out, null, 2)).toMatchFileSnapshot('./__golden__/policies.empty.json')
  })

  it('matches the golden policies.json with live state', async () => {
    const out = compilePolicies({
      cooldown: { telegram: ['-1001234567890'], slack: ['C0HOT'] },
      members: { telegram: ['424242', '515151'], slack: ['D0MEMBER'] },
    })
    await expect(JSON.stringify(out, null, 2)).toMatchFileSnapshot('./__golden__/policies.live.json')
  })

  it('keeps Telegram ids numeric and always includes canaries', () => {
    const out = compilePolicies({ cooldown: { telegram: ['-100555'], slack: [] }, members: { telegram: ['77'], slack: [] } })
    const cooldown = out.policies.find((p) => p.id === 'cooldown-telegram')!
    expect(cooldown.when).toEqual({ field: 'chat_id', operator: 'in', value: [Number(CANARY.telegram.cooldownChat), -100555] })
    const dm = out.policies.find((p) => p.id === 'dm-members-only-telegram')!
    expect(JSON.stringify(dm.when)).toContain(`${Number(CANARY.telegram.member)},77`)
  })

  it('uses bare field names only (body.text is a schema error in swytchcode)', () => {
    const out = compilePolicies({ cooldown: { telegram: [], slack: [] }, members: { telegram: [], slack: [] } })
    expect(JSON.stringify(out)).not.toMatch(/"field":"body\./)
  })

  it('targets every outbound chat tool with the secret rule', () => {
    const out = compilePolicies({ cooldown: { telegram: [], slack: [] }, members: { telegram: [], slack: [] } })
    const rule = out.policies.find((p) => p.id === 'no-secrets')!
    expect(rule.target).toEqual([
      'telegram_v5_0.sendmessage.create',
      'telegram_v5_0.editmessagetext.create',
      'slack.chat.postmessage.create',
      'slack.chat.update.create',
    ])
  })
})

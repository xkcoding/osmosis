import { describe, it, expect } from 'vitest'
import { buildMessage } from './format.js'

describe('buildMessage', () => {
  it('renders summary, PR list and source footer', () => {
    const msg = buildMessage({
      summary: '今日要点 1\n要点 2',
      sources: ['builderpulse'],
      prUrls: ['https://github.com/owner/repo/pull/42'],
      date: '2026-04-17',
    })
    expect(msg).toMatch(/^📡 每日情报摘要 — 2026-04-17/)
    expect(msg).toContain('今日要点 1')
    expect(msg).toContain('- https://github.com/owner/repo/pull/42')
    expect(msg).toMatch(/osmosis · 来源: builderpulse$/)
  })

  it('shows fallback when there are no PRs', () => {
    const msg = buildMessage({
      summary: 'x',
      sources: [],
      prUrls: [],
      date: '2026-04-17',
    })
    expect(msg).toContain('- (无新 PR)')
    expect(msg).toContain('osmosis · 来源: (none)')
  })
})

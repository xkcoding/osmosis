import { describe, it, expect } from 'vitest'
import { buildMessage } from './format.js'

describe('buildMessage', () => {
  it('renders header, summary body, and osmosis footer', () => {
    const msg = buildMessage({
      summary: '今日要点 1\n要点 2',
      sources: ['builderpulse'],
      prUrls: ['https://github.com/owner/repo/pull/42'],
      date: '2026-04-17',
    })
    expect(msg).toMatch(/^📡 每日情报摘要 — 2026-04-17/)
    expect(msg).toContain('今日要点 1')
    expect(msg).toMatch(/---\nosmosis$/)
  })

  it('stays consistent with empty source/pr lists (summary carries its own links)', () => {
    const msg = buildMessage({
      summary: '# x\n\nbody',
      sources: [],
      prUrls: [],
      date: '2026-04-17',
    })
    expect(msg).toContain('# x\n\nbody')
    expect(msg).toMatch(/osmosis$/)
  })
})

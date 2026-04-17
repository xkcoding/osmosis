import { describe, it, expect } from 'vitest'
import { buildMessage, buildHeaderTitle } from './format.js'

describe('buildHeaderTitle', () => {
  it('uses single source title in header', () => {
    const title = buildHeaderTitle({
      summary: 'x',
      sources: [{ name: 'builderpulse', title: 'BuilderPulse Daily' }],
      prUrls: [],
      date: '2026-04-17',
    })
    expect(title).toBe('📡 BuilderPulse Daily — 2026-04-17')
  })

  it('joins multiple short titles with middle dot', () => {
    const title = buildHeaderTitle({
      summary: 'x',
      sources: [
        { name: 'a', title: 'BuilderPulse' },
        { name: 'b', title: '橘鸦 AI 早报' },
      ],
      prUrls: [],
      date: '2026-04-17',
    })
    expect(title).toBe('📡 BuilderPulse · 橘鸦 AI 早报 — 2026-04-17')
  })

  it('falls back to N-source form when joined titles are too long', () => {
    const title = buildHeaderTitle({
      summary: 'x',
      sources: [
        { name: 'a', title: 'Very Long Source Title Number One' },
        { name: 'b', title: 'Equally Long Source Title Number Two' },
      ],
      prUrls: [],
      date: '2026-04-17',
    })
    expect(title).toBe('📡 2 源日报 — 2026-04-17')
  })

  it('falls back to generic title when no sources', () => {
    const title = buildHeaderTitle({
      summary: 'x',
      sources: [],
      prUrls: [],
      date: '2026-04-17',
    })
    expect(title).toBe('📡 每日情报摘要 — 2026-04-17')
  })
})

describe('buildMessage', () => {
  it('renders header, summary body, and osmosis footer', () => {
    const msg = buildMessage({
      summary: '今日要点 1\n要点 2',
      sources: [{ name: 'builderpulse', title: 'BuilderPulse Daily' }],
      prUrls: ['https://github.com/owner/repo/pull/42'],
      date: '2026-04-17',
    })
    expect(msg).toMatch(/^📡 BuilderPulse Daily — 2026-04-17/)
    expect(msg).toContain('今日要点 1')
    expect(msg).toMatch(/---\nosmosis$/)
  })
})

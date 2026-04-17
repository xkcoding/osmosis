import { describe, it, expect } from 'vitest'
import { resolveTemplate, todayParts } from './template.js'

describe('resolveTemplate', () => {
  const parts = { date: '2026-04-17', year: '2026', month: '04', day: '17' }

  it('replaces {date}', () => {
    expect(resolveTemplate('foo/{date}.md', parts)).toBe('foo/2026-04-17.md')
  })

  it('replaces {year}/{month}/{day}', () => {
    expect(resolveTemplate('{year}/{month}/{day}', parts)).toBe('2026/04/17')
  })

  it('replaces multiple occurrences', () => {
    expect(resolveTemplate('{year}-{year}', parts)).toBe('2026-2026')
  })

  it('passes through unrelated text', () => {
    expect(resolveTemplate('static/path.md', parts)).toBe('static/path.md')
  })

  it('does not touch unknown braces', () => {
    expect(resolveTemplate('{unknown}/{date}', parts)).toBe('{unknown}/2026-04-17')
  })
})

describe('todayParts', () => {
  it('formats fixed date in Asia/Shanghai by default', () => {
    const fixed = new Date('2026-04-17T01:00:00Z')
    const parts = todayParts(fixed)
    expect(parts).toEqual({ date: '2026-04-17', year: '2026', month: '04', day: '17' })
  })

  it('rolls into next day at UTC midnight + 8h', () => {
    const lateUtc = new Date('2026-04-17T17:00:00Z')
    const parts = todayParts(lateUtc)
    expect(parts.date).toBe('2026-04-18')
  })
})

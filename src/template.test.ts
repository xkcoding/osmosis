import { describe, it, expect, afterEach } from 'vitest'
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

  describe('OSMOSIS_DATE override', () => {
    const ORIGINAL = process.env.OSMOSIS_DATE
    afterEach(() => {
      if (ORIGINAL === undefined) delete process.env.OSMOSIS_DATE
      else process.env.OSMOSIS_DATE = ORIGINAL
    })

    it('pins today to the given date regardless of the clock', () => {
      process.env.OSMOSIS_DATE = '2026-06-19'
      const parts = todayParts(new Date('2026-06-22T05:00:00Z'))
      expect(parts).toEqual({ date: '2026-06-19', year: '2026', month: '06', day: '19' })
    })

    it('throws on a malformed override', () => {
      process.env.OSMOSIS_DATE = '06/19/2026'
      expect(() => todayParts()).toThrow(/OSMOSIS_DATE must be YYYY-MM-DD/)
    })
  })
})

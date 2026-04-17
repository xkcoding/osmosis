import { describe, it, expect } from 'vitest'
import { checkContentQuality, stripFrontmatter } from './quality.js'

const validBody = `# Today's News

Hello world. This is a substantial paragraph of content that exceeds the
default minimum body length so the validator is satisfied with the body size.

- bullet one
- bullet two
- bullet three

[link](https://example.com)
`

describe('stripFrontmatter', () => {
  it('removes a leading frontmatter block', () => {
    const input = `---\ntitle: x\ndate: 2026-04-17\n---\n\nbody here`
    expect(stripFrontmatter(input)).toBe('body here')
  })

  it('returns input unchanged when no frontmatter', () => {
    expect(stripFrontmatter('just body')).toBe('just body')
  })

  it('does not remove an inner --- separator', () => {
    const input = `# title\n\nbody\n\n---\n\nfooter`
    expect(stripFrontmatter(input)).toBe(input)
  })
})

describe('checkContentQuality', () => {
  it('passes valid markdown content', () => {
    expect(checkContentQuality(validBody)).toEqual([])
  })

  it('flags empty content', () => {
    const issues = checkContentQuality('')
    expect(issues.map((i) => i.rule)).toContain('non-empty')
  })

  it('flags whitespace-only content', () => {
    const issues = checkContentQuality('   \n\n   \n')
    expect(issues.map((i) => i.rule)).toContain('non-empty')
  })

  it('flags only-frontmatter content', () => {
    const issues = checkContentQuality(`---\ntitle: x\n---\n`)
    expect(issues.map((i) => i.rule)).toContain('non-empty')
  })

  it('flags too-short body', () => {
    const issues = checkContentQuality('# Hi\n\nshort body.\n\n- a\n- b\n- c\n- d\n- e')
    expect(issues.map((i) => i.rule)).toContain('min-body-chars')
  })

  it('flags too-few lines', () => {
    const long = 'x'.repeat(500)
    const issues = checkContentQuality(`# Title\n\n${long}`)
    expect(issues.map((i) => i.rule)).toContain('min-body-lines')
  })

  it('flags HTML error pages', () => {
    const html = `<!DOCTYPE html>\n<html><body>404 Not Found</body></html>${'x'.repeat(300)}`
    const issues = checkContentQuality(html)
    expect(issues.map((i) => i.rule)).toContain('forbid-pattern')
  })

  it('flags placeholder content', () => {
    const stub = `# Today\n\n占位${'x'.repeat(300)}\n\n- a\n- b\n- c\n- d\n- e`
    const issues = checkContentQuality(stub)
    expect(issues.map((i) => i.rule)).toContain('forbid-pattern')
  })

  it('flags content lacking markdown signal', () => {
    const plain = 'lorem ipsum '.repeat(50) + '\nsecond line\nthird\nfourth\nfifth'
    const issues = checkContentQuality(plain)
    expect(issues.map((i) => i.rule)).toContain('markdown-signal')
  })

  it('honours custom minBodyChars', () => {
    expect(checkContentQuality('# x\n\nshort\n\n- a\n- b\n- c\n- d\n- e', { minBodyChars: 10 })).toEqual([])
  })

  it('skips markdown-signal check when disabled', () => {
    const plain = 'lorem '.repeat(60) + '\nl2\nl3\nl4\nl5'
    expect(checkContentQuality(plain, { requireMarkdownSignal: false })).toEqual([])
  })

  it('appends custom forbid patterns to defaults', () => {
    const custom = `# Real\n\n${'x'.repeat(300)}\n\nDRAFT\n- a\n- b\n- c\n- d`
    const issues = checkContentQuality(custom, { forbidPatterns: ['draft'] })
    expect(issues.map((i) => i.rule)).toContain('forbid-pattern')
  })

  it('handles content with frontmatter prefix', () => {
    const withFm = `---\ntitle: foo\n---\n\n${validBody}`
    expect(checkContentQuality(withFm)).toEqual([])
  })
})

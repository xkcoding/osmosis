import { describe, it, expect } from 'vitest'
import { formatForObsidian } from './formatter.js'

const result = {
  title: 'BuilderPulse Daily',
  date: '2026-04-17',
  content: '# Hi\n\nbody\n',
  sourceUrl: 'https://github.com/BuilderPulse/BuilderPulse/blob/main/zh/2026/2026-04-17.md',
}

describe('formatForObsidian', () => {
  it('emits frontmatter, body, and source footer', () => {
    const out = formatForObsidian(result, { title: result.title })
    expect(out.startsWith('---\n')).toBe(true)
    expect(out).toMatch(/title: BuilderPulse Daily — 2026-04-17/)
    expect(out).toMatch(/date_saved: 2026-04-17/)
    expect(out).toMatch(/^---\n[\s\S]*?\n---\n\n# Hi\n\nbody\n+---\n\n> \[!info\] 来源/)
    expect(out).toContain(result.sourceUrl)
  })

  it('merges custom frontmatter fields', () => {
    const out = formatForObsidian(result, {
      title: result.title,
      frontmatter: { type: 'reference', tags: ['clipping/builderpulse'] },
    })
    expect(out).toMatch(/type: reference/)
    expect(out).toMatch(/tags:\s*\n\s*- clipping\/builderpulse/)
  })

  it('trims leading and trailing whitespace from body', () => {
    const padded = { ...result, content: '\n\n# Hi\n\nbody\n\n\n' }
    const out = formatForObsidian(padded, { title: result.title })
    expect(out).toMatch(/---\n\n# Hi\n\nbody\n\n---/)
  })
})

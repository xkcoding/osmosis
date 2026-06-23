import { describe, it, expect, vi } from 'vitest'
import { rehostImages, type RehostDeps } from './image-rehost.js'

function makeDeps(overrides: Partial<RehostDeps> = {}): RehostDeps {
  return {
    fetchImage: vi.fn(async () => ({ data: Buffer.from('raw'), contentType: 'image/png' })),
    compress: vi.fn(async () => ({ data: Buffer.from('small'), ext: 'webp', contentType: 'image/webp' })),
    upload: vi.fn(async (key: string) => `https://cdn.example.com/${key}`),
    ...overrides,
  }
}

const OPTS = { keyPrefix: 'osmosis/juya' }

describe('rehostImages', () => {
  it('rewrites markdown image URLs to the uploaded CDN URL', async () => {
    const deps = makeDeps()
    const md = '![alt](https://img.juya.uk/a.png)'
    const res = await rehostImages(md, deps, OPTS)

    expect(res.rehosted).toBe(1)
    expect(res.failed).toBe(0)
    // key is content-addressed: prefix/<hash>.webp
    expect(res.markdown).toMatch(/^!\[alt\]\(https:\/\/cdn\.example\.com\/osmosis\/juya\/[a-f0-9]{16}\.webp\)$/)
  })

  it('preserves the image title segment when rewriting', async () => {
    const res = await rehostImages('![](https://img.juya.uk/a.png "cap")', makeDeps(), OPTS)
    expect(res.markdown).toContain(' "cap")')
  })

  it('rewrites <img src> HTML tags too', async () => {
    const res = await rehostImages('<img src="https://img.juya.uk/b.gif" alt="x">', makeDeps(), OPTS)
    expect(res.rehosted).toBe(1)
    expect(res.markdown).toMatch(/<img src="https:\/\/cdn\.example\.com\/osmosis\/juya\/[a-f0-9]{16}\.webp" alt="x">/)
  })

  it('deduplicates identical URLs — fetches once, replaces all occurrences', async () => {
    const deps = makeDeps()
    const md = '![a](https://img.juya.uk/a.png)\n![b](https://img.juya.uk/a.png)'
    const res = await rehostImages(md, deps, OPTS)

    expect(deps.fetchImage).toHaveBeenCalledTimes(1)
    expect(res.rehosted).toBe(1)
    expect([...res.markdown.matchAll(/cdn\.example\.com/g)]).toHaveLength(2)
  })

  it('skips non-http URLs and hosts in skipHosts', async () => {
    const deps = makeDeps()
    const md =
      '![a](data:image/png;base64,xxx)\n![b](/relative.png)\n![c](https://cdn.example.com/already.webp)'
    const res = await rehostImages(md, deps, { ...OPTS, skipHosts: ['cdn.example.com'] })

    expect(deps.fetchImage).not.toHaveBeenCalled()
    expect(res.rehosted).toBe(0)
    expect(res.skipped).toBe(3)
    expect(res.markdown).toBe(md)
  })

  it('keeps the original URL when a single image fails (never breaks the digest)', async () => {
    const deps = makeDeps({
      fetchImage: vi
        .fn()
        .mockResolvedValueOnce({ data: Buffer.from('ok'), contentType: 'image/png' })
        .mockRejectedValueOnce(new Error('404')),
    })
    const md = '![ok](https://img.juya.uk/ok.png)\n![bad](https://img.juya.uk/bad.png)'
    const res = await rehostImages(md, deps, OPTS)

    expect(res.rehosted).toBe(1)
    expect(res.failed).toBe(1)
    expect(res.markdown).toContain('cdn.example.com') // the good one rewritten
    expect(res.markdown).toContain('https://img.juya.uk/bad.png') // the failed one preserved
  })

  it('returns markdown unchanged when there are no images', async () => {
    const deps = makeDeps()
    const res = await rehostImages('# just text', deps, OPTS)
    expect(deps.fetchImage).not.toHaveBeenCalled()
    expect(res).toMatchObject({ rehosted: 0, failed: 0, skipped: 0, markdown: '# just text' })
  })
})

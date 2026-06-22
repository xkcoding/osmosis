import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { rssFetcher } from './rss.js'

const ORIGINAL_TZ = process.env.OSMOSIS_TZ
const FIXED_NOW = new Date('2026-05-08T05:00:00.000Z') // → 2026-05-08 in Asia/Shanghai

let fetchMock: ReturnType<typeof vi.fn>

beforeEach(() => {
  process.env.OSMOSIS_TZ = 'Asia/Shanghai'
  vi.useFakeTimers()
  vi.setSystemTime(FIXED_NOW)
  fetchMock = vi.fn()
  vi.stubGlobal('fetch', fetchMock)
})

afterEach(() => {
  vi.useRealTimers()
  vi.unstubAllGlobals()
  if (ORIGINAL_TZ === undefined) delete process.env.OSMOSIS_TZ
  else process.env.OSMOSIS_TZ = ORIGINAL_TZ
})

function feed(description: string): string {
  return `<?xml version="1.0" encoding="utf-8"?>
<rss version="2.0"><channel><title>feed</title>
<item><title>2026-05-08</title><link>https://example.com/2026-05-08/</link>
<description>${description}</description></item>
</channel></rss>`
}

function xmlResp(body: string) {
  return { ok: true, status: 200, text: async () => body }
}

describe('rssFetcher', () => {
  it('parses a feed whose item inlines far more than 1000 escaped entities', async () => {
    // Real daily feeds embed escaped HTML; fast-xml-parser's default
    // maxTotalExpansions=1000 rejects them. Regression guard for the raised cap.
    const heavy = '&lt;p&gt;item&#8197;&amp;&lt;/p&gt;'.repeat(400) // ~2400 entities
    fetchMock.mockResolvedValue(xmlResp(feed(heavy)))

    const result = await rssFetcher.fetch({
      type: 'rss',
      feedUrl: 'https://example.com/rss.xml',
      titlePattern: '{date}',
      title: '橘鸦 AI 早报',
    })

    expect(result).not.toBeNull()
    expect(result?.date).toBe('2026-05-08')
    expect(result?.sourceUrl).toBe('https://example.com/2026-05-08/')
    expect(result?.content).toContain('item')
  })

  it('returns null when no item title matches today', async () => {
    fetchMock.mockResolvedValue(xmlResp(feed('&lt;p&gt;x&lt;/p&gt;').replace('2026-05-08', '2026-05-07')))

    const result = await rssFetcher.fetch({
      type: 'rss',
      feedUrl: 'https://example.com/rss.xml',
      titlePattern: '{date}',
    })

    expect(result).toBeNull()
  })

  it('throws on non-OK HTTP status', async () => {
    fetchMock.mockResolvedValue({ ok: false, status: 404, text: async () => '' })

    await expect(
      rssFetcher.fetch({ type: 'rss', feedUrl: 'https://example.com/gone.xml' }),
    ).rejects.toThrow(/HTTP 404/)
  })
})

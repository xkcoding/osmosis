import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { aihotFetcher } from './aihot.js'

const ORIGINAL_TZ = process.env.OSMOSIS_TZ
const FIXED_NOW = new Date('2026-05-08T05:00:00.000Z')

interface MockResp {
  ok: boolean
  status: number
  json?: () => Promise<unknown>
  text?: () => Promise<string>
}

function jsonResp(status: number, body: unknown): MockResp {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
    text: async () => JSON.stringify(body),
  }
}

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

const dailyOk = {
  date: '2026-05-08',
  generatedAt: '2026-05-08T00:05:00.000Z',
  windowStart: '2026-05-07T00:00:00.000Z',
  windowEnd: '2026-05-08T00:00:00.000Z',
  lead: {
    title: 'lead title',
    leadParagraph: 'today major AI events overview.',
  },
  sections: [
    {
      label: '模型发布/更新',
      items: [
        {
          title: 'Anthropic releases Claude Opus 4.7',
          summary: '1M context window GA.',
          sourceUrl: 'https://anthropic.com/x',
          sourceName: 'Anthropic Blog',
        },
      ],
    },
    { label: '产品发布/更新', items: [] },
    { label: '行业动态', items: [] },
    { label: '论文研究', items: [] },
    { label: '技巧与观点', items: [] },
  ],
  flashes: [
    {
      title: 'Cursor 1.0',
      sourceName: 'Cursor Blog',
      sourceUrl: 'https://cursor.sh/blog/v1',
      publishedAt: '2026-05-08T01:00:00.000Z',
    },
  ],
}

const itemsOk = {
  count: 2,
  hasNext: false,
  nextCursor: null,
  items: [
    {
      id: 'a',
      title: 'GPT-OSS-70B open sourced',
      title_en: null,
      url: 'https://openai.com/blog/gpt-oss',
      permalink: null,
      source: 'OpenAI Blog',
      publishedAt: '2026-05-08T02:15:00.000Z',
      summary: 'OpenAI open-sources 70B model.',
      category: 'ai-models',
    },
    {
      id: 'b',
      title: 'No-summary item',
      title_en: null,
      url: 'https://example.com/b',
      permalink: null,
      source: 'Example',
      publishedAt: null,
      summary: null,
      category: null,
    },
  ],
}

function itemsPage(
  items: unknown[],
  opts: { hasNext?: boolean; nextCursor?: string | null } = {},
): unknown {
  return { count: items.length, hasNext: opts.hasNext ?? false, nextCursor: opts.nextCursor ?? null, items }
}

function selItem(id: string, publishedAt: string | null, extra: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id,
    title: `Item ${id}`,
    url: `https://example.com/${id}`,
    permalink: `https://aihot.virxact.com/items/${id}`,
    source: 'Src',
    publishedAt,
    summary: null,
    category: null,
    ...extra,
  }
}

describe('aihotFetcher', () => {
  it('returns null when daily endpoint is 404, and does not call items', async () => {
    fetchMock.mockResolvedValueOnce(jsonResp(404, { error: 'No daily report for 2026-05-08.' }))
    const result = await aihotFetcher.fetch({ type: 'aihot' })
    expect(result).toBeNull()
    expect(fetchMock).toHaveBeenCalledTimes(1)
    expect((fetchMock.mock.calls[0]![0] as string)).toContain('/api/public/daily/2026-05-08')
  })

  it('throws on daily 5xx', async () => {
    fetchMock.mockResolvedValueOnce(jsonResp(500, { error: 'boom' }))
    await expect(aihotFetcher.fetch({ type: 'aihot' })).rejects.toThrow(/500/)
  })

  it('merges daily + selected into markdown, fills notifyBody, sets metadata', async () => {
    fetchMock.mockResolvedValueOnce(jsonResp(200, dailyOk))
    fetchMock.mockResolvedValueOnce(jsonResp(200, itemsOk))
    const result = await aihotFetcher.fetch({ type: 'aihot' })
    expect(result).not.toBeNull()
    expect(result!.title).toBe('AI HOT 日报')
    expect(result!.date).toBe('2026-05-08')
    expect(result!.sourceUrl).toBe('https://aihot.virxact.com/')
    expect(result!.content).toContain('today major AI events overview.')
    expect(result!.content).toContain('模型发布/更新')
    expect(result!.content).toContain('Claude Opus 4.7')
    expect(result!.content).toContain('快讯')
    expect(result!.content).toContain('精选池')
    expect(result!.content).toContain('GPT-OSS-70B open sourced')
    expect(result!.notifyBody).toBeDefined()
    expect(result!.notifyBody).toContain('today major AI events overview.')
    expect(result!.notifyBody).toContain('模型发布/更新')
    expect(result!.notifyBody).toContain('精选池')
    expect(result!.notifyBody).toContain('GPT-OSS-70B open sourced')
  })

  it('omits selected section from notifyBody when selected is empty', async () => {
    fetchMock.mockResolvedValueOnce(jsonResp(200, dailyOk))
    fetchMock.mockResolvedValueOnce(jsonResp(200, { ...itemsOk, items: [] }))
    const result = await aihotFetcher.fetch({ type: 'aihot' })
    expect(result!.notifyBody).toContain('模型发布/更新')
    expect(result!.notifyBody).not.toContain('精选池')
  })

  it('falls back to daily-only when selected endpoint fails', async () => {
    fetchMock.mockResolvedValueOnce(jsonResp(200, dailyOk))
    fetchMock.mockResolvedValueOnce(jsonResp(503, { error: 'service unavailable' }))
    const result = await aihotFetcher.fetch({ type: 'aihot' })
    expect(result).not.toBeNull()
    expect(result!.content).toContain('today major AI events')
    expect(result!.content).not.toContain('精选池')
  })

  it('omits lead blockquote when lead is null and never renders the literal "null"', async () => {
    const noLead = { ...dailyOk, lead: null }
    fetchMock.mockResolvedValueOnce(jsonResp(200, noLead))
    fetchMock.mockResolvedValueOnce(jsonResp(200, { ...itemsOk, items: [] }))
    const result = await aihotFetcher.fetch({ type: 'aihot' })
    expect(result!.content).not.toMatch(/^>\s/m)
    expect(result!.content).not.toContain('null')
  })

  it('omits empty sections and empty flashes', async () => {
    const skinny = {
      ...dailyOk,
      sections: dailyOk.sections.map((s) => ({ ...s, items: [] })),
      flashes: [],
    }
    fetchMock.mockResolvedValueOnce(jsonResp(200, skinny))
    fetchMock.mockResolvedValueOnce(jsonResp(200, { ...itemsOk, items: [] }))
    const result = await aihotFetcher.fetch({ type: 'aihot' })
    expect(result!.content).not.toContain('模型发布/更新')
    expect(result!.content).not.toContain('快讯')
  })

  it('renders selected items with null summary as title-only line', async () => {
    fetchMock.mockResolvedValueOnce(jsonResp(200, dailyOk))
    fetchMock.mockResolvedValueOnce(
      jsonResp(200, { ...itemsOk, items: [{ ...itemsOk.items[1], publishedAt: '2026-05-08T03:00:00.000Z' }] }),
    )
    const result = await aihotFetcher.fetch({ type: 'aihot' })
    expect(result!.content).toContain('No-summary item')
    expect(result!.content).not.toMatch(/No-summary item.*\n {2}null/)
  })

  it('truncates notifyBody to <= 20480 bytes with the truncation suffix', async () => {
    const huge = {
      ...dailyOk,
      sections: [
        {
          label: '模型发布/更新',
          items: Array.from({ length: 1200 }, (_, i) => ({
            title: `Title ${i}`.padEnd(80, 'x'),
            summary: 'Summary '.padEnd(120, 'y'),
            sourceUrl: 'https://example.com',
            sourceName: 'Example Source',
          })),
        },
        ...dailyOk.sections.slice(1),
      ],
    }
    fetchMock.mockResolvedValueOnce(jsonResp(200, huge))
    fetchMock.mockResolvedValueOnce(jsonResp(200, { ...itemsOk, items: [] }))
    const result = await aihotFetcher.fetch({ type: 'aihot' })
    expect(Buffer.byteLength(result!.notifyBody!, 'utf8')).toBeLessThanOrEqual(20480)
    expect(result!.notifyBody!.endsWith('…\n（已截断）')).toBe(true)
  })

  it('sends a custom User-Agent on every outbound request', async () => {
    fetchMock.mockResolvedValueOnce(jsonResp(200, dailyOk))
    fetchMock.mockResolvedValueOnce(jsonResp(200, itemsOk))
    await aihotFetcher.fetch({ type: 'aihot' })
    for (const call of fetchMock.mock.calls) {
      const init = call[1] as { headers?: Record<string, string> } | undefined
      const ua = init?.headers?.['User-Agent']
      expect(ua).toBeDefined()
      expect(ua).toMatch(/^osmosis\//)
      expect(ua).not.toMatch(/^(curl|node)/i)
    }
  })

  it('passes 48h-window since and take=100 to selected endpoint when no ctx', async () => {
    fetchMock.mockResolvedValueOnce(jsonResp(200, dailyOk))
    fetchMock.mockResolvedValueOnce(jsonResp(200, itemsOk))
    await aihotFetcher.fetch({ type: 'aihot' })
    const itemsUrl = fetchMock.mock.calls[1]![0] as string
    expect(itemsUrl).toContain('mode=selected')
    expect(itemsUrl).toContain('take=100')
    // FIXED_NOW 2026-05-08T05:00:00Z − 48h
    expect(decodeURIComponent(itemsUrl)).toContain('since=2026-05-06T05:00:00.000Z')
  })
})

describe('aihot selected window & pagination', () => {
  it('uses min(lastSyncedAt, now-48h) as since', async () => {
    fetchMock.mockResolvedValueOnce(jsonResp(200, dailyOk))
    fetchMock.mockResolvedValueOnce(jsonResp(200, itemsPage([])))
    // lastSyncedAt (05-03) older than now-48h (05-06T05:00) → wins
    await aihotFetcher.fetch({ type: 'aihot' }, { lastSyncedAt: '2026-05-03T00:00:00.000Z' })
    expect(decodeURIComponent(fetchMock.mock.calls[1]![0] as string)).toContain('since=2026-05-03T00:00:00.000Z')
  })

  it('clamps since to now-7d', async () => {
    fetchMock.mockResolvedValueOnce(jsonResp(200, dailyOk))
    fetchMock.mockResolvedValueOnce(jsonResp(200, itemsPage([])))
    await aihotFetcher.fetch({ type: 'aihot' }, { lastSyncedAt: '2026-04-01T00:00:00.000Z' })
    expect(decodeURIComponent(fetchMock.mock.calls[1]![0] as string)).toContain('since=2026-05-01T05:00:00.000Z')
  })

  it('paginates with nextCursor and 200ms gap, merging pages', async () => {
    fetchMock.mockResolvedValueOnce(jsonResp(200, dailyOk))
    fetchMock.mockResolvedValueOnce(
      jsonResp(200, itemsPage([selItem('p1', '2026-05-08T02:00:00.000Z')], { hasNext: true, nextCursor: 'c1' })),
    )
    fetchMock.mockResolvedValueOnce(jsonResp(200, itemsPage([selItem('p2', '2026-05-08T01:00:00.000Z')])))
    const promise = aihotFetcher.fetch({ type: 'aihot' })
    const [result] = await Promise.all([promise, vi.runAllTimersAsync()])
    expect(result!.content).toContain('Item p1')
    expect(result!.content).toContain('Item p2')
    expect(decodeURIComponent(fetchMock.mock.calls[2]![0] as string)).toContain('cursor=c1')
  })

  it('stops at the first non-null publishedAt older than since and drops it', async () => {
    fetchMock.mockResolvedValueOnce(jsonResp(200, dailyOk))
    fetchMock.mockResolvedValueOnce(
      jsonResp(200, itemsPage(
        [selItem('new1', '2026-05-08T02:00:00.000Z'), selItem('old1', '2026-05-01T00:00:00.000Z')],
        { hasNext: true, nextCursor: 'c1' },
      )),
    )
    const result = await aihotFetcher.fetch({ type: 'aihot' })
    expect(result!.content).toContain('Item new1')
    expect(result!.content).not.toContain('Item old1')
    expect(fetchMock).toHaveBeenCalledTimes(2) // daily + 1 page，未跟进 cursor
  })

  it('skips null-publishedAt items without terminating pagination', async () => {
    fetchMock.mockResolvedValueOnce(jsonResp(200, dailyOk))
    fetchMock.mockResolvedValueOnce(
      jsonResp(200, itemsPage(
        [selItem('nullpub', null), selItem('good', '2026-05-08T02:00:00.000Z')],
      )),
    )
    const result = await aihotFetcher.fetch({ type: 'aihot' })
    expect(result!.content).not.toContain('Item nullpub')
    expect(result!.content).toContain('Item good')
  })

  it('stops when a page yields no new ids (cursor silently reset)', async () => {
    fetchMock.mockResolvedValueOnce(jsonResp(200, dailyOk))
    fetchMock.mockResolvedValueOnce(
      jsonResp(200, itemsPage([selItem('x', '2026-05-08T02:00:00.000Z')], { hasNext: true, nextCursor: 'c1' })),
    )
    fetchMock.mockResolvedValueOnce(
      jsonResp(200, itemsPage([selItem('x', '2026-05-08T02:00:00.000Z')], { hasNext: true, nextCursor: 'c2' })),
    )
    const promise = aihotFetcher.fetch({ type: 'aihot' })
    const [result] = await Promise.all([promise, vi.runAllTimersAsync()])
    expect(fetchMock).toHaveBeenCalledTimes(3) // daily + 2 pages，第三页不再请求
    expect(result!.content).toContain('Item x')
  })

  it('hard-caps pagination at 5 pages', async () => {
    fetchMock.mockResolvedValueOnce(jsonResp(200, dailyOk))
    for (let i = 0; i < 6; i++) {
      fetchMock.mockResolvedValueOnce(
        jsonResp(200, itemsPage([selItem(`pg${i}`, '2026-05-08T02:00:00.000Z')], { hasNext: true, nextCursor: `c${i}` })),
      )
    }
    const promise = aihotFetcher.fetch({ type: 'aihot' })
    await Promise.all([promise, vi.runAllTimersAsync()])
    expect(fetchMock).toHaveBeenCalledTimes(6) // daily + 5 pages
  })

  it('retries once with backoff on 429 (daily), then succeeds', async () => {
    fetchMock.mockResolvedValueOnce(jsonResp(429, { error: 'rate_limited' }))
    fetchMock.mockResolvedValueOnce(jsonResp(200, dailyOk))
    fetchMock.mockResolvedValueOnce(jsonResp(200, itemsPage([])))
    const promise = aihotFetcher.fetch({ type: 'aihot' })
    const [result] = await Promise.all([promise, vi.runAllTimersAsync()])
    expect(result).not.toBeNull()
    expect(fetchMock).toHaveBeenCalledTimes(3)
  })

  it('degrades selected to collected-so-far when a later page errors', async () => {
    fetchMock.mockResolvedValueOnce(jsonResp(200, dailyOk))
    fetchMock.mockResolvedValueOnce(
      jsonResp(200, itemsPage([selItem('keep', '2026-05-08T02:00:00.000Z')], { hasNext: true, nextCursor: 'c1' })),
    )
    fetchMock.mockResolvedValueOnce(jsonResp(503, { error: 'boom' }))
    const promise = aihotFetcher.fetch({ type: 'aihot' })
    const [result] = await Promise.all([promise, vi.runAllTimersAsync()])
    expect(result).not.toBeNull()
    expect(result!.content).toContain('Item keep')
  })
})

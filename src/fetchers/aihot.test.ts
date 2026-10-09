import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { aihotFetcher } from './aihot.js'
import type { FetchContext } from './types.js'

const ORIGINAL_TZ = process.env.OSMOSIS_TZ
const ORIGINAL_DATE = process.env.OSMOSIS_DATE
const FIXED_NOW = new Date('2026-10-20T05:00:00.000Z')
const API = 'https://aihot.news/api/v1'

interface MockResp {
  ok: boolean
  status: number
  json: () => Promise<unknown>
}

function jsonResp(status: number, body: unknown): MockResp {
  return { ok: status >= 200 && status < 300, status, json: async () => body }
}

type Handler = MockResp | Error | ((url: string) => MockResp | Error)

/** 按 URL 前缀路由；数组 = 依次消费（最后一个重复使用） */
let routes: Record<string, Handler | Handler[]>
let fetchMock: ReturnType<typeof vi.fn>

/** 驱动 sleep（页间隔 / 429 退避）的假定时器跑完，避免真实等待 */
async function run(ctx?: FetchContext): Promise<Awaited<ReturnType<typeof aihotFetcher.fetch>>> {
  const p = aihotFetcher.fetch({ type: 'aihot' }, ctx)
  p.catch(() => undefined)
  await vi.runAllTimersAsync()
  return p
}

function urls(): string[] {
  return fetchMock.mock.calls.map((c) => c[0] as string)
}

function callsTo(prefix: string): string[] {
  return urls().filter((u) => u.startsWith(`${API}${prefix}`))
}

beforeEach(() => {
  process.env.OSMOSIS_TZ = 'Asia/Shanghai'
  delete process.env.OSMOSIS_DATE
  vi.useFakeTimers()
  vi.setSystemTime(FIXED_NOW)
  routes = {}
  fetchMock = vi.fn(async (url: string) => {
    const key = Object.keys(routes)
      .sort((a, b) => b.length - a.length)
      .find((k) => url.startsWith(`${API}${k}`))
    if (!key) throw new Error(`unrouted ${url}`)
    let h = routes[key]!
    if (Array.isArray(h)) h = h.length > 1 ? h.shift()! : h[0]!
    const r = typeof h === 'function' ? h(url) : h
    if (r instanceof Error) throw r
    return r
  })
  vi.stubGlobal('fetch', fetchMock)
})

afterEach(() => {
  vi.useRealTimers()
  vi.unstubAllGlobals()
  if (ORIGINAL_TZ === undefined) delete process.env.OSMOSIS_TZ
  else process.env.OSMOSIS_TZ = ORIGINAL_TZ
  if (ORIGINAL_DATE === undefined) delete process.env.OSMOSIS_DATE
  else process.env.OSMOSIS_DATE = ORIGINAL_DATE
})

function report(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    date: '2026-10-20',
    generatedAt: '2026-10-20T00:00:15.000Z',
    windowStart: '2026-10-19T00:00:00.000Z',
    windowEnd: '2026-10-20T00:00:00.000Z',
    links: { aihot: 'https://aihot.news/daily/2026-10-20' },
    lead: { title: 'lead title', leadParagraph: 'today major AI events overview.' },
    sections: [
      {
        label: '模型发布/更新',
        items: [
          {
            title: 'Anthropic releases Claude Opus 5.5',
            summary: '1M context window GA.',
            source: { name: 'Anthropic Blog' },
            links: { aihot: 'https://aihot.news/items/opus55', original: 'https://anthropic.com/x' },
          },
        ],
      },
      { label: '产品发布/更新', items: [] },
    ],
    flashes: [
      {
        title: 'Cursor 3.0',
        source: { name: 'Cursor Blog' },
        links: { aihot: 'https://aihot.news/items/cursor3', original: 'https://cursor.sh/blog/v3' },
        publishedAt: '2026-10-20T01:00:00.000Z',
      },
    ],
    ...overrides,
  }
}

const dailyOk = (overrides: Record<string, unknown> = {}): MockResp =>
  jsonResp(200, { schemaVersion: 1, report: report(overrides) })

function item(id: string, extra: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id,
    title: `Item ${id}`,
    originalTitle: null,
    summary: null,
    source: { name: 'Src' },
    links: { aihot: `https://aihot.news/items/${id}`, original: `https://example.com/${id}` },
    publishedAt: '2026-10-19T10:00:00.000Z',
    discoveredAt: '2026-10-19T10:05:00.000Z',
    category: null,
    score: 70,
    selected: true,
    reason: null,
    ...extra,
  }
}

function itemsPage(items: unknown[], opts: { hasMore?: boolean; nextCursor?: string | null } = {}): MockResp {
  return jsonResp(200, {
    schemaVersion: 1,
    query: {},
    items,
    page: { count: items.length, hasMore: opts.hasMore ?? false, nextCursor: opts.nextCursor ?? null },
  })
}

const upsert = (it: Record<string, unknown>): Record<string, unknown> => ({
  op: 'upsert',
  changedAt: '2026-10-19T12:00:00.000Z',
  item: it,
})
const remove = (id: string): Record<string, unknown> => ({ op: 'remove', changedAt: '2026-10-19T13:00:00.000Z', id })

function changesPage(changes: unknown[], cursor: string, hasMore = false): MockResp {
  return jsonResp(200, { schemaVersion: 1, fields: 'default', cursor, count: changes.length, hasMore, changes })
}

const snapshotOk = (cursor = 'SNAP'): MockResp =>
  jsonResp(200, { schemaVersion: 1, asOf: '2026-10-20T05:00:00Z', fields: 'default', cursor, count: 1, hasMore: true, nextPage: 'p2', items: [] })

let recentN: number[] = []

function ctxWith(opts: { cursor?: string; recent?: string[]; stateThrows?: boolean; recentThrows?: boolean } = {}): FetchContext {
  recentN = []
  return {
    getLastSyncState: async () => {
      if (opts.stateThrows) throw new Error('gh down')
      return opts.cursor ? { cursor: opts.cursor } : undefined
    },
    getRecentSyncedContents: async (n: number) => {
      recentN.push(n)
      if (opts.recentThrows) throw new Error('gh down')
      return opts.recent ?? []
    },
  }
}

describe('aihot daily (v1)', () => {
  it('returns null when daily is 404, and calls no selected endpoint', async () => {
    routes['/dailies/'] = jsonResp(404, { type: '/problems/not-found', status: 404, code: 'not_found' })
    const result = await run(ctxWith({ cursor: 'C0' }))
    expect(result).toBeNull()
    expect(urls()).toEqual([`${API}/dailies/2026-10-20`])
  })

  it('throws on daily 5xx with status and endpoint in the message', async () => {
    routes['/dailies/'] = jsonResp(500, {})
    await expect(run()).rejects.toThrow(/500.*\/dailies\/2026-10-20/)
  })

  it('renders daily report with dual links, sets metadata and notifyBody', async () => {
    routes['/dailies/'] = dailyOk()
    routes['/selected/snapshot'] = snapshotOk()
    routes['/items'] = itemsPage([])
    const result = await run()
    expect(result!.title).toBe('AI HOT 日报')
    expect(result!.date).toBe('2026-10-20')
    expect(result!.sourceUrl).toBe('https://aihot.news/')
    expect(result!.content).toContain('> today major AI events overview.')
    expect(result!.content).toContain('## 🚀 模型发布/更新')
    expect(result!.content).toContain(
      '- [Anthropic releases Claude Opus 5.5](https://aihot.news/items/opus55) — Anthropic Blog（[原文](https://anthropic.com/x)）',
    )
    expect(result!.content).toContain('  1M context window GA.')
    expect(result!.content).toContain('## ⚡️ 快讯')
    expect(result!.content).not.toContain('产品发布/更新')
    expect(result!.content).not.toContain('新入选精选')
    expect(result!.notifyBody).toBe(result!.content)
  })

  it('omits lead when null and never renders the literal "null"', async () => {
    routes['/dailies/'] = dailyOk({ lead: null })
    routes['/selected/snapshot'] = snapshotOk()
    routes['/items'] = itemsPage([])
    const result = await run()
    expect(result!.content).not.toMatch(/^>/m)
    expect(result!.content).not.toContain('null')
  })

  it('omits empty sections and empty flashes', async () => {
    routes['/dailies/'] = dailyOk({ sections: [{ label: '行业动态', items: [] }], flashes: [] })
    routes['/selected/snapshot'] = snapshotOk()
    routes['/items'] = itemsPage([item('a')])
    const result = await run()
    expect(result!.content).not.toContain('行业动态')
    expect(result!.content).not.toContain('快讯')
    expect(result!.content).toContain('## 🔥 新入选精选')
  })

  it('falls back to a single link when only the original link exists', async () => {
    routes['/dailies/'] = dailyOk({
      sections: [{ label: '论文研究', items: [{ title: 'Paper', summary: null, source: { name: 'arXiv' }, links: { original: 'https://arxiv.org/x' } }] }],
    })
    routes['/selected/snapshot'] = snapshotOk()
    routes['/items'] = itemsPage([])
    const result = await run()
    expect(result!.content).toContain('- [Paper](https://arxiv.org/x) — arXiv')
  })

  it('sends a custom User-Agent and only hits aihot.news/api/v1', async () => {
    routes['/dailies/'] = dailyOk()
    routes['/selected/changes'] = changesPage([upsert(item('a'))], 'C1')
    await run(ctxWith({ cursor: 'C0' }))
    for (const call of fetchMock.mock.calls) {
      expect((call[0] as string).startsWith(`${API}/`)).toBe(true)
      const ua = (call[1] as { headers: Record<string, string> }).headers['User-Agent']!
      expect(ua).toMatch(/^osmosis\//)
    }
  })

  it('retries once with backoff on 429, then succeeds', async () => {
    routes['/dailies/'] = [jsonResp(429, {}), dailyOk()]
    routes['/selected/snapshot'] = snapshotOk()
    routes['/items'] = itemsPage([])
    const result = await run()
    expect(result).not.toBeNull()
    expect(callsTo('/dailies/')).toHaveLength(2)
  })

  it('truncates notifyBody to <= 20480 bytes with the truncation suffix', async () => {
    const huge = Array.from({ length: 400 }, (_, i) => ({
      title: `T${i}`,
      summary: '很长的摘要'.repeat(20),
      source: { name: 'S' },
      links: { original: `https://e.com/${i}` },
    }))
    routes['/dailies/'] = dailyOk({ sections: [{ label: '行业动态', items: huge }] })
    routes['/selected/snapshot'] = snapshotOk()
    routes['/items'] = itemsPage([])
    const result = await run()
    expect(Buffer.byteLength(result!.notifyBody!, 'utf8')).toBeLessThanOrEqual(20480)
    expect(result!.notifyBody!.endsWith('…\n（已截断）')).toBe(true)
  })
})

describe('aihot selected ledger (selected/changes)', () => {
  it('reads changes from the last cursor and writes the returned cursor', async () => {
    routes['/dailies/'] = dailyOk()
    routes['/selected/changes'] = changesPage([upsert(item('a', { summary: 'sum a' })), upsert(item('b'))], 'C1')
    const result = await run(ctxWith({ cursor: 'C0' }))
    expect(callsTo('/selected/changes')[0]).toBe(`${API}/selected/changes?cursor=C0&limit=100`)
    expect(callsTo('/items')).toHaveLength(0)
    expect(callsTo('/selected/snapshot')).toHaveLength(0)
    expect(result!.syncState).toEqual({ cursor: 'C1' })
    // 账本旧→新，渲染新→旧
    const sel = result!.content.split('## 🔥 新入选精选')[1]!
    expect(sel.indexOf('Item b')).toBeLessThan(sel.indexOf('Item a'))
    expect(sel).toContain('- [Item a](https://aihot.news/items/a) — Src（[原文](https://example.com/a)）\n  sum a')
  })

  it('drops items removed later in the same batch, ignores removes of unseen items', async () => {
    routes['/dailies/'] = dailyOk()
    routes['/selected/changes'] = changesPage([upsert(item('x')), upsert(item('y')), remove('x'), remove('zzz')], 'C1')
    const result = await run(ctxWith({ cursor: 'C0' }))
    expect(result!.content).not.toContain('Item x')
    expect(result!.content).toContain('Item y')
  })

  it('keeps one entry per id (last upsert wins) and skips selected:false upserts', async () => {
    routes['/dailies/'] = dailyOk()
    routes['/selected/changes'] = changesPage(
      [upsert(item('a')), upsert(item('a', { title: 'Item a v2' })), upsert(item('n', { selected: false }))],
      'C1',
    )
    const result = await run(ctxWith({ cursor: 'C0' }))
    expect(result!.content).toContain('Item a v2')
    expect(result!.content.match(/\(https:\/\/aihot\.news\/items\/a\)/g)).toHaveLength(1)
    expect(result!.content).not.toContain('Item n')
  })

  it('does not render reason', async () => {
    routes['/dailies/'] = dailyOk()
    routes['/selected/changes'] = changesPage([upsert(item('a', { reason: '值得一读的推荐理由' }))], 'C1')
    const result = await run(ctxWith({ cursor: 'C0' }))
    expect(result!.content).toContain('Item a')
    expect(result!.content).not.toContain('值得一读的推荐理由')
  })

  it('paginates with the returned cursor until hasMore is false', async () => {
    routes['/dailies/'] = dailyOk()
    routes['/selected/changes'] = (url: string) =>
      url.includes('cursor=C0') ? changesPage([upsert(item('p1'))], 'C1', true) : changesPage([upsert(item('p2'))], 'C2')
    const result = await run(ctxWith({ cursor: 'C0' }))
    expect(callsTo('/selected/changes')).toHaveLength(2)
    expect(callsTo('/selected/changes')[1]).toContain('cursor=C1')
    expect(result!.content).toContain('Item p1')
    expect(result!.content).toContain('Item p2')
    expect(result!.syncState).toEqual({ cursor: 'C2' })
  })

  it('at the page cap writes the last applied cursor and renders no truncation notice', async () => {
    let n = 0
    routes['/dailies/'] = dailyOk()
    routes['/selected/changes'] = () => {
      n++
      return changesPage([upsert(item(`i${n}`))], `C${n}`, true)
    }
    const result = await run(ctxWith({ cursor: 'C0' }))
    expect(callsTo('/selected/changes')).toHaveLength(5)
    expect(result!.syncState).toEqual({ cursor: 'C5' })
    expect(result!.content).not.toContain('⚠️')
  })

  it('keeps the original cursor when the first page fails (daily only)', async () => {
    routes['/dailies/'] = dailyOk()
    routes['/selected/changes'] = jsonResp(503, {})
    const result = await run(ctxWith({ cursor: 'C0' }))
    expect(result!.content).not.toContain('新入选精选')
    expect(result!.syncState).toEqual({ cursor: 'C0' })
    expect(callsTo('/items')).toHaveLength(0)
  })

  it('keeps applied pages and their cursor when a later page fails', async () => {
    routes['/dailies/'] = dailyOk()
    routes['/selected/changes'] = (url: string) =>
      url.includes('cursor=C0') ? changesPage([upsert(item('p1'))], 'C1', true) : new Error('network')
    const result = await run(ctxWith({ cursor: 'C0' }))
    expect(result!.content).toContain('Item p1')
    expect(result!.syncState).toEqual({ cursor: 'C1' })
  })

  it('falls back to snapshot + window on 409 snapshot_required', async () => {
    routes['/dailies/'] = dailyOk()
    routes['/selected/changes'] = jsonResp(409, { code: 'snapshot_required', status: 409 })
    routes['/selected/snapshot'] = snapshotOk('SNAP')
    routes['/items'] = itemsPage([item('w')])
    const result = await run(ctxWith({ cursor: 'C0' }))
    expect(result!.content).toContain('Item w')
    expect(result!.syncState).toEqual({ cursor: 'SNAP' })
  })
})

describe('aihot selected fallback window', () => {
  it('without a cursor: snapshot first, then the 7d window; writes the snapshot cursor', async () => {
    routes['/dailies/'] = dailyOk()
    routes['/selected/snapshot'] = snapshotOk('SNAP')
    routes['/items'] = itemsPage([item('a'), item('b')])
    const result = await run(ctxWith())
    const order = urls().filter((u) => !u.includes('/dailies/'))
    expect(order[0]).toBe(`${API}/selected/snapshot?limit=1`)
    expect(order[1]).toBe(`${API}/items?mode=selected&window=7d&by=timeline&limit=100`)
    expect(callsTo('/selected/changes')).toHaveLength(0)
    expect(result!.syncState).toEqual({ cursor: 'SNAP' })
    expect(result!.content).toContain('Item a')
    expect(result!.content).toContain('Item b')
  })

  it('falls back when reading the last sync_state throws', async () => {
    routes['/dailies/'] = dailyOk()
    routes['/selected/snapshot'] = snapshotOk('SNAP')
    routes['/items'] = itemsPage([item('a')])
    const result = await run(ctxWith({ stateThrows: true }))
    expect(result!.content).toContain('Item a')
    expect(result!.syncState).toEqual({ cursor: 'SNAP' })
  })

  it('works without ctx (local smoke run)', async () => {
    routes['/dailies/'] = dailyOk()
    routes['/selected/snapshot'] = snapshotOk('SNAP')
    routes['/items'] = itemsPage([item('a')])
    const result = await run()
    expect(result!.content).toContain('Item a')
    expect(result!.syncState).toEqual({ cursor: 'SNAP' })
  })

  it('still renders the window but writes no sync_state when snapshot fails', async () => {
    routes['/dailies/'] = dailyOk()
    routes['/selected/snapshot'] = jsonResp(503, {})
    routes['/items'] = itemsPage([item('a')])
    const result = await run(ctxWith())
    expect(result!.content).toContain('Item a')
    expect(result!.syncState).toBeUndefined()
  })

  it('paginates with page.nextCursor and stops when a page yields no new ids', async () => {
    routes['/dailies/'] = dailyOk()
    routes['/selected/snapshot'] = snapshotOk()
    routes['/items'] = (url: string) =>
      url.includes('cursor=N1')
        ? itemsPage([item('a')], { hasMore: true, nextCursor: 'N2' }) // 无新 id → 停
        : itemsPage([item('a')], { hasMore: true, nextCursor: 'N1' })
    await run(ctxWith())
    expect(callsTo('/items')).toHaveLength(2)
    expect(callsTo('/items')[1]).toContain('&cursor=N1')
  })

  it('renders a visible truncation notice when the window hits the page cap', async () => {
    let n = 0
    routes['/dailies/'] = dailyOk()
    routes['/selected/snapshot'] = snapshotOk()
    routes['/items'] = () => {
      n++
      return itemsPage([item(`w${n}`)], { hasMore: true, nextCursor: `N${n}` })
    }
    const result = await run(ctxWith())
    expect(callsTo('/items')).toHaveLength(5)
    expect(result!.content).toContain('> ⚠️ 精选池已达单次抓取上限')
    expect(result!.content).not.toContain('次日')
  })

  it('degrades to daily-only when the window endpoint fails', async () => {
    routes['/dailies/'] = dailyOk()
    routes['/selected/snapshot'] = snapshotOk('SNAP')
    routes['/items'] = jsonResp(503, {})
    const result = await run(ctxWith())
    expect(result!.content).toContain('模型发布/更新')
    expect(result!.content).not.toContain('新入选精选')
    expect(result!.syncState).toEqual({ cursor: 'SNAP' })
  })
})

describe('aihot pushed-set dedup', () => {
  it('drops items whose id appears under the old aihot.virxact.com domain in history', async () => {
    routes['/dailies/'] = dailyOk()
    routes['/selected/changes'] = changesPage([upsert(item('abc')), upsert(item('fresh'))], 'C1')
    const result = await run(ctxWith({ cursor: 'C0', recent: ['- [old](https://aihot.virxact.com/items/abc) — X（[原文](https://elsewhere.com/abc)）'] }),
    )
    expect(result!.content).not.toContain('Item abc')
    expect(result!.content).toContain('Item fresh')
  })

  it('drops items whose original url appeared in history (cross-key)', async () => {
    routes['/dailies/'] = dailyOk()
    routes['/selected/changes'] = changesPage([upsert(item('k'))], 'C1')
    const result = await run(ctxWith({ cursor: 'C0', recent: ['- [t](https://example.com/k)'] }),
    )
    expect(result!.content).not.toContain('Item k')
  })

  it('drops an edited upsert of an already-pushed item', async () => {
    routes['/dailies/'] = dailyOk()
    routes['/selected/changes'] = changesPage([upsert(item('ed', { title: 'Edited title' }))], 'C1')
    const result = await run(ctxWith({ cursor: 'C0', recent: ['- [Item ed](https://aihot.news/items/ed) — Src（[原文](https://example.com/ed)）'] }),
    )
    expect(result!.content).not.toContain('Edited title')
  })

  it('drops items colliding with today daily (by id or original url), keeping the daily entry', async () => {
    routes['/dailies/'] = dailyOk()
    routes['/selected/changes'] = changesPage(
      [
        upsert(item('opus55', { title: 'dup by id' })),
        upsert(item('other', { title: 'dup by url', links: { aihot: 'https://aihot.news/items/other', original: 'https://cursor.sh/blog/v3' } })),
      ],
      'C1',
    )
    const result = await run(ctxWith({ cursor: 'C0' }))
    expect(result!.content).toContain('Anthropic releases Claude Opus 5.5')
    expect(result!.content).not.toContain('dup by id')
    expect(result!.content).not.toContain('dup by url')
    expect(result!.content).not.toContain('新入选精选')
  })

  it('reads 3 recent PRs on the ledger path and 8 on the 7d fallback window', async () => {
    routes['/dailies/'] = dailyOk()
    routes['/selected/changes'] = changesPage([upsert(item('a'))], 'C1')
    await run(ctxWith({ cursor: 'C0' }))
    expect(recentN).toEqual([3])

    routes['/selected/snapshot'] = snapshotOk()
    routes['/items'] = itemsPage([item('b')])
    await run(ctxWith())
    expect(recentN).toEqual([8])
  })

  it('keeps all items when reading history throws (duplicate beats loss)', async () => {
    routes['/dailies/'] = dailyOk()
    routes['/selected/changes'] = changesPage([upsert(item('a'))], 'C1')
    const result = await run(ctxWith({ cursor: 'C0', recentThrows: true }))
    expect(result!.content).toContain('Item a')
  })
})

describe('aihot backfill (OSMOSIS_DATE pinned)', () => {
  it('requests only the pinned daily, reads no sync state and writes none', async () => {
    process.env.OSMOSIS_DATE = '2026-10-15'
    routes['/dailies/'] = dailyOk({ date: '2026-10-15' })
    const getLastSyncState = vi.fn(async () => ({ cursor: 'C0' }))
    const result = await run({ getLastSyncState, getRecentSyncedContents: async () => [] },
    )
    expect(urls()).toEqual([`${API}/dailies/2026-10-15`])
    expect(getLastSyncState).not.toHaveBeenCalled()
    expect(result!.date).toBe('2026-10-15')
    expect(result!.syncState).toBeUndefined()
    expect(result!.content).not.toContain('新入选精选')
  })
})

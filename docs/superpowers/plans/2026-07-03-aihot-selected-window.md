# aihot 精选池推送窗口重构 — 实现计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** aihot 精选池从"当天 UTC 午夜起、单页 20 条"改为"粗窗口（48h/lastSyncedAt）翻页拿全 + 已推送集合精确去重"，消除系统性遗漏；卡片链接改为站内 permalink + 原文双链接。

**Architecture:** 三层改动：① `src/dedup.ts` 的 gh 查询扩展出 `lastSyncedAt`；② `Fetcher` 接口新增可选 `FetchContext`（`lastSyncedAt` + 懒加载历史 PR 内容回调），由 `src/index.ts` 注入，fetcher 不碰 gh；③ `src/fetchers/aihot.ts` 实现粗窗口、cursor 翻页（防静默回首屏）、429 退避、双键集合去重、双链接渲染。

**Tech Stack:** TypeScript (native ESM，import 必须带 `.js` 后缀)、vitest（fake timers + `vi.stubGlobal('fetch')` 模式，见 `src/fetchers/aihot.test.ts`）、gh CLI（经 `promisify(execFile)`）。

**Spec:** `docs/superpowers/specs/2026-07-03-aihot-selected-window-design.md`

## Global Constraints

- 每个任务完成后跑 `pnpm check`（typecheck + lint + test）必须全绿才能 commit。
- 插件架构：fetcher 不 import gh/child_process，不特判源名。
- items API 契约：`take` ≤ 100；cursor 不透明、失效静默回首屏；排序 `publishedAt` 倒序；`since` 服务端上限 7 天。
- 常量：`SELECTED_TAKE=100`、`MAX_PAGES=5`、`PAGE_INTERVAL_MS=200`、`RETRY_429_MS=1500`、`OVERLAP_MS=48h`、`SINCE_CAP_MS=7d`、`RECENT_PR_COUNT=3`。
- 去重键：每条目 `permalink` 与原文 `url` **双键，任一命中即重**；禁用 `permalink ?? url` 单键。
- 出错取向：历史 PR 回读失败 → 去重集合降级为空（宁重勿漏，warn 日志）；selected 端点失败 → 降级 daily-only（现状保留）。
- 不改：两个 label 幂等机制、一源一卡、workflow、其他 fetcher 行为、notify body 20KB 截断。

---

### Task 1: `getSyncStatus` 替换 `isAlreadySynced`（`src/dedup.ts`）

**Files:**
- Modify: `src/dedup.ts`
- Create: `src/dedup.test.ts`
- Modify: `src/index.ts:8,100-107`（改 import 与调用点，本任务内保证编译通过）

**Interfaces:**
- Produces: `getSyncStatus(query: DedupQuery): Promise<SyncStatus>`，`SyncStatus = { syncedToday: boolean; lastSyncedAt: string | null }`。`lastSyncedAt` 为该源 OPEN/MERGED PR 中最大 `createdAt`（不限日期）。旧 `isAlreadySynced` 删除。

- [ ] **Step 1: 写失败测试 `src/dedup.test.ts`**

```ts
import { describe, it, expect, beforeEach, vi } from 'vitest'

const ghMock = vi.hoisted(() => vi.fn())

vi.mock('node:child_process', async () => {
  const { promisify } = await import('node:util')
  const execFile: ((...args: unknown[]) => void) & Record<symbol, unknown> = () => {
    throw new Error('use promisified form')
  }
  execFile[promisify.custom] = ghMock
  return { execFile }
})

const { getSyncStatus } = await import('./dedup.js')

beforeEach(() => {
  ghMock.mockReset()
})

function ghList(prs: { title: string; state: string; createdAt: string }[]): void {
  ghMock.mockResolvedValueOnce({ stdout: JSON.stringify(prs), stderr: '' })
}

describe('getSyncStatus', () => {
  it('reports syncedToday when an OPEN PR title contains the date', async () => {
    ghList([{ title: 'sync(aihot): 2026-07-03', state: 'OPEN', createdAt: '2026-07-03T00:10:00Z' }])
    const s = await getSyncStatus({ targetRepo: 'o/r', sourceName: 'aihot', date: '2026-07-03' })
    expect(s.syncedToday).toBe(true)
    expect(s.lastSyncedAt).toBe('2026-07-03T00:10:00Z')
  })

  it('ignores CLOSED PRs for both fields', async () => {
    ghList([{ title: 'sync(aihot): 2026-07-03', state: 'CLOSED', createdAt: '2026-07-03T00:10:00Z' }])
    const s = await getSyncStatus({ targetRepo: 'o/r', sourceName: 'aihot', date: '2026-07-03' })
    expect(s.syncedToday).toBe(false)
    expect(s.lastSyncedAt).toBeNull()
  })

  it('returns max createdAt across dates as lastSyncedAt even when today is unsynced', async () => {
    ghList([
      { title: 'sync(aihot): 2026-07-01', state: 'MERGED', createdAt: '2026-07-01T00:12:00Z' },
      { title: 'sync(aihot): 2026-07-02', state: 'MERGED', createdAt: '2026-07-02T00:11:00Z' },
    ])
    const s = await getSyncStatus({ targetRepo: 'o/r', sourceName: 'aihot', date: '2026-07-03' })
    expect(s.syncedToday).toBe(false)
    expect(s.lastSyncedAt).toBe('2026-07-02T00:11:00Z')
  })

  it('returns nulls on empty list', async () => {
    ghList([])
    const s = await getSyncStatus({ targetRepo: 'o/r', sourceName: 'aihot', date: '2026-07-03' })
    expect(s).toEqual({ syncedToday: false, lastSyncedAt: null })
  })

  it('queries gh with both labels and state all and createdAt field', async () => {
    ghList([])
    await getSyncStatus({ targetRepo: 'o/r', sourceName: 'aihot', date: '2026-07-03' })
    const args = ghMock.mock.calls[0]![1] as string[]
    expect(args).toContain('auto-sync,source:aihot')
    expect(args).toContain('all')
    expect(args.join(' ')).toContain('createdAt')
  })
})
```

- [ ] **Step 2: 跑测试确认失败**

Run: `pnpm vitest run src/dedup.test.ts`
Expected: FAIL —— `getSyncStatus` 未导出。

- [ ] **Step 3: 实现 `src/dedup.ts`（整文件替换为）**

```ts
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'

const execFileAsync = promisify(execFile)

export interface DedupQuery {
  targetRepo: string
  sourceName: string
  date: string
}

export interface SyncStatus {
  syncedToday: boolean
  lastSyncedAt: string | null
}

export async function getSyncStatus(query: DedupQuery): Promise<SyncStatus> {
  const { stdout } = await execFileAsync('gh', [
    'pr', 'list',
    '--repo', query.targetRepo,
    '--label', `auto-sync,source:${query.sourceName}`,
    '--state', 'all',
    '--json', 'title,state,createdAt',
    '--limit', '50',
  ])
  const list = JSON.parse(stdout) as { title: string; state: string; createdAt: string }[]
  const active = list.filter((p) => p.state === 'OPEN' || p.state === 'MERGED')
  const syncedToday = active.some((p) => p.title.includes(query.date))
  let lastSyncedAt: string | null = null
  for (const p of active) {
    if (lastSyncedAt === null || p.createdAt > lastSyncedAt) lastSyncedAt = p.createdAt
  }
  return { syncedToday, lastSyncedAt }
}
```

- [ ] **Step 4: 更新 `src/index.ts` 调用点**

`import { isAlreadySynced } from './dedup.js'` 改为 `import { getSyncStatus } from './dedup.js'`；`runFetch` 中：

```ts
  const targetRepo = process.env.TARGET_REPO
  if (targetRepo) {
    const status = await getSyncStatus({ targetRepo, sourceName: sub.name, date: parts.date })
    if (status.syncedToday) {
      console.log(`[fetch] ${sub.name} ${parts.date}: already synced, skip`)
      writeOutput('has_new_content', 'false')
      writeOutput('source_name', sub.name)
      writeOutput('date', parts.date)
      return
    }
  }
```

（`lastSyncedAt` 的使用在 Task 3 接线，本任务先保证行为等价。）

- [ ] **Step 5: 跑 `pnpm check` 确认全绿**

- [ ] **Step 6: Commit**

```bash
git add src/dedup.ts src/dedup.test.ts src/index.ts
git commit -m "feat(dedup): getSyncStatus returns lastSyncedAt alongside synced flag"
```

---

### Task 2: `fetchRecentSyncedContents`（`src/pr-listing.ts`）

**Files:**
- Modify: `src/pr-listing.ts`
- Create: `src/pr-listing.test.ts`

**Interfaces:**
- Consumes: 同文件已有 `fetchPrFile(targetRepo, prNumber, path)`。
- Produces: `fetchRecentSyncedContents(targetRepo: string, sourceName: string, n: number): Promise<string[]>` —— 该源最近 n 个**含 `.md` 文件的** OPEN/MERGED PR（按 `createdAt` 新→旧）的首个 `.md` 内容（先过滤含 md 再取 n，保证尽量拿满 n 份）；出错向上抛（由调用方降级）。

- [ ] **Step 1: 写失败测试 `src/pr-listing.test.ts`**

```ts
import { describe, it, expect, beforeEach, vi } from 'vitest'

const ghMock = vi.hoisted(() => vi.fn())

vi.mock('node:child_process', async () => {
  const { promisify } = await import('node:util')
  const execFile: ((...args: unknown[]) => void) & Record<symbol, unknown> = () => {
    throw new Error('use promisified form')
  }
  execFile[promisify.custom] = ghMock
  return { execFile }
})

const { fetchRecentSyncedContents } = await import('./pr-listing.js')

beforeEach(() => {
  ghMock.mockReset()
  ghMock.mockImplementation((_cmd: string, args: string[]) => {
    if (args[0] === 'pr' && args[1] === 'list') {
      return Promise.resolve({
        stdout: JSON.stringify([
          { number: 1, state: 'MERGED', createdAt: '2026-07-01T00:10:00Z', files: [{ path: 'a/1.md' }] },
          { number: 3, state: 'OPEN', createdAt: '2026-07-03T00:10:00Z', files: [{ path: 'a/3.md' }] },
          { number: 9, state: 'CLOSED', createdAt: '2026-07-09T00:10:00Z', files: [{ path: 'a/9.md' }] },
          { number: 2, state: 'MERGED', createdAt: '2026-07-02T00:10:00Z', files: [{ path: 'img.png' }] },
        ]),
        stderr: '',
      })
    }
    if (args[0] === 'pr' && args[1] === 'view') {
      return Promise.resolve({
        stdout: JSON.stringify({
          headRefName: 'branch-x', headRefOid: 'oid', state: 'OPEN', mergeCommit: null, baseRefName: 'main',
        }),
        stderr: '',
      })
    }
    if (args[0] === 'api') {
      const prPath = args[1] as string
      const marker = prPath.includes('a%2F3.md') || prPath.includes('a/3.md') ? 'content-of-3' : 'content-of-1'
      return Promise.resolve({ stdout: Buffer.from(marker, 'utf8').toString('base64'), stderr: '' })
    }
    return Promise.reject(new Error(`unexpected gh call: ${args.join(' ')}`))
  })
})

describe('fetchRecentSyncedContents', () => {
  it('returns newest-first md contents, skips CLOSED and md-less PRs, honours n', async () => {
    const contents = await fetchRecentSyncedContents('o/r', 'aihot', 2)
    expect(contents).toEqual(['content-of-3', 'content-of-1'])
  })

  it('filters by source label in the gh query', async () => {
    await fetchRecentSyncedContents('o/r', 'aihot', 1)
    const listArgs = ghMock.mock.calls[0]![1] as string[]
    expect(listArgs).toContain('auto-sync,source:aihot')
    expect(listArgs).toContain('all')
  })
})
```

- [ ] **Step 2: 跑测试确认失败**

Run: `pnpm vitest run src/pr-listing.test.ts`
Expected: FAIL —— `fetchRecentSyncedContents` 未导出。

- [ ] **Step 3: 在 `src/pr-listing.ts` 末尾（`extractSourceName` 之前）新增**

```ts
export async function fetchRecentSyncedContents(
  targetRepo: string,
  sourceName: string,
  n: number,
): Promise<string[]> {
  const { stdout } = await execFileAsync('gh', [
    'pr', 'list',
    '--repo', targetRepo,
    '--label', `auto-sync,source:${sourceName}`,
    '--state', 'all',
    '--json', 'number,state,createdAt,files',
    '--limit', '20',
  ])

  type RawPr = { number: number; state: string; createdAt: string; files: { path: string }[] }
  const raw = JSON.parse(stdout) as RawPr[]
  const recent = raw
    .filter((p) => p.state === 'OPEN' || p.state === 'MERGED')
    .filter((p) => p.files.some((f) => f.path.endsWith('.md')))
    .sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1))
    .slice(0, n)

  const contents: string[] = []
  for (const pr of recent) {
    const md = pr.files.find((f) => f.path.endsWith('.md'))!
    contents.push(await fetchPrFile(targetRepo, pr.number, md.path))
  }
  return contents
}
```

- [ ] **Step 4: 跑 `pnpm check` 确认全绿**

- [ ] **Step 5: Commit**

```bash
git add src/pr-listing.ts src/pr-listing.test.ts
git commit -m "feat(pr-listing): fetchRecentSyncedContents reads recent synced PR markdown"
```

---

### Task 3: `FetchContext` 接口 + `src/index.ts` 注入

**Files:**
- Modify: `src/fetchers/types.ts`
- Modify: `src/index.ts`（`runFetch`）

**Interfaces:**
- Consumes: Task 1 `getSyncStatus`、Task 2 `fetchRecentSyncedContents`。
- Produces: `FetchContext { lastSyncedAt?: string; getRecentSyncedContents?: (n: number) => Promise<string[]> }`；`Fetcher.fetch(config: SourceConfig, ctx?: FetchContext)`。Task 4/5 的 aihot fetcher 消费 `ctx`。

- [ ] **Step 1: `src/fetchers/types.ts` 全文替换为**

```ts
export interface SourceConfig {
  type: string
  [key: string]: unknown
}

export interface FetchResult {
  title: string
  date: string
  content: string
  sourceUrl: string
  notifyBody?: string
}

export interface FetchContext {
  /** 本源最近一个已同步 PR 的 createdAt（ISO datetime）；无历史 PR 时缺省 */
  lastSyncedAt?: string
  /** 懒加载最近 n 个已同步 PR 的 markdown 内容（新→旧）；仅需要历史的 fetcher 调用 */
  getRecentSyncedContents?: (n: number) => Promise<string[]>
}

export interface Fetcher {
  readonly type: string
  fetch(config: SourceConfig, ctx?: FetchContext): Promise<FetchResult | null>
}
```

- [ ] **Step 2: `src/index.ts` 注入 ctx**

import 增加：`fetchRecentSyncedContents`（并入现有 `./pr-listing.js` import）与 `import type { FetchContext } from './fetchers/types.js'`。`runFetch` 中 dedup 块与 fetch 调用改为：

```ts
  let ctx: FetchContext | undefined
  const targetRepo = process.env.TARGET_REPO
  if (targetRepo) {
    const status = await getSyncStatus({ targetRepo, sourceName: sub.name, date: parts.date })
    if (status.syncedToday) {
      console.log(`[fetch] ${sub.name} ${parts.date}: already synced, skip`)
      writeOutput('has_new_content', 'false')
      writeOutput('source_name', sub.name)
      writeOutput('date', parts.date)
      return
    }
    ctx = {
      lastSyncedAt: status.lastSyncedAt ?? undefined,
      getRecentSyncedContents: (n) => fetchRecentSyncedContents(targetRepo, sub.name, n),
    }
  }

  const fetcher = getFetcher(sub.source.type)
  const result = await fetcher.fetch(sub.source, ctx)
```

- [ ] **Step 3: 跑 `pnpm check` 确认全绿**（现有 fetcher 实现少一个参数是合法 TS，行为不变）

- [ ] **Step 4: Commit**

```bash
git add src/fetchers/types.ts src/index.ts
git commit -m "feat(fetchers): optional FetchContext with lastSyncedAt + recent-PR reader"
```

---

### Task 4: aihot 粗窗口 + cursor 翻页 + 429 退避

**Files:**
- Modify: `src/fetchers/aihot.ts`
- Modify: `src/fetchers/aihot.test.ts`

**Interfaces:**
- Consumes: `FetchContext`（Task 3）。
- Produces: aihot 内部 `computeSinceIso(lastSyncedAt?: string): string`、`fetchSelectedWindow(sinceIso: string): Promise<SelectedItem[]>`；`SelectedItem` 增加 `permalink?: string | null`、`publishedAt?: string | null`（Task 5 渲染消费）。

- [ ] **Step 1: 更新既有窗口断言测试 + 新增失败测试（`src/fetchers/aihot.test.ts`）**

既有测试 `passes since=todayUtcMidnightIso and take=20 to selected endpoint`（约 222 行）整体替换为：

```ts
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
```

新增 describe 块：

```ts
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
```

同文件既有测试 `renders selected items with null summary as title-only line`：`items: [itemsOk.items[1]]` 改为 `items: [{ ...itemsOk.items[1], publishedAt: '2026-05-08T03:00:00.000Z' }]`（null publishedAt 现在会被跳过）。`itemsOk` 顶部夹具中给 item `a`、`b` 各加 `permalink: null`。

- [ ] **Step 2: 跑测试确认新增用例失败**

Run: `pnpm vitest run src/fetchers/aihot.test.ts`
Expected: 新增用例 FAIL（take=20、无翻页、429 直抛等）。

- [ ] **Step 3: 实现 `src/fetchers/aihot.ts`**

常量区替换/新增：

```ts
const SELECTED_TAKE = 100
const MAX_PAGES = 5
const PAGE_INTERVAL_MS = 200
const RETRY_429_MS = 1500
const OVERLAP_MS = 48 * 60 * 60 * 1000
const SINCE_CAP_MS = 7 * 24 * 60 * 60 * 1000
```

接口调整：

```ts
interface SelectedItem {
  id?: string
  title?: string | null
  url?: string | null
  permalink?: string | null
  source?: string | null
  summary?: string | null
  publishedAt?: string | null
}

interface SelectedResponse {
  items: SelectedItem[]
  hasNext?: boolean
  nextCursor?: string | null
}
```

新增 helpers（删除 `todayUtcMidnightIso`）：

```ts
const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms))

async function fetchWithRetry(url: string): Promise<Response> {
  let res = await fetch(url, { headers: { 'User-Agent': USER_AGENT } })
  if (res.status === 429) {
    await sleep(RETRY_429_MS)
    res = await fetch(url, { headers: { 'User-Agent': USER_AGENT } })
  }
  return res
}

function computeSinceIso(lastSyncedAt: string | undefined): string {
  const now = Date.now()
  const overlapFloor = now - OVERLAP_MS
  const cap = now - SINCE_CAP_MS
  const parsed = lastSyncedAt ? Date.parse(lastSyncedAt) : NaN
  let t = Number.isFinite(parsed) ? Math.min(parsed, overlapFloor) : overlapFloor
  t = Math.max(t, cap)
  return new Date(t).toISOString()
}
```

`getJson` 内部的 `fetch(url, { headers: ... })` 改为 `fetchWithRetry(url)`（其余 404/error 逻辑不动）。`fetchSelected` 整体替换为：

```ts
async function fetchSelectedWindow(sinceIso: string): Promise<SelectedItem[]> {
  const sinceMs = Date.parse(sinceIso)
  const collected: SelectedItem[] = []
  const seenIds = new Set<string>()
  let cursor: string | null = null

  for (let page = 0; page < MAX_PAGES; page++) {
    const url =
      `${BASE_URL}/api/public/items?mode=selected&since=${encodeURIComponent(sinceIso)}&take=${SELECTED_TAKE}` +
      (cursor ? `&cursor=${encodeURIComponent(cursor)}` : '')

    let body: SelectedResponse
    try {
      const res = await fetchWithRetry(url)
      if (!res.ok) {
        console.error(`[aihot] selected endpoint ${res.status}, degrading to collected-so-far`)
        return collected
      }
      body = (await res.json()) as SelectedResponse
    } catch (err) {
      console.error('[aihot] selected endpoint error, degrading to collected-so-far:', err)
      return collected
    }

    const items = Array.isArray(body.items) ? body.items : []
    let sawNewId = false
    let hitBoundary = false
    for (const item of items) {
      if (!item.id || seenIds.has(item.id)) continue
      seenIds.add(item.id)
      sawNewId = true
      if (item.publishedAt == null) continue // 无法参与窗口判定，跳过且不终止
      if (Date.parse(item.publishedAt) < sinceMs) {
        hitBoundary = true
        break
      }
      collected.push(item)
    }

    if (hitBoundary || !sawNewId || !body.hasNext || !body.nextCursor) break
    cursor = body.nextCursor
    await sleep(PAGE_INTERVAL_MS)
  }
  return collected
}
```

`fetch` 主流程签名与窗口调用：

```ts
  async fetch(_config: SourceConfig, ctx?: FetchContext): Promise<FetchResult | null> {
    const parts = todayParts()
    const daily = await fetchDaily(parts.date)
    if (!daily) return null

    const selected = await fetchSelectedWindow(computeSinceIso(ctx?.lastSyncedAt))
    // …渲染流程本任务不变（去重与双链接在 Task 5）
```

import 行补 `FetchContext`：`import type { Fetcher, FetchResult, SourceConfig, FetchContext } from './types.js'`。

- [ ] **Step 4: 跑 `pnpm check` 确认全绿**

- [ ] **Step 5: Commit**

```bash
git add src/fetchers/aihot.ts src/fetchers/aihot.test.ts
git commit -m "feat(aihot): coarse 48h window, cursor pagination with guards, 429 backoff"
```

---

### Task 5: aihot 双键集合去重 + 双链接渲染

**Files:**
- Modify: `src/fetchers/aihot.ts`
- Modify: `src/fetchers/aihot.test.ts`

**Interfaces:**
- Consumes: Task 3 `ctx.getRecentSyncedContents`、Task 4 `fetchSelectedWindow`/`SelectedItem.permalink`，以及 Task 4 已加入 `src/fetchers/aihot.test.ts` 的测试 helpers `itemsPage()`/`selItem()`（定义见 Task 4 Step 1，本任务直接复用）。
- Produces: 最终卡片行为——精选条目对"最近 3 个 PR 内容 + 当天日报"双键去重；所有条目行格式 `- [标题](permalink) — 来源（[原文](url)）`（无 permalink 时 `- [标题](url) — 来源`）；精选区块标题 `## 🔥 新入选精选`。

- [ ] **Step 1: 更新既有渲染断言 + 新增失败测试**

既有测试中所有 `'精选池'` 字符串断言（merges / omits-empty / falls-back 三处）改为 `'新入选精选'`。`dailyOk` 夹具的 section item 与 flash 各补 `permalink: null`。新增：

```ts
describe('aihot dedup & dual links', () => {
  const histItem = selItem('hist', '2026-05-08T02:00:00.000Z')
  const freshItem = selItem('fresh', '2026-05-08T02:30:00.000Z')

  it('drops selected items whose permalink appeared in recent synced PRs', async () => {
    fetchMock.mockResolvedValueOnce(jsonResp(200, dailyOk))
    fetchMock.mockResolvedValueOnce(jsonResp(200, itemsPage([histItem, freshItem])))
    const ctx = {
      getRecentSyncedContents: async () =>
        ['# old card\n- [t](https://aihot.virxact.com/items/hist)（[原文](https://x.example/other)）'],
    }
    const result = await aihotFetcher.fetch({ type: 'aihot' }, ctx)
    expect(result!.content).not.toContain('Item hist')
    expect(result!.content).toContain('Item fresh')
  })

  it('drops selected items whose original url appeared in recent synced PRs (cross-key match)', async () => {
    fetchMock.mockResolvedValueOnce(jsonResp(200, dailyOk))
    fetchMock.mockResolvedValueOnce(jsonResp(200, itemsPage([histItem, freshItem])))
    const ctx = {
      getRecentSyncedContents: async () => ['- [t](https://example.com/hist)'],
    }
    const result = await aihotFetcher.fetch({ type: 'aihot' }, ctx)
    expect(result!.content).not.toContain('Item hist')
    expect(result!.content).toContain('Item fresh')
  })

  it('drops selected items colliding with today daily sections, keeping the daily entry', async () => {
    fetchMock.mockResolvedValueOnce(jsonResp(200, dailyOk))
    fetchMock.mockResolvedValueOnce(
      jsonResp(200, itemsPage([selItem('dup', '2026-05-08T02:00:00.000Z', { url: 'https://anthropic.com/x' })])),
    )
    const result = await aihotFetcher.fetch({ type: 'aihot' })
    expect(result!.content).toContain('Claude Opus 4.7')
    expect(result!.content).not.toContain('Item dup')
    expect(result!.content).not.toContain('新入选精选')
  })

  it('keeps all selected items when getRecentSyncedContents throws (degrade, never lose)', async () => {
    fetchMock.mockResolvedValueOnce(jsonResp(200, dailyOk))
    fetchMock.mockResolvedValueOnce(jsonResp(200, itemsPage([freshItem])))
    const ctx = { getRecentSyncedContents: async (): Promise<string[]> => { throw new Error('gh down') } }
    const result = await aihotFetcher.fetch({ type: 'aihot' }, ctx)
    expect(result!.content).toContain('Item fresh')
  })

  it('renders dual links when permalink exists, single link otherwise', async () => {
    fetchMock.mockResolvedValueOnce(jsonResp(200, dailyOk))
    fetchMock.mockResolvedValueOnce(
      jsonResp(200, itemsPage([
        selItem('withp', '2026-05-08T02:00:00.000Z'),
        selItem('nop', '2026-05-08T02:10:00.000Z', { permalink: null }),
      ])),
    )
    const result = await aihotFetcher.fetch({ type: 'aihot' })
    expect(result!.content).toContain(
      '- [Item withp](https://aihot.virxact.com/items/withp) — Src（[原文](https://example.com/withp)）',
    )
    expect(result!.content).toContain('- [Item nop](https://example.com/nop) — Src')
    expect(result!.content).not.toContain('(https://aihot.virxact.com/items/nop)')
  })

  it('renders daily section items with dual links when daily provides permalink', async () => {
    const dailyWithPermalink = {
      ...dailyOk,
      sections: [
        {
          label: '模型发布/更新',
          items: [
            {
              title: 'Claude Opus 4.7',
              summary: 's',
              sourceUrl: 'https://anthropic.com/x',
              sourceName: 'Anthropic Blog',
              permalink: 'https://aihot.virxact.com/items/opus47',
            },
          ],
        },
        ...dailyOk.sections.slice(1),
      ],
    }
    fetchMock.mockResolvedValueOnce(jsonResp(200, dailyWithPermalink))
    fetchMock.mockResolvedValueOnce(jsonResp(200, itemsPage([])))
    const result = await aihotFetcher.fetch({ type: 'aihot' })
    expect(result!.content).toContain(
      '- [Claude Opus 4.7](https://aihot.virxact.com/items/opus47) — Anthropic Blog（[原文](https://anthropic.com/x)）',
    )
  })
})
```

- [ ] **Step 2: 跑测试确认新增用例失败**

Run: `pnpm vitest run src/fetchers/aihot.test.ts`
Expected: 新增用例 FAIL。

- [ ] **Step 3: 实现**

接口补 permalink：

```ts
interface DailySectionItem {
  title?: string | null
  summary?: string | null
  sourceUrl?: string | null
  sourceName?: string | null
  permalink?: string | null
}

interface DailyFlash {
  title?: string | null
  sourceName?: string | null
  sourceUrl?: string | null
  publishedAt?: string | null
  permalink?: string | null
}
```

新增常量与 helpers：

```ts
const RECENT_PR_COUNT = 3

function linkLine(
  title: string,
  permalink: string | null | undefined,
  originalUrl: string,
  sourceName: string,
): string {
  const source = sourceName ? ` — ${sourceName}` : ''
  if (permalink) return `- [${title}](${permalink})${source}（[原文](${originalUrl})）`
  return `- [${title}](${originalUrl})${source}`
}

function extractLinkKeys(contents: string[]): Set<string> {
  const keys = new Set<string>()
  for (const md of contents) {
    for (const m of md.matchAll(/\]\((https?:\/\/[^)\s]+)\)/g)) keys.add(m[1]!)
  }
  return keys
}

function dailyLinkKeys(daily: DailyResponse): Set<string> {
  const keys = new Set<string>()
  for (const section of daily.sections ?? []) {
    for (const item of section.items ?? []) {
      if (item.permalink) keys.add(item.permalink)
      if (item.sourceUrl) keys.add(item.sourceUrl)
    }
  }
  for (const f of daily.flashes ?? []) {
    if (f.permalink) keys.add(f.permalink)
    if (f.sourceUrl) keys.add(f.sourceUrl)
  }
  return keys
}

function selectedItemKeys(item: SelectedItem): string[] {
  const keys: string[] = []
  if (item.permalink) keys.push(item.permalink)
  if (item.url) keys.push(item.url)
  return keys
}
```

渲染函数改造——`renderDailyMarkdown` 中 section item 行与 flash 行分别改为：

```ts
      lines.push(linkLine(item.title, item.permalink, item.sourceUrl, item.sourceName ?? ''))
```

```ts
      lines.push(linkLine(f.title, f.permalink, f.sourceUrl, f.sourceName ?? ''))
```

`renderSelectedMarkdown` 替换为（空区块不输出标题）：

```ts
function renderSelectedMarkdown(items: SelectedItem[]): string {
  const lines: string[] = []
  for (const item of items) {
    if (!item.title || !item.url) continue
    lines.push(linkLine(item.title, item.permalink, item.url, item.source ?? ''))
    if (typeof item.summary === 'string' && item.summary.trim()) {
      lines.push(`  ${item.summary.trim()}`)
    }
  }
  if (lines.length === 0) return ''
  return ['## 🔥 新入选精选', ...lines].join('\n').trim()
}
```

`fetch` 主流程在 `fetchSelectedWindow` 之后、渲染之前插入去重：

```ts
    let selected = await fetchSelectedWindow(computeSinceIso(ctx?.lastSyncedAt))
    if (selected.length > 0) {
      let pushedKeys = new Set<string>()
      if (ctx?.getRecentSyncedContents) {
        try {
          pushedKeys = extractLinkKeys(await ctx.getRecentSyncedContents(RECENT_PR_COUNT))
        } catch (err) {
          console.warn('[aihot] recent PR contents unavailable, dedup degraded to empty set:', err)
        }
      }
      const dailyKeys = dailyLinkKeys(daily)
      selected = selected.filter(
        (item) => !selectedItemKeys(item).some((k) => pushedKeys.has(k) || dailyKeys.has(k)),
      )
    }
```

- [ ] **Step 4: 跑 `pnpm check` 确认全绿**

- [ ] **Step 5: Commit**

```bash
git add src/fetchers/aihot.ts src/fetchers/aihot.test.ts
git commit -m "feat(aihot): pushed-set dual-key dedup and dual-link rendering"
```

---

### Task 6: 收尾验证

**Files:** 无新改动（验证任务）。

- [ ] **Step 1: `pnpm check` 全绿**

- [ ] **Step 2: 对照 spec 核对**——逐条核对 `docs/superpowers/specs/2026-07-03-aihot-selected-window-design.md` 的"详细设计"与"错误处理小结"每一行都有对应实现/测试。

- [ ] **Step 3: 本地冒烟（无 TARGET_REPO 路径，打真实 API）**

Run: `pnpm fetch --subscription aihot --output-dir /tmp/aihot-smoke`
Expected: 写出 md；无 ctx 时窗口为 now−48h；`新入选精选` 区块存在（当天有精选时）；行格式为双链接。检查后 `rm -rf /tmp/aihot-smoke`。

- [ ] **Step 4: Commit（如冒烟暴露修正）后收尾**

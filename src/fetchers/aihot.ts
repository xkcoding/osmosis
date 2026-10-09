import type { Fetcher, FetchResult, SourceConfig, FetchContext } from './types.js'
import { isDatePinned, todayParts } from '../template.js'

const BASE_URL = 'https://aihot.news/api/v1'
const SITE_URL = 'https://aihot.news/'
const USER_AGENT = 'osmosis/1.0 (+https://github.com/xkcoding/osmosis)'
const PAGE_LIMIT = 100
const MAX_PAGES = 5
const PAGE_INTERVAL_MS = 200
const RETRY_429_MS = 1500
const RECENT_PR_COUNT = 3
// 兜底窗口覆盖 7 天，已推送集合必须同样覆盖约 7 个日更 PR，否则首日迁移会重推 4~7 天前的条目
const RECENT_PR_COUNT_WINDOW = 8
const NOTIFY_BODY_MAX_BYTES = 20480
const TRUNCATION_SUFFIX = '…\n（已截断）'
// 站内条目链接：新旧域名视为同一条目（切换前的历史 PR 里全是旧域名）
const ITEM_LINK_RE = /^https?:\/\/(?:aihot\.news|aihot\.virxact\.com)\/items\/([A-Za-z0-9_-]+)/

const SECTION_EMOJI: Record<string, string> = {
  '模型发布/更新': '🚀',
  '产品发布/更新': '📦',
  '行业动态': '📰',
  '论文研究': '📑',
  '技巧与观点': '💡',
}

interface Links {
  aihot?: string | null
  original?: string | null
}

interface SourceRef {
  name?: string | null
}

interface DailyEntry {
  title?: string | null
  summary?: string | null
  source?: SourceRef | null
  links?: Links | null
}

interface DailySection {
  label?: string | null
  items?: DailyEntry[] | null
}

interface DailyReport {
  date: string
  lead: { title?: string | null; leadParagraph?: string | null } | null
  sections: DailySection[]
  flashes: DailyEntry[]
}

interface DailyResponse {
  report?: DailyReport | null
}

interface Item {
  id?: string
  title?: string | null
  summary?: string | null
  source?: SourceRef | null
  links?: Links | null
  selected?: boolean
}

interface ItemsResponse {
  items?: Item[] | null
  page?: { hasMore?: boolean; nextCursor?: string | null } | null
}

interface SelectedChange {
  op?: 'upsert' | 'remove'
  item?: Item | null
  id?: string
}

interface SelectedChangesResponse {
  cursor?: string
  hasMore?: boolean
  changes?: SelectedChange[] | null
}

interface SnapshotResponse {
  cursor?: string
}

interface SelectedBatch {
  items: Item[]
  truncated: boolean
  /** true = 来自兜底 7d 窗口（去重需覆盖更长历史） */
  fromWindow: boolean
  /** 下一次运行续读的账本水位；undefined 表示不写 sync_state（下次走兜底） */
  cursor?: string
}

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms))

async function fetchWithRetry(url: string): Promise<Response> {
  let res = await fetch(url, { headers: { 'User-Agent': USER_AGENT } })
  if (res.status === 429) {
    await sleep(RETRY_429_MS)
    res = await fetch(url, { headers: { 'User-Agent': USER_AGENT } })
  }
  return res
}

async function fetchDaily(date: string): Promise<DailyReport | null> {
  const url = `${BASE_URL}/dailies/${date}`
  const res = await fetchWithRetry(url)
  if (res.status === 404) return null
  if (!res.ok) throw new Error(`AI HOT API ${res.status} for ${url}`)
  const body = (await res.json()) as DailyResponse
  return body.report ?? null
}

type LedgerOutcome = { kind: 'ok'; items: Item[]; cursor: string } | { kind: 'reset' }

/**
 * 账本增量：从上次水位读入选变更。水位只在整页应用后前移；
 * 中途失败保留已应用部分与对应水位（宁重勿漏），409 交给调用方重建水位。
 */
async function fetchLedger(startCursor: string): Promise<LedgerOutcome> {
  // Map 保留插入顺序 = changedAt 旧→新；重复 upsert 先删后插，以最后一次为准
  const picked = new Map<string, Item>()
  let applied = startCursor

  for (let page = 0; page < MAX_PAGES; page++) {
    const url = `${BASE_URL}/selected/changes?cursor=${encodeURIComponent(applied)}&limit=${PAGE_LIMIT}`
    let body: SelectedChangesResponse
    try {
      const res = await fetchWithRetry(url)
      if (res.status === 409) return { kind: 'reset' }
      if (!res.ok) {
        console.error(`[aihot] selected changes ${res.status}, keeping cursor at last applied page`)
        break
      }
      body = (await res.json()) as SelectedChangesResponse
    } catch (err) {
      console.error('[aihot] selected changes error, keeping cursor at last applied page:', err)
      break
    }

    for (const change of body.changes ?? []) {
      if (change.op === 'upsert' && change.item?.id) {
        picked.delete(change.item.id)
        if (change.item.selected !== false) picked.set(change.item.id, change.item)
      } else if (change.op === 'remove' && change.id) {
        picked.delete(change.id)
      }
    }

    if (!body.cursor || body.cursor === applied) break
    applied = body.cursor
    if (!body.hasMore) break
    if (page < MAX_PAGES - 1) await sleep(PAGE_INTERVAL_MS)
  }

  return { kind: 'ok', items: [...picked.values()].reverse(), cursor: applied }
}

async function fetchSnapshotCursor(): Promise<string | undefined> {
  try {
    const res = await fetchWithRetry(`${BASE_URL}/selected/snapshot?limit=1`)
    if (!res.ok) {
      console.error(`[aihot] selected snapshot ${res.status}, sync_state not written this run`)
      return undefined
    }
    const body = (await res.json()) as SnapshotResponse
    return typeof body.cursor === 'string' && body.cursor ? body.cursor : undefined
  } catch (err) {
    console.error('[aihot] selected snapshot error, sync_state not written this run:', err)
    return undefined
  }
}

async function fetchWindow(): Promise<{ items: Item[]; truncated: boolean }> {
  const collected: Item[] = []
  const seenIds = new Set<string>()
  let cursor: string | null = null

  for (let page = 0; page < MAX_PAGES; page++) {
    const url =
      `${BASE_URL}/items?mode=selected&window=7d&by=timeline&limit=${PAGE_LIMIT}` +
      (cursor ? `&cursor=${encodeURIComponent(cursor)}` : '')

    let body: ItemsResponse
    try {
      const res = await fetchWithRetry(url)
      if (!res.ok) {
        console.error(`[aihot] selected items ${res.status}, degrading to collected-so-far`)
        return { items: collected, truncated: false }
      }
      body = (await res.json()) as ItemsResponse
    } catch (err) {
      console.error('[aihot] selected items error, degrading to collected-so-far:', err)
      return { items: collected, truncated: false }
    }

    let sawNewId = false
    for (const item of body.items ?? []) {
      if (!item.id || seenIds.has(item.id)) continue
      seenIds.add(item.id)
      sawNewId = true
      collected.push(item)
    }

    const next = body.page?.nextCursor
    if (!sawNewId || !body.page?.hasMore || !next) return { items: collected, truncated: false }
    cursor = next
    if (page < MAX_PAGES - 1) await sleep(PAGE_INTERVAL_MS)
  }

  // 兜底窗口触顶：水位取自窗口之前的 snapshot，超出部分不会再出现，截断必须可见
  console.error(`[aihot] selected window truncated at ${MAX_PAGES} pages, more items advertised by API`)
  return { items: collected, truncated: true }
}

async function fetchSelected(ctx: FetchContext | undefined): Promise<SelectedBatch> {
  let cursor: string | undefined
  if (ctx?.getLastSyncState) {
    try {
      cursor = (await ctx.getLastSyncState())?.cursor
    } catch (err) {
      console.warn('[aihot] last sync_state unavailable, falling back to window:', err)
    }
  }

  if (cursor) {
    const ledger = await fetchLedger(cursor)
    if (ledger.kind === 'ok') return { items: ledger.items, truncated: false, fromWindow: false, cursor: ledger.cursor }
    console.warn('[aihot] ledger cursor rejected (409 snapshot_required), falling back to window')
  }

  // 先取水位再读窗口：两者之间入选的条目会在下次账本里再出现一次（交给去重），反过来则会漏
  const snapshotCursor = await fetchSnapshotCursor()
  const window = await fetchWindow()
  return { ...window, fromWindow: true, cursor: snapshotCursor }
}

function linkLine(entry: DailyEntry | Item): string | null {
  const title = entry.title
  const aihot = entry.links?.aihot
  const original = entry.links?.original
  if (!title || (!aihot && !original)) return null
  const name = entry.source?.name
  const source = name ? ` — ${name}` : ''
  if (aihot && original) return `- [${title}](${aihot})${source}（[原文](${original})）`
  return `- [${title}](${(aihot ?? original)!})${source}`
}

function addUrlKey(keys: Set<string>, url: string): void {
  keys.add(`url:${url}`)
  const id = ITEM_LINK_RE.exec(url)?.[1]
  if (id) keys.add(`id:${id}`)
}

function extractLinkKeys(contents: string[]): Set<string> {
  const keys = new Set<string>()
  for (const md of contents) {
    for (const m of md.matchAll(/\]\((https?:\/\/[^)\s]+)\)/g)) addUrlKey(keys, m[1]!)
  }
  return keys
}

function dailyLinkKeys(daily: DailyReport): Set<string> {
  const keys = new Set<string>()
  const entries = [...(daily.sections ?? []).flatMap((s) => s.items ?? []), ...(daily.flashes ?? [])]
  for (const e of entries) {
    if (e.links?.aihot) addUrlKey(keys, e.links.aihot)
    if (e.links?.original) addUrlKey(keys, e.links.original)
  }
  return keys
}

function itemKeys(item: Item): string[] {
  const keys: string[] = []
  if (item.id) keys.push(`id:${item.id}`)
  if (item.links?.original) keys.push(`url:${item.links.original}`)
  return keys
}

function pushEntry(lines: string[], entry: DailyEntry | Item, withSummary: boolean): void {
  const line = linkLine(entry)
  if (!line) return
  lines.push(line)
  if (withSummary && typeof entry.summary === 'string' && entry.summary.trim()) {
    lines.push(`  ${entry.summary.trim()}`)
  }
}

function renderDailyMarkdown(daily: DailyReport): string {
  const lines: string[] = []

  if (daily.lead && typeof daily.lead.leadParagraph === 'string' && daily.lead.leadParagraph.trim()) {
    lines.push(`> ${daily.lead.leadParagraph.trim()}`)
    lines.push('')
  }

  for (const section of daily.sections ?? []) {
    if (!section.label) continue
    const items = section.items ?? []
    if (items.length === 0) continue
    const emoji = SECTION_EMOJI[section.label] ?? ''
    lines.push(`## ${emoji ? emoji + ' ' : ''}${section.label}`)
    for (const item of items) pushEntry(lines, item, true)
    lines.push('')
  }

  const flashes = daily.flashes ?? []
  if (flashes.length > 0) {
    lines.push('## ⚡️ 快讯')
    for (const f of flashes) pushEntry(lines, f, false)
    lines.push('')
  }

  return lines.join('\n').trim()
}

function renderSelectedMarkdown(items: Item[], truncated: boolean): string {
  const lines: string[] = []
  for (const item of items) pushEntry(lines, item, true)
  if (lines.length === 0) return ''
  if (truncated) {
    lines.push('')
    lines.push('> ⚠️ 精选池已达单次抓取上限，本次仅收录最新条目。')
  }
  return ['## 🔥 新入选精选', ...lines].join('\n').trim()
}

function truncateNotifyBody(s: string): string {
  if (Buffer.byteLength(s, 'utf8') <= NOTIFY_BODY_MAX_BYTES) return s
  const suffixBytes = Buffer.byteLength(TRUNCATION_SUFFIX, 'utf8')
  const budget = NOTIFY_BODY_MAX_BYTES - suffixBytes
  const buf = Buffer.from(s, 'utf8').subarray(0, budget)
  // ensure utf-8 boundary by decoding with fatal=false
  const truncated = new TextDecoder('utf-8', { fatal: false }).decode(buf).replace(/�+$/g, '')
  return truncated + TRUNCATION_SUFFIX
}

export const aihotFetcher: Fetcher = {
  type: 'aihot',

  async fetch(_config: SourceConfig, ctx?: FetchContext): Promise<FetchResult | null> {
    const parts = todayParts()
    const daily = await fetchDaily(parts.date)
    if (!daily) return null

    // 回填（OSMOSIS_DATE）只落当日日报：账本水位是"现在"的，不能写进历史笔记，也无法按历史日期重建精选
    const batch: SelectedBatch = isDatePinned()
      ? { items: [], truncated: false, fromWindow: false }
      : await fetchSelected(ctx)
    let selected = batch.items
    if (selected.length > 0) {
      let pushedKeys = new Set<string>()
      if (ctx?.getRecentSyncedContents) {
        try {
          pushedKeys = extractLinkKeys(await ctx.getRecentSyncedContents(batch.fromWindow ? RECENT_PR_COUNT_WINDOW : RECENT_PR_COUNT))
        } catch (err) {
          console.warn('[aihot] recent PR contents unavailable, dedup degraded to empty set:', err)
        }
      }
      const dailyKeys = dailyLinkKeys(daily)
      selected = selected.filter((item) => !itemKeys(item).some((k) => pushedKeys.has(k) || dailyKeys.has(k)))
    }

    const dailyMd = renderDailyMarkdown(daily)
    const selectedMd = renderSelectedMarkdown(selected, batch.truncated)
    const content = [dailyMd, selectedMd].filter((s) => s.length > 0).join('\n\n---\n\n')
    const notifyBody = truncateNotifyBody(content)

    return {
      title: 'AI HOT 日报',
      date: parts.date,
      content,
      sourceUrl: SITE_URL,
      notifyBody,
      ...(batch.cursor ? { syncState: { cursor: batch.cursor } } : {}),
    }
  },
}

import type { Fetcher, FetchResult, SourceConfig, FetchContext } from './types.js'
import { todayParts } from '../template.js'

const BASE_URL = 'https://aihot.virxact.com'
const USER_AGENT = 'osmosis/1.0 (+https://github.com/xkcoding/osmosis)'
const SELECTED_TAKE = 100
const MAX_PAGES = 5
const PAGE_INTERVAL_MS = 200
const RETRY_429_MS = 1500
const OVERLAP_MS = 48 * 60 * 60 * 1000
const SINCE_CAP_MS = 7 * 24 * 60 * 60 * 1000
const RECENT_PR_COUNT = 3
const NOTIFY_BODY_MAX_BYTES = 20480
const TRUNCATION_SUFFIX = '…\n（已截断）'

const SECTION_EMOJI: Record<string, string> = {
  '模型发布/更新': '🚀',
  '产品发布/更新': '📦',
  '行业动态': '📰',
  '论文研究': '📑',
  '技巧与观点': '💡',
}

interface DailyLead {
  title?: string | null
  leadParagraph?: string | null
}

interface DailySectionItem {
  title?: string | null
  summary?: string | null
  sourceUrl?: string | null
  sourceName?: string | null
  permalink?: string | null
}

interface DailySection {
  label?: string | null
  items?: DailySectionItem[] | null
}

interface DailyFlash {
  title?: string | null
  sourceName?: string | null
  sourceUrl?: string | null
  publishedAt?: string | null
  permalink?: string | null
}

interface DailyResponse {
  date: string
  lead: DailyLead | null
  sections: DailySection[]
  flashes: DailyFlash[]
}

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

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms))

async function fetchWithRetry(url: string): Promise<Response> {
  let res = await fetch(url, { headers: { 'User-Agent': USER_AGENT } })
  if (res.status === 429) {
    await sleep(RETRY_429_MS)
    res = await fetch(url, { headers: { 'User-Agent': USER_AGENT } })
  }
  return res
}

async function getJson<T>(url: string): Promise<{ status: number; body: T | null }> {
  const res = await fetchWithRetry(url)
  if (res.status === 404) {
    try {
      return { status: 404, body: (await res.json()) as T }
    } catch {
      return { status: 404, body: null }
    }
  }
  if (!res.ok) {
    const status = res.status
    throw new Error(`AI HOT API ${status} for ${url}`)
  }
  return { status: res.status, body: (await res.json()) as T }
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

async function fetchDaily(date: string): Promise<DailyResponse | null> {
  const url = `${BASE_URL}/api/public/daily/${date}`
  const { status, body } = await getJson<DailyResponse | { error: string }>(url)
  if (status === 404) return null
  if (body && typeof body === 'object' && 'error' in body) return null
  return body as DailyResponse
}

interface SelectedWindow {
  items: SelectedItem[]
  truncated: boolean
}

async function fetchSelectedWindow(sinceIso: string): Promise<SelectedWindow> {
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
        return { items: collected, truncated: false }
      }
      body = (await res.json()) as SelectedResponse
    } catch (err) {
      console.error('[aihot] selected endpoint error, degrading to collected-so-far:', err)
      return { items: collected, truncated: false }
    }

    const items = Array.isArray(body.items) ? body.items : []
    let sawNewId = false
    let hitBoundary = false
    for (const item of items) {
      if (!item.id || seenIds.has(item.id)) continue
      seenIds.add(item.id)
      sawNewId = true
      // publishedAt 为 null 时无法参与窗口判定：保留（宁重勿漏，交给集合去重），但不触发终止
      if (item.publishedAt != null && Date.parse(item.publishedAt) < sinceMs) {
        hitBoundary = true
        break
      }
      collected.push(item)
    }

    if (hitBoundary || !sawNewId || !body.hasNext || !body.nextCursor) {
      return { items: collected, truncated: false }
    }
    cursor = body.nextCursor
    if (page < MAX_PAGES - 1) await sleep(PAGE_INTERVAL_MS)
  }

  // 触顶且服务端仍报 hasNext：截断必须可见，不能静默当作完整窗口
  console.error(`[aihot] selected window truncated at ${MAX_PAGES} pages, more items advertised by API`)
  return { items: collected, truncated: true }
}

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

function renderDailyMarkdown(daily: DailyResponse): string {
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
    for (const item of items) {
      if (!item.title || !item.sourceUrl) continue
      lines.push(linkLine(item.title, item.permalink, item.sourceUrl, item.sourceName ?? ''))
      if (typeof item.summary === 'string' && item.summary.trim()) {
        lines.push(`  ${item.summary.trim()}`)
      }
    }
    lines.push('')
  }

  const flashes = daily.flashes ?? []
  if (flashes.length > 0) {
    lines.push('## ⚡️ 快讯')
    for (const f of flashes) {
      if (!f.title || !f.sourceUrl) continue
      lines.push(linkLine(f.title, f.permalink, f.sourceUrl, f.sourceName ?? ''))
    }
    lines.push('')
  }

  return lines.join('\n').trim()
}

function renderSelectedMarkdown(items: SelectedItem[], truncated: boolean): string {
  const lines: string[] = []
  for (const item of items) {
    if (!item.title || !item.url) continue
    lines.push(linkLine(item.title, item.permalink, item.url, item.source ?? ''))
    if (typeof item.summary === 'string' && item.summary.trim()) {
      lines.push(`  ${item.summary.trim()}`)
    }
  }
  if (lines.length === 0) return ''
  if (truncated) {
    lines.push('')
    lines.push('> ⚠️ 精选池已达单次抓取上限，本次仅收录最新条目；次日窗口会自动补收其余部分。')
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

    const window = await fetchSelectedWindow(computeSinceIso(ctx?.lastSyncedAt))
    let selected = window.items
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

    const dailyMd = renderDailyMarkdown(daily)
    const selectedMd = renderSelectedMarkdown(selected, window.truncated)
    const content = [dailyMd, selectedMd].filter((s) => s.length > 0).join('\n\n---\n\n')
    const notifyBody = truncateNotifyBody(content)

    return {
      title: 'AI HOT 日报',
      date: parts.date,
      content,
      sourceUrl: 'https://aihot.virxact.com/',
      notifyBody,
    }
  },
}

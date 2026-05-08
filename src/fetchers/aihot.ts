import type { Fetcher, FetchResult, SourceConfig } from './types.js'
import { todayParts } from '../template.js'

const BASE_URL = 'https://aihot.virxact.com'
const USER_AGENT = 'osmosis/1.0 (+https://github.com/xkcoding/osmosis)'
const SELECTED_TAKE = 20
const NOTIFY_BODY_MAX_BYTES = 4096
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
  source?: string | null
  summary?: string | null
}

interface SelectedResponse {
  items: SelectedItem[]
}

async function getJson<T>(url: string): Promise<{ status: number; body: T | null }> {
  const res = await fetch(url, { headers: { 'User-Agent': USER_AGENT } })
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

function todayUtcMidnightIso(): string {
  const d = todayParts()
  return `${d.date}T00:00:00.000Z`
}

async function fetchDaily(date: string): Promise<DailyResponse | null> {
  const url = `${BASE_URL}/api/public/daily/${date}`
  const { status, body } = await getJson<DailyResponse | { error: string }>(url)
  if (status === 404) return null
  if (body && typeof body === 'object' && 'error' in body) return null
  return body as DailyResponse
}

async function fetchSelected(sinceIso: string): Promise<SelectedItem[]> {
  const url = `${BASE_URL}/api/public/items?mode=selected&since=${encodeURIComponent(sinceIso)}&take=${SELECTED_TAKE}`
  try {
    const res = await fetch(url, { headers: { 'User-Agent': USER_AGENT } })
    if (!res.ok) {
      console.error(`[aihot] selected endpoint ${res.status}, degrading to daily-only`)
      return []
    }
    const body = (await res.json()) as SelectedResponse
    return Array.isArray(body.items) ? body.items : []
  } catch (err) {
    console.error('[aihot] selected endpoint error, degrading to daily-only:', err)
    return []
  }
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
      const sourceName = item.sourceName ?? ''
      lines.push(`- [${item.title}](${item.sourceUrl})${sourceName ? ` — ${sourceName}` : ''}`)
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
      const sourceName = f.sourceName ?? ''
      lines.push(`- [${f.title}](${f.sourceUrl})${sourceName ? ` — ${sourceName}` : ''}`)
    }
    lines.push('')
  }

  return lines.join('\n').trim()
}

function renderSelectedMarkdown(items: SelectedItem[]): string {
  if (items.length === 0) return ''
  const lines: string[] = ['## 🔥 精选池（过去 24 小时）']
  for (const item of items) {
    if (!item.title || !item.url) continue
    const source = item.source ?? ''
    lines.push(`- [${item.title}](${item.url})${source ? ` — ${source}` : ''}`)
    if (typeof item.summary === 'string' && item.summary.trim()) {
      lines.push(`  ${item.summary.trim()}`)
    }
  }
  return lines.join('\n').trim()
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

  async fetch(_config: SourceConfig): Promise<FetchResult | null> {
    const parts = todayParts()
    const daily = await fetchDaily(parts.date)
    if (!daily) return null

    const selected = await fetchSelected(todayUtcMidnightIso())

    const dailyMd = renderDailyMarkdown(daily)
    const selectedMd = renderSelectedMarkdown(selected)
    const content = [dailyMd, selectedMd].filter((s) => s.length > 0).join('\n\n---\n\n')
    const notifyBody = truncateNotifyBody(dailyMd)

    return {
      title: 'AI HOT 日报',
      date: parts.date,
      content,
      sourceUrl: 'https://aihot.virxact.com/',
      notifyBody,
    }
  },
}

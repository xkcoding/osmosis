import { XMLParser } from 'fast-xml-parser'
import { NodeHtmlMarkdown } from 'node-html-markdown'
import type { Fetcher, FetchResult, SourceConfig } from './types.js'
import { resolveTemplate, todayParts } from '../template.js'

interface RssConfig extends SourceConfig {
  type: 'rss'
  feedUrl: string
  titlePattern?: string
  title?: string
}

interface RssItem {
  title?: string | number
  link?: string
  description?: string
  'content:encoded'?: string
  pubDate?: string
}

export const rssFetcher: Fetcher = {
  type: 'rss',

  async fetch(config: SourceConfig): Promise<FetchResult | null> {
    const cfg = config as RssConfig
    if (!cfg.feedUrl) throw new Error('rss fetcher requires feedUrl')

    const parts = todayParts()
    const titlePattern = resolveTemplate(cfg.titlePattern ?? '{date}', parts)

    const res = await fetch(cfg.feedUrl)
    if (!res.ok) throw new Error(`RSS fetch HTTP ${res.status} for ${cfg.feedUrl}`)
    const xml = await res.text()

    const parser = new XMLParser({
      ignoreAttributes: false,
      parseTagValue: false,
      cdataPropName: '__cdata',
      trimValues: true,
    })
    const obj = parser.parse(xml) as { rss?: { channel?: { item?: RssItem | RssItem[] } } }
    const rawItems = obj.rss?.channel?.item
    if (!rawItems) return null
    const items = Array.isArray(rawItems) ? rawItems : [rawItems]

    const match = items.find((item) => String(item.title ?? '').trim() === titlePattern)
    if (!match) return null

    const html = extractHtml(match)
    if (!html) return null

    const nhm = new NodeHtmlMarkdown({}, undefined, undefined)
    const markdown = nhm.translate(html)

    return {
      title: cfg.title ?? 'RSS Feed',
      date: parts.date,
      content: markdown,
      sourceUrl: String(match.link ?? cfg.feedUrl),
    }
  },
}

function extractHtml(item: RssItem): string {
  const encoded = item['content:encoded']
  if (encoded) {
    if (typeof encoded === 'string') return encoded
    const cdata = (encoded as { __cdata?: string }).__cdata
    if (cdata) return cdata
  }
  return typeof item.description === 'string' ? item.description : ''
}

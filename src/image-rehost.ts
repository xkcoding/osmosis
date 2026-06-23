import { createHash } from 'node:crypto'
import { compressImage } from './image-compress.js'
import { ossPutObject, type OssConfig } from './oss.js'
import type OSS from 'ali-oss'
import type { ImageRehostConfig } from './config.js'

/** Injected side-effects, so the core logic is unit-testable without sharp/OSS/network. */
export interface RehostDeps {
  fetchImage: (url: string) => Promise<{ data: Buffer; contentType: string }>
  compress: (data: Buffer, contentType: string) => Promise<{ data: Buffer; ext: string; contentType: string }>
  upload: (key: string, data: Buffer, contentType: string) => Promise<string>
}

export interface RehostCoreOptions {
  /** Object key prefix for uploaded images, e.g. "osmosis/juya-ai-daily". */
  keyPrefix: string
  /** Hostnames to leave untouched (already-rehosted CDN domain, etc.). */
  skipHosts?: string[]
  /** Override the content hasher (default sha256, first 16 hex chars). */
  hash?: (data: Buffer) => string
}

export interface RehostResult {
  markdown: string
  rehosted: number
  failed: number
  skipped: number
}

// Markdown image: ![alt](url "optional title")
const MD_IMAGE = /!\[([^\]]*)\]\((\S+?)(\s+"[^"]*"|\s+'[^']*')?\)/g
// HTML <img ... src="url" ...>
const HTML_IMAGE = /<img\b[^>]*?\bsrc\s*=\s*["']([^"']+)["'][^>]*>/gi

function defaultHash(data: Buffer): string {
  return createHash('sha256').update(data).digest('hex').slice(0, 16)
}

function collectUrls(markdown: string): string[] {
  const urls = new Set<string>()
  for (const m of markdown.matchAll(MD_IMAGE)) urls.add(m[2]!)
  for (const m of markdown.matchAll(HTML_IMAGE)) urls.add(m[1]!)
  return [...urls]
}

function isEligible(url: string, skipHosts: Set<string>): boolean {
  let parsed: URL
  try {
    parsed = new URL(url)
  } catch {
    return false // relative paths, data: URIs, malformed — leave alone
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return false
  if (skipHosts.has(parsed.hostname)) return false
  return true
}

/**
 * Rehost remote images referenced in `markdown`: download → compress → upload,
 * then rewrite every reference to the new URL. Pure orchestration — all I/O is
 * injected via `deps`. A single image that fails keeps its original URL (the
 * digest must never break because one image 404'd).
 */
export async function rehostImages(
  markdown: string,
  deps: RehostDeps,
  opts: RehostCoreOptions,
): Promise<RehostResult> {
  const hash = opts.hash ?? defaultHash
  const skipHosts = new Set(opts.skipHosts ?? [])
  const allUrls = collectUrls(markdown)
  const eligible = allUrls.filter((u) => isEligible(u, skipHosts))

  const replacement = new Map<string, string>()
  let rehosted = 0
  let failed = 0

  for (const url of eligible) {
    try {
      const { data, contentType } = await deps.fetchImage(url)
      const compressed = await deps.compress(data, contentType)
      const key = `${opts.keyPrefix}/${hash(compressed.data)}.${compressed.ext}`
      const newUrl = await deps.upload(key, compressed.data, compressed.contentType)
      replacement.set(url, newUrl)
      rehosted++
    } catch (err) {
      failed++
      console.warn(`[rehost] keep original, failed for ${url}: ${(err as Error).message}`)
    }
  }

  const rewritten = applyReplacements(markdown, replacement)
  return {
    markdown: rewritten,
    rehosted,
    failed,
    skipped: allUrls.length - eligible.length,
  }
}

function applyReplacements(markdown: string, map: Map<string, string>): string {
  if (map.size === 0) return markdown
  return markdown
    .replace(MD_IMAGE, (full, alt: string, url: string, title?: string) => {
      const next = map.get(url)
      return next ? `![${alt}](${next}${title ?? ''})` : full
    })
    .replace(HTML_IMAGE, (full, src: string) => {
      const next = map.get(src)
      return next ? full.replace(src, next) : full
    })
}

const FETCH_UA =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36'

/**
 * Production wiring: composes real fetch + sharp + OSS into `rehostImages`.
 * `slug` namespaces the OSS key path; `images` carries per-subscription
 * compression knobs; `oss` is the resolved client + config from env.
 */
export async function rehostMarkdownImages(
  markdown: string,
  slug: string,
  date: string,
  images: ImageRehostConfig,
  oss: { client: OSS; config: OssConfig },
): Promise<RehostResult> {
  // Object keys are organised by source + date: [<OSS_KEY_PREFIX>/]<slug>/<date>/<hash>.<ext>
  const subPrefix = (images.keyPrefix ?? slug).replace(/^\/+|\/+$/g, '')
  const keyPrefix = [oss.config.keyPrefix, subPrefix, date]
    .filter(Boolean)
    .join('/')
    .replace(/\/+/g, '/')

  // per-subscription processStyle overrides the env-level default
  const config: OssConfig = images.processStyle
    ? { ...oss.config, processStyle: images.processStyle }
    : oss.config

  const skipHosts = [...(images.skipHosts ?? [])]
  if (config.cdnBaseUrl) {
    try {
      skipHosts.push(new URL(config.cdnBaseUrl).hostname)
    } catch {
      // ignore malformed CDN base; the upload step still works via OSS URL
    }
  }

  const deps: RehostDeps = {
    fetchImage: async (url) => {
      const res = await fetch(url, { headers: { 'User-Agent': FETCH_UA } })
      if (!res.ok) throw new Error(`HTTP ${res.status}`)
      const data = Buffer.from(await res.arrayBuffer())
      const contentType = res.headers.get('content-type') ?? 'application/octet-stream'
      return { data, contentType }
    },
    compress: (data) =>
      compressImage(data, {
        format: images.format,
        quality: images.quality,
        maxWidth: images.maxWidth,
      }),
    upload: (key, data, contentType) => ossPutObject(oss.client, config, key, data, contentType),
  }

  return rehostImages(markdown, deps, { keyPrefix, skipHosts })
}

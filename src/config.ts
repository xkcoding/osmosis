import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { parse as parseYaml } from 'yaml'
import type { SourceConfig } from './fetchers/types.js'
import type { QualityConfig } from './quality.js'

export interface FrontmatterConfig {
  type?: string
  source?: string
  tags?: string[]
  [key: string]: unknown
}

export interface ObsidianOutput {
  enabled: boolean
  path: string
  frontmatter?: FrontmatterConfig
}

export interface NotifyOutput {
  enabled: boolean
  summary: boolean
  channels: string[]
}

export interface SummaryConfig {
  promptFile?: string
}

export interface ImageRehostConfig {
  /** Turn image rehosting on for this subscription. */
  rehost?: boolean
  /** Output format. Default "webp". */
  format?: 'webp' | 'jpeg' | 'png'
  /** Encoder quality 0-100. Default 80. */
  quality?: number
  /** Optional max width in px; larger images are downscaled. Off by default. */
  maxWidth?: number
  /** OSS key sub-path under OSS_KEY_PREFIX. Default the subscription slug. */
  keyPrefix?: string
  /** OSS image style appended as `?x-oss-process=style/<name>`. Overrides OSS_PROCESS_STYLE. */
  processStyle?: string
  /** Hostnames to leave untouched (in addition to the CDN domain). */
  skipHosts?: string[]
}

export interface Subscription {
  name: string
  source: SourceConfig
  summary?: SummaryConfig
  output: {
    obsidian?: ObsidianOutput
    notify?: NotifyOutput
  }
  quality?: QualityConfig
  images?: ImageRehostConfig
}

const SUBSCRIPTIONS_DIR = process.env.OSMOSIS_SUBSCRIPTIONS_DIR ?? 'subscriptions'

export function listSubscriptions(dir: string = SUBSCRIPTIONS_DIR): Subscription[] {
  return readdirSync(dir)
    .filter((f) => f.endsWith('.yml') || f.endsWith('.yaml'))
    .map((f) => loadSubscriptionFile(join(dir, f)))
}

export function loadSubscription(slug: string, dir: string = SUBSCRIPTIONS_DIR): Subscription {
  for (const ext of ['.yml', '.yaml']) {
    try {
      return loadSubscriptionFile(join(dir, `${slug}${ext}`))
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err
    }
  }
  throw new Error(`Subscription not found: ${slug}`)
}

export function subscriptionSlug(filename: string): string {
  return filename.replace(/\.(yml|yaml)$/, '')
}

function loadSubscriptionFile(path: string): Subscription {
  const raw = readFileSync(path, 'utf8')
  const data = parseYaml(raw) as Subscription
  if (!data.name || !data.source?.type) {
    throw new Error(`Invalid subscription at ${path}: missing name or source.type`)
  }
  return data
}

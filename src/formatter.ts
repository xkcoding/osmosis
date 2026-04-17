import { stringify as stringifyYaml } from 'yaml'
import type { FetchResult } from './fetchers/types.js'
import type { FrontmatterConfig } from './config.js'

export interface FormatOptions {
  title: string
  frontmatter?: FrontmatterConfig
}

export function formatForObsidian(result: FetchResult, options: FormatOptions): string {
  const fm: Record<string, unknown> = {
    title: `${options.title} — ${result.date}`,
    date_saved: result.date,
    ...(options.frontmatter ?? {}),
  }

  const fmBlock = stringifyYaml(fm).trim()

  return `---\n${fmBlock}\n---\n\n${result.content.trim()}\n\n---\n\n> [!info] 来源\n> 自动同步自 [${result.title}](${result.sourceUrl})\n`
}

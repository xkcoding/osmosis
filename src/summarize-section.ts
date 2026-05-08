import { parse as parseYaml } from 'yaml'

export interface BuildSectionInput {
  sourceName: string
  displayTitle: string
  prUrl: string
  notifySummaryDisabled: boolean
  prMarkdown: string
  llmSummarize: () => Promise<string | null>
}

export interface BuiltSection {
  sourceName: string
  displayTitle: string
  summary: string
  prUrl: string
}

export async function buildSection(input: BuildSectionInput): Promise<BuiltSection | null> {
  if (input.notifySummaryDisabled) {
    const notifyBody = extractNotifyBody(input.prMarkdown)
    if (notifyBody && notifyBody.trim().length > 0) {
      return {
        sourceName: input.sourceName,
        displayTitle: input.displayTitle,
        summary: notifyBody,
        prUrl: input.prUrl,
      }
    }
    return null
  }

  const text = await input.llmSummarize()
  if (!text || !text.trim()) return null
  return {
    sourceName: input.sourceName,
    displayTitle: input.displayTitle,
    summary: text,
    prUrl: input.prUrl,
  }
}

export function extractNotifyBody(markdown: string): string | undefined {
  const m = markdown.match(/^---\n([\s\S]*?)\n---\n/)
  if (!m || !m[1]) return undefined
  try {
    const fm = parseYaml(m[1]) as Record<string, unknown>
    const v = fm?.notify_body
    return typeof v === 'string' ? v : undefined
  } catch {
    return undefined
  }
}

export interface QualityConfig {
  minBodyChars?: number
  minBodyLines?: number
  requireMarkdownSignal?: boolean
  forbidPatterns?: string[]
  onFail?: 'error' | 'skip'
}

export interface QualityIssue {
  rule: string
  message: string
}

const DEFAULTS = {
  minBodyChars: 200,
  minBodyLines: 5,
  requireMarkdownSignal: true,
  forbidPatterns: [
    '<!doctype',
    '<html',
    'coming soon',
    'todo: write',
    'placeholder content',
  ],
} satisfies Required<Omit<QualityConfig, 'onFail'>>

const MARKDOWN_SIGNALS = [
  /^#{1,6}\s+\S/m,
  /^[-*+]\s+\S/m,
  /^\d+\.\s+\S/m,
  /^>\s+\S/m,
  /\[[^\]]+\]\([^)\s]+\)/,
  /!\[[^\]]*\]\([^)\s]+\)/,
  /^```/m,
  /\*\*[^*\n]+\*\*/,
]

export function checkContentQuality(
  content: string,
  config: QualityConfig = {},
): QualityIssue[] {
  const cfg = { ...DEFAULTS, ...config }
  const issues: QualityIssue[] = []

  const body = stripFrontmatter(content).trim()

  if (body.length === 0) {
    issues.push({ rule: 'non-empty', message: 'content body is empty after stripping frontmatter' })
    return issues
  }

  if (body.length < cfg.minBodyChars) {
    issues.push({
      rule: 'min-body-chars',
      message: `body length ${body.length} < ${cfg.minBodyChars}`,
    })
  }

  const nonEmptyLines = body.split(/\r?\n/).filter((l) => l.trim().length > 0).length
  if (nonEmptyLines < cfg.minBodyLines) {
    issues.push({
      rule: 'min-body-lines',
      message: `non-empty line count ${nonEmptyLines} < ${cfg.minBodyLines}`,
    })
  }

  const lower = body.toLowerCase()
  for (const pattern of cfg.forbidPatterns) {
    if (lower.includes(pattern.toLowerCase())) {
      issues.push({
        rule: 'forbid-pattern',
        message: `body contains forbidden pattern: ${pattern}`,
      })
    }
  }

  if (cfg.requireMarkdownSignal && !looksLikeMarkdown(body)) {
    issues.push({
      rule: 'markdown-signal',
      message: 'body has no recognizable markdown signal (heading/list/link/quote/image/code/bold)',
    })
  }

  return issues
}

export function formatIssues(issues: QualityIssue[]): string {
  return issues.map((i) => `  - [${i.rule}] ${i.message}`).join('\n')
}

export function stripFrontmatter(s: string): string {
  const m = s.match(/^---\r?\n[\s\S]*?\r?\n---\r?\n?/)
  if (!m) return s
  return s.slice(m[0].length).replace(/^\r?\n/, '')
}

function looksLikeMarkdown(s: string): boolean {
  return MARKDOWN_SIGNALS.some((p) => p.test(s))
}

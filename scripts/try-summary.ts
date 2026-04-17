import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs'
import { dirname } from 'node:path'
import { parseArgs } from 'node:util'
import { loadSubscription } from '../src/config.js'
import { getFetcher } from '../src/fetchers/registry.js'
import { summarize } from '../src/summarizer.js'

loadDotEnv('.env.local')

const { values } = parseArgs({
  args: process.argv.slice(2),
  options: {
    subscription: { type: 'string', short: 's' },
    'content-file': { type: 'string', short: 'c' },
    'cache-dir': { type: 'string', default: '.cache/try-summary' },
    'no-cache': { type: 'boolean', default: false },
    model: { type: 'string', short: 'm' },
  },
})

const slug = values.subscription
if (!slug) {
  console.error('Usage: pnpm try-summary --subscription <slug> [--content-file <path>] [--model <id>] [--no-cache]')
  process.exit(1)
}

const sub = loadSubscription(slug)
const cachePath = `${values['cache-dir']}/${slug}.md`

let content: string
let title: string
let sourceUrl: string

if (values['content-file']) {
  content = readFileSync(values['content-file'], 'utf8')
  title = sub.name
  sourceUrl = '(local file)'
  console.error(`[try-summary] using --content-file ${values['content-file']}`)
} else if (!values['no-cache'] && existsSync(cachePath)) {
  const raw = readFileSync(cachePath, 'utf8')
  const sep = raw.indexOf('\n---CONTENT---\n')
  const meta = JSON.parse(raw.slice(0, sep))
  content = raw.slice(sep + '\n---CONTENT---\n'.length)
  title = meta.title
  sourceUrl = meta.sourceUrl
  console.error(`[try-summary] using cache ${cachePath} (pass --no-cache to refetch)`)
} else {
  console.error(`[try-summary] fetching ${slug} via ${sub.source.type}...`)
  const fetcher = getFetcher(sub.source.type)
  const result = await fetcher.fetch(sub.source)
  if (!result) {
    console.error(`[try-summary] no content for today`)
    process.exit(1)
  }
  content = result.content
  title = result.title
  sourceUrl = result.sourceUrl

  mkdirSync(dirname(cachePath), { recursive: true })
  writeFileSync(
    cachePath,
    `${JSON.stringify({ title, sourceUrl, cachedAt: new Date().toISOString() })}\n---CONTENT---\n${content}`,
    'utf8',
  )
  console.error(`[try-summary] cached to ${cachePath}`)
}

const promptPath = sub.summary?.promptFile ?? 'prompts/summary.md'
const promptTemplate = readFileSync(promptPath, 'utf8')
console.error(`[try-summary] prompt: ${promptPath} (${promptTemplate.length} chars)`)
console.error(`[try-summary] content: ${content.length} chars`)
const modelOverride = values.model ?? process.env.SUMMARY_MODEL
if (modelOverride) console.error(`[try-summary] model: ${modelOverride}`)

const startedAt = Date.now()
const text = await summarize(
  { name: sub.name, title, content, prUrl: sourceUrl },
  promptTemplate,
  { model: values.model },
)
const elapsed = ((Date.now() - startedAt) / 1000).toFixed(1)

console.log(text)
console.error(`\n--- ${text.length} chars · ${elapsed}s ---`)

function loadDotEnv(path: string): void {
  if (!existsSync(path)) return
  for (const line of readFileSync(path, 'utf8').split('\n')) {
    const trimmed = line.trim()
    if (!trimmed || trimmed.startsWith('#')) continue
    const m = trimmed.match(/^([A-Z_][A-Z0-9_]*)\s*=\s*(.*)$/)
    if (!m) continue
    const key = m[1]!
    let value = m[2]!
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1)
    }
    process.env[key] ??= value
  }
}

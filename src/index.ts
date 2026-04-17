import { mkdirSync, writeFileSync, readFileSync, existsSync, appendFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { parseArgs } from 'node:util'
import { listSubscriptions, loadSubscription, type Subscription } from './config.js'
import { getFetcher } from './fetchers/registry.js'
import { formatForObsidian } from './formatter.js'
import { resolveTemplate, todayParts } from './template.js'
import { isAlreadySynced } from './dedup.js'
import { checkContentQuality, formatIssues } from './quality.js'
import { summarize } from './summarizer.js'
import { listSyncedPrs, fetchPrFile } from './pr-listing.js'
import { getNotifier, listChannels } from './notifiers/registry.js'
import type { NotifyPayload } from './notifiers/types.js'

const cmd = process.argv[2]

try {
  switch (cmd) {
    case 'fetch':
      await runFetch()
      break
    case 'list':
      runList()
      break
    case 'matrix':
      runMatrix()
      break
    case 'summarize':
      await runSummarize()
      break
    case 'notify':
      await runNotify()
      break
    case undefined:
    case 'help':
    case '--help':
    case '-h':
      printHelp()
      break
    default:
      console.error(`Unknown command: ${cmd}`)
      printHelp()
      process.exit(1)
  }
} catch (err) {
  console.error(err instanceof Error ? err.stack ?? err.message : err)
  process.exit(1)
}

function printHelp(): void {
  console.log(`osmosis CLI

Commands:
  fetch       --subscription <slug> --output-dir <path>
  list        list all subscription slugs (one per line)
  matrix      print GitHub Actions matrix JSON for all subscriptions
  summarize   --target-repo <owner/repo> [--date YYYY-MM-DD] [--output <file>]
  notify      --target-repo <owner/repo> --summary-file <file> [--date YYYY-MM-DD]
`)
}

function runList(): void {
  const items = listSubscriptions()
  for (const s of items) {
    console.log(s.name)
  }
}

function runMatrix(): void {
  const items = listSubscriptions()
  const matrix = { include: items.map((s) => ({ name: s.name })) }
  const json = JSON.stringify(matrix)
  console.log(json)
  writeOutput('matrix', json)
}

async function runFetch(): Promise<void> {
  const { values } = parseArgs({
    args: process.argv.slice(3),
    options: {
      subscription: { type: 'string' },
      'output-dir': { type: 'string' },
    },
  })

  const slug = values.subscription
  const outputDir = values['output-dir'] ?? '.'
  if (!slug) throw new Error('--subscription is required')

  const sub = loadSubscription(slug)
  const parts = todayParts()

  const targetRepo = process.env.TARGET_REPO
  if (targetRepo) {
    const synced = await isAlreadySynced({ targetRepo, sourceName: sub.name, date: parts.date })
    if (synced) {
      console.log(`[fetch] ${sub.name} ${parts.date}: already synced, skip`)
      writeOutput('has_new_content', 'false')
      writeOutput('source_name', sub.name)
      writeOutput('date', parts.date)
      return
    }
  }

  const fetcher = getFetcher(sub.source.type)
  const result = await fetcher.fetch(sub.source)
  if (!result) {
    console.log(`[fetch] ${sub.name} ${parts.date}: no content`)
    writeOutput('has_new_content', 'false')
    writeOutput('source_name', sub.name)
    writeOutput('date', parts.date)
    return
  }

  const issues = checkContentQuality(result.content, sub.quality)
  if (issues.length > 0) {
    const detail = formatIssues(issues)
    const onFail = sub.quality?.onFail ?? 'error'
    if (onFail === 'skip') {
      console.log(`[fetch] ${sub.name} ${parts.date}: quality skip\n${detail}`)
      writeOutput('has_new_content', 'false')
      writeOutput('source_name', sub.name)
      writeOutput('date', parts.date)
      writeOutput('skipped_reason', `quality:${issues[0]!.rule}`)
      return
    }
    const preview = result.content.slice(0, 500).replaceAll('\n', '\n    ')
    throw new Error(
      `Quality check failed for ${sub.name} ${parts.date}:\n${detail}\n\n--- content preview (first 500 chars) ---\n    ${preview}`,
    )
  }

  if (!sub.output.obsidian?.enabled) {
    throw new Error(`Subscription ${sub.name} has no obsidian output configured`)
  }

  const outPath = resolveTemplate(sub.output.obsidian.path, parts)
  const fullPath = join(outputDir, outPath)
  const formatted = formatForObsidian(result, {
    title: result.title,
    frontmatter: sub.output.obsidian.frontmatter,
  })

  mkdirSync(dirname(fullPath), { recursive: true })
  writeFileSync(fullPath, formatted, 'utf8')
  console.log(`[fetch] ${sub.name} ${parts.date}: wrote ${fullPath}`)

  writeOutput('has_new_content', 'true')
  writeOutput('source_name', sub.name)
  writeOutput('date', parts.date)
  writeOutput('output_path', outPath)
  writeOutput('source_url', result.sourceUrl)
}

const DEFAULT_PROMPT_PATH = 'prompts/summary.md'

async function runSummarize(): Promise<void> {
  const { values } = parseArgs({
    args: process.argv.slice(3),
    options: {
      'target-repo': { type: 'string' },
      date: { type: 'string' },
      output: { type: 'string' },
    },
  })

  const targetRepo = values['target-repo'] ?? process.env.TARGET_REPO
  if (!targetRepo) throw new Error('--target-repo or TARGET_REPO is required')
  const date = values.date ?? todayParts().date
  const outputPath = values.output ?? 'summary.md'

  const prs = await listSyncedPrs(targetRepo, date)
  if (prs.length === 0) {
    console.log(`[summarize] no PRs for ${date}`)
    writeFileSync(outputPath, '', 'utf8')
    writeOutput('has_summary', 'false')
    writeOutput('pr_count', '0')
    return
  }

  const sections: { sourceName: string; title: string; summary: string; prUrl: string }[] = []
  for (const pr of prs) {
    const mdFile = pr.files.find((f) => f.endsWith('.md'))
    if (!mdFile) continue

    let subscription: Subscription
    try {
      subscription = loadSubscription(pr.sourceName)
    } catch {
      console.log(`[summarize] unknown subscription ${pr.sourceName}, skip`)
      continue
    }
    if (subscription.output.notify?.summary === false) continue

    try {
      const content = await fetchPrFile(targetRepo, pr.number, mdFile)
      const promptPath = subscription.summary?.promptFile ?? DEFAULT_PROMPT_PATH
      const promptTemplate = readFileSync(promptPath, 'utf8')
      const text = await summarize(
        { name: pr.sourceName, title: pr.title, content, prUrl: pr.url },
        promptTemplate,
      )
      if (text) {
        sections.push({ sourceName: pr.sourceName, title: pr.title, summary: text, prUrl: pr.url })
      }
    } catch (err) {
      console.error(`[summarize] failed for PR #${pr.number}:`, err)
    }
  }

  if (sections.length === 0) {
    console.log(`[summarize] no summary produced for ${date}`)
    writeFileSync(outputPath, '', 'utf8')
    writeOutput('has_summary', 'false')
    writeOutput('pr_count', String(prs.length))
    return
  }

  const body = sections
    .map((s) => `## ${s.title}\n\n${s.summary}\n\n> 全文 PR: ${s.prUrl}`)
    .join('\n\n---\n\n')

  writeFileSync(outputPath, body, 'utf8')
  console.log(`[summarize] wrote ${outputPath} (${sections.length} sources)`)
  writeOutput('has_summary', 'true')
  writeOutput('pr_count', String(prs.length))
  writeOutput('pr_urls', prs.map((p) => p.url).join(','))
  writeOutput('source_names', sections.map((s) => s.sourceName).join(','))
}

async function runNotify(): Promise<void> {
  const { values } = parseArgs({
    args: process.argv.slice(3),
    options: {
      'target-repo': { type: 'string' },
      'summary-file': { type: 'string' },
      date: { type: 'string' },
    },
  })

  const targetRepo = values['target-repo'] ?? process.env.TARGET_REPO
  if (!targetRepo) throw new Error('--target-repo or TARGET_REPO is required')
  const summaryFile = values['summary-file']
  if (!summaryFile) throw new Error('--summary-file is required')
  const date = values.date ?? todayParts().date

  if (!existsSync(summaryFile)) {
    console.log(`[notify] summary file missing: ${summaryFile}, skip`)
    return
  }
  const summary = readFileSync(summaryFile, 'utf8').trim()
  if (!summary) {
    console.log(`[notify] empty summary, skip`)
    return
  }

  const prs = await listSyncedPrs(targetRepo, date)
  const payload: NotifyPayload = {
    summary,
    sources: dedupe(prs.map((p) => p.sourceName)),
    prUrls: prs.map((p) => p.url),
    date,
  }

  const wantedChannels = collectChannels(prs.map((p) => p.sourceName))
  const channels = wantedChannels.length > 0 ? wantedChannels : listChannels()

  const results = await Promise.allSettled(
    channels.map(async (ch) => {
      const notifier = getNotifier(ch)
      if (!notifier) {
        console.log(`[notify] unknown channel: ${ch}, skip`)
        return
      }
      await notifier.send(payload)
    }),
  )

  for (const r of results) {
    if (r.status === 'rejected') {
      console.error(`[notify] channel failed:`, r.reason)
    }
  }
}

function collectChannels(sourceNames: string[]): string[] {
  const channels = new Set<string>()
  for (const name of sourceNames) {
    try {
      const sub = loadSubscription(name)
      if (sub.output.notify?.enabled) {
        for (const ch of sub.output.notify.channels) channels.add(ch)
      }
    } catch {
      // unknown subscription (e.g. removed yaml), skip
    }
  }
  return Array.from(channels)
}

function dedupe<T>(items: T[]): T[] {
  return Array.from(new Set(items))
}

function writeOutput(key: string, value: string): void {
  const file = process.env.GITHUB_OUTPUT
  if (!file) return
  appendFileSync(file, `${key}=${value.replaceAll('\n', '%0A')}\n`)
}


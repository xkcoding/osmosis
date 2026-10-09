import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { parse as parseYaml } from 'yaml'

const execFileAsync = promisify(execFile)

export const SUMMARY_SENT_LABEL = 'summary-sent'

export interface SyncedPr {
  number: number
  title: string
  url: string
  labels: string[]
  files: string[]
  sourceName: string
}

export async function listSyncedPrs(targetRepo: string, date: string): Promise<SyncedPr[]> {
  const { stdout } = await execFileAsync('gh', [
    'pr', 'list',
    '--repo', targetRepo,
    '--label', 'auto-sync',
    '--state', 'all',
    '--json', 'number,title,url,labels,files,state',
    '--limit', '100',
  ])

  type RawPr = {
    number: number
    title: string
    url: string
    state: string
    labels: { name: string }[]
    files: { path: string }[]
  }

  const raw = JSON.parse(stdout) as RawPr[]
  return raw
    .filter((p) => (p.state === 'OPEN' || p.state === 'MERGED') && p.title.includes(date))
    .filter((p) => !p.labels.some((l) => l.name === SUMMARY_SENT_LABEL))
    .map((p) => ({
      number: p.number,
      title: p.title,
      url: p.url,
      labels: p.labels.map((l) => l.name),
      files: p.files.map((f) => f.path),
      sourceName: extractSourceName(p.labels.map((l) => l.name)),
    }))
}

export async function markSummarySent(targetRepo: string, prNumber: number): Promise<void> {
  await ensureLabel(targetRepo, SUMMARY_SENT_LABEL)
  await execFileAsync('gh', [
    'pr', 'edit', String(prNumber),
    '--repo', targetRepo,
    '--add-label', SUMMARY_SENT_LABEL,
  ])
}

async function ensureLabel(targetRepo: string, name: string): Promise<void> {
  try {
    await execFileAsync('gh', [
      'label', 'create', name,
      '--repo', targetRepo,
      '--color', '0e8a16',
      '--description', 'Daily summary has been pushed; excluded from future notify runs',
      '--force',
    ])
  } catch (err) {
    console.error(`[notify] ensureLabel ${name} warning:`, err)
  }
}

export async function fetchPrFile(targetRepo: string, prNumber: number, path: string): Promise<string> {
  const branchOut = await execFileAsync('gh', [
    'pr', 'view', String(prNumber),
    '--repo', targetRepo,
    '--json', 'headRefName,headRefOid,state,mergeCommit,baseRefName',
  ])
  const meta = JSON.parse(branchOut.stdout) as {
    headRefName: string
    headRefOid: string
    state: string
    mergeCommit: { oid: string } | null
    baseRefName: string
  }

  // For merged PRs, the head branch is typically auto-deleted. Use the
  // merge commit SHA so we read the exact state that landed. For open
  // PRs, use the head branch (always exists, always up-to-date).
  const ref =
    meta.state === 'MERGED' && meta.mergeCommit
      ? meta.mergeCommit.oid
      : meta.state === 'CLOSED'
        ? meta.headRefOid
        : meta.headRefName

  const [owner, repo] = targetRepo.split('/')
  const encodedPath = path.split('/').map(encodeURIComponent).join('/')
  const encodedRef = encodeURIComponent(ref)
  const { stdout } = await execFileAsync('gh', [
    'api',
    `/repos/${owner}/${repo}/contents/${encodedPath}?ref=${encodedRef}`,
    '--jq', '.content',
  ])

  return Buffer.from(stdout.trim(), 'base64').toString('utf8')
}

const CONTENT_DATE_RE = /\d{4}-\d{2}-\d{2}/

/**
 * Newest-first order for a source's synced PRs: by the content date in the title
 * (`📡 <slug> YYYY-MM-DD`), then by createdAt. A backfilled PR (OSMOSIS_DATE) is
 * created last but carries an older date — ordering by createdAt alone would let
 * it displace the real latest day from the pushed-set and the sync_state anchor.
 */
export function newestSyncedFirst(
  a: { title: string; createdAt: string },
  b: { title: string; createdAt: string },
): number {
  const da = contentDate(a)
  const db = contentDate(b)
  if (da !== db) return da < db ? 1 : -1
  if (a.createdAt === b.createdAt) return 0
  return a.createdAt < b.createdAt ? 1 : -1
}

function contentDate(p: { title: string; createdAt: string }): string {
  return CONTENT_DATE_RE.exec(p.title)?.[0] ?? p.createdAt.slice(0, 10)
}

export async function fetchRecentSyncedContents(
  targetRepo: string,
  sourceName: string,
  n: number,
): Promise<string[]> {
  const { stdout } = await execFileAsync('gh', [
    'pr', 'list',
    '--repo', targetRepo,
    '--label', `auto-sync,source:${sourceName}`,
    '--state', 'all',
    '--json', 'number,title,state,createdAt,files',
    '--limit', '20',
  ])

  type RawPr = { number: number; title: string; state: string; createdAt: string; files: { path: string }[] }
  const raw = JSON.parse(stdout) as RawPr[]
  const recent = raw
    .filter((p) => p.state === 'OPEN' || p.state === 'MERGED')
    .filter((p) => p.files.some((f) => f.path.endsWith('.md')))
    .sort(newestSyncedFirst)
    .slice(0, n)

  const contents: string[] = []
  for (const pr of recent) {
    const md = pr.files.find((f) => f.path.endsWith('.md'))!
    contents.push(await fetchPrFile(targetRepo, pr.number, md.path))
  }
  return contents
}

/**
 * Reads the `sync_state` frontmatter map from the source's newest synced PR
 * (title-date order). Missing PR / field / unparsable frontmatter → undefined;
 * gh errors propagate so the fetcher picks its own degradation.
 */
export async function fetchLastSyncState(
  targetRepo: string,
  sourceName: string,
): Promise<Record<string, string> | undefined> {
  const [latest] = await fetchRecentSyncedContents(targetRepo, sourceName, 1)
  if (!latest) return undefined
  const m = latest.match(/^---\n([\s\S]*?)\n---\n/)
  if (!m || !m[1]) return undefined
  let fm: unknown
  try {
    fm = parseYaml(m[1])
  } catch {
    return undefined
  }
  const raw = (fm as Record<string, unknown> | null)?.sync_state
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return undefined
  const state: Record<string, string> = {}
  for (const [k, v] of Object.entries(raw)) {
    if (typeof v === 'string') state[k] = v
  }
  return Object.keys(state).length > 0 ? state : undefined
}

function extractSourceName(labels: string[]): string {
  const label = labels.find((l) => l.startsWith('source:'))
  return label ? label.slice('source:'.length) : 'unknown'
}

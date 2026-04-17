import { execFile } from 'node:child_process'
import { promisify } from 'node:util'

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

function extractSourceName(labels: string[]): string {
  const label = labels.find((l) => l.startsWith('source:'))
  return label ? label.slice('source:'.length) : 'unknown'
}

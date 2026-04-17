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
    '--json', 'headRefName,headRepositoryOwner,headRepository',
  ])
  const meta = JSON.parse(branchOut.stdout) as {
    headRefName: string
    headRepositoryOwner: { login: string }
    headRepository: { name: string }
  }

  const owner = meta.headRepositoryOwner.login
  const repo = meta.headRepository.name
  const branch = meta.headRefName

  const { stdout } = await execFileAsync('gh', [
    'api',
    `/repos/${owner}/${repo}/contents/${path}?ref=${branch}`,
    '--jq', '.content',
  ])

  return Buffer.from(stdout.trim(), 'base64').toString('utf8')
}

function extractSourceName(labels: string[]): string {
  const label = labels.find((l) => l.startsWith('source:'))
  return label ? label.slice('source:'.length) : 'unknown'
}

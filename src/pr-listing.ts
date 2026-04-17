import { execFile } from 'node:child_process'
import { promisify } from 'node:util'

const execFileAsync = promisify(execFile)

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
    .map((p) => ({
      number: p.number,
      title: p.title,
      url: p.url,
      labels: p.labels.map((l) => l.name),
      files: p.files.map((f) => f.path),
      sourceName: extractSourceName(p.labels.map((l) => l.name)),
    }))
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

import { execFile } from 'node:child_process'
import { promisify } from 'node:util'

const execFileAsync = promisify(execFile)

export interface DedupQuery {
  targetRepo: string
  sourceName: string
  date: string
}

export interface SyncStatus {
  syncedToday: boolean
}

export async function getSyncStatus(query: DedupQuery): Promise<SyncStatus> {
  const { stdout } = await execFileAsync('gh', [
    'pr', 'list',
    '--repo', query.targetRepo,
    '--label', `auto-sync,source:${query.sourceName}`,
    '--state', 'all',
    '--json', 'title,state',
    '--limit', '50',
  ])
  const list = JSON.parse(stdout) as { title: string; state: string }[]
  const syncedToday = list.some(
    (p) => (p.state === 'OPEN' || p.state === 'MERGED') && p.title.includes(query.date),
  )
  return { syncedToday }
}

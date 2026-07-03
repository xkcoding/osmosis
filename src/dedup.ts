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
  lastSyncedAt: string | null
}

export async function getSyncStatus(query: DedupQuery): Promise<SyncStatus> {
  const { stdout } = await execFileAsync('gh', [
    'pr', 'list',
    '--repo', query.targetRepo,
    '--label', `auto-sync,source:${query.sourceName}`,
    '--state', 'all',
    '--json', 'title,state,createdAt',
    '--limit', '50',
  ])
  const list = JSON.parse(stdout) as { title: string; state: string; createdAt: string }[]
  const active = list.filter((p) => p.state === 'OPEN' || p.state === 'MERGED')
  const syncedToday = active.some((p) => p.title.includes(query.date))
  let lastSyncedAt: string | null = null
  for (const p of active) {
    if (lastSyncedAt === null || p.createdAt > lastSyncedAt) lastSyncedAt = p.createdAt
  }
  return { syncedToday, lastSyncedAt }
}

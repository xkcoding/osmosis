import { execFile } from 'node:child_process'
import { promisify } from 'node:util'

const execFileAsync = promisify(execFile)

export interface DedupQuery {
  targetRepo: string
  sourceName: string
  date: string
}

export async function isAlreadySynced(query: DedupQuery): Promise<boolean> {
  const { stdout } = await execFileAsync('gh', [
    'pr', 'list',
    '--repo', query.targetRepo,
    '--label', 'auto-sync',
    '--label', `source:${query.sourceName}`,
    '--state', 'open',
    '--state', 'merged',
    '--json', 'title',
    '--limit', '50',
  ])
  const list = JSON.parse(stdout) as { title: string }[]
  return list.some((p) => p.title.includes(query.date))
}

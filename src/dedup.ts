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
    '--search', query.date,
    '--state', 'open',
    '--state', 'merged',
    '--json', 'number',
  ])
  const list = JSON.parse(stdout) as { number: number }[]
  return list.length > 0
}

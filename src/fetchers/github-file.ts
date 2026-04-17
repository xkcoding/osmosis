import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import type { Fetcher, FetchResult, SourceConfig } from './types.js'
import { resolveTemplate, todayParts } from '../template.js'

const execFileAsync = promisify(execFile)

interface GithubFileConfig extends SourceConfig {
  type: 'github-file'
  repo: string
  path: string
  branch?: string
  title?: string
}

interface ContentResponse {
  type: string
  content: string
  encoding: BufferEncoding
}

export const githubFileFetcher: Fetcher = {
  type: 'github-file',

  async fetch(config: SourceConfig): Promise<FetchResult | null> {
    const cfg = config as GithubFileConfig
    const [owner, repo] = cfg.repo.split('/')
    if (!owner || !repo) {
      throw new Error(`Invalid repo: ${cfg.repo} (expected owner/repo)`)
    }

    const parts = todayParts()
    const path = resolveTemplate(cfg.path, parts)
    const branch = cfg.branch ?? 'main'
    const encodedPath = path.split('/').map(encodeURIComponent).join('/')
    const endpoint = `/repos/${owner}/${repo}/contents/${encodedPath}?ref=${encodeURIComponent(branch)}`

    let stdout: string
    try {
      ;({ stdout } = await execFileAsync('gh', ['api', '-H', 'Accept: application/vnd.github+json', endpoint]))
    } catch (err) {
      if (isNotFound(err)) return null
      throw err
    }

    const data = JSON.parse(stdout) as ContentResponse
    if (data.type !== 'file') {
      throw new Error(`Path is not a file: ${path}`)
    }
    const content = Buffer.from(data.content, data.encoding).toString('utf8')

    return {
      title: cfg.title ?? `${owner}/${repo}`,
      date: parts.date,
      content,
      sourceUrl: `https://github.com/${owner}/${repo}/blob/${branch}/${path}`,
    }
  },
}

function isNotFound(err: unknown): boolean {
  if (typeof err !== 'object' || err === null) return false
  const e = err as { stderr?: string | Buffer; message?: string }
  const stderr = typeof e.stderr === 'string' ? e.stderr : e.stderr?.toString() ?? ''
  const msg = e.message ?? ''
  return /HTTP 404|Not Found/.test(stderr) || /HTTP 404|Not Found/.test(msg)
}

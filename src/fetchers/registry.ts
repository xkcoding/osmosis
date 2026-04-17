import type { Fetcher } from './types.js'
import { githubFileFetcher } from './github-file.js'

const registry = new Map<string, Fetcher>()

export function register(fetcher: Fetcher): void {
  registry.set(fetcher.type, fetcher)
}

export function getFetcher(type: string): Fetcher {
  const fetcher = registry.get(type)
  if (!fetcher) {
    throw new Error(`Unknown fetcher type: ${type}`)
  }
  return fetcher
}

register(githubFileFetcher)

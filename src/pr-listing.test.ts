import { describe, it, expect, beforeEach, vi } from 'vitest'

const ghMock = vi.hoisted(() => vi.fn())

vi.mock('node:child_process', async () => {
  const { promisify } = await import('node:util')
  const execFile = (): never => {
    throw new Error('use promisified form')
  }
  Object.defineProperty(execFile, promisify.custom, { value: ghMock })
  return { execFile }
})

const { fetchRecentSyncedContents } = await import('./pr-listing.js')

type ListedPr = { number: number; state: string; createdAt: string; title: string; files: { path: string }[] }

const DEFAULT_PRS: ListedPr[] = [
  { number: 1, state: 'MERGED', createdAt: '2026-07-01T00:10:00Z', title: '📡 aihot 2026-07-01', files: [{ path: 'a/1.md' }] },
  { number: 3, state: 'OPEN', createdAt: '2026-07-03T00:10:00Z', title: '📡 aihot 2026-07-03', files: [{ path: 'a/3.md' }] },
  { number: 9, state: 'CLOSED', createdAt: '2026-07-09T00:10:00Z', title: '📡 aihot 2026-07-09', files: [{ path: 'a/9.md' }] },
  { number: 2, state: 'MERGED', createdAt: '2026-07-02T00:10:00Z', title: '📡 aihot 2026-07-02', files: [{ path: 'img.png' }] },
]

let listedPrs: ListedPr[] = DEFAULT_PRS

beforeEach(() => {
  listedPrs = DEFAULT_PRS
  ghMock.mockReset()
  ghMock.mockImplementation((_cmd: string, args: string[]) => {
    if (args[0] === 'pr' && args[1] === 'list') {
      return Promise.resolve({ stdout: JSON.stringify(listedPrs), stderr: '' })
    }
    if (args[0] === 'pr' && args[1] === 'view') {
      return Promise.resolve({
        stdout: JSON.stringify({
          headRefName: 'branch-x', headRefOid: 'oid', state: 'OPEN', mergeCommit: null, baseRefName: 'main',
        }),
        stderr: '',
      })
    }
    if (args[0] === 'api') {
      // contents path a/<n>.md → "content-of-<n>"
      const n = /a\/(\d+)\.md/.exec(args[1] as string)?.[1]
      return Promise.resolve({ stdout: Buffer.from(`content-of-${n}`, 'utf8').toString('base64'), stderr: '' })
    }
    return Promise.reject(new Error(`unexpected gh call: ${args.join(' ')}`))
  })
})

describe('fetchRecentSyncedContents', () => {
  it('returns newest-first md contents, skips CLOSED and md-less PRs, honours n', async () => {
    const contents = await fetchRecentSyncedContents('o/r', 'aihot', 2)
    expect(contents).toEqual(['content-of-3', 'content-of-1'])
  })

  it('filters by source label in the gh query', async () => {
    await fetchRecentSyncedContents('o/r', 'aihot', 1)
    const listArgs = ghMock.mock.calls[0]![1] as string[]
    expect(listArgs).toContain('auto-sync,source:aihot')
    expect(listArgs).toContain('all')
  })

  it('orders by the content date in the title, so a later-created backfill PR never displaces a newer day', async () => {
    listedPrs = [
      { number: 3, state: 'MERGED', createdAt: '2026-07-03T00:10:00Z', title: '📡 aihot 2026-07-03', files: [{ path: 'a/3.md' }] },
      // backfilled afterwards: newest createdAt, older content date
      { number: 5, state: 'OPEN', createdAt: '2026-07-03T06:00:00Z', title: '📡 aihot 2026-06-28', files: [{ path: 'a/5.md' }] },
      { number: 2, state: 'MERGED', createdAt: '2026-07-02T00:10:00Z', title: '📡 aihot 2026-07-02', files: [{ path: 'a/2.md' }] },
    ]
    const contents = await fetchRecentSyncedContents('o/r', 'aihot', 2)
    expect(contents).toEqual(['content-of-3', 'content-of-2'])
    const listArgs = ghMock.mock.calls[0]![1] as string[]
    expect(listArgs[listArgs.indexOf('--json') + 1]!.split(',')).toContain('title')
  })
})

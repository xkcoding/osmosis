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

beforeEach(() => {
  ghMock.mockReset()
  ghMock.mockImplementation((_cmd: string, args: string[]) => {
    if (args[0] === 'pr' && args[1] === 'list') {
      return Promise.resolve({
        stdout: JSON.stringify([
          { number: 1, state: 'MERGED', createdAt: '2026-07-01T00:10:00Z', files: [{ path: 'a/1.md' }] },
          { number: 3, state: 'OPEN', createdAt: '2026-07-03T00:10:00Z', files: [{ path: 'a/3.md' }] },
          { number: 9, state: 'CLOSED', createdAt: '2026-07-09T00:10:00Z', files: [{ path: 'a/9.md' }] },
          { number: 2, state: 'MERGED', createdAt: '2026-07-02T00:10:00Z', files: [{ path: 'img.png' }] },
        ]),
        stderr: '',
      })
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
      const prPath = args[1] as string
      const marker = prPath.includes('a%2F3.md') || prPath.includes('a/3.md') ? 'content-of-3' : 'content-of-1'
      return Promise.resolve({ stdout: Buffer.from(marker, 'utf8').toString('base64'), stderr: '' })
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
})

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

const { getSyncStatus } = await import('./dedup.js')

beforeEach(() => {
  ghMock.mockReset()
})

function ghList(prs: { title: string; state: string; createdAt: string }[]): void {
  ghMock.mockResolvedValueOnce({ stdout: JSON.stringify(prs), stderr: '' })
}

describe('getSyncStatus', () => {
  it('reports syncedToday when an OPEN PR title contains the date', async () => {
    ghList([{ title: 'sync(aihot): 2026-07-03', state: 'OPEN', createdAt: '2026-07-03T00:10:00Z' }])
    const s = await getSyncStatus({ targetRepo: 'o/r', sourceName: 'aihot', date: '2026-07-03' })
    expect(s.syncedToday).toBe(true)
    expect(s.lastSyncedAt).toBe('2026-07-03T00:10:00Z')
  })

  it('ignores CLOSED PRs for both fields', async () => {
    ghList([{ title: 'sync(aihot): 2026-07-03', state: 'CLOSED', createdAt: '2026-07-03T00:10:00Z' }])
    const s = await getSyncStatus({ targetRepo: 'o/r', sourceName: 'aihot', date: '2026-07-03' })
    expect(s.syncedToday).toBe(false)
    expect(s.lastSyncedAt).toBeNull()
  })

  it('returns max createdAt across dates as lastSyncedAt even when today is unsynced', async () => {
    ghList([
      { title: 'sync(aihot): 2026-07-01', state: 'MERGED', createdAt: '2026-07-01T00:12:00Z' },
      { title: 'sync(aihot): 2026-07-02', state: 'MERGED', createdAt: '2026-07-02T00:11:00Z' },
    ])
    const s = await getSyncStatus({ targetRepo: 'o/r', sourceName: 'aihot', date: '2026-07-03' })
    expect(s.syncedToday).toBe(false)
    expect(s.lastSyncedAt).toBe('2026-07-02T00:11:00Z')
  })

  it('returns nulls on empty list', async () => {
    ghList([])
    const s = await getSyncStatus({ targetRepo: 'o/r', sourceName: 'aihot', date: '2026-07-03' })
    expect(s).toEqual({ syncedToday: false, lastSyncedAt: null })
  })

  it('queries gh with both labels and state all and createdAt field', async () => {
    ghList([])
    await getSyncStatus({ targetRepo: 'o/r', sourceName: 'aihot', date: '2026-07-03' })
    const args = ghMock.mock.calls[0]![1] as string[]
    expect(args).toContain('auto-sync,source:aihot')
    expect(args).toContain('all')
    expect(args.join(' ')).toContain('createdAt')
  })
})

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

function ghList(prs: { title: string; state: string }[]): void {
  ghMock.mockResolvedValueOnce({ stdout: JSON.stringify(prs), stderr: '' })
}

describe('getSyncStatus', () => {
  it('reports syncedToday when an OPEN PR title contains the date', async () => {
    ghList([{ title: 'sync(aihot): 2026-07-03', state: 'OPEN' }])
    const s = await getSyncStatus({ targetRepo: 'o/r', sourceName: 'aihot', date: '2026-07-03' })
    expect(s.syncedToday).toBe(true)
  })

  it('reports syncedToday for a MERGED PR', async () => {
    ghList([{ title: 'sync(aihot): 2026-07-03', state: 'MERGED' }])
    const s = await getSyncStatus({ targetRepo: 'o/r', sourceName: 'aihot', date: '2026-07-03' })
    expect(s.syncedToday).toBe(true)
  })

  it('ignores CLOSED PRs', async () => {
    ghList([{ title: 'sync(aihot): 2026-07-03', state: 'CLOSED' }])
    const s = await getSyncStatus({ targetRepo: 'o/r', sourceName: 'aihot', date: '2026-07-03' })
    expect(s.syncedToday).toBe(false)
  })

  it('is false when only other dates are synced', async () => {
    ghList([{ title: 'sync(aihot): 2026-07-02', state: 'MERGED' }])
    const s = await getSyncStatus({ targetRepo: 'o/r', sourceName: 'aihot', date: '2026-07-03' })
    expect(s).toEqual({ syncedToday: false })
  })

  it('returns false on empty list', async () => {
    ghList([])
    const s = await getSyncStatus({ targetRepo: 'o/r', sourceName: 'aihot', date: '2026-07-03' })
    expect(s).toEqual({ syncedToday: false })
  })

  it('queries gh with both labels and state all', async () => {
    ghList([])
    await getSyncStatus({ targetRepo: 'o/r', sourceName: 'aihot', date: '2026-07-03' })
    const args = ghMock.mock.calls[0]![1] as string[]
    expect(args).toContain('auto-sync,source:aihot')
    expect(args).toContain('all')
  })
})

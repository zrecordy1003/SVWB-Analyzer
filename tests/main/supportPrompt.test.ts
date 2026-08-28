import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { SupportPromptPayload } from '../../src/shared/support'

const electronMock = vi.hoisted(() => ({
  handlers: new Map<string, (...args: any[]) => unknown>(),
  opened: [] as string[]
}))

vi.mock('electron', () => ({
  ipcMain: {
    handle: vi.fn((channel: string, handler: (...args: any[]) => unknown) => {
      electronMock.handlers.set(channel, handler)
    })
  },
  shell: {
    openExternal: vi.fn((url: string) => {
      electronMock.opened.push(url)
      return Promise.resolve()
    })
  }
}))

// A stand-in for electron-store: same get/set shape, plain object behind it.
const storeMock = vi.hoisted(() => {
  const values = new Map<string, unknown>()
  return {
    values,
    store: {
      get: (key: string) => values.get(key),
      set: (key: string, value: unknown) => values.set(key, value)
    }
  }
})

vi.mock('../../src/main/store.js', () => ({ store: storeMock.store }))

const prismaMock = vi.hoisted(() => ({ matchCount: 0, throws: false }))

vi.mock('../../src/main/data/db/client.js', () => ({
  getDb: () => ({
    selectFrom: () => ({
      select: () => ({
        executeTakeFirstOrThrow: () => {
          if (prismaMock.throws) throw new Error('no database')
          return Promise.resolve({ n: prismaMock.matchCount })
        }
      })
    })
  })
}))

const { recordLaunch, registerSupportIpc } = await import('../../src/main/support/supportPrompt')

function check(): Promise<SupportPromptPayload | null> {
  const handler = electronMock.handlers.get('support:check')
  expect(handler, 'Missing IPC handler: support:check').toBeTypeOf('function')
  return handler!({}) as Promise<SupportPromptPayload | null>
}

async function optOut(): Promise<void> {
  await electronMock.handlers.get('support:optOut')!({})
}

function launch(times: number): void {
  for (let i = 0; i < times; i += 1) recordLaunch()
}

describe('support prompt milestones', () => {
  beforeEach(() => {
    electronMock.handlers.clear()
    storeMock.values.clear()
    prismaMock.matchCount = 0
    prismaMock.throws = false
    registerSupportIpc()
  })

  it('stays silent below both thresholds', async () => {
    launch(19)
    prismaMock.matchCount = 99
    expect(await check()).toBeNull()
  })

  it('fires the launch milestone once and never again', async () => {
    launch(20)

    const first = await check()
    expect(first).toEqual({ reason: 'launches', matchCount: 0, launchCount: 20 })

    // Ignoring the toast is an answer: the same milestone must not come back,
    // not on the next check and not on the next launch.
    expect(await check()).toBeNull()
    launch(5)
    expect(await check()).toBeNull()
  })

  it('prefers the match milestone, then allows the launch one later', async () => {
    launch(20)
    prismaMock.matchCount = 100

    expect((await check())?.reason).toBe('matches')
    expect((await check())?.reason).toBe('launches')
    expect(await check()).toBeNull()
  })

  it('opting out silences a milestone that is already due', async () => {
    prismaMock.matchCount = 500
    await optOut()
    expect(await check()).toBeNull()
  })

  it('still fires on launches when the database cannot be counted', async () => {
    prismaMock.throws = true
    launch(20)
    expect(await check()).toEqual({ reason: 'launches', matchCount: 0, launchCount: 20 })
  })

  it('tolerates a config written before the support key existed', async () => {
    storeMock.values.set('support', undefined)
    launch(20)
    expect((await check())?.reason).toBe('launches')
  })
})

/**
 * The upload path against a real migrated database: what it sends, when it
 * refuses to send, and that nothing it does can throw at its caller.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { TelemetryPayload, TelemetryStatus } from '../../src/shared/telemetry'
import { createMigratedTestDb, insertMatch, removeTestDb, type TestDb } from '../helpers/db'

const electronMock = vi.hoisted(() => ({
  handlers: new Map<string, (...args: any[]) => unknown>()
}))

vi.mock('electron', () => ({
  ipcMain: {
    handle: vi.fn((channel: string, handler: (...args: any[]) => unknown) => {
      electronMock.handlers.set(channel, handler)
    })
  },
  app: { getVersion: () => '9.9.9', getLocale: () => 'zh-TW' },
  net: { fetch: vi.fn() }
}))

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

const telemetry = await import('../../src/main/telemetry/telemetry')

const NOW = Date.parse('2026-09-02T10:00:00Z')
const ENDPOINT = 'https://telemetry.example.test'

type Sent = { url: string; body: TelemetryPayload }

let db: TestDb | undefined
let sent: Sent[]
let respond: () => Response | Promise<Response>

async function invoke<T>(channel: string, ...args: unknown[]): Promise<T> {
  const handler = electronMock.handlers.get(channel)
  expect(handler, `Missing IPC handler: ${channel}`).toBeTypeOf('function')
  return (await handler!({}, ...args)) as T
}

const okResponse = (): Response =>
  new Response(JSON.stringify({ ok: true, accepted: 14, rejected: [] }), { status: 200 })

/**
 * The steady state of an install that uploads: the setting on *and* the
 * one-time notice already shown. Both are required - a test that only flips the
 * setting is testing the notice gate, not the upload.
 */
async function enableAndTell(): Promise<void> {
  await invoke('telemetry:setEnabled', true)
  storeMock.values.set('telemetryPromptShown', true)
}

describe('telemetry upload', () => {
  beforeEach(async () => {
    electronMock.handlers.clear()
    storeMock.values.clear()
    sent = []
    respond = okResponse
    db = await createMigratedTestDb()
    telemetry.configureTelemetryForTests({
      now: () => NOW,
      endpoint: () => ENDPOINT,
      environment: () => ({ appVersion: '9.9.9', platform: 'win32', arch: 'x64', locale: 'zh-TW' }),
      fetch: async (url, init) => {
        sent.push({ url, body: JSON.parse(String(init?.body)) as TelemetryPayload })
        return respond()
      }
    })
    telemetry.registerTelemetryIpc()
  })

  afterEach(async () => {
    telemetry.configureTelemetryForTests(null)
    await removeTestDb(db)
    db = undefined
  })

  it('starts with no install id and nothing sent', async () => {
    const status = await invoke<TelemetryStatus>('telemetry:status')
    expect(status).toMatchObject({ enabled: false, configured: true, installId: null })
    await telemetry.uploadNow({ force: true })
    expect(sent).toHaveLength(0)
  })

  it('sends nothing before the notice has been shown, however enabled it is', async () => {
    await invoke('telemetry:setEnabled', true)
    await telemetry.uploadNow({ force: true })
    expect(sent).toHaveLength(0)

    // The notice going out is what unblocks it - and only for real.
    expect(await invoke<boolean>('telemetry:noticeDue')).toBe(true)
    await telemetry.uploadNow({ force: true })
    expect(sent).toHaveLength(1)
  })

  it('previewing does not mint an install id', async () => {
    const preview = await invoke<TelemetryPayload>('telemetry:preview')
    expect(preview.days).toHaveLength(14)
    expect(preview.installId).not.toMatch(/^[0-9a-f-]{36}$/)
    expect((await invoke<TelemetryStatus>('telemetry:status')).installId).toBeNull()
  })

  it('mints one install id on enable and keeps it across toggles', async () => {
    const on = await invoke<TelemetryStatus>('telemetry:setEnabled', true)
    expect(on.enabled).toBe(true)
    expect(on.installId).toMatch(/^[0-9a-f-]{36}$/)
    expect(storeMock.values.get('settings.telemetry')).toBe(true)

    const off = await invoke<TelemetryStatus>('telemetry:setEnabled', false)
    expect(off.enabled).toBe(false)
    expect(off.installId).toBe(on.installId)

    const again = await invoke<TelemetryStatus>('telemetry:setEnabled', true)
    expect(again.installId).toBe(on.installId)
  })

  it('sends the rolled-up window and records the success', async () => {
    await insertMatch({
      result: true,
      play_order: 'first',
      my_class: 'witch',
      oppo_class: 'dragon',
      mode: 'ranked',
      playedAt: new Date(NOW - 3_600_000)
    })
    await insertMatch({
      result: null,
      play_order: 'second',
      my_class: 'elf',
      oppo_class: 'royal',
      mode: 'ranked',
      playedAt: new Date(NOW - 7_200_000)
    })
    // Older than the window: must not appear.
    await insertMatch({
      result: false,
      play_order: 'first',
      my_class: 'elf',
      oppo_class: 'royal',
      mode: 'ranked',
      playedAt: new Date(NOW - 40 * 86_400_000)
    })

    await enableAndTell()
    const status = await invoke<TelemetryStatus>('telemetry:uploadNow')

    expect(sent).toHaveLength(1)
    expect(sent[0].url).toBe(`${ENDPOINT}/v1/ingest`)
    const body = sent[0].body
    expect(body).toMatchObject({
      schema: 1,
      appVersion: '9.9.9',
      platform: 'win32',
      arch: 'x64',
      locale: 'zh-TW',
      sentAt: new Date(NOW).toISOString()
    })
    expect(body.installId).toBe(status.installId)
    expect(body.days).toHaveLength(14)
    const today = body.days.at(-1)!
    expect(today).toEqual({
      date: '2026-09-02',
      abandoned: 1,
      manual: 0,
      buckets: [
        {
          tier: 'clean',
          mode: 'ranked',
          myClass: 'witch',
          oppoClass: 'dragon',
          playOrder: 'first',
          result: 'win',
          count: 1
        }
      ]
    })
    expect(body.days.reduce((n, d) => n + d.buckets.length, 0)).toBe(1)

    expect(status.lastUploadAt).toBe(new Date(NOW).toISOString())
    expect(status.lastError).toBeNull()
  })

  it('never puts a note, deck, tag, timestamp or number in the payload', async () => {
    await insertMatch({
      result: true,
      play_order: 'first',
      my_class: 'witch',
      oppo_class: 'dragon',
      mode: 'ranked',
      current_cr: 1234,
      playedAt: new Date(NOW - 60_000)
    })
    await enableAndTell()
    await invoke('telemetry:uploadNow')
    const text = JSON.stringify(sent[0].body)
    for (const forbidden of ['note', 'deck', 'tag', 'playedAt', '1234', 'bp', 'cr']) {
      expect(text.toLowerCase()).not.toContain(`"${forbidden}"`)
    }
  })

  it('records an HTTP failure and a network failure without throwing', async () => {
    await enableAndTell()

    respond = () => new Response('nope', { status: 503 })
    let status = await invoke<TelemetryStatus>('telemetry:uploadNow')
    expect(status.lastError).toContain('503')
    expect(status.lastUploadAt).toBeNull()

    respond = () => {
      throw new TypeError('fetch failed')
    }
    status = await invoke<TelemetryStatus>('telemetry:uploadNow')
    expect(status.lastError).toContain('fetch failed')

    respond = okResponse
    status = await invoke<TelemetryStatus>('telemetry:uploadNow')
    expect(status.lastError).toBeNull()
    expect(status.lastUploadAt).not.toBeNull()
  })

  it('sends nothing when the build has no endpoint, even if enabled', async () => {
    telemetry.configureTelemetryForTests({
      now: () => NOW,
      endpoint: () => null,
      fetch: async () => {
        sent.push({ url: 'x', body: {} as TelemetryPayload })
        return okResponse()
      }
    })
    await invoke('telemetry:setEnabled', true)
    const status = await invoke<TelemetryStatus>('telemetry:uploadNow')
    expect(status.configured).toBe(false)
    expect(sent).toHaveLength(0)
  })

  it('collapses uploads closer together than the minimum gap unless forced', async () => {
    await enableAndTell()
    await telemetry.uploadNow()
    await telemetry.uploadNow()
    expect(sent).toHaveLength(1)
    await telemetry.uploadNow({ force: true })
    expect(sent).toHaveLength(2)
  })

  it('shows the notice once, and never once telemetry has been turned off', async () => {
    await invoke('telemetry:setEnabled', true)
    expect(await invoke<boolean>('telemetry:noticeDue')).toBe(true)
    expect(await invoke<boolean>('telemetry:noticeDue')).toBe(false)

    // Someone who found the switch first is not told it was turned on for them.
    storeMock.values.clear()
    await invoke('telemetry:setEnabled', false)
    expect(await invoke<boolean>('telemetry:noticeDue')).toBe(false)
  })

  it('does not show the notice when there is nowhere to send to', async () => {
    telemetry.configureTelemetryForTests({ now: () => NOW, endpoint: () => null })
    await invoke('telemetry:setEnabled', true)
    expect(await invoke<boolean>('telemetry:noticeDue')).toBe(false)
    // Not marked shown either: marking it here would let a later build with an
    // endpoint upload without ever having told anyone.
    expect(storeMock.values.get('telemetryPromptShown')).toBeUndefined()
  })
})

/**
 * The upload endpoint, and the one condition under which a development build
 * has none.
 *
 * This exists because the guard it covers is invisible: a dev build that keeps
 * uploading looks exactly like a dev build that does not. The only way anyone
 * notices the gate has regressed is by finding this machine's seeded matches
 * in the published aggregate — which is how the last one was found.
 *
 * Note what is deliberately NOT gated: `telemetryEndpoint()` itself. Reading
 * the published meta document uses the same origin, and breaking that would
 * make 環境 blank whenever the app runs from source.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const electronMock = vi.hoisted(() => ({ isPackaged: true }))
vi.mock('electron', () => ({ app: electronMock }))

const { telemetryEndpoint, telemetryUploadEndpoint } = await import('../../src/main/telemetry/config')

const PROD = 'https://telemetry.svwb-analyzer.workers.dev'

beforeEach(() => {
  electronMock.isPackaged = true
  delete process.env.SVWB_TELEMETRY_URL
})
afterEach(() => {
  delete process.env.SVWB_TELEMETRY_URL
})

describe('telemetryEndpoint', () => {
  it('is the built-in origin regardless of packaging — reads must keep working', () => {
    expect(telemetryEndpoint()).toBe(PROD)
    electronMock.isPackaged = false
    expect(telemetryEndpoint()).toBe(PROD)
  })

  it('refuses a plain-http override that is not local', () => {
    process.env.SVWB_TELEMETRY_URL = 'http://example.com'
    expect(telemetryEndpoint()).toBeNull()
  })

  it('allows http for a local dev server', () => {
    process.env.SVWB_TELEMETRY_URL = 'http://127.0.0.1:8787'
    expect(telemetryEndpoint()).toBe('http://127.0.0.1:8787')
  })
})

describe('telemetryUploadEndpoint', () => {
  it('is the built-in origin on a packaged build', () => {
    expect(telemetryUploadEndpoint()).toBe(PROD)
  })

  it('is null on an unpackaged build — this machine does not upload', () => {
    electronMock.isPackaged = false
    expect(telemetryUploadEndpoint()).toBeNull()
  })

  it('an explicit override re-enables it, because typing a URL is intent', () => {
    electronMock.isPackaged = false
    process.env.SVWB_TELEMETRY_URL = 'http://localhost:8787'
    expect(telemetryUploadEndpoint()).toBe('http://localhost:8787')
  })

  it('a blank override does not count as intent', () => {
    electronMock.isPackaged = false
    process.env.SVWB_TELEMETRY_URL = '   '
    expect(telemetryUploadEndpoint()).toBeNull()
  })
})

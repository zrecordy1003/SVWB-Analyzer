/**
 * The engine log's three ways of losing the evidence it exists to keep.
 *
 * This file is the record of a support case that could not be diagnosed at all:
 * a user whose recognition never started, whose window badge was green (that
 * badge reports the window scan, not the engine), and whose diagnostics export
 * was empty - because the engine's own explanation went to a `console` with no
 * terminal and no file behind it. So the value of this module is entirely in
 * whether a line survives to disk, and that is what is tested here.
 *
 * One case per way the line can be lost:
 *
 *  1. Written before the directory is known. The startup record is composed at
 *     the very beginning of `startEngine`, so a naive writer would drop exactly
 *     the lines that matter most.
 *  2. Rotation. The cap must move the old generation aside, not delete it -
 *     losing the startup record to a chatty session would reproduce the
 *     original bug at a delay.
 *  3. An unwritable directory. Logging is a diagnostic side effect and must
 *     never be able to take the app down; there is nowhere to report it to.
 *
 * The formatting is deliberately not asserted beyond the tag being findable:
 * the file is read by a human grepping for `[Engine]`, and pinning the exact
 * timestamp layout would only make it tedious to improve.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import fs from 'fs'
import os from 'os'
import path from 'path'

let dir: string

/** A fresh module instance, since the directory and buffer are module state. */
async function freshModule(): Promise<typeof import('../../src/main/recognition/runtimeLog')> {
  vi.resetModules()
  return import('../../src/main/recognition/runtimeLog')
}

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'svwb-runtime-log-'))
  // The writer mirrors to the console for a development run; the suite does not
  // need to see it.
  vi.spyOn(console, 'log').mockImplementation(() => {})
})

afterEach(() => {
  vi.restoreAllMocks()
  fs.rmSync(dir, { recursive: true, force: true })
})

describe('runtimeLog', () => {
  it('keeps lines written before the directory is known', async () => {
    const log = await freshModule()

    // The order `startEngine` really uses: the environment is described first,
    // and only then is there somewhere to put it.
    log.logRuntime('Startup', 'version=9.9.9 arch=x64')
    log.configureRuntimeLog(dir)
    log.logRuntime('Engine', 'spawned pid=4242')

    const written = fs.readFileSync(path.join(dir, log.RUNTIME_LOG_FILE), 'utf8')
    expect(written).toContain('version=9.9.9 arch=x64')
    expect(written).toContain('spawned pid=4242')
    // Held lines must come back in the order they were written, or the log
    // stops being a timeline.
    expect(written.indexOf('version=9.9.9')).toBeLessThan(written.indexOf('spawned'))
  })

  it('rotates the old generation aside instead of dropping it', async () => {
    const log = await freshModule()
    log.configureRuntimeLog(dir)

    const current = path.join(dir, log.RUNTIME_LOG_FILE)
    const previous = path.join(dir, log.RUNTIME_LOG_PREVIOUS_FILE)

    // Straight past the cap, so the next write has to rotate. Written through
    // the filesystem rather than the logger to keep the test fast.
    fs.writeFileSync(current, `${'x'.repeat(300 * 1024)}\n`)
    log.logRuntime('Engine', 'exited code=1 signal=none reachedReady=false')

    expect(fs.existsSync(previous)).toBe(true)
    expect(fs.readFileSync(previous, 'utf8')).toContain('x'.repeat(64))
    expect(fs.readFileSync(current, 'utf8')).toContain('exited code=1')
  })

  it('never throws when the directory cannot be written', async () => {
    const log = await freshModule()

    // A path whose parent is a FILE, so neither the mkdir nor the append can
    // succeed - the shape of the real failure, which is a locked or
    // permission-denied profile directory.
    const blocker = path.join(dir, 'not-a-directory')
    fs.writeFileSync(blocker, 'x')

    expect(() => log.configureRuntimeLog(path.join(blocker, 'diagnostics'))).not.toThrow()
    expect(() => log.logRuntime('Engine', 'spawned pid=1')).not.toThrow()
    expect(() => log.logRuntimeLines('Engine', 'a\nb\n')).not.toThrow()
  })

  it('splits a multi-line stderr chunk and drops the blank lines', async () => {
    const log = await freshModule()
    log.configureRuntimeLog(dir)

    // Exactly what arrives on the engine's stderr: one chunk, several lines, a
    // trailing newline. Each has to be findable on its own line by tag.
    log.logRuntimeLines('Engine', 'cannot start capture: attach failed\n\nbacktrace: none\n')

    const lines = fs
      .readFileSync(path.join(dir, log.RUNTIME_LOG_FILE), 'utf8')
      .split('\n')
      .filter(Boolean)
    expect(lines).toHaveLength(2)
    expect(lines[0]).toContain('[Engine] cannot start capture: attach failed')
    expect(lines[1]).toContain('[Engine] backtrace: none')
  })
})

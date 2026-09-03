/**
 * The real transport: an Electron `utilityProcess` running `src/dbworker`.
 *
 * Separate from `remoteDriver.ts` so the driver can be tested without
 * Electron, and separate from `client.ts` so the choice of transport is made
 * once, at startup, by the module that knows whether this is the app or a test.
 */
import { utilityProcess, type UtilityProcess } from 'electron'
import path from 'node:path'

import type { DbTransport, DbWorkerRequest, DbWorkerResponse } from './remoteDriver.js'

/**
 * Where the worker's bundle lands.
 *
 * `electron-vite` builds it alongside main (see the `dbworker` input in
 * `electron.vite.config.ts`), so it sits next to `out/main/index.js` in
 * development and inside the app bundle when packaged - the same directory
 * either way, which is why this needs no `app.isPackaged` branch unlike the
 * engine and the migrations.
 */
function workerPath(): string {
  return path.join(__dirname, 'dbworker.js')
}

export function createWorkerTransport(): DbTransport {
  const child: UtilityProcess = utilityProcess.fork(workerPath(), [], {
    // `better-sqlite3` is a native module, so the worker needs Node's require
    // and the app's own module paths.
    stdio: 'inherit',
    serviceName: 'svwb-db'
  })

  const listeners: ((response: DbWorkerResponse) => void)[] = []
  child.on('message', (data) => {
    for (const listener of listeners) listener(data as DbWorkerResponse)
  })
  /**
   * A worker that dies takes the database with it, and there is nothing
   * useful to do about it from here: every pending query rejects on its own
   * (the driver holds them), and the next one fails the same way. Logged
   * rather than restarted, because a silent restart would hide a repeatable
   * crash behind an intermittent one.
   */
  child.on('exit', (code) => console.error('[DB] worker exited:', code))

  return {
    send: (request: DbWorkerRequest) => child.postMessage(request),
    onMessage: (listener) => listeners.push(listener),
    dispose: () => {
      child.kill()
    }
  }
}

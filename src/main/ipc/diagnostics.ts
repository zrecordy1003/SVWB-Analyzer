/**
 * Lets the user see and hand over what the analyzer recorded about its own
 * recognition failures.
 *
 * Nothing here uploads anything: the export writes a zip to a location the user
 * picks, so handing it over stays an explicit act. The reading and packing logic
 * lives in `../diagnosticsBundle.js` so it can be tested outside Electron.
 */
import { app, dialog, ipcMain, shell } from 'electron'
import fs from 'fs'
import os from 'os'
import path from 'path'
import {
  buildBundle,
  clearStore,
  summarise,
  type BundleEnvironment,
  type DiagnosticsSummary
} from '../recognition/diagnosticsBundle.js'
import { getDiagnosticsDir } from '../paths.js'

function environment(): BundleEnvironment {
  return {
    appVersion: app.getVersion(),
    platform: process.platform,
    osRelease: os.release(),
    logicalCores: os.cpus().length
  }
}

const EMPTY: DiagnosticsSummary = { eventCount: 0, frameCount: 0, bytes: 0, latestAt: null }

export function registerDiagnosticsIpc(): void {
  ipcMain.handle('diagnostics:summary', async (): Promise<DiagnosticsSummary> => {
    try {
      return summarise(getDiagnosticsDir())
    } catch (e) {
      console.error('[Diag] summary failed:', e)
      return EMPTY
    }
  })

  ipcMain.handle('diagnostics:openFolder', async (): Promise<string> => {
    const dir = getDiagnosticsDir()
    const err = await shell.openPath(dir)
    if (err) console.warn('[Diag] cannot open folder:', err)
    return dir
  })

  ipcMain.handle('diagnostics:clear', async (): Promise<DiagnosticsSummary> => {
    const dir = getDiagnosticsDir()
    try {
      clearStore(dir)
    } catch (e) {
      console.error('[Diag] clear failed:', e)
    }
    return summarise(dir)
  })

  /** Resolves to the written path, or null if there was nothing to export or the user cancelled. */
  ipcMain.handle('diagnostics:export', async (): Promise<string | null> => {
    const dir = getDiagnosticsDir()
    const bundle = await buildBundle(dir, environment())
    if (!bundle) return null

    const stamp = new Date().toISOString().slice(0, 19).replace(/[:T]/g, '-')
    const { canceled, filePath } = await dialog.showSaveDialog({
      title: '匯出診斷包',
      defaultPath: path.join(app.getPath('downloads'), `svwb-diagnostics-${stamp}.zip`),
      filters: [{ name: 'Zip', extensions: ['zip'] }]
    })
    if (canceled || !filePath) return null

    fs.writeFileSync(filePath, bundle)
    return filePath
  })
}

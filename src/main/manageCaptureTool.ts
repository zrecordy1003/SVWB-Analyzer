import { app } from 'electron'
import { ChildProcess, spawn } from 'node:child_process'
import { existsSync, mkdirSync } from 'node:fs'
import path from 'node:path'
import treeKill from 'tree-kill'

export type CaptureEventName =
  | 'started'
  | 'frame_saved'
  | 'frame_error'
  | 'window_closed'
  | 'error'
  | 'exited'

export interface CaptureEvent {
  event: CaptureEventName
  message: string
  output?: string
  code?: number | null
  signal?: NodeJS.Signals | null
}

export interface CaptureOptions {
  hwnd: number
  outputPath?: string
  intervalMs?: number
  includeCursor?: boolean
  onEvent?: (event: CaptureEvent) => void
}

let captureProcess: ChildProcess | null = null
let startPromise: Promise<void> | null = null
let stopPromise: Promise<void> | null = null

function getExePath(): string {
  return app.isPackaged
    ? path.join(process.resourcesPath, 'tools', 'svwb-capture-tool.exe')
    : path.join(__dirname, '../../tools', 'svwb-capture-tool.exe')
}

function getCaptureDir(): string {
  const dir = path.join(app.getPath('userData'), 'capture')
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true })
  return dir
}

/** Dynamic capture output must never be written into the packaged resources directory. */
export function getCaptureImagePath(): string {
  return path.join(getCaptureDir(), 'svwb.png')
}

export function getCaptureTemporaryPath(): string {
  return `${getCaptureImagePath()}.tmp.png`
}

export function isCaptureRunning(): boolean {
  return captureProcess !== null && captureProcess.exitCode === null
}

function killCapture(): Promise<void> {
  const child = captureProcess
  if (!child?.pid) return Promise.resolve()

  return new Promise((resolve, reject) => {
    treeKill(child.pid!, 'SIGTERM', (error) => {
      if (captureProcess === child) captureProcess = null
      if (error) return reject(error)
      resolve()
    })
  })
}

function readCaptureEvents(
  stream: NodeJS.ReadableStream,
  onEvent?: CaptureOptions['onEvent']
): void {
  let buffered = ''
  stream.setEncoding('utf8')
  stream.on('data', (chunk: string) => {
    buffered += chunk
    const lines = buffered.split(/\r?\n/)
    buffered = lines.pop() ?? ''

    for (const line of lines) {
      if (!line.trim()) continue
      try {
        onEvent?.(JSON.parse(line) as CaptureEvent)
      } catch {
        console.log('[Capture]', line)
      }
    }
  })
}

function startCapture(options: CaptureOptions): Promise<void> {
  if (!Number.isSafeInteger(options.hwnd) || options.hwnd <= 0) {
    return Promise.reject(new Error(`Invalid capture HWND: ${options.hwnd}`))
  }

  const exePath = getExePath()
  const outputPath = options.outputPath ?? getCaptureImagePath()
  const args = [
    '--hwnd',
    String(options.hwnd),
    '--output',
    outputPath,
    '--interval-ms',
    String(options.intervalMs ?? 500)
  ]
  if (options.includeCursor) args.push('--include-cursor')

  const child = spawn(exePath, args, {
    cwd: path.dirname(exePath),
    detached: false,
    windowsHide: true,
    stdio: ['ignore', 'pipe', 'pipe']
  })
  captureProcess = child

  if (child.stdout) readCaptureEvents(child.stdout, options.onEvent)
  if (child.stderr) {
    child.stderr.setEncoding('utf8')
    child.stderr.on('data', (chunk: string) => console.warn('[Capture]', chunk.trim()))
  }

  return new Promise((resolve, reject) => {
    child.once('spawn', resolve)
    child.once('error', (error) => {
      if (captureProcess === child) captureProcess = null
      options.onEvent?.({ event: 'error', message: error.message, output: outputPath })
      reject(error)
    })
    child.once('exit', (code, signal) => {
      if (captureProcess === child) captureProcess = null
      options.onEvent?.({
        event: 'exited',
        message: 'capture helper exited',
        output: outputPath,
        code,
        signal
      })
    })
  })
}

/**
 * Starts at most one helper. Concurrent callers share the same pending start,
 * so polling, lifecycle, and IPC events cannot create competing writers.
 */
export function spawnCapture(options: CaptureOptions): Promise<void> {
  if (isCaptureRunning()) return Promise.resolve()
  if (startPromise) return startPromise

  const pending = startCapture(options)
  startPromise = pending
  void pending.then(
    () => {
      if (startPromise === pending) startPromise = null
    },
    () => {
      if (startPromise === pending) startPromise = null
    }
  )
  return pending
}

/** Stops only the helper owned by this application process. */
export async function stopCapture(): Promise<void> {
  if (stopPromise) return stopPromise

  const pending = (async () => {
    try {
      await startPromise
    } catch {
      // A failed start has already released ownership.
    }
    await killCapture()
  })()
  stopPromise = pending

  try {
    await pending
  } catch (error) {
    console.error('[Capture] failed to stop helper:', error)
  } finally {
    if (stopPromise === pending) stopPromise = null
  }
}

import { app } from 'electron'
import { ChildProcess, exec, spawn } from 'node:child_process'
import path from 'node:path'
import treeKill from 'tree-kill'
import { promisify } from 'node:util'

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

const execAsync = promisify(exec)

function getExePath(): string {
  return app.isPackaged
    ? path.join(process.resourcesPath, 'tools', 'svwb-capture-tool.exe')
    : path.join(__dirname, '../../tools', 'svwb-capture-tool.exe')
}

export function getCaptureImagePath(): string {
  return app.isPackaged
    ? path.join(process.resourcesPath, 'tools', 'svwb.png')
    : path.join(__dirname, '../../tools', 'svwb.png')
}

export function getCaptureTemporaryPath(): string {
  return `${getCaptureImagePath()}.tmp.png`
}

export function isCaptureRunning(): boolean {
  return captureProcess !== null && captureProcess.exitCode === null
}

/** Kill stale capture helpers left behind by an earlier application process. */
async function killStaleCaptureProcesses(): Promise<void> {
  try {
    const { stdout } = await execAsync(
      'tasklist /FI "IMAGENAME eq svwb-capture-tool.exe" /FO CSV /NH'
    )
    const hasStaleProcess = stdout
      .trim()
      .split(/\r?\n/)
      .some((line) => line.toLowerCase().startsWith('"svwb-capture-tool.exe"'))

    if (hasStaleProcess) {
      await execAsync('taskkill /F /T /IM svwb-capture-tool.exe')
    }
  } catch (error) {
    // tasklist returns localized informational output when no matching process exists.
    console.warn('[Capture] unable to check stale capture helpers:', error)
  }
}

function killCapture(): Promise<void> {
  return new Promise((resolve, reject) => {
    if (!captureProcess?.pid) return resolve()
    treeKill(captureProcess.pid, 'SIGTERM', (error) => {
      if (error) return reject(error)
      captureProcess = null
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
        const event = JSON.parse(line) as CaptureEvent
        onEvent?.(event)
      } catch {
        console.log('[Capture]', line)
      }
    }
  })
}

/**
 * Start the Windows-native capture helper. The helper receives a process-verified
 * HWND, which avoids fragile lookup by a localized window title.
 */
export async function spawnCapture(options: CaptureOptions): Promise<void> {
  if (!Number.isSafeInteger(options.hwnd) || options.hwnd <= 0) {
    throw new Error(`Invalid capture HWND: ${options.hwnd}`)
  }

  if (isCaptureRunning()) await killCapture()
  await killStaleCaptureProcesses()

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

  child.once('error', (error) => {
    if (captureProcess === child) captureProcess = null
    options.onEvent?.({ event: 'error', message: error.message, output: outputPath })
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
}

export async function stopCapture(): Promise<void> {
  try {
    await killCapture()
  } catch (error) {
    console.error('[Capture] failed to stop helper:', error)
  }
}

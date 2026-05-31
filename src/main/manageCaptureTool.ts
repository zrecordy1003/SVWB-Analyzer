import { app } from 'electron'
import { exec, spawn, ChildProcess } from 'child_process'
import path from 'path'
import { copyFileSync, existsSync, statSync } from 'fs'
import treeKill from 'tree-kill'
import { promisify } from 'util'
import { getCaptureDir, getRuntimeToolsDir } from './paths.js'

let captureProcess: ChildProcess | null = null

function getBundledExePath(): string {
  return app.isPackaged
    ? path.join(process.resourcesPath, 'tools', 'svwb-capture-tool.exe')
    : path.join(__dirname, '../../tools', 'svwb-capture-tool.exe')
}

function getRunnableExePath(): string {
  const sourcePath = getBundledExePath()
  const targetPath = path.join(getRuntimeToolsDir(), 'svwb-capture-tool.exe')
  const shouldCopy =
    !existsSync(targetPath) ||
    statSync(sourcePath).size !== statSync(targetPath).size ||
    statSync(sourcePath).mtimeMs > statSync(targetPath).mtimeMs

  if (shouldCopy) copyFileSync(sourcePath, targetPath)
  return targetPath
}

const execAsync = promisify(exec)

/**
 * 檢查 svwb-capture-tool.exe 是否在執行，
 * 如果有就強制殺掉所有實例。
 */
async function checkCapture(exePath: string): Promise<void> {
  try {
    const escapedPath = exePath.replace(/'/g, "''")
    await execAsync(
      `powershell -NoProfile -Command "$target='${escapedPath}'; ` +
        `Get-CimInstance Win32_Process | ` +
        `Where-Object { $_.Name -eq 'svwb-capture-tool.exe' -and $_.ExecutablePath -eq $target } | ` +
        `ForEach-Object { Stop-Process -Id $_.ProcessId -Force }"`
    )
    console.log('Checked capture tool process for current runtime path.')
  } catch (err) {
    console.error('Error checking/killing capture tool:', err)
  }
}

function killCapture(): Promise<void> {
  return new Promise((resolve, reject) => {
    if (!captureProcess?.pid) return resolve()
    treeKill(captureProcess.pid, 'SIGTERM', (err) => {
      if (err) return reject(err)
      captureProcess = null
      resolve()
    })
  })
}

/**
 * 啟動擷取工具
 */
export async function spawnCapture(isFirst: boolean): Promise<void> {
  const exePath = getRunnableExePath()

  if (isFirst) {
    await killCapture().catch((err) => {
      console.error('Failed to kill existing capture process:', err)
    })

    await checkCapture(exePath).catch((err) => {
      console.error('Failed to kill existing capture process:', err)
    })
  }

  const captureDir = getCaptureDir()
  captureProcess = spawn(
    exePath,
    [], // 不需再傳任何參數
    {
      cwd: captureDir,
      detached: true,
      windowsHide: true,
      stdio: 'ignore'
    }
  )
  captureProcess.unref()

  captureProcess.on('exit', (code, signal) => {
    console.log(`Capture exited (code=${code}, signal=${signal})`)
    captureProcess = null
  })

  console.log(`Spawned capture tool (pid=${captureProcess.pid})`)
}

/**
 * 停止擷取工具
 */
export async function stopCapture(): Promise<void> {
  await killCapture()
    .then(() => console.log('Stopped capture'))
    .catch((err) => console.error('Error stopping capture:', err))
}

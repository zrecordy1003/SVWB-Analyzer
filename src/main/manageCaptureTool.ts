import { app } from 'electron'
import { exec, spawn, ChildProcess } from 'child_process'
import path from 'path'
import treeKill from 'tree-kill'
import { promisify } from 'util'

let captureProcess: ChildProcess | null = null

function getExePath(): string {
  return app.isPackaged
    ? path.join(process.resourcesPath, 'tools', 'svwb-capture-tool.exe')
    : path.join(__dirname, '../../tools', 'svwb-capture-tool.exe')
}

const execAsync = promisify(exec)

/**
 * 檢查 svwb-capture-tool.exe 是否在執行，
 * 如果有就強制殺掉所有實例。
 */
async function checkCapture(): Promise<void> {
  try {
    // /NH 不印表頭，篩選映像檔名稱 eq
    const { stdout } = await execAsync('tasklist /FI "IMAGENAME eq svwb-capture-tool.exe" /NH')

    // 如果有任何非空輸出就表示至少有一個在跑
    if (stdout.trim()) {
      console.log('svwb-capture-tool.exe is running, terminating...')
      // /F 強制，/T 同時結束子程序
      await execAsync('taskkill /F /T /IM svwb-capture-tool.exe')
      console.log('All svwb-capture-tool.exe processes have been terminated.')
    } else {
      console.log('svwb-capture-tool.exe is not running.')
    }
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
  if (isFirst) {
    await killCapture().catch((err) => {
      console.error('Failed to kill existing capture process:', err)
    })

    await checkCapture().catch((err) => {
      console.error('Failed to kill existing capture process:', err)
    })
  }

  const exePath = getExePath()
  captureProcess = spawn(
    exePath,
    [], // 不需再傳任何參數
    {
      cwd: path.dirname(exePath),
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

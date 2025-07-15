import { spawn } from 'child_process'
import path from 'path'

let captureProcess: ReturnType<typeof spawn> | null = null

export function spawnCapture(interval: number): void {
  if (captureProcess) {
    const killer = spawn('taskkill', ['/IM', 'svwb-capture-tool.exe', '/F', '/T'], {
      shell: true,
      stdio: 'ignore'
    })
    killer.on('exit', () => {
      doSpawn(interval)
    })
    captureProcess = null
  } else {
    doSpawn(interval)
  }
}

function doSpawn(interval: number): void {
  const exePath = path.join(__dirname, '../../resources', 'svwb-capture-tool.exe')
  captureProcess = spawn(
    exePath,
    ['--interval', interval.toString(), '--output-pattern', `svwb-${interval}.png`],
    { cwd: path.dirname(exePath) }
  )
  console.log(`Spawned capture (pid=${captureProcess.pid})`)
}

export function stopCapture(): void {
  if (!captureProcess) return
  if (captureProcess) {
    spawn('taskkill', ['/IM', 'svwb-capture-tool.exe', '/F', '/T'], { shell: true })
    captureProcess = null
    console.log('Stopped capture')
  }
}

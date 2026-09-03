import { useEffect, useState } from 'react'

interface bounds {
  x?: number
  y?: number
  width?: number
  height?: number
}

interface svwbStatus {
  running: boolean
  hwnd: number | null
  bounds?: bounds
  /**
   * Whether the recognition engine reported itself ready.
   *
   * Separate from `running`, which only says the game window was found - a
   * check that happens in the main process and knows nothing about the engine.
   */
  engineReady?: boolean
  /** True only after the engine has decoded a frame from the current capture. */
  capturing?: boolean
}

export const useSvwbStatus = (): svwbStatus | undefined => {
  const [running, setRunning] = useState<svwbStatus>()

  useEffect(() => {
    const unsubStatus = window.electron?.ipcRenderer.on('svwb:status', (_event, status) => {
      setRunning(status)
    })
    const unsubCapture = window.electron?.ipcRenderer.on(
      'capture:status',
      (_event, capturing: boolean) => {
        setRunning((current) => (current ? { ...current, capturing } : current))
      }
    )

    return () => {
      unsubStatus()
      unsubCapture()
    }
  }, [])

  return running
}

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
}

export const useSvwbStatus = (): svwbStatus | undefined => {
  const [running, setRunning] = useState<svwbStatus>()

  useEffect(() => {
    const unsubStatus = window.electron?.ipcRenderer.on('svwb:status', (_event, status) => {
      setRunning(status)
    })

    return () => {
      unsubStatus()
    }
  }, [])

  return running
}

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

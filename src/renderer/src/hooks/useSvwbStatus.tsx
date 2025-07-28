import { useEffect, useState } from 'react'

interface bound {
  x?: number
  y?: number
  width?: number
  height?: number
}

interface svwbStatus {
  running: boolean
  hwnd: number | null
  bound?: bound
}

export const useSvwbStatus = (): svwbStatus | undefined => {
  const [running, setRunning] = useState<svwbStatus>()

  useEffect(() => {
    const unsubStatus = window.electron.ipcRenderer.on('svwb:status', (_event, status) => {
      setRunning(status)
    })

    return () => {
      unsubStatus()
    }
  }, [])

  return running
}

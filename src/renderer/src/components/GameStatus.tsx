import { useEffect, useState } from 'react'

import { useSvwbStatus } from '../hooks/useSvwbStatus'
import { Box } from '@mui/material'

const GameStatus = (): React.JSX.Element => {
  const svwbStatus = useSvwbStatus()
  const isRunning = svwbStatus?.running
  const [isCapturing, setIsCapturing] = useState<boolean>(false)

  const isMinimized =
    svwbStatus?.bound && svwbStatus.bound.x === -32000 && svwbStatus.bound.y === -32000

  useEffect(() => {
    const unsubCaptureStatus = window.electron.ipcRenderer.on(
      'capture:status',
      (_e, data: boolean) => setIsCapturing(data)
    )
    return () => {
      unsubCaptureStatus()
    }
  }, [])

  return (
    <div style={{ display: 'flex', flexDirection: 'column', width: '70vw' }}>
      <div>
        {isMinimized ? (
          <Box sx={{ color: 'red' }}>遊戲以最小化執行中，擷取已暫停</Box>
        ) : (
          <Box display={'flex'} flexDirection={'column'}>
            <span style={{ color: isRunning ? 'green' : 'red' }}>
              {isRunning ? '遊戲正在執行中' : '未偵測到遊戲'}
            </span>
            {/* <span>{isCapturing ? '擷取進行中' : '擷取已暫停'}</span> */}
          </Box>
        )}
        {/* <Button variant="outlined" color="error" onClick={stopCapture}>
          停止擷取
        </Button> */}
      </div>

      {/* <span style={{ color: 'coral' }}>
        {svwbStatus?.bound ? JSON.stringify(svwbStatus.bound) : 'bound'}
      </span> */}
    </div>
  )
}

export default GameStatus

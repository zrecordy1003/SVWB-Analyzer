import { useEffect, useState } from 'react'
import { classes } from '@renderer/map/classMap'
import { Box, Button } from '@mui/material'

interface Class {
  id: number
  name: string
  label: string
  code: string
  src: string
}

interface BattleState {
  inBattle: boolean
  ownClass: string | null
  enemyClass: string | null
  playOrder: string | null
}

const Analyzer = (): React.JSX.Element => {
  const [isRecognizing, setIsRecognizing] = useState<boolean>(false)
  const [battleState, setBattleState] = useState<BattleState>({
    inBattle: false,
    ownClass: null,
    enemyClass: null,
    playOrder: null
  })

  const [classAssets, setClassAssets] = useState<Record<string, Class>>({})

  useEffect(() => {
    const unsubStatus = window.electron.ipcRenderer.on('battle:status', (_e, msg: BattleState) => {
      setBattleState(msg)
      const matchedClasss = classes.filter(
        (Class) => Class.name === msg.ownClass || Class.name === msg.enemyClass
      )
      const ClasssByName = Object.fromEntries(matchedClasss.map((Class) => [Class.name, Class]))
      setClassAssets(ClasssByName)
      setIsRecognizing(true)
    })

    return () => {
      unsubStatus()
    }
  }, [])

  return (
    <Box marginTop={1}>
      <Box display={'flex'} gap={2}>
        <Button
          variant="contained"
          color="success"
          // onClick={() => analyze()}
          disabled={isRecognizing}
        >
          {isRecognizing ? '分析中' : '未在分析...'}
        </Button>
        <Button variant="contained" color="success" onClick={() => console.log(battleState)}>
          got state
        </Button>
        <Button variant="contained" color="success" onClick={() => console.log(classAssets)}>
          got statessss
        </Button>
      </Box>
      {isRecognizing ? (
        battleState.inBattle ? (
          <div>
            <h2>🟢 對戰中</h2>
            <div>
              <p>
                我方職業：<strong>{battleState.ownClass}</strong>
              </p>
            </div>
            {battleState.ownClass && (
              <div>
                {/* <img
                src={ClassAssets[battleState.ownClass].src}
                style={{
                  width: '100px',
                  height: '100px',
                  borderRadius: '5px',
                  // cursor: 'pointer',
                  objectFit: 'cover',
                  objectPosition: 'top top',
                  transition: 'border 0.1s'
                }}
              /> */}
              </div>
            )}
            <p>
              先攻 / 後攻：<strong>{battleState.playOrder === 'first' ? '先攻' : '後攻'}</strong>
            </p>
            <p>
              對方職業： <strong>{battleState.enemyClass}</strong>
            </p>
            {battleState.enemyClass && (
              <div>
                {/* <img
                src={ClassAssets[battleState.enemyClass].src}
                style={{
                  width: '100px',
                  height: '100px',
                  borderRadius: '5px',
                  // cursor: 'pointer',
                  objectFit: 'cover',
                  objectPosition: 'top top',
                  transition: 'border 0.1s'
                }}
              /> */}
              </div>
            )}
          </div>
        ) : (
          <div>
            <h2>🔴 尚未進入對戰</h2>
          </div>
        )
      ) : (
        <Box>尚未開始辨識</Box>
      )}
    </Box>
  )
}

export default Analyzer

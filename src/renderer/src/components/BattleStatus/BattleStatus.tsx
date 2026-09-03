import React, { useEffect, useState } from 'react'
import ClassIcon from '@renderer/components/Common/ClassIcon'
import { classesMap, classTextSx } from '@renderer/map/classMap'
import { Box, Typography, Stack, Chip } from '@mui/material'

import CenterFocusStrongIcon from '@mui/icons-material/CenterFocusStrong'
import SearchOffOutlinedIcon from '@mui/icons-material/SearchOffOutlined'

interface BattleState {
  inBattle: boolean
  ownClass: string | null
  enemyClass: string | null
  playOrder: string | null
}

// interface StatusHeaderProps {
//   inBattle: boolean
//   recognizing: boolean
// }

const BattleStatus = (): React.JSX.Element => {
  const [isRecognizing, setIsRecognizing] = useState<boolean>(false)
  const [battleState, setBattleState] = useState<BattleState>({
    inBattle: false,
    ownClass: null,
    enemyClass: null,
    playOrder: null
  })

  const rippleSx = {
    position: 'relative',
    '&::before': {
      content: '""',
      position: 'absolute',
      inset: -6,
      borderRadius: '50%',
      border: '2px solid rgba(76,175,80,0.35)', // 可換主題色
      animation: 'ripple 1.8s infinite ease-out'
    },
    '@keyframes ripple': {
      '0%': { transform: 'scale(0.85)', opacity: 0.8 },
      // '0%': { transform: 'scale(1)', opacity: 0.15 },
      '100%': { transform: 'scale(1.2)', opacity: 0 }
    }
  }

  // const pulseSx = {
  //   animation: 'pulse 6s infinite',
  //   '@keyframes pulse': {
  //     '0%': { transform: 'scale(1)', filter: 'drop-shadow(0 0 0px rgba(255,255,255,0))' },
  //     '50%': { transform: 'scale(1.06)', filter: 'drop-shadow(0 0 6px rgba(255,255,255,0.35))' },
  //     '100%': { transform: 'scale(1)', filter: 'drop-shadow(0 0 0px rgba(255,255,255,0))' }
  //   }
  // }

  useEffect(() => {
    const unsubBattleInfo = window.electron?.ipcRenderer.on(
      'battle:status',
      (_e, msg: BattleState) => {
        setBattleState(msg)
      }
    )

    /**
     * Whether recognition is running is `gameStatus.capturing`, and it arrives
     * on `game:status` - the broadcast that only fires on a change. There used
     * to be a `battle:recog` message carrying the same boolean on every
     * one-second poll; it was deleted, not replaced.
     *
     * The catch-up matters because of that change gating: this component can
     * mount well after the last transition (a reload, or the user opening this
     * page later), so it asks once for the current value instead of waiting
     * for the game's next state change.
     */
    const unsubGameStatus = window.electron?.ipcRenderer.on(
      'game:status',
      (_e, status: { capturing?: boolean } | null) => {
        setIsRecognizing(!!status?.capturing)
      }
    )
    void window.electron?.ipcRenderer
      .invoke('game:getStatus')
      .then((status: { capturing?: boolean } | null) => setIsRecognizing(!!status?.capturing))
      .catch(() => setIsRecognizing(false))

    return () => {
      unsubBattleInfo()
      unsubGameStatus()
    }
  }, [])

  useEffect(() => {
    if (isRecognizing) {
      window.electron?.ipcRenderer.invoke('battle:getStatus').then((state: BattleState) => {
        setBattleState(state)
      })
    }
  }, [isRecognizing])

  // const StatusHeader: React.FC<StatusHeaderProps> = ({
  //   inBattle,
  //   recognizing
  // }: StatusHeaderProps) => {
  //   if (recognizing === false) {
  //     return (
  //       <Stack direction="row" spacing={1.5} alignItems="center">
  //         <PauseCircle fontSize="large" />
  //         <Typography variant="h6">辨識暫停</Typography>
  //       </Stack>
  //     )
  //   }

  //   if (!inBattle) {
  //     return (
  //       <Stack direction="row" spacing={1.5} alignItems="center">
  //         <Typography variant="h6">偵測中</Typography>
  //         <Box sx={rippleSx}>
  //           <Radar fontSize="large" />
  //         </Box>
  //       </Stack>
  //     )
  //   }

  //   return (
  //     // <Stack direction="row" spacing={1.5} alignItems="center">
  //     //   <Box>
  //     //     <SportsEsportsOutlinedIcon fontSize="large" />
  //     //   </Box>
  //     //   <Typography variant="h6">對戰進行中</Typography>
  //     // </Stack>
  //     <></>
  //   )
  // }

  const renderBattleInfo = (): React.JSX.Element => {
    if (isRecognizing === false) {
      return (
        <Stack direction="row" spacing={1} alignItems="center" height={'3rem'}>
          <Box display={'flex'}>
            <SearchOffOutlinedIcon fontSize="large" color="error" sx={{ opacity: 0.9 }} />
          </Box>
          <Typography variant="h6" sx={{ color: 'grey.500', fontWeight: 600 }}>
            偵測暫停中
          </Typography>
        </Stack>
      )
    }

    if (isRecognizing === true && !battleState.inBattle) {
      return (
        <Stack direction="row" spacing={1} alignItems="center" height={'3rem'}>
          <Box sx={rippleSx} display={'flex'}>
            <CenterFocusStrongIcon fontSize="large" />
          </Box>
          <Typography variant="h6">偵測中</Typography>
        </Stack>
      )
    }

    const TurnOrder = ({ order }: { order: 'first' | 'second' }): React.JSX.Element => {
      return (
        <Box
          position={'absolute'}
          sx={{ transform: 'translateX(109px) translateY(8px)', zIndex: 10 }}
        >
          {/* <Typography variant="caption" color="text.secondary">
            順序
          </Typography> */}
          {order === 'first' ? (
            <Chip
              sx={{ p: 1 }}
              variant="filled"
              label="先攻"
              // color="info"
            />
          ) : (
            // <Typography>我方先攻</Typography>
            <Chip
              sx={{ p: 1 }}
              variant="filled"
              label="後攻"
              // color="info"
            />
            // <Typography>我方後攻</Typography>
          )}
        </Box>
      )
    }

    return (
      <Box>
        {battleState.inBattle && (
          <Box
            display="flex"
            // flexDirection="column"
            alignItems="center"
            justifyContent="center"
            // mt={1}
            gap={2}
          >
            {/* <StatusHeader inBattle={battleState.inBattle} recognizing={isRecognizing} /> */}
            <Box display="flex">
              <Box
                position={'relative'}
                display={'flex'}
                justifyContent={'center'}
                alignItems={'center'}
                width={'150px'}
                height={'50px'}
                bgcolor={battleState.ownClass ? classesMap[battleState.ownClass]?.bgColor : 'null'}
                sx={{
                  clipPath: 'polygon(0 0, 100% 0, 75% 100%, 0% 100%)',
                  borderRadius: '5px'
                }}
              >
                {/* 這兩塊是整個畫面上職業最該被一眼認出來的地方，也是唯一一次
                    只會出現一兩個徽章的地方，所以尺寸放到 34 - 深色底上不靠底板
                    就夠亮。斜切的 clipPath 會吃掉右緣，所以徽章和字一起靠左推。 */}
                <Box display="flex" alignItems="center" gap={1} marginRight={'15px'}>
                  <ClassIcon id={battleState.ownClass} size={34} />
                  <Typography variant="h6" sx={classTextSx(battleState.ownClass)}>
                    {battleState.ownClass ? (classesMap[battleState.ownClass]?.label ?? '') : null}
                  </Typography>
                </Box>
              </Box>

              <TurnOrder order={battleState.playOrder === 'first' ? 'first' : 'second'} />

              <Box
                display={'flex'}
                justifyContent={'center'}
                alignItems={'center'}
                width={'150px'}
                height={'50px'}
                bgcolor={
                  battleState.enemyClass ? classesMap[battleState.enemyClass]?.bgColor : 'null'
                }
                sx={{
                  clipPath: 'polygon(25% 0, 100% 0, 100% 100%, 0% 100%)',
                  ml: '-30px',
                  borderRadius: '5px'
                }}
              >
                <Box display="flex" alignItems="center" gap={1} marginLeft={'15px'}>
                  <ClassIcon id={battleState.enemyClass} size={34} />
                  <Typography variant="h6" sx={classTextSx(battleState.enemyClass)}>
                    {battleState.enemyClass
                      ? (classesMap[battleState.enemyClass]?.label ?? '')
                      : null}
                  </Typography>
                </Box>
              </Box>
            </Box>
          </Box>
        )}
      </Box>
    )
  }

  // const classNames = ['elf', 'royal', 'witch', 'dragon', 'bishop', 'nightmare', 'nemesis']
  // const playOrders = ['first', 'second']

  return (
    <Box mb={2}>
      {/* <Stack direction="row" spacing={2} mb={2}>
        <Button
          variant="contained"
          color="primary"
          onClick={() => {
            // 隨機選自己和對手（不重複）
            const ownClass = classNames[Math.floor(Math.random() * classNames.length)]
            const enemyClass = classNames[Math.floor(Math.random() * classNames.length)]

            // 隨機選先攻後攻
            const playOrder = playOrders[Math.floor(Math.random() * playOrders.length)]

            setBattleState({
              inBattle: true,
              ownClass,
              enemyClass,
              playOrder
            })
          }}
        >
          隨機測試資料
        </Button>
        <Button
          variant="contained"
          color="primary"
          onClick={() =>
            setBattleState({
              inBattle: true,
              ownClass: 'elf',
              enemyClass: 'nemesis',
              playOrder: 'first'
            })
          }
        >
          測試資料
        </Button>
        <Button
          variant="outlined"
          color="secondary"
          onClick={() =>
            setBattleState({
              inBattle: false,
              ownClass: null,
              enemyClass: null,
              playOrder: null
            })
          }
        >
          清空資料
        </Button>

        <Button variant="outlined" color="secondary" onClick={() => setIsRecognizing(true)}>
          開始辨識
        </Button>
        <Button variant="outlined" color="secondary" onClick={() => setIsRecognizing(false)}>
          暫停辨識
        </Button>
      </Stack> */}

      {renderBattleInfo()}
    </Box>
  )
}

export default React.memo(BattleStatus)

import { useEffect, useState } from 'react'
import { roles } from '@renderer/map/roleMap'

interface Role {
  id: number
  name: string
  label: string
  code: string
  src: string
}

interface BattleState {
  inBattle: boolean
  ownRole: string | null
  enemyRole: string | null
  playOrder: string | null
}

const Analyzer = (): React.JSX.Element => {
  const [battleState, setBattleState] = useState<BattleState>({
    inBattle: false,
    ownRole: null,
    enemyRole: null,
    playOrder: null
  })

  const [roleAssets, setRoleAssets] = useState<Record<string, Role>>({})

  useEffect(() => {
    window.electron.ipcRenderer.on('battle:status', (_e, msg) => {
      setBattleState(msg)
      const matchedRoles = roles.filter(
        (role) => role.name === msg.ownRole || role.name === msg.enemyRole
      )
      const rolesByName = Object.fromEntries(matchedRoles.map((role) => [role.name, role]))
      setRoleAssets(rolesByName)
    })

    return () => {
      window.electron.ipcRenderer.removeAllListeners('battle:status')
    }
  }, [])

  const analyze = (): void => {
    window.electron.ipcRenderer.send('analyze-image')
  }

  return (
    <div style={{ padding: 16 }}>
      <button onClick={() => analyze()}>start analyze</button>
      <button onClick={() => console.log(JSON.stringify(battleState))}>got state</button>
      <button onClick={() => console.log(JSON.stringify(roleAssets))}>got statessss</button>
      {battleState.inBattle ? (
        <div>
          <h2>🟢 對戰中</h2>
          <div>
            <p>
              我方職業：<strong>{battleState.ownRole}</strong>
            </p>
          </div>
          {battleState.ownRole && (
            <div>
              <img src={roleAssets[battleState.ownRole].src} />
            </div>
          )}
          <p>
            先手 / 後手：<strong>{battleState.playOrder === 'first' ? '先手' : '後手'}</strong>
          </p>
          <p>
            對方職業： <strong>{battleState.enemyRole}</strong>
          </p>
        </div>
      ) : (
        <div>
          <h2>🔴 尚未進入對戰</h2>
        </div>
      )}
    </div>
  )
}

export default Analyzer

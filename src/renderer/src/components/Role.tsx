import { CSSProperties, useEffect, useState } from 'react'

import Lovesign from '../../../../resources/character/Lovesign.png'
import MarieMalisse from '../../../../resources/character/MarieMalisse.png'
import KaoriYuihara from '../../../../resources/character/KaoriYuihara.png'
import Galan from '../../../../resources/character/Galan.png'
import Esperanza from '../../../../resources/character/Esperanza.png'
import Diawl from '../../../../resources/character/Diawl.png'
import Dreizehn from '../../../../resources/character/Dreizehn.png'

import { useSvwbStatus } from '../hooks/useSvwbStatus'

const Role = (): React.JSX.Element => {
  const running = useSvwbStatus()

  const [role, setRole] = useState()
  const [roleList, setRoleList] = useState([])

  const [captureFreq, setCaptureFreq] = useState(1)

  useEffect(() => {
    window.electron.ipcRenderer.send('start-capture', captureFreq)
    window.electron.ipcRenderer.on('frame', (_event, frame) => {
      console.log('[frame]', frame)
    })

    return () => {
      window.electron.ipcRenderer.removeAllListeners('frame')
    }
  }, [])

  const ROLES = [
    { id: 1, label: '妖精', code: 'Digit1', src: Lovesign },
    { id: 2, label: '皇家', code: 'Digit2', src: MarieMalisse },
    { id: 3, label: '巫師', code: 'Digit3', src: KaoriYuihara },
    { id: 4, label: '龍族', code: 'Digit4', src: Galan },
    { id: 5, label: '主教', code: 'Digit5', src: Esperanza },
    { id: 6, label: '夜魔', code: 'Digit6', src: Diawl },
    { id: 7, label: '復仇', code: 'Digit7', src: Dreizehn }
  ]

  type Deck = {
    id: number
    name: string
    class: string
    // Add other properties as needed
  }

  const startCapture = (interval: number): void => {
    window.electron.ipcRenderer.send('start-capture', interval)
  }

  const stopCapture = (): void => {
    window.electron.ipcRenderer.send('stop-capture')
  }

  const useDeckApi = (): {
    getAll: () => Promise<Deck[]>
    add: (n: string, c: string) => Promise<Deck>
  } => ({
    getAll: () => window.electron.ipcRenderer.invoke('decks:getAll'),
    add: (n: string, c: string) => window.electron.ipcRenderer.invoke('decks:add', n, c)
  })

  const { getAll, add } = useDeckApi()

  useEffect(() => {
    document.addEventListener('keydown', KeyDown, false)
    return () => {
      document.removeEventListener('keydown', KeyDown, false)
    }
  }, [roleList])

  const updateRole = (roleParam): void => {
    setRole(roleParam)
    // setRoleList((prev) => [...prev, roleParam])
  }

  const KeyDown = (e: KeyboardEvent): void => {
    if (e.code === 'Digit1') updateRole(1)
    if (e.code === 'Digit2') updateRole(2)
    if (e.code === 'Digit3') updateRole(3)
    if (e.code === 'Digit4') updateRole(4)
    if (e.code === 'Digit5') updateRole(5)
    if (e.code === 'Digit6') updateRole(6)
    if (e.code === 'Digit7') updateRole(7)
    if (e.code === 'Escape') updateRole(0)
    if (e.code === 'Backspace' && roleList.length > 0) {
      setRoleList((prev) => prev.slice(0, -1))
      return
    }
  }

  const roleStyle: CSSProperties = {
    display: 'flex',
    justifyContent: 'center',
    alignItems: 'center',
    width: '50px',
    height: '50px',
    border: '1px solid pink',
    borderRadius: '5px',
    transition: 'background-color 0.3s',
    cursor: 'pointer'
  }

  const deckStyle: CSSProperties = {
    width: '20%',
    height: '100px',
    backgroundColor: 'darkcyan'
  }

  return (
    <div style={{ display: 'flex', flexDirection: 'column', width: '70vw' }}>
      <span>{JSON.stringify(captureFreq)}</span>
      <div>
        <h1>截圖頻率(秒)</h1>
        <button onClick={() => stopCapture()}>stop it!</button>
        <select
          value={captureFreq}
          onChange={(e) => {
            setCaptureFreq(Number(e.target.value))
            startCapture(Number(e.target.value))
          }}
        >
          <option value={1}>1</option>
          <option value={3}>3</option>
          <option value={5}>5</option>
        </select>
      </div>
      <span style={{ color: 'red' }}>{running?.running ? '遊戲正在執行中' : '未偵測到遊戲'}</span>
      <span style={{ color: 'cyan' }}>
        {running?.hwnd ? running?.hwnd : '執行遊戲後將顯示hwnd'}
      </span>
      <span style={{ color: 'coral' }}>
        {running?.bound ? JSON.stringify(running?.bound) : 'bound'}
      </span>
      <button
        onClick={async () => {
          const decks = await getAll()
          console.log(decks)
        }}
      >
        ss
      </button>
      <div style={{ display: 'flex', gap: '5px', flexWrap: 'wrap' }}>
        {ROLES.map((roleItem) => (
          <img
            key={roleItem.id}
            src={roleItem.src}
            alt={roleItem.label}
            title={roleItem.label}
            onClick={() => updateRole(roleItem.id)}
            style={{
              width: '100px',
              height: '100px',
              border: role === roleItem.id ? '3px solid blue' : '1px solid transparent',
              borderRadius: '5px',
              cursor: 'pointer',
              objectFit: 'cover',
              objectPosition: 'top top',
              transition: 'border 0.1s'
            }}
          />
        ))}
      </div>

      <div style={{ display: 'flex', gap: '5px' }}>
        <div
          style={{ ...roleStyle, backgroundColor: role === 1 ? 'blue' : 'transparent' }}
          onClick={() => updateRole(1)}
        >
          妖精
        </div>
        <div
          style={{ ...roleStyle, backgroundColor: role === 2 ? 'blue' : 'transparent' }}
          onClick={() => updateRole(2)}
        >
          皇家
        </div>
        <div
          style={{ ...roleStyle, backgroundColor: role === 3 ? 'blue' : 'transparent' }}
          onClick={() => updateRole(3)}
        >
          巫師
        </div>
        <div
          style={{ ...roleStyle, backgroundColor: role === 4 ? 'blue' : 'transparent' }}
          onClick={() => updateRole(4)}
        >
          龍族
        </div>
        <div
          style={{ ...roleStyle, backgroundColor: role === 5 ? 'blue' : 'transparent' }}
          onClick={() => updateRole(5)}
        >
          主教
        </div>
        <div
          style={{ ...roleStyle, backgroundColor: role === 6 ? 'blue' : 'transparent' }}
          onClick={() => updateRole(6)}
        >
          夜魔
        </div>
        <div
          style={{ ...roleStyle, backgroundColor: role === 7 ? 'blue' : 'transparent' }}
          onClick={() => updateRole(7)}
        >
          復仇
        </div>
      </div>
      <div style={{ display: 'flex', width: '80vw', flexDirection: 'column', gap: '10px' }}>
        <div style={{ display: 'flex', width: '100%', justifyContent: 'space-between' }}>
          <h1>{role && ROLES.find((item) => item.id === role)?.label}</h1>
          {/* <select>
            <option>甲蟲</option>
            <option>妖精</option>
            <option>6</option>
          </select> */}
        </div>
        <div style={{ display: 'flex', width: '100%', gap: '10px' }}>
          <div style={{ ...deckStyle }}>甲蟲</div>
          <div style={{ ...deckStyle }}>控制妖</div>
          <div style={{ ...deckStyle }}>3</div>
          <div style={{ ...deckStyle }}>4</div>
          <div onClick={() => add('創造物 AF', '復仇')}>新增牌組</div>
          {/* <button>s</button> */}
        </div>
        {/* <div style={{ display: 'flex', width: '100%', justifyContent: 'space-between' }}>
          <h1>af</h1>
          <select>
            <option>人偶</option>
            <option>造物</option>
            <option>6</option>
          </select>
        </div> */}
      </div>
      {roleList.length > 0 && (
        <div style={{ marginTop: '20px' }}>
          <h2>-</h2>
          <ul>
            {roleList.map((r, idx) => (
              <li key={`${r}-${idx + 1}`}>
                {idx + 1} {ROLES.find((role) => role.id === r)?.label}
              </li>
            ))}
          </ul>
        </div>
      )}
    </div>
  )
}

export default Role

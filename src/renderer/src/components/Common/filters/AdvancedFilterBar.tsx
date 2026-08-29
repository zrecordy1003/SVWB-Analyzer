/**
 * 工作列底下那條「進階條件」。
 *
 * 條件被收進抽屜以後，關上抽屜就沒有任何東西說明資料被縮小過 - 這條列就是說明：
 * 生效中的條件各自是一顆 chip，點下去就地改這一條，＋ 直接加一條，兩者都不用
 * 開抽屜。抽屜留給「一次看完全部」。
 *
 * 分析器和對局列表共用同一個元件，而不是各寫一份長得像的：chip 的間距、＋ 的
 * 虛線邊框、popover 的寬度與「移除」按鈕的位置，只要有一邊先被改，兩頁就會開始
 * 各自漂移。各頁不同的只有「有哪些條件、每條長什麼編輯器」，那些用 props 傳。
 */
import React, { useRef, useState } from 'react'
import {
  Box,
  Button,
  Chip,
  ListItemIcon,
  ListItemText,
  Menu,
  MenuItem,
  Popover,
  Typography
} from '@mui/material'
import AddIcon from '@mui/icons-material/Add'
import type { SvgIconComponent } from '@mui/icons-material'

import { DROPDOWN_ITEM_SX, DROPDOWN_PAPER_SX } from './dropdownSurface'

export type AdvancedChip<K extends string> = { key: K; label: string }

type Props<K extends string> = {
  /** 生效中的條件，順序就是顯示順序。 */
  chips: AdvancedChip<K>[]
  /** 還沒生效、＋ 可以提供的條件。 */
  addableKeys: K[]
  labels: Record<K, string>
  icons: Record<K, SvgIconComponent>
  /** 一條條件的編輯器；popover 與抽屜共用同一個，兩邊才不會漂移。 */
  renderEditor: (key: K, autoFocus: boolean) => React.ReactNode
  /** 從 ＋ 加一條時要先送出的補丁（有些條件「打開」本身就是一次狀態變更）。 */
  onEnable: (key: K) => void
  onRemove: (key: K) => void
  onClearAll: () => void
  /** 某幾條的編輯器比較寬（例如牌組），用這個蓋掉預設寬度。 */
  editorWidth?: (key: K) => number
}

const DEFAULT_EDITOR_WIDTH = 340

export function AdvancedFilterBar<K extends string>({
  chips,
  addableKeys,
  labels,
  icons,
  renderEditor,
  onEnable,
  onRemove,
  onClearAll,
  editorWidth
}: Props<K>): React.JSX.Element {
  // K 是泛型，`Record<K, …>[K]` 在 TSX 裡取不回具體的 props 型別（每個 icon 都
  // 被當成「可能是任何一個 key」），所以在這裡一次收斂成字串索引。
  const iconOf = icons as Record<string, SvgIconComponent>

  const rowRef = useRef<HTMLDivElement>(null)
  const [addAnchor, setAddAnchor] = useState<HTMLElement | null>(null)
  const [editor, setEditor] = useState<{ key: K; anchor: HTMLElement } | null>(null)

  const handleAdd = (key: K, anchor: HTMLElement): void => {
    onEnable(key)
    setAddAnchor(null)
    // 釘在 ＋ 上，而不是那顆即將出現的 chip：chip 還沒被 React 建出來，
    // 拿它當 anchor 會讓 popover 停在畫面角落。
    setEditor({ key, anchor })
  }

  return (
    <>
      <Box
        ref={rowRef}
        display="flex"
        alignItems="center"
        gap={0.75}
        flexWrap="wrap"
        sx={{ pt: 1, borderTop: '1px dashed', borderColor: 'divider' }}
      >
        <Typography variant="caption" sx={{ opacity: 0.7, mr: 0.5 }}>
          進階條件
        </Typography>

        {chips.map((chip) => {
          const Icon = iconOf[chip.key]
          return (
            <Chip
              key={chip.key}
              size="small"
              color="primary"
              variant="outlined"
              icon={<Icon sx={{ fontSize: 16 }} />}
              label={chip.label}
              onClick={(event) => setEditor({ key: chip.key, anchor: event.currentTarget })}
              onDelete={() => onRemove(chip.key)}
            />
          )
        })}

        <Chip
          size="small"
          variant="outlined"
          icon={<AddIcon sx={{ fontSize: 16 }} />}
          label={chips.length ? '新增' : '新增條件'}
          disabled={addableKeys.length === 0}
          onClick={(event) => setAddAnchor(event.currentTarget)}
          sx={{ borderStyle: 'dashed' }}
        />

        {chips.length > 0 && (
          <Button size="small" onClick={onClearAll}>
            全部清除
          </Button>
        )}
      </Box>

      {/* 新增條件：只列出還沒生效的那幾條。 */}
      <Menu
        anchorEl={addAnchor}
        open={Boolean(addAnchor)}
        onClose={() => setAddAnchor(null)}
        anchorOrigin={{ vertical: 'bottom', horizontal: 'left' }}
        transformOrigin={{ vertical: 'top', horizontal: 'left' }}
        slotProps={{ paper: { sx: { ...DROPDOWN_PAPER_SX, minWidth: 180 } } }}
      >
        {addableKeys.map((key) => {
          const Icon = iconOf[key]
          return (
            <MenuItem
              key={key}
              onClick={() => addAnchor && handleAdd(key, addAnchor)}
              sx={DROPDOWN_ITEM_SX}
            >
              <ListItemIcon sx={{ minWidth: 28, color: 'text.secondary' }}>
                <Icon fontSize="small" />
              </ListItemIcon>
              <ListItemText slotProps={{ primary: { variant: 'body2' } }}>
                {labels[key]}
              </ListItemText>
            </MenuItem>
          )
        })}
      </Menu>

      {/* 就地編輯一條進階條件。清空選擇會讓 chip 當場消失，而一個已經從 DOM
          卸載的 anchor 會把 popover 丟到畫面左上角 - 所以退回釘在整列上。 */}
      <Popover
        open={Boolean(editor)}
        anchorEl={editor ? (editor.anchor.isConnected ? editor.anchor : rowRef.current) : null}
        onClose={() => setEditor(null)}
        anchorOrigin={{ vertical: 'bottom', horizontal: 'left' }}
        transformOrigin={{ vertical: 'top', horizontal: 'left' }}
        slotProps={{
          paper: {
            sx: {
              ...DROPDOWN_PAPER_SX,
              p: 2,
              width: editor ? (editorWidth?.(editor.key) ?? DEFAULT_EDITOR_WIDTH) : undefined,
              maxWidth: 'calc(100vw - 32px)'
            }
          }
        }}
      >
        {editor && (
          <Box display="flex" flexDirection="column" gap={1.5}>
            <Box display="flex" alignItems="center" justifyContent="space-between" gap={1}>
              <Box display="flex" alignItems="center" gap={0.75}>
                {React.createElement(iconOf[editor.key], { fontSize: 'small' })}
                <Typography variant="subtitle2" fontWeight={700}>
                  {labels[editor.key]}
                </Typography>
              </Box>
              <Button
                size="small"
                color="inherit"
                onClick={() => {
                  onRemove(editor.key)
                  setEditor(null)
                }}
              >
                移除
              </Button>
            </Box>
            {renderEditor(editor.key, true)}
          </Box>
        )}
      </Popover>
    </>
  )
}

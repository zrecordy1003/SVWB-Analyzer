/**
 * One match, as a form: used both to add a record by hand and to correct one
 * the engine wrote.
 *
 * # Why a drawer, and why one component
 *
 * It was a centred `AppDialog` with an 880px summary bar bolted on top and
 * every field in one long flex row, which is the shape a form takes when it
 * grows a field at a time. The bar was wider than the dialog, so it scrolled
 * sideways; and a modal that covers the list is the wrong container for an edit
 * whose whole context is the row you opened it from.
 *
 * Create and edit are one component because they fill in the same fields.
 * Keeping two would mean maintaining the same form twice, and the two copies
 * would drift.
 *
 * # It has to fit
 *
 * The window's minimum is 1100x700, and at that size this form must not
 * scroll - a form you scroll is one where you cannot see what you have not
 * answered yet. That constraint IS the layout below: no section headings (they
 * cost about 150px for words the fields already say), one 56px label column
 * down the left instead of a caption above every field, and every control 36px
 * tall on a row it shares with another. The drawer is wide rather than tall for
 * the same reason - horizontal room is what buys vertical room. The body still
 * scrolls if it has to; it should not have to.
 *
 * # The card under the header
 *
 * Replaces `SummaryHeader`, which is deleted. Same job - show what is about to
 * be saved - but built as a small `MatchCard`: a result block on the left in the
 * result's colour, class over deck on each side of a fixed VS column, mode and
 * time on a meta row. So the top of the drawer is the row you right-clicked,
 * and in create mode it fills itself in as you answer.
 *
 * # Controls
 *
 * Everything is `CONTROL_SX` - the soft filled pill the toolbars, the search
 * box and the segmented controls all use. MUI's outlined-with-floating-label
 * default is not a look this app has anywhere else, and a form full of them
 * read as some other program's dialog.
 */
import React, { useEffect, useMemo, useState } from 'react'
import {
  Autocomplete,
  Box,
  Button,
  Chip,
  CircularProgress,
  Drawer,
  IconButton,
  InputAdornment,
  MenuItem,
  Select,
  Stack,
  TextField,
  Tooltip,
  Typography
} from '@mui/material'
import AddIcon from '@mui/icons-material/Add'
import CloseIcon from '@mui/icons-material/Close'
import DeleteForeverIcon from '@mui/icons-material/DeleteForever'
import DeleteIcon from '@mui/icons-material/Delete'
import EditIcon from '@mui/icons-material/Edit'
import KeyboardArrowDownRoundedIcon from '@mui/icons-material/KeyboardArrowDownRounded'
import LocalOfferOutlinedIcon from '@mui/icons-material/LocalOfferOutlined'
import { format as formatDate } from 'date-fns'

import AppDialog, { DANGER_ACCENT } from '@renderer/components/Common/AppDialog'
import ClassIcon from '@renderer/components/Common/ClassIcon'
import ClassTag from '@renderer/components/Common/ClassTag'
import ModeLabel from '@renderer/components/Common/ModeLabel'
import PlayOrderMark from '@renderer/components/Common/PlayOrderMark'
import SegmentedControl, { type Segment } from '@renderer/components/Common/SegmentedControl'
import { NEUTRAL_TONE } from '@renderer/components/Common/classTone'
import {
  BACKDROP_SX,
  BAR_SX,
  DRAWER_SURFACE_SX,
  HAIRLINE_BOTTOM,
  HAIRLINE_TOP
} from '@renderer/components/Common/surfaces'
import {
  CONTROL_SX,
  DROPDOWN_ITEM_SX,
  DROPDOWN_PAPER_SX
} from '@renderer/components/Common/filters/dropdownSurface'
import { classes, classesMap, isDecklessMode, modes } from '@renderer/map/classMap'
import { invokeIpc } from '@renderer/ipc'
import type { ClassName, Deck, GameMode, Match, PlayOrder, Tag } from '@shared/domain'

import DeckPicker from './DeckPicker'

type MatchWithRelations = Match & {
  tags?: { tagId: number; tag: Tag }[]
  my_deck?: Deck | null
  oppo_deck?: Deck | null
}

/**
 * 表單握著的形狀。
 *
 * 和 `MatchWithRelations` 一樣，只有三個在 schema 裡 NOT NULL 的欄位可以是空
 * 的：新增一筆舊紀錄時，使用者還沒選職業與先後攻的那段時間是真的存在，硬塞一
 * 個預設值只會讓人按了儲存卻不知道自己記了什麼。存檔前擋住，所以資料庫永遠看
 * 不到這個狀態。
 */
type MatchDraft = Omit<MatchWithRelations, 'id' | 'my_class' | 'oppo_class' | 'play_order'> & {
  /** 新增模式下還沒有 id。 */
  id: number | null
  my_class: ClassName | ''
  oppo_class: ClassName | ''
  play_order: PlayOrder | null
}

type Props = {
  open: boolean
  /** 要編輯的紀錄；新增模式下是 `null`。 */
  matchId: number | null
  /** 開在新增模式：不去抓資料，從空白草稿開始，儲存走 `matches:create`。 */
  create?: boolean
  onClose: () => void
  onSaved?: (m: MatchWithRelations) => void
  onCreated?: (m: MatchWithRelations) => void
  onDeleted?: () => void
}

/** 標題列、表單與動作列對齊用的同一個左邊界，和進階篩選抽屜一致。 */
const GUTTER = 2.5

/** 左邊那一欄標籤的寬度。整張表單共用同一個值，欄位的左緣才會落在一條線上。 */
const LABEL_COL = 56

const toISO = (d: Date | string | null | undefined) => (d ? new Date(d).toISOString() : null)

/** `<input type="datetime-local">` 吃的格式，也只吃這個格式。 */
const toLocalInput = (d: Date | string | null | undefined): string =>
  d ? formatDate(new Date(d), "yyyy-MM-dd'T'HH:mm") : ''

/**
 * 勝／敗／未定的字色與底色，和對局列表卡片左邊那一塊用的是同一組。
 *
 * 抄過來而不是引用，是因為那幾個值在 `MatchCard` 裡是行內常數；真正該做的是把
 * 它們抽成共用的 token，但那會動到卡片，不在這次的範圍內。
 */
const RESULT_TONE = {
  win: { fg: '#69d8a8', bg: 'rgba(105, 216, 168, 0.16)', label: '勝利' },
  lose: { fg: '#f0829a', bg: 'rgba(240, 130, 154, 0.16)', label: '敗北' },
  none: { fg: '#7d8490', bg: 'rgba(125, 132, 144, 0.16)', label: '未定' }
} as const

const resultKey = (result: boolean | null | undefined): keyof typeof RESULT_TONE =>
  result == null ? 'none' : result ? 'win' : 'lose'

/**
 * 勝敗。
 *
 * 「未記錄」只在編輯模式出現：引擎確實會寫出結果不明的紀錄（辨識到開局卻沒抓到
 * 結算），那是真實存在的狀態，改的時候要看得到也留得住。但手動新增不一樣——會
 * 打開這張表單去補一筆的人，一定知道自己那場贏了還是輸了，而一筆沒有勝敗的紀錄
 * 對勝率統計毫無用處。所以新增時就是兩段，沒選之前浮片不畫。
 */
const RESULT_SEGMENTS: Segment<'win' | 'lose' | 'none'>[] = [
  { id: 'win', label: '勝' },
  { id: 'lose', label: '敗' },
  { id: 'none', label: '未記錄' }
]

const RESULT_SEGMENTS_REQUIRED = RESULT_SEGMENTS.filter((segment) => segment.id !== 'none')

const ORDER_SEGMENTS: Segment<PlayOrder>[] = [
  { id: 'first', label: '先攻' },
  { id: 'second', label: '後攻' }
]

/**
 * 一張空白草稿。
 *
 * `playedAt` 給現在，因為「剛打完但沒被辨識到」是手動新增最常見的情境；要補很久
 * 以前的紀錄就改那個欄位。其餘一律留空，包括模式——猜錯模式會直接汙染勝率統計。
 */
const blankDraft = (): MatchDraft => ({
  id: null,
  result: null,
  play_order: null,
  my_class: '',
  oppo_class: '',
  my_deckId: null,
  oppo_deckId: null,
  mode: null,
  bp: null,
  mp: null,
  delta_mp: null,
  current_cr: null,
  delta_cr: null,
  durationTime: null,
  playedAt: new Date(),
  endedAt: null,
  year: null,
  month: null,
  day: null,
  note: null,
  updatedAt: null,
  source: 'manual',
  observed: null,
  edited_fields: null,
  mode_confidence: null,
  engine_version: null,
  recog_flags: null,
  tags: [],
  my_deck: null,
  oppo_deck: null
})

/* ================================
 * 表單零件
 * ================================ */

/** 欄位左邊的標籤。每一列都是同一個字級、同一個顏色、同一欄寬。 */
const RowLabel: React.FC<{ children: React.ReactNode }> = ({ children }) => (
  <Typography
    variant="caption"
    noWrap
    sx={{ color: 'text.secondary', fontWeight: 700, letterSpacing: '.02em' }}
  >
    {children}
  </Typography>
)

/**
 * 一列：左邊一個標籤，右邊由呼叫端決定要切幾格。
 *
 * 標籤在左而不是在欄位上方，是為了高度——每個欄位頭上加一行字，整張表單就多出
 * 一百多 px，而那正是會不會捲動的差別。
 */
const FieldRow: React.FC<{
  label: string
  columns: string
  align?: 'center' | 'start'
  children: React.ReactNode
}> = ({ label, columns, align = 'center', children }) => (
  <Box
    sx={{
      display: 'grid',
      gridTemplateColumns: `${LABEL_COL}px ${columns}`,
      columnGap: 2,
      alignItems: align === 'center' ? 'center' : 'start',
      ...(align === 'start' ? { pt: 1 } : null)
    }}
  >
    <RowLabel>{label}</RowLabel>
    {children}
  </Box>
)

/** 職業下拉：值本身就是徽章加職業名，所以不需要一個標籤來說明它是什麼。 */
const ClassField: React.FC<{
  value: ClassName | ''
  error?: boolean
  label: string
  onChange: (klass: ClassName) => void
}> = ({ value, error = false, label, onChange }) => (
  <Select
    value={value}
    displayEmpty
    error={error}
    inputProps={{ 'aria-label': label }}
    IconComponent={KeyboardArrowDownRoundedIcon}
    renderValue={(selected) =>
      selected ? (
        <ClassTag id={String(selected)} size={18} />
      ) : (
        <Typography variant="body2" color="text.disabled" fontStyle="italic">
          選擇職業
        </Typography>
      )
    }
    onChange={(e) => onChange(e.target.value as ClassName)}
    MenuProps={{ slotProps: { paper: { sx: { ...DROPDOWN_PAPER_SX, minWidth: 200 } } } }}
    sx={{
      ...CONTROL_SX,
      '& .MuiSelect-select': { display: 'flex', alignItems: 'center', py: 0, pl: 1.5 }
    }}
  >
    {classes.map((option) => (
      <MenuItem
        key={option.id}
        value={option.id}
        sx={{
          ...DROPDOWN_ITEM_SX,
          '&.Mui-selected': { bgcolor: `${option.color}22` },
          '&.Mui-selected:hover': { bgcolor: `${option.color}33` }
        }}
      >
        <ClassTag id={option.id} size={18} />
      </MenuItem>
    ))}
  </Select>
)

/**
 * 模式下拉。
 *
 * 每一列就是 `ModeLabel`，也就是對局卡片上那個模式的長相——同一個模式在兩個地方
 * 不該是兩種顏色的兩種字。「未辨識」留在清單裡：引擎辨識失敗的紀錄本來就是這個
 * 值，看得到才改得動。
 */
const ModeField: React.FC<{
  value: GameMode | null
  error?: boolean
  onChange: (mode: GameMode | null) => void
}> = ({ value, error = false, onChange }) => (
  <Select
    value={value ?? ''}
    displayEmpty
    error={error}
    inputProps={{ 'aria-label': '模式' }}
    IconComponent={KeyboardArrowDownRoundedIcon}
    renderValue={(selected) =>
      selected ? (
        <ModeLabel mode={String(selected)} />
      ) : (
        <Typography variant="body2" color="text.disabled" fontStyle="italic">
          選擇模式
        </Typography>
      )
    }
    onChange={(e) => onChange((e.target.value || null) as GameMode | null)}
    MenuProps={{ slotProps: { paper: { sx: { ...DROPDOWN_PAPER_SX, minWidth: 200 } } } }}
    sx={{
      ...CONTROL_SX,
      '& .MuiSelect-select': { display: 'flex', alignItems: 'center', py: 0, pl: 1.5 }
    }}
  >
    <MenuItem value="" sx={DROPDOWN_ITEM_SX}>
      <Typography variant="body2" color="text.disabled" fontStyle="italic">
        未選擇
      </Typography>
    </MenuItem>
    {modes.map((option) => (
      <MenuItem
        key={option.id}
        value={option.id}
        sx={{
          ...DROPDOWN_ITEM_SX,
          '&.Mui-selected': { bgcolor: `${option.tone}22` },
          '&.Mui-selected:hover': { bgcolor: `${option.tone}33` }
        }}
      >
        <ModeLabel mode={option.id} />
      </MenuItem>
    ))}
  </Select>
)

/**
 * 三個分數欄位。
 *
 * 名字用前置的 adornment，不用標籤也不用上面一行字：三個並排的數字框光看是分不
 * 出誰是誰的，而 adornment 不佔任何高度。數字微調鈕拿掉——那 17px 在這個寬度下
 * 比兩個箭頭有用。
 */
const ScoreField: React.FC<{
  name: string
  value: number | null
  onChange: (next: number | null) => void
}> = ({ name, value, onChange }) => (
  <TextField
    fullWidth
    size="small"
    type="number"
    value={value ?? ''}
    onChange={(e) => onChange(e.target.value === '' ? null : Number(e.target.value))}
    slotProps={{
      input: {
        startAdornment: (
          <InputAdornment position="start" sx={{ mr: 0.5 }}>
            <Typography variant="caption" sx={{ color: 'text.secondary', fontWeight: 700 }}>
              {name}
            </Typography>
          </InputAdornment>
        )
      },
      htmlInput: { 'aria-label': name }
    }}
    sx={{
      '& .MuiOutlinedInput-root': { ...CONTROL_SX, pl: 1.25 },
      '& input': { fontVariantNumeric: 'tabular-nums', textAlign: 'right', px: 0.5 },
      '& input[type=number]': { MozAppearance: 'textfield' },
      '& input::-webkit-outer-spin-button, & input::-webkit-inner-spin-button': {
        WebkitAppearance: 'none',
        margin: 0
      }
    }}
  />
)

/* ================================
 * 上方的預覽卡片
 * ================================ */

/** 一側：徽章、職業名、底下的牌組名——和對局卡片同一個寫法。 */
const PreviewSide: React.FC<{
  klass: ClassName | ''
  deckName?: string | null
  deckless: boolean
  width?: number
}> = ({ klass, deckName, deckless, width }) => (
  <Box
    sx={{
      display: 'flex',
      alignItems: 'center',
      gap: 1,
      minWidth: 0,
      overflow: 'hidden',
      ...(width ? { width, flexShrink: 0 } : { flex: 1 })
    }}
  >
    <ClassIcon id={klass || null} size={20} tone={klass ? undefined : NEUTRAL_TONE} />
    <Box sx={{ minWidth: 0 }}>
      <Typography
        noWrap
        sx={{
          fontSize: 15,
          fontWeight: 800,
          lineHeight: 1.35,
          color: klass ? classesMap[klass].color : 'text.disabled',
          fontStyle: klass ? undefined : 'italic'
        }}
      >
        {klass ? classesMap[klass].label : '未選職業'}
      </Typography>
      {!deckless && (
        <Typography
          noWrap
          sx={{
            fontSize: 12.5,
            lineHeight: 1.35,
            color: deckName ? 'text.secondary' : 'text.disabled',
            fontStyle: deckName ? undefined : 'italic'
          }}
        >
          {deckName ?? '未設定'}
        </Typography>
      )}
    </Box>
  </Box>
)

/**
 * 這一筆現在長什麼樣，畫成一張小的對局卡片。
 *
 * 刻意和 `MatchCard` 同一個構造：左邊一塊結果色的方塊，右邊職業在上、牌組在下、
 * 中間一個固定寬的 VS 欄，底下一列 meta。
 */
const PreviewCard: React.FC<{ draft: MatchDraft; deckless: boolean }> = ({ draft, deckless }) => {
  const tone = RESULT_TONE[resultKey(draft.result)]

  return (
    <Box
      sx={{
        display: 'flex',
        borderRadius: 2,
        overflow: 'hidden',
        border: '1px solid rgba(255,255,255,0.09)',
        bgcolor: 'rgba(255,255,255,0.022)'
      }}
    >
      <Box
        sx={{
          width: 72,
          flexShrink: 0,
          display: 'grid',
          placeItems: 'center',
          bgcolor: tone.bg,
          color: tone.fg
        }}
      >
        <Typography sx={{ fontSize: 16, fontWeight: 800, lineHeight: 1 }}>{tone.label}</Typography>
      </Box>

      <Box
        sx={{
          flex: 1,
          minWidth: 0,
          px: 2,
          py: 1,
          display: 'flex',
          flexDirection: 'column',
          justifyContent: 'center',
          gap: 0.5
        }}
      >
        <Box sx={{ display: 'flex', alignItems: 'center', gap: 0.25, minWidth: 0 }}>
          <PreviewSide
            klass={draft.my_class}
            deckName={draft.my_deck?.name}
            deckless={deckless}
            width={168}
          />
          <Typography
            variant="caption"
            sx={{
              width: 28,
              flexShrink: 0,
              textAlign: 'center',
              color: 'text.disabled',
              fontWeight: 700,
              letterSpacing: '.06em'
            }}
          >
            VS
          </Typography>
          <PreviewSide
            klass={draft.oppo_class}
            deckName={draft.oppo_deck?.name}
            deckless={deckless}
          />
        </Box>

        <Box sx={{ display: 'flex', alignItems: 'center', gap: 1.25, minWidth: 0 }}>
          {draft.play_order ? (
            <PlayOrderMark order={draft.play_order} dense />
          ) : (
            <Typography sx={{ fontSize: 11, color: 'text.disabled', fontStyle: 'italic' }}>
              先後攻未選
            </Typography>
          )}
          {draft.mode ? (
            <ModeLabel mode={draft.mode} dense />
          ) : (
            <Typography sx={{ fontSize: 11, color: 'text.disabled', fontStyle: 'italic' }}>
              未選模式
            </Typography>
          )}
          <Typography
            sx={{ fontSize: 11, color: 'text.secondary', fontVariantNumeric: 'tabular-nums' }}
          >
            {draft.playedAt ? formatDate(new Date(draft.playedAt), 'yyyy/MM/dd HH:mm') : '—'}
          </Typography>
        </Box>
      </Box>
    </Box>
  )
}

/** ——— TagEditor：下拉清單內按鈕觸發 Dialog 的編輯／刪除 ——— */
const TagEditor: React.FC<{
  value: Tag[]
  onChange: (tags: Tag[]) => void
  onGlobalTagsDeleted?: (deletedIds: number[]) => void
}> = ({ value, onChange, onGlobalTagsDeleted }) => {
  const [all, setAll] = useState<Tag[]>([])
  const [inputValue, setInputValue] = useState('')

  // 編輯 Dialog 狀態
  const [editing, setEditing] = useState<Tag | null>(null)
  const [draftName, setDraftName] = useState('')
  const [saveBusy, setSaveBusy] = useState(false)
  const [renameError, setRenameError] = useState<string | null>(null)

  // 刪除 Dialog 狀態
  const [deleting, setDeleting] = useState<Tag | null>(null)
  const [deleteBusy, setDeleteBusy] = useState(false)

  // 初次載入全部標籤
  useEffect(() => {
    void invokeIpc('tags:list').then((list) => setAll(list || []))
  }, [])

  // 以名稱（不分大小寫）找重複
  const hasDupName = (name: string, excludeId?: number) =>
    all.some((t) => t.id !== excludeId && t.name.trim().toLowerCase() === name.trim().toLowerCase())

  // freeSolo 建立（Enter）
  const ensureCreate = async (raw: string): Promise<Tag | null> => {
    const name = raw.trim()
    if (!name) return null
    const existed = all.find((t) => t.name.toLowerCase() === name.toLowerCase())
    if (existed) return existed
    const created = await invokeIpc('tags:create', name)
    setAll((prev) => [...prev, created])
    return created
  }

  // 避免點擊編輯/刪除按鈕導致選項被選中或 popper 關閉
  const stopClicks: React.MouseEventHandler = (e) => {
    e.preventDefault()
    e.stopPropagation()
  }

  // 儲存重新命名
  const saveRename = async () => {
    if (!editing) return
    const name = draftName.trim()
    if (!name) return
    if (hasDupName(name, editing.id)) {
      setRenameError('名稱重複')
      return
    }
    try {
      setSaveBusy(true)
      const updated = await invokeIpc('tags:update', { id: editing.id, name })
      // 更新清單與目前選取
      setAll((prev) => prev.map((t) => (t.id === updated.id ? { ...t, name: updated.name } : t)))
      onChange(value.map((t) => (t.id === updated.id ? { ...t, name: updated.name } : t)))
      setEditing(null)
      setDraftName('')
      setRenameError(null)
    } finally {
      setSaveBusy(false)
    }
  }

  // 確認刪除
  const confirmDelete = async () => {
    if (!deleting) return
    try {
      setDeleteBusy(true)
      await invokeIpc('tags:delete', deleting.id)
      setAll((prev) => prev.filter((t) => t.id !== deleting.id))
      const next = value.filter((t) => t.id !== deleting.id)
      if (next.length !== value.length) onChange(next)
      onGlobalTagsDeleted?.([deleting.id])
      setDeleting(null)
    } finally {
      setDeleteBusy(false)
    }
  }

  return (
    <>
      <Autocomplete<Tag, true, false, true>
        multiple
        freeSolo
        disableCloseOnSelect
        size="small"
        options={all}
        value={value}
        inputValue={inputValue}
        onInputChange={(_e, v) => setInputValue(v)}
        getOptionLabel={(o) => (typeof o === 'string' ? o : o.name)}
        isOptionEqualToValue={(a, b) => a.id === b.id}
        slotProps={{ paper: { sx: DROPDOWN_PAPER_SX } }}
        onChange={async (_e, newValue) => {
          // newValue 可能包含 string（freeSolo）；轉存為 Tag 陣列
          const real: Tag[] = []
          for (const item of newValue as any[]) {
            if (typeof item === 'string') {
              const t = await ensureCreate(item)
              if (t && !real.some((x) => x.id === t.id)) real.push(t)
            } else if (!real.some((x) => x.id === item.id)) {
              real.push(item)
            }
          }
          onChange(real)
          setInputValue('')
        }}
        renderTags={(tagValue, getTagProps) =>
          tagValue.map((option, index) => (
            <Chip {...getTagProps({ index })} key={option.id} label={option.name} size="small" />
          ))
        }
        renderInput={(params) => (
          <TextField
            {...params}
            placeholder={value.length ? '' : '輸入以新增或選擇（Enter 建立）'}
            sx={{ '& .MuiOutlinedInput-root': { ...CONTROL_SX, height: 'auto', minHeight: 36 } }}
            onKeyDown={async (e) => {
              if (e.key === 'Enter') {
                const raw = (e.currentTarget as HTMLInputElement).value?.trim()
                if (!raw) return
                e.preventDefault()
                const tag = await ensureCreate(raw)
                if (tag && !value.some((t) => t.id === tag.id)) onChange([...value, tag])
                setInputValue('')
              }
            }}
          />
        )}
        renderOption={(props, option) => (
          <li {...props} key={option.id} style={{ display: 'flex', alignItems: 'center' }}>
            <Box sx={{ display: 'flex', alignItems: 'center', width: '100%', gap: 0.5 }}>
              <Typography sx={{ flex: 1, minWidth: 0 }} noWrap>
                {option.name}
              </Typography>
              <Tooltip title="編輯">
                <IconButton
                  size="small"
                  onMouseDown={stopClicks}
                  onClick={(e) => {
                    stopClicks(e)
                    setEditing(option)
                    setDraftName(option.name)
                    setRenameError(null)
                  }}
                >
                  <EditIcon fontSize="small" />
                </IconButton>
              </Tooltip>
              <Tooltip title="刪除">
                <IconButton
                  size="small"
                  color="error"
                  onMouseDown={stopClicks}
                  onClick={(e) => {
                    stopClicks(e)
                    setDeleting(option)
                  }}
                >
                  <DeleteIcon fontSize="small" />
                </IconButton>
              </Tooltip>
            </Box>
          </li>
        )}
      />

      {/* 編輯 Dialog */}
      <AppDialog
        open={!!editing}
        onClose={() => setEditing(null)}
        busy={saveBusy}
        maxWidth="xs"
        title="編輯標籤"
        icon={<LocalOfferOutlinedIcon fontSize="small" />}
        actions={
          <>
            <Button
              onClick={() => setEditing(null)}
              disabled={saveBusy}
              sx={{ textTransform: 'none' }}
            >
              取消
            </Button>
            <Button
              onClick={() => void saveRename()}
              disabled={saveBusy || draftName.trim() === ''}
              variant="contained"
              disableElevation
              sx={{ borderRadius: 2, textTransform: 'none', fontWeight: 800 }}
            >
              {saveBusy ? '儲存中…' : '儲存'}
            </Button>
          </>
        }
      >
        <TextField
          fullWidth
          autoFocus
          label="名稱"
          value={draftName}
          onChange={(e) => {
            setDraftName(e.target.value)
            setRenameError(null)
          }}
          error={!!renameError}
          helperText={renameError ?? ' '}
          onKeyDown={(e) => {
            if (e.key === 'Enter') {
              e.preventDefault()
              void saveRename()
            }
          }}
        />
      </AppDialog>

      {/* 刪除 Dialog */}
      <AppDialog
        open={!!deleting}
        onClose={() => setDeleting(null)}
        busy={deleteBusy}
        maxWidth="xs"
        title="刪除標籤"
        icon={<DeleteIcon fontSize="small" />}
        accent={DANGER_ACCENT}
        actions={
          <>
            <Button
              onClick={() => setDeleting(null)}
              disabled={deleteBusy}
              sx={{ textTransform: 'none' }}
            >
              取消
            </Button>
            <Button
              color="error"
              variant="contained"
              disableElevation
              onClick={() => void confirmDelete()}
              disabled={deleteBusy}
              sx={{ borderRadius: 2, textTransform: 'none', fontWeight: 800 }}
            >
              {deleteBusy ? '刪除中…' : '刪除'}
            </Button>
          </>
        }
      >
        <Typography variant="body2" color="text.secondary">
          確定要刪除「{deleting?.name}」嗎？此動作將同時從所有使用到該標籤的紀錄移除。
        </Typography>
      </AppDialog>
    </>
  )
}

/* ================================
 * 抽屜本體
 * ================================ */

const MatchFormDrawer: React.FC<Props> = ({
  open,
  matchId,
  create = false,
  onClose,
  onSaved,
  onCreated,
  onDeleted
}) => {
  const [loading, setLoading] = useState(false)
  const [data, setData] = useState<MatchDraft | null>(null)
  /** 主要是新增模式用：擋下 schema 不接受的空欄位。顯示在動作列，不佔表單高度。 */
  const [formError, setFormError] = useState<string | null>(null)

  // 刪除確認 Dialog 狀態
  const [confirmOpen, setConfirmOpen] = useState(false)
  const [deleting, setDeleting] = useState(false)

  useEffect(() => {
    if (!open) return
    setFormError(null)
    if (create) {
      // 每次開啟都是一張新的草稿：上一次填到一半的內容留著，只會讓人以為自己
      // 在編輯某筆既有紀錄。
      setData(blankDraft())
      return
    }
    if (!matchId) return
    // 先清掉：不清的話開另一列的瞬間，上面那張預覽卡片會有一格是前一筆的內容，
    // 而它現在夠顯眼，看起來就像開錯了紀錄。
    setData(null)
    setLoading(true)
    window.electron.ipcRenderer
      .invoke('matches:getById', matchId)
      .then((m) => setData(m))
      .finally(() => setLoading(false))
  }, [open, create, matchId])

  const tagList = useMemo(() => data?.tags?.map((x) => x.tag) ?? [], [data])

  // 2Pick 之類的模式沒有牌組：不給選，存檔時也把改模式之前殘留的牌組一起清掉
  const deckless = isDecklessMode(data?.mode)

  const patch = (values: Partial<MatchDraft>): void =>
    setData((current) => (current ? { ...current, ...values } : current))

  const handleSave = async () => {
    if (!data) return

    // 新增模式才驗證。既有紀錄不套這一組：引擎寫出來的紀錄本來就可能缺結果或
    // 缺模式，編輯時把它擋住等於連改別的欄位都改不了。
    if (create) {
      if (!data.my_class || !data.oppo_class) {
        setFormError('雙方職業都要選')
        return
      }
      if (data.result == null) {
        setFormError('勝敗要選一個')
        return
      }
      if (!data.play_order) {
        setFormError('先／後攻必填')
        return
      }
      if (!data.mode) {
        setFormError('模式要選一個——它決定這一筆會進哪一份統計')
        return
      }
      if (!data.playedAt) {
        setFormError('對戰時間要填')
        return
      }
    }
    setFormError(null)

    setLoading(true)
    try {
      const shared = {
        result: data.result ?? null,
        play_order: data.play_order,
        my_class: data.my_class as ClassName,
        oppo_class: data.oppo_class as ClassName,
        mode: (data.mode ?? null) as GameMode | null,
        bp: data.bp ?? null,
        durationTime: data.durationTime ?? null,
        my_deckId: deckless ? null : (data.my_deckId ?? null),
        oppo_deckId: deckless ? null : (data.oppo_deckId ?? null),
        note: data.note ?? null,
        playedAt: toISO(data.playedAt),
        // CR 這兩欄過去只在畫面上改得動，payload 根本沒帶——按了儲存就無聲消失。
        // 新增走的是同一份 payload，兩邊行為不一致比原本的漏掉更糟，所以一起補上。
        current_cr: data.current_cr ?? null,
        delta_cr: data.delta_cr ?? null,
        tagIds: tagList.map((t) => t.id)
      }

      if (create) {
        const created = await window.electron.ipcRenderer.invoke('matches:create', shared)
        onCreated?.(created)
        onClose()
        return
      }

      const updated = await window.electron.ipcRenderer.invoke('matches:updateWithExtras', {
        ...shared,
        id: data.id,
        prevUpdatedAt: toISO(data.updatedAt)!
      })
      onSaved?.(updated)
      onClose()
    } catch (e: any) {
      if (e?.code === 'CONFLICT' || String(e?.message).includes('CONFLICT_UPDATED_AT')) {
        setFormError('這筆已被其他流程更新，請關掉重新開啟編輯')
      } else {
        console.error(e)
        setFormError(create ? '新增失敗，請確認欄位' : '儲存失敗')
      }
    } finally {
      setLoading(false)
    }
  }

  // 刪除 Flow
  const confirmDelete = async () => {
    // 沒有 id 就沒有東西可刪。新增模式下按不到這個按鈕，但型別上仍是可能的。
    if (!data?.id) return
    setDeleting(true)
    try {
      await window.electron.ipcRenderer.invoke('matches:delete', data.id)
      onDeleted?.()
      setConfirmOpen(false)
      onClose()
    } catch (e) {
      console.error(e)
      setFormError('刪除失敗')
    } finally {
      setDeleting(false)
    }
  }

  /**
   * 新增時 `null` 要對不到任何一段（浮片不畫）；編輯時它就是「未記錄」那一段。
   */
  const resultSegment = data?.result == null ? (create ? '' : 'none') : data.result ? 'win' : 'lose'

  const missingRequired =
    create &&
    (!data?.my_class ||
      !data?.oppo_class ||
      data?.result == null ||
      !data?.play_order ||
      !data?.mode)

  return (
    <Drawer
      anchor="right"
      open={open}
      // 背景點擊刻意不關：這是一張握著未存編輯的表單，滑鼠掃到旁邊不該把它丟掉。
      // Escape 仍然關得掉——那是一個明確的按鍵，不是失手。
      onClose={(_event, reason) => {
        if (reason === 'escapeKeyDown' && !loading) onClose()
      }}
      slotProps={{
        backdrop: { sx: BACKDROP_SX },
        paper: {
          elevation: 0,
          sx: {
            ...DRAWER_SURFACE_SX,
            // 寬而不高：這張表單要在 1100x700 的最小視窗裡不捲動，而橫向的空間
            // 就是換來縱向空間的東西——一列塞兩個欄位，高度就少一列。
            width: 'min(840px, calc(100vw - 96px))'
          }
        }
      }}
    >
      <Box sx={{ display: 'flex', height: '100%', flexDirection: 'column' }}>
        {/* ---------- 標題列。預覽卡片跟著它一起住在上面這條帶子裡 ---------- */}
        <Box
          sx={{
            ...BAR_SX,
            ...HAIRLINE_BOTTOM,
            px: GUTTER,
            pt: GUTTER,
            pb: 1.75,
            flexShrink: 0
          }}
        >
          <Stack direction="row" alignItems="flex-start" spacing={1.5}>
            <Box
              sx={{
                display: 'grid',
                placeItems: 'center',
                width: 36,
                height: 36,
                borderRadius: 2,
                flexShrink: 0,
                color: 'text.secondary',
                bgcolor: 'rgba(255,255,255,0.06)',
                border: '1px solid rgba(255,255,255,0.08)'
              }}
            >
              {create ? <AddIcon fontSize="small" /> : <EditIcon fontSize="small" />}
            </Box>
            <Box sx={{ flex: 1, minWidth: 0 }}>
              <Typography
                variant="h6"
                component="h2"
                sx={{ fontWeight: 800, fontSize: 17, lineHeight: 1.3 }}
              >
                {create ? '新增對戰紀錄' : '編輯對戰紀錄'}
              </Typography>
              <Typography
                variant="caption"
                sx={{ display: 'block', color: 'text.secondary', mt: 0.25 }}
              >
                {create
                  ? '手動補一筆。會標記為手動新增，不列入辨識準確率的統計。'
                  : data?.updatedAt
                    ? `更新於 ${formatDate(new Date(data.updatedAt), 'yyyy/MM/dd HH:mm:ss')}`
                    : '尚未更新過'}
              </Typography>
            </Box>
            <IconButton
              size="small"
              onClick={onClose}
              disabled={loading}
              aria-label="關閉對戰紀錄表單"
              sx={{ color: 'text.secondary', '&:hover': { bgcolor: 'rgba(255,255,255,0.08)' } }}
            >
              <CloseIcon fontSize="small" />
            </IconButton>
          </Stack>

          {data && (
            <Box sx={{ mt: 1.5 }}>
              <PreviewCard draft={data} deckless={deckless} />
            </Box>
          )}
        </Box>

        {/* ---------- 表單 ---------- */}
        <Box sx={{ flex: 1, minHeight: 0, overflowY: 'auto', px: GUTTER, py: 2 }}>
          {!data ? (
            <Box display="flex" justifyContent="center" py={6}>
              <CircularProgress size={28} />
            </Box>
          ) : (
            <Stack spacing={2.5}>
              {/* 勝敗與先後攻並排：兩個都是「這場怎麼打的」，也都只有兩三個選項。 */}
              <FieldRow label="勝敗" columns={`1fr ${LABEL_COL}px 1fr`}>
                <SegmentedControl
                  options={create ? RESULT_SEGMENTS_REQUIRED : RESULT_SEGMENTS}
                  value={resultSegment as 'win' | 'lose' | 'none'}
                  onChange={(next) => patch({ result: next === 'none' ? null : next === 'win' })}
                  height={36}
                  minSegmentWidth={64}
                  error={!!formError && data.result == null}
                  aria-label="勝敗"
                />
                <RowLabel>先後攻</RowLabel>
                {/* 沒選之前浮片不畫。這一欄在資料庫是 NOT NULL，而全 app 都把未知
                    的先後攻當成後攻——預設停在「先攻」等於幫使用者答了一題他還沒
                    看到的問題。 */}
                <SegmentedControl
                  options={ORDER_SEGMENTS}
                  value={(data.play_order ?? '') as PlayOrder}
                  onChange={(next) => patch({ play_order: next })}
                  height={36}
                  minSegmentWidth={64}
                  error={!!formError && !data.play_order}
                  aria-label="先攻或後攻"
                />
              </FieldRow>

              {/* 一側一列，職業在前牌組在後：對局是兩邊的事，填的時候也是一邊
                  一邊填。換職業就把那一側的牌組清掉——牌組的職業是固定的，留著
                  就是一筆對不起來的資料。 */}
              <Stack spacing={1.5}>
                <FieldRow label="我方" columns="1fr 1fr">
                  <ClassField
                    label="我方職業"
                    value={data.my_class}
                    error={!!formError && !data.my_class}
                    onChange={(klass) => patch({ my_class: klass, my_deckId: null, my_deck: null })}
                  />
                  {deckless ? (
                    <Typography variant="caption" color="text.secondary">
                      這個模式的牌是抽出來的，不記錄牌組。
                    </Typography>
                  ) : (
                    <DeckPicker
                      compact
                      klass={data.my_class || undefined}
                      value={data.my_deckId ?? null}
                      onChange={(deck) =>
                        patch({
                          my_deckId: deck?.id ?? null,
                          my_deck: deck
                            ? ({ id: deck.id, name: deck.name, class: deck.class } as Deck)
                            : null
                        })
                      }
                    />
                  )}
                </FieldRow>

                <FieldRow label="對手" columns="1fr 1fr">
                  <ClassField
                    label="對手職業"
                    value={data.oppo_class}
                    error={!!formError && !data.oppo_class}
                    onChange={(klass) =>
                      patch({ oppo_class: klass, oppo_deckId: null, oppo_deck: null })
                    }
                  />
                  {deckless ? (
                    <Box />
                  ) : (
                    <DeckPicker
                      compact
                      klass={data.oppo_class || undefined}
                      value={data.oppo_deckId ?? null}
                      onChange={(deck) =>
                        patch({
                          oppo_deckId: deck?.id ?? null,
                          oppo_deck: deck
                            ? ({ id: deck.id, name: deck.name, class: deck.class } as Deck)
                            : null
                        })
                      }
                    />
                  )}
                </FieldRow>
              </Stack>

              <Stack spacing={1.5}>
                {/* 模式在前、時間在後：模式決定這一筆進哪一份統計，也決定下面
                    有沒有牌組欄可填，是這一列裡真正要先決定的那個。 */}
                <FieldRow label="模式" columns="1fr 1fr">
                  <ModeField
                    value={data.mode ?? null}
                    error={!!formError && !data.mode}
                    onChange={(mode) => patch({ mode })}
                  />
                  <TextField
                    fullWidth
                    size="small"
                    type="datetime-local"
                    value={toLocalInput(data.playedAt)}
                    onChange={(e) =>
                      patch({
                        playedAt: e.target.value ? new Date(e.target.value) : data.playedAt
                      })
                    }
                    slotProps={{ htmlInput: { 'aria-label': '對戰時間' } }}
                    sx={{
                      '& .MuiOutlinedInput-root': CONTROL_SX,
                      '& input': { fontVariantNumeric: 'tabular-nums' },
                      // 原生的日曆圖示在深色底上幾乎看不見
                      '& input::-webkit-calendar-picker-indicator': {
                        filter: 'invert(1)',
                        opacity: 0.5,
                        cursor: 'pointer'
                      }
                    }}
                  />
                </FieldRow>

                {/* 三個分數擠在一列：階級對戰以外通常全是空的，不值得一列一個。 */}
                <FieldRow label="分數" columns="1fr 1fr 1fr">
                  <ScoreField
                    name="CR"
                    value={data.current_cr ?? null}
                    onChange={(current_cr) => patch({ current_cr })}
                  />
                  <ScoreField
                    name="ΔCR"
                    value={data.delta_cr ?? null}
                    onChange={(delta_cr) => patch({ delta_cr })}
                  />
                  <ScoreField name="BP" value={data.bp ?? null} onChange={(bp) => patch({ bp })} />
                </FieldRow>
              </Stack>

              <Stack spacing={1.5}>
                <FieldRow label="標籤" columns="1fr">
                  <TagEditor
                    value={tagList}
                    onChange={(tags) => patch({ tags: tags.map((t) => ({ tagId: t.id, tag: t })) })}
                    onGlobalTagsDeleted={(deletedIds) => {
                      setData((d) => {
                        if (!d) return d
                        const next = {
                          ...d,
                          tags: (d.tags ?? []).filter((x) => !deletedIds.includes(x.tagId))
                        }
                        // 樂觀更新外層列表（即使沒按儲存，也先讓列表同步畫面）。
                        // 草稿還不在列表裡，所以只有既有紀錄要往上報。
                        if (next.id !== null) {
                          onSaved?.({ ...next, id: next.id } as MatchWithRelations)
                        }
                        return next
                      })
                    }}
                  />
                </FieldRow>

                <FieldRow label="備註" columns="1fr" align="start">
                  <TextField
                    fullWidth
                    size="small"
                    value={data.note ?? ''}
                    onChange={(e) => patch({ note: e.target.value || null })}
                    placeholder="想記下來的事：對手的關鍵牌、自己的失誤…"
                    slotProps={{ htmlInput: { 'aria-label': '備註' } }}
                    multiline
                    minRows={2}
                    maxRows={4}
                    sx={{ '& .MuiOutlinedInput-root': { ...CONTROL_SX, height: 'auto', py: 1 } }}
                  />
                </FieldRow>
              </Stack>
            </Stack>
          )}
        </Box>

        {/* ---------- 動作列。錯誤訊息就放這裡，不另外佔表單的高度 ---------- */}
        <Box sx={{ ...BAR_SX, ...HAIRLINE_TOP, px: GUTTER, py: 1.75, flexShrink: 0 }}>
          <Stack direction="row" alignItems="center" spacing={1.5}>
            {/* 刪除擺在最左邊，離「儲存」最遠。同一排裡兩個相鄰的按鈕一個存一個
                刪，是最容易點錯的排法。 */}
            {!create && data && (
              <Button
                onClick={() => setConfirmOpen(true)}
                disabled={loading}
                color="error"
                startIcon={<DeleteForeverIcon fontSize="small" />}
                sx={{ textTransform: 'none', flexShrink: 0 }}
              >
                刪除
              </Button>
            )}
            <Typography
              variant="caption"
              sx={{ flex: 1, minWidth: 0, color: 'error.light', textAlign: 'right' }}
            >
              {formError}
            </Typography>
            <Button
              onClick={onClose}
              disabled={loading}
              sx={{ textTransform: 'none', flexShrink: 0 }}
            >
              取消
            </Button>
            <Tooltip title={missingRequired ? '還有必填欄位沒填' : ''} placement="top">
              <span>
                <Button
                  variant="contained"
                  disableElevation
                  onClick={() => void handleSave()}
                  disabled={loading || !data}
                  sx={{
                    borderRadius: 2,
                    textTransform: 'none',
                    fontWeight: 800,
                    minWidth: 104,
                    flexShrink: 0
                  }}
                >
                  {loading ? '處理中…' : create ? '新增紀錄' : '儲存變更'}
                </Button>
              </span>
            </Tooltip>
          </Stack>
        </Box>
      </Box>

      {/* 刪除確認 Dialog */}
      <AppDialog
        open={confirmOpen}
        onClose={() => setConfirmOpen(false)}
        busy={deleting}
        maxWidth="xs"
        title="刪除確認"
        icon={<DeleteForeverIcon fontSize="small" />}
        accent={DANGER_ACCENT}
        actions={
          <>
            <Button
              onClick={() => setConfirmOpen(false)}
              disabled={deleting}
              sx={{ textTransform: 'none' }}
            >
              取消
            </Button>
            <Button
              variant="contained"
              color="error"
              disableElevation
              onClick={() => void confirmDelete()}
              disabled={deleting}
              sx={{ borderRadius: 2, textTransform: 'none', fontWeight: 800 }}
            >
              {deleting ? '刪除中…' : '刪除'}
            </Button>
          </>
        }
      >
        <Typography variant="body2" color="text.secondary">
          確定要刪除此對戰紀錄嗎？此動作無法復原。
        </Typography>
      </AppDialog>
    </Drawer>
  )
}

export default MatchFormDrawer

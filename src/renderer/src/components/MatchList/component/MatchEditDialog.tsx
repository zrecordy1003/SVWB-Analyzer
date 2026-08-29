// src/renderer/components/matches/MatchEditDialog.tsx
import React, { useEffect, useMemo, useState } from 'react'
import {
  Box,
  Button,
  Chip,
  Dialog,
  DialogActions,
  DialogContent,
  DialogTitle,
  Divider,
  FormControl,
  InputLabel,
  MenuItem,
  Select,
  TextField,
  Typography,
  Autocomplete,
  IconButton,
  Tooltip,
  Paper
} from '@mui/material'
import DeleteForeverIcon from '@mui/icons-material/DeleteForever'
import DeleteIcon from '@mui/icons-material/Delete'
import EditIcon from '@mui/icons-material/Edit'
import { format as formatDate } from 'date-fns'
import type { Match, GameMode, PlayOrder, Tag, Deck, ClassName } from '@shared/domain'
import { isDecklessMode, modesMap } from '@renderer/map/classMap'
import DeckPicker, { type DeckLite } from './DeckPicker'
import SummaryHeader from './SummaryHeader'
import { Close } from '@mui/icons-material'

type MatchWithRelations = Match & {
  tags?: { tagId: number; tag: Tag }[]
  my_deck?: Deck | null
  oppo_deck?: Deck | null
}

type Props = {
  open: boolean
  matchId: number | null
  onClose: () => void
  onSaved?: (m: MatchWithRelations) => void
  onDeleted?: () => void
}

const toISO = (d: Date | string | null | undefined) => (d ? new Date(d).toISOString() : null)

/** ——— 勝敗選擇 ——— */
const ResultSelect: React.FC<{
  value: boolean | null | undefined
  onChange: (v: boolean | null) => void
}> = ({ value, onChange }) => (
  <FormControl fullWidth size="small">
    <InputLabel>勝敗</InputLabel>
    <Select
      label="勝敗"
      value={value === undefined ? '' : value === null ? 'null' : value ? 'win' : 'lose'}
      renderValue={(selected) => {
        if (selected === 'null') return <span style={{ color: '#aaa' }}>未紀錄</span>
        return <span>{selected === 'win' ? '勝' : '敗'}</span>
      }}
      onChange={(e) => {
        const v = e.target.value
        if (v === 'null') onChange(null)
        else onChange(v === 'win')
      }}
    >
      <MenuItem value="null" sx={{ color: 'gray' }}>
        未紀錄
      </MenuItem>
      <MenuItem value="win">勝</MenuItem>
      <MenuItem value="lose">敗</MenuItem>
    </Select>
  </FormControl>
)

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
    void window.electron.ipcRenderer.invoke('tags:list').then((list: Tag[]) => setAll(list || []))
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
    const created: Tag = await window.electron.ipcRenderer.invoke('tags:create', name)
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
      const updated: Tag = await window.electron.ipcRenderer.invoke('tags:update', {
        id: editing.id,
        name
      })
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
      await window.electron.ipcRenderer.invoke('tags:delete', deleting.id)
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
        options={all}
        value={value}
        inputValue={inputValue}
        onInputChange={(_e, v) => setInputValue(v)}
        getOptionLabel={(o) => (typeof o === 'string' ? o : o.name)}
        isOptionEqualToValue={(a, b) => a.id === b.id}
        // filterSelectedOptions
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
            label="標籤"
            size="small"
            placeholder="輸入以新增或選擇（Enter 建立）"
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
      <Dialog
        open={!!editing}
        onClose={() => (saveBusy ? undefined : setEditing(null))}
        maxWidth="xs"
        fullWidth
      >
        <DialogTitle>編輯標籤</DialogTitle>
        <DialogContent sx={{ pt: 2 }}>
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
        </DialogContent>
        <DialogActions>
          <Button onClick={() => setEditing(null)} disabled={saveBusy}>
            取消
          </Button>
          <Button
            onClick={() => void saveRename()}
            disabled={saveBusy || draftName.trim() === ''}
            variant="contained"
          >
            {saveBusy ? '儲存中…' : '儲存'}
          </Button>
        </DialogActions>
      </Dialog>

      {/* 刪除 Dialog */}
      <Dialog
        open={!!deleting}
        onClose={() => (deleteBusy ? undefined : setDeleting(null))}
        maxWidth="xs"
        fullWidth
      >
        <DialogTitle>刪除標籤</DialogTitle>
        <DialogContent>
          確定要刪除「{deleting?.name}」嗎？此動作將同時從所有使用到該標籤的紀錄移除。
        </DialogContent>
        <DialogActions>
          <Button onClick={() => setDeleting(null)} disabled={deleteBusy}>
            取消
          </Button>
          <Button
            color="error"
            variant="contained"
            onClick={() => void confirmDelete()}
            disabled={deleteBusy}
          >
            {deleteBusy ? '刪除中…' : '刪除'}
          </Button>
        </DialogActions>
      </Dialog>
    </>
  )
}

const MatchEditDialog: React.FC<Props> = ({ open, matchId, onClose, onSaved, onDeleted }) => {
  const [loading, setLoading] = useState(false)
  const [data, setData] = useState<MatchWithRelations | null>(null)

  // 刪除確認 Dialog 狀態
  const [confirmOpen, setConfirmOpen] = useState(false)
  const [deleting, setDeleting] = useState(false)

  useEffect(() => {
    if (!open || !matchId) return
    setLoading(true)
    window.electron.ipcRenderer
      .invoke('matches:getById', matchId)
      .then((m) => setData(m))
      .finally(() => setLoading(false))
  }, [open, matchId])

  const tagList = useMemo(() => data?.tags?.map((x) => x.tag) ?? [], [data])

  // 2Pick 之類的模式沒有牌組：不給選，存檔時也把改模式之前殘留的牌組一起清掉
  const deckless = isDecklessMode(data?.mode)

  const handleSave = async () => {
    if (!data) return
    setLoading(true)
    try {
      const payload = {
        id: data.id,
        prevUpdatedAt: toISO(data.updatedAt)!,
        result: data.result ?? null,
        play_order: (data.play_order ?? null) as PlayOrder | null,
        my_class: data.my_class as ClassName,
        oppo_class: data.oppo_class as ClassName,
        mode: (data.mode ?? null) as GameMode | null,
        bp: data.bp ?? null,
        durationTime: data.durationTime ?? null,
        my_deckId: deckless ? null : (data.my_deckId ?? null),
        oppo_deckId: deckless ? null : (data.oppo_deckId ?? null),
        note: data.note ?? null,
        playedAt: toISO(data.playedAt),
        tagIds: tagList.map((t) => t.id)
      }
      const updated = await window.electron.ipcRenderer.invoke('matches:updateWithExtras', payload)
      onSaved?.(updated)
      onClose()
    } catch (e: any) {
      if (e?.code === 'CONFLICT' || e?.message === 'CONFLICT_UPDATED_AT') {
        alert('此筆資料已被其他流程更新，請重新開啟編輯。')
      } else {
        console.error(e)
        alert('儲存失敗')
      }
    } finally {
      setLoading(false)
    }
  }

  // 刪除 Flow
  const openDeleteConfirm = () => setConfirmOpen(true)
  const confirmDelete = async () => {
    if (!data) return
    setDeleting(true)
    try {
      await window.electron.ipcRenderer.invoke('matches:delete', data.id)
      onDeleted?.()
      setConfirmOpen(false)
      onClose()
    } catch (e) {
      console.error(e)
      alert('刪除失敗')
    } finally {
      setDeleting(false)
    }
  }

  const updatedLabel = data?.updatedAt
    ? formatDate(new Date(data.updatedAt), 'yyyy/MM/dd HH:mm:ss')
    : '尚未記錄'

  return (
    <Dialog
      open={open}
      // onClose={onClose}
      maxWidth="md"
      fullWidth
      onClose={(_event, reason) => {
        if (reason === 'backdropClick' || reason === 'escapeKeyDown') return
        onClose()
      }}
    >
      <DialogTitle bgcolor={'#1e1e1eff'}>
        <Box display={'flex'} alignItems={'center'} justifyContent={'space-between'}>
          編輯對戰紀錄
          <IconButton onClick={onClose}>
            <Close />
          </IconButton>
        </Box>
      </DialogTitle>
      <DialogContent dividers sx={{ p: 0 }}>
        {data && (
          <SummaryHeader
            result={data.result ?? null}
            play_order={data.play_order}
            mode={data.mode ?? null}
            my_class={data.my_class}
            oppo_class={data.oppo_class}
            my_deckName={data.my_deck?.name ?? null}
            oppo_deckName={data.oppo_deck?.name ?? null}
            bp={data.bp ?? null}
            current_cr={data.current_cr ?? null}
            delta_cr={data.delta_cr ?? null}
            durationTime={data.durationTime ?? null}
            playedAt={data.playedAt ?? null}
          />
        )}

        {!data ? (
          <Box p={2}>
            <Typography variant="body2" color="text.secondary">
              載入中…
            </Typography>
          </Box>
        ) : (
          <>
            {/* 上半區：基本欄位 */}
            <Box component={Paper} elevation={0} sx={{ p: 2, borderRadius: 0 }}>
              <Box
                sx={{
                  display: 'flex',
                  gap: 2
                }}
              >
                <Box sx={{ minWidth: '100px' }}>
                  <ResultSelect
                    value={data.result ?? null}
                    onChange={(v) => setData({ ...data, result: v })}
                  />
                </Box>

                <Box sx={{ minWidth: '120px' }}>
                  <FormControl fullWidth size="small">
                    <InputLabel shrink>先 / 後攻</InputLabel>
                    <Select
                      label="先/後攻"
                      displayEmpty
                      value={data.play_order ?? ''}
                      renderValue={(selected) => {
                        if (!selected) return <span style={{ color: '#aaa' }}>未選擇</span>
                        return <span>{selected === 'first' ? '先攻' : '後攻'}</span>
                      }}
                      onChange={(e) =>
                        setData({
                          ...data,
                          play_order: (e.target.value || data.play_order) as PlayOrder
                        })
                      }
                    >
                      <MenuItem value="">
                        <span style={{ color: '#aaa' }}>（未選擇）</span>
                      </MenuItem>
                      <MenuItem value="first">先攻</MenuItem>
                      <MenuItem value="second">後攻</MenuItem>
                    </Select>
                  </FormControl>
                </Box>

                <Box sx={{ minWidth: '120px' }}>
                  <FormControl fullWidth size="small">
                    <InputLabel shrink>模式</InputLabel>
                    <Select
                      label="模式"
                      displayEmpty
                      renderValue={(selected) => {
                        if (!selected) {
                          return <span style={{ color: '#aaa' }}>未選擇</span>
                        }
                        const modeKey = selected as GameMode
                        const { label, color } = modesMap[modeKey]
                        return (
                          <Box component="span" sx={{ color }}>
                            {label}
                          </Box>
                        )
                      }}
                      value={data.mode ?? ''}
                      onChange={(e) =>
                        setData({ ...data, mode: (e.target.value || null) as GameMode | null })
                      }
                    >
                      <MenuItem value="">
                        <span style={{ color: '#aaa' }}>（未選擇）</span>
                      </MenuItem>
                      {Object.entries(modesMap).map(([k, v]) => (
                        <MenuItem
                          key={k}
                          value={k}
                          sx={{
                            color: v.color,
                            '&.Mui-selected': { color: v.color },
                            '&.Mui-selected:hover': { color: v.color }
                          }}
                        >
                          {v.label}
                        </MenuItem>
                      ))}
                    </Select>
                  </FormControl>
                </Box>

                <Box sx={{ minWidth: '80px' }}>
                  <TextField
                    size="small"
                    label="CR"
                    type="number"
                    value={data.current_cr ?? ''}
                    onChange={(e) =>
                      setData({
                        ...data,
                        current_cr: e.target.value === '' ? null : Number(e.target.value)
                      })
                    }
                    placeholder="–"
                    slotProps={{ inputLabel: { shrink: true } }}
                  />
                </Box>

                <Box sx={{ minWidth: '80px' }}>
                  <TextField
                    size="small"
                    label="ΔCR"
                    type="number"
                    value={data.delta_cr ?? ''}
                    onChange={(e) =>
                      setData({
                        ...data,
                        delta_cr: e.target.value === '' ? null : Number(e.target.value)
                      })
                    }
                    placeholder="–"
                    slotProps={{ inputLabel: { shrink: true } }}
                  />
                </Box>

                <Box sx={{ minWidth: '80px' }}>
                  <TextField
                    size="small"
                    label="BP"
                    type="number"
                    value={data.bp ?? ''}
                    onChange={(e) =>
                      setData({
                        ...data,
                        bp: e.target.value === '' ? null : Number(e.target.value)
                      })
                    }
                    placeholder="–"
                    slotProps={{ inputLabel: { shrink: true } }}
                  />
                </Box>

                {/* <Box sx={{}}>
                  <TextField
                    fullWidth
                    size="small"
                    label="時長(秒)"
                    type="number"
                    value={data.durationTime ?? ''}
                    onChange={(e) =>
                      setData({
                        ...data,
                        durationTime: e.target.value === '' ? null : Number(e.target.value)
                      })
                    }
                    inputProps={{ inputMode: 'numeric', min: 0 }}
                  />
                </Box> */}
              </Box>
            </Box>

            <Divider />

            {/* 牌組選擇 */}
            <Box component={Paper} elevation={0} sx={{ p: 2, borderRadius: 0 }}>
              <Typography variant="subtitle2" sx={{ mb: 1 }}>
                牌組
              </Typography>

              {deckless ? (
                <Typography variant="body2" color="text.secondary">
                  {modesMap[data.mode as string]?.label ?? '此模式'}的牌是抽出來的，不記錄牌組。
                </Typography>
              ) : (
                <Box
                  sx={{
                    display: 'grid',
                    gridTemplateColumns: { xs: '1fr', md: '1fr 1fr' },
                    gap: 2,
                    alignItems: 'start'
                  }}
                >
                  <DeckPicker
                    label="我方牌組"
                    klass={data.my_class}
                    value={data.my_deckId ?? null}
                    onChange={(deck: DeckLite | null) =>
                      setData({
                        ...data,
                        my_deckId: deck?.id ?? null,
                        my_deck: deck
                          ? ({ id: deck.id, name: deck.name, class: deck.class } as Deck)
                          : null
                      })
                    }
                  />

                  <DeckPicker
                    label="對手牌組"
                    klass={data.oppo_class}
                    value={data.oppo_deckId ?? null}
                    onChange={(deck: DeckLite | null) =>
                      setData({
                        ...data,
                        oppo_deckId: deck?.id ?? null,
                        oppo_deck: deck
                          ? ({ id: deck.id, name: deck.name, class: deck.class } as Deck)
                          : null
                      })
                    }
                  />
                </Box>
              )}
            </Box>

            <Divider />

            {/* 標籤與備註 */}
            <Box component={Paper} elevation={0} sx={{ p: 2, borderRadius: 0 }}>
              <Typography variant="subtitle2" sx={{ mb: 1 }}>
                標籤與備註
              </Typography>
              <Box sx={{ display: 'grid', gridTemplateColumns: '1fr', gap: 2 }}>
                <TagEditor
                  value={tagList}
                  onChange={(tags) =>
                    setData((d) =>
                      d ? { ...d, tags: tags.map((t) => ({ tagId: t.id, tag: t })) } : d
                    )
                  }
                  onGlobalTagsDeleted={(deletedIds) => {
                    setData((d) => {
                      if (!d) return d
                      const next = {
                        ...d,
                        tags: (d.tags ?? []).filter((x) => !deletedIds.includes(x.tagId))
                      }
                      // 樂觀更新外層列表（即使沒按儲存，也先讓列表同步畫面）
                      onSaved?.(next)
                      return next
                    })
                  }}
                />
                <TextField
                  label="備註"
                  value={data.note ?? ''}
                  onChange={(e) => setData({ ...data, note: e.target.value || null })}
                  multiline
                  minRows={3}
                  fullWidth
                />
              </Box>
            </Box>

            <Divider />

            {/* 時間區塊 */}
            <Box component={Paper} elevation={0} sx={{ p: 2, borderRadius: 0 }}>
              <Box
                sx={{
                  display: 'flex',
                  justifyContent: 'space-between',
                  alignItems: 'center'
                }}
              >
                {/* <TextField
                  size="small"
                  label="開始時間"
                  type="datetime-local"
                  value={data.playedAt ? formatDate(new Date(data.playedAt), "yyyy-MM-dd'T'HH:mm") : ''}
                  onChange={(e) =>
                    setData({
                      ...data,
                      playedAt: e.target.value ? (new Date(e.target.value) as any) : null
                    })
                  }
                  sx={{ width: 260 }}
                /> */}
                <Typography variant="caption" color="text.secondary">
                  更新時間：{updatedLabel}
                </Typography>
                <Box sx={{ justifySelf: 'end' }}>
                  <Tooltip title="刪除此紀錄">
                    <IconButton color="error" onClick={openDeleteConfirm} aria-label="delete-match">
                      <DeleteForeverIcon />
                    </IconButton>
                  </Tooltip>
                </Box>
              </Box>
            </Box>
          </>
        )}
      </DialogContent>

      <DialogActions sx={{ p: 2, bgcolor: '#1e1e1eff' }}>
        <Button onClick={onClose} disabled={loading}>
          取消
        </Button>
        <Button variant="contained" onClick={handleSave} disabled={loading}>
          儲存
        </Button>
      </DialogActions>

      {/* 刪除確認 Dialog */}
      <Dialog open={confirmOpen} onClose={() => (deleting ? undefined : setConfirmOpen(false))}>
        <DialogTitle>刪除確認</DialogTitle>
        <DialogContent>確定要刪除此對戰紀錄嗎？此動作無法復原。</DialogContent>
        <DialogActions>
          <Button onClick={() => setConfirmOpen(false)} disabled={deleting}>
            取消
          </Button>
          <Button variant="contained" color="error" onClick={confirmDelete} disabled={deleting}>
            {deleting ? '刪除中…' : '刪除'}
          </Button>
        </DialogActions>
      </Dialog>
    </Dialog>
  )
}

export default MatchEditDialog

// src/renderer/components/matches/MatchEditDialog.tsx（節選，只要把你的檔案整體換成這版即可）
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
  Stack,
  TextField,
  Typography,
  Autocomplete,
  IconButton,
  Tooltip,
  Paper
} from '@mui/material'
import Grid from '@mui/material/Grid'
import DeleteForeverIcon from '@mui/icons-material/DeleteForever'
import dayjs from 'dayjs'
import type { Match, GameMode, PlayOrder, ClassName, Tag, Deck } from '@prisma/client'
import { classesMap, modesMap } from '@renderer/map/classMap'
import DeckPicker from './DeckPicker'
import SummaryHeader from './SummaryHeader'

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

const ResultSelect: React.FC<{
  value: boolean | null | undefined
  onChange: (v: boolean | null) => void
}> = ({ value, onChange }) => (
  <FormControl fullWidth size="small">
    <InputLabel>勝敗</InputLabel>
    <Select
      label="勝敗"
      value={value === undefined ? '' : value === null ? 'null' : value ? 'win' : 'lose'}
      onChange={(e) => {
        const v = e.target.value
        if (v === 'null' || v === '') onChange(null)
        else onChange(v === 'win')
      }}
    >
      <MenuItem value="win">勝</MenuItem>
      <MenuItem value="lose">敗</MenuItem>
      <MenuItem value="null">未紀錄</MenuItem>
    </Select>
  </FormControl>
)

const TagEditor: React.FC<{
  value: Tag[]
  onChange: (tags: Tag[]) => void
}> = ({ value, onChange }) => {
  const [all, setAll] = useState<Tag[]>([])
  useEffect(() => {
    window.electron.ipcRenderer.invoke('tags:list').then(setAll)
  }, [])
  return (
    <Autocomplete
      multiple
      options={all}
      value={value}
      onChange={(_e, v) => onChange(v)}
      getOptionLabel={(o) => o.name}
      renderTags={(tagValue, getTagProps) =>
        tagValue.map((option, index) => (
          <Chip {...getTagProps({ index })} key={option.id} label={option.name} size="small" />
        ))
      }
      renderInput={(p) => (
        <TextField {...p} label="標籤" size="small" placeholder="輸入以新增或選擇" />
      )}
      freeSolo
      onKeyDown={async (e) => {
        if (e.key === 'Enter') {
          const input = (e.target as HTMLInputElement).value?.trim()
          if (!input) return
          const existed = all.find((t) => t.name.toLowerCase() === input.toLowerCase())
          let tag = existed
          if (!existed) {
            tag = await window.electron.ipcRenderer.invoke('tags:create', input)
            setAll((prev) => [...prev, tag!])
          }
          if (tag && !value.some((t) => t.id === tag!.id)) onChange([...value, tag!])
        }
      }}
    />
  )
}

const MatchEditDialog: React.FC<Props> = ({ open, matchId, onClose, onSaved, onDeleted }) => {
  const [loading, setLoading] = useState(false)
  const [data, setData] = useState<MatchWithRelations | null>(null)

  useEffect(() => {
    if (!open || !matchId) return
    setLoading(true)
    window.electron.ipcRenderer
      .invoke('matches:getById', matchId)
      .then((m) => setData(m))
      .finally(() => setLoading(false))
  }, [open, matchId])

  const tagList = useMemo(() => data?.tags?.map((x) => x.tag) ?? [], [data])

  const handleSave = async () => {
    if (!data) return
    setLoading(true)
    try {
      const payload = {
        id: data.id,
        prevUpdatedAt: toISO(data.updatedAt)!,
        result: data.result ?? null,
        play_order: data.play_order,
        my_class: data.my_class,
        oppo_class: data.oppo_class,
        mode: data.mode ?? null,
        bp: data.bp ?? null,
        durationTime: data.durationTime ?? null,
        my_deckId: data.my_deckId ?? null,
        oppo_deckId: data.oppo_deckId ?? null,
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

  const handleDelete = async () => {
    if (!data) return
    if (!confirm('確定要刪除此對戰紀錄？此動作無法復原。')) return
    setLoading(true)
    try {
      await window.electron.ipcRenderer.invoke('matches:delete', data.id)
      onDeleted?.()
      onClose()
    } catch (e) {
      console.error(e)
      alert('刪除失敗')
    } finally {
      setLoading(false)
    }
  }

  const updatedLabel = data?.updatedAt
    ? dayjs(data.updatedAt).format('YYYY/MM/DD HH:mm:ss')
    : '尚未記錄'

  return (
    <Dialog open={open} onClose={onClose} maxWidth="md" fullWidth>
      <DialogTitle>編輯對戰紀錄</DialogTitle>
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
                  display: 'grid',
                  gridTemplateColumns: { xs: '1fr', md: 'repeat(12, 1fr)' },
                  gap: 2,
                  alignItems: 'start'
                }}
              >
                <Box sx={{ gridColumn: { xs: '1 / -1', md: 'span 3' } }}>
                  <ResultSelect
                    value={data.result ?? null}
                    onChange={(v) => setData({ ...data, result: v })}
                  />
                </Box>

                <Box sx={{ gridColumn: { xs: '1 / -1', md: 'span 3' } }}>
                  <FormControl fullWidth size="small">
                    <InputLabel>先/後攻</InputLabel>
                    <Select
                      label="先/後攻"
                      value={data.play_order}
                      onChange={(e) =>
                        setData({ ...data, play_order: e.target.value as PlayOrder })
                      }
                    >
                      <MenuItem value="first">先攻</MenuItem>
                      <MenuItem value="second">後攻</MenuItem>
                    </Select>
                  </FormControl>
                </Box>

                <Box sx={{ gridColumn: { xs: '1 / -1', md: 'span 3' } }}>
                  <FormControl fullWidth size="small">
                    <InputLabel>模式</InputLabel>
                    <Select
                      label="模式"
                      value={data.mode ?? ''}
                      onChange={(e) =>
                        setData({ ...data, mode: (e.target.value || null) as GameMode | null })
                      }
                    >
                      <MenuItem value="">（未選擇）</MenuItem>
                      {Object.entries(modesMap).map(([k, v]) => (
                        <MenuItem key={k} value={k}>
                          {v.label}
                        </MenuItem>
                      ))}
                    </Select>
                  </FormControl>
                </Box>

                <Box sx={{ gridColumn: { xs: 'span 6', md: 'span 2' } }}>
                  <TextField
                    fullWidth
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
                  />
                </Box>

                <Box sx={{ gridColumn: { xs: 'span 6', md: 'span 1' } }}>
                  <TextField
                    fullWidth
                    size="small"
                    label="秒"
                    type="number"
                    value={data.durationTime ?? ''}
                    onChange={(e) =>
                      setData({
                        ...data,
                        durationTime: e.target.value === '' ? null : Number(e.target.value)
                      })
                    }
                  />
                </Box>
              </Box>
            </Box>

            <Divider />

            {/* 牌組選擇 */}
            <Box component={Paper} elevation={0} sx={{ p: 2, borderRadius: 0 }}>
              <Typography variant="subtitle2" sx={{ mb: 1 }}>
                牌組
              </Typography>
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
                  onChange={(id) => setData({ ...data, my_deckId: id })}
                />
                <DeckPicker
                  label="對手牌組"
                  klass={data.oppo_class}
                  value={data.oppo_deckId ?? null}
                  onChange={(id) => setData({ ...data, oppo_deckId: id })}
                />
              </Box>
            </Box>

            <Divider />

            {/* 標籤與備註 */}
            <Box component={Paper} elevation={0} sx={{ p: 2, borderRadius: 0 }}>
              <Box sx={{ display: 'grid', gridTemplateColumns: '1fr', gap: 2 }}>
                <TagEditor
                  value={tagList}
                  onChange={(tags) =>
                    setData((d) =>
                      d ? { ...d, tags: tags.map((t) => ({ tagId: t.id, tag: t })) } : d
                    )
                  }
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
                  display: 'grid',
                  gridTemplateColumns: { xs: '1fr', md: 'auto 1fr auto' },
                  gap: 2,
                  alignItems: 'center'
                }}
              >
                <TextField
                  size="small"
                  label="開始時間"
                  type="datetime-local"
                  value={dayjs(data.playedAt).format('YYYY-MM-DDTHH:mm')}
                  onChange={(e) => setData({ ...data, playedAt: new Date(e.target.value) as any })}
                  sx={{ width: 260 }}
                />
                <Typography variant="caption" color="text.secondary">
                  更新時間：
                  {updatedLabel}
                  {/* {data?.updatedAt
                    ? dayjs(data.updatedAt).format('YYYY/MM/DD HH:mm:ss')
                    : '尚未記錄'} */}
                </Typography>
                <Box sx={{ justifySelf: 'end' }}>
                  <Tooltip title="刪除此紀錄">
                    <IconButton color="error" onClick={handleDelete}>
                      <DeleteForeverIcon />
                    </IconButton>
                  </Tooltip>
                </Box>
              </Box>
            </Box>
          </>
        )}
      </DialogContent>
      <DialogActions sx={{ p: 2 }}>
        <Button onClick={onClose}>取消</Button>
        <Button variant="contained" onClick={handleSave} disabled={loading}>
          儲存
        </Button>
      </DialogActions>
    </Dialog>
  )
}

export default MatchEditDialog

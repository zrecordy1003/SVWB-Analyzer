// src/renderer/components/matches/MatchList.tsx
import React, { useEffect, useRef, useState, ChangeEvent } from 'react'
import {
  Box,
  Chip,
  Paper,
  Table,
  TableBody,
  TableCell,
  TableContainer,
  TableHead,
  TableRow,
  TablePagination,
  Typography,
  IconButton,
  Tooltip,
  Stack
} from '@mui/material'
import LooksOneTwoToneIcon from '@mui/icons-material/LooksOneTwoTone'
import LooksTwoTwoToneIcon from '@mui/icons-material/LooksTwoTwoTone'
import EditIcon from '@mui/icons-material/Edit'
import DeleteOutlineIcon from '@mui/icons-material/DeleteOutline'
import NoteAltOutlinedIcon from '@mui/icons-material/NoteAltOutlined'
import WbSunnyIcon from '@mui/icons-material/WbSunny'
import NightsStayIcon from '@mui/icons-material/NightsStay'
import BrightnessHighIcon from '@mui/icons-material/BrightnessHigh'
import WbTwilightIcon from '@mui/icons-material/WbTwilight'
import BedtimeIcon from '@mui/icons-material/Bedtime'
import SunnySnowingIcon from '@mui/icons-material/SunnySnowing'

import { classesMap, modesMap } from '@renderer/map/classMap'
import { Match } from '@prisma/client'
import SearchBar from './component/SearchBar'
import MatchEditDialog from './component/MatchEditDialog'
import ConfirmDialog from '../Common/ConfirmDialog'

const PAGE_SIZE_OPTIONS = [5, 10]
function useDebounced<T>(value: T, delay = 200): T {
  const [v, setV] = useState(value)
  useEffect(() => {
    const id = setTimeout(() => setV(value), delay)
    return () => clearTimeout(id)
  }, [value, delay])
  return v
}

const getPeriodByHour = (hour?: number): { label: string; icon: React.JSX.Element } => {
  if (hour === undefined) return { label: '', icon: <></> }
  if (hour >= 0 && hour < 6)
    return {
      label: '凌晨',
      icon: (
        <SunnySnowingIcon
          sx={{ color: '#7986cb', verticalAlign: 'middle', ml: '7px', mr: '4px', mb: '3px' }}
        />
      )
    }
  if (hour >= 6 && hour < 12)
    return {
      label: '早上',
      icon: (
        <WbSunnyIcon
          sx={{ color: 'gold', verticalAlign: 'middle', ml: '7px', mr: '4px', mb: '3px' }}
        />
      )
    }
  if (hour === 12)
    return {
      label: '中午',
      icon: (
        <BrightnessHighIcon
          sx={{ color: '#ffb74d', verticalAlign: 'middle', ml: '7px', mr: '4px', mb: '3px' }}
        />
      )
    }
  if (hour > 12 && hour < 18)
    return {
      label: '下午',
      icon: (
        <WbTwilightIcon
          sx={{ color: '#f16a1c', verticalAlign: 'middle', ml: '7px', mr: '4px', mb: '3px' }}
        />
      )
    }
  if (hour >= 18 && hour < 20)
    return {
      label: '傍晚',
      icon: (
        <BedtimeIcon
          sx={{ color: '#ff8a65', verticalAlign: 'middle', ml: '7px', mr: '4px', mb: '3px' }}
        />
      )
    }
  return {
    label: '晚上',
    icon: (
      <NightsStayIcon
        sx={{ color: '#78909c', verticalAlign: 'middle', ml: '7px', mr: '4px', mb: '3px' }}
      />
    )
  }
}

const startOf = (d: Date): Date => {
  const x = new Date(d)
  x.setHours(0, 0, 0, 0)
  return x
}
const endOf = (d: Date): Date => {
  const x = new Date(d)
  x.setHours(23, 59, 59, 999)
  return x
}

const MatchList = (): React.JSX.Element => {
  // filter state
  const today = new Date()
  const [filters, setFilters] = useState<SearchFilters>({
    my: [],
    oppo: [],
    mode: null,
    rangeKey: 'today',
    startDate: startOf(today),
    endDate: endOf(today)
  })
  const onFiltersChange: OnFiltersChange = (patch) => setFilters((f) => ({ ...f, ...patch }))
  const [rows, setRows] = useState<Match[]>([])
  const [totalCount, setTotalCount] = useState<number>(0)
  const [page, setPage] = useState<number>(0)
  const [rowsPerPage, setRowsPerPage] = useState<number>(PAGE_SIZE_OPTIONS[0])
  const debouncedFilters = useDebounced(filters, 200)
  const reqIdRef = useRef(0)
  const filtersRef = useRef(filters)
  useEffect(() => {
    filtersRef.current = filters
  }, [filters])
  const pageRef = useRef(page)
  useEffect(() => {
    pageRef.current = page
  }, [page])
  const rowsPerPageRef = useRef(rowsPerPage)
  useEffect(() => {
    rowsPerPageRef.current = rowsPerPage
  }, [rowsPerPage])

  // Edit dialog
  const [editId, setEditId] = useState<number | null>(null)
  const [confirmDelete, setConfirmDelete] = useState<{ open: boolean; id: number | null }>({
    open: false,
    id: null
  })

  // IPC helpers
  const fetchFilteredCount = async (f: SearchFilters): Promise<void> => {
    const myIds = f.my.map((c) => c.id)
    const oppoIds = f.oppo.map((c) => c.id)
    let count: number
    if (f.rangeKey === 'custom') {
      count = await window.electron?.ipcRenderer.invoke(
        'matches:count',
        myIds,
        oppoIds,
        f.mode,
        f.rangeKey,
        f.startDate,
        f.endDate
      )
    } else {
      count = await window.electron?.ipcRenderer.invoke(
        'matches:count',
        myIds,
        oppoIds,
        f.mode,
        f.rangeKey
      )
    }
    setTotalCount(count)
  }

  const fetchPage = async (
    pageIndex: number,
    pageSize: number,
    f: SearchFilters
  ): Promise<void> => {
    const myIds = f.my.map((c) => c.id)
    const oppoIds = f.oppo.map((c) => c.id)
    const currentReq = ++reqIdRef.current
    let data: Match[]
    if (f.rangeKey === 'custom') {
      data = await window.electron?.ipcRenderer.invoke(
        'matches:getPage',
        pageIndex,
        pageSize,
        myIds,
        oppoIds,
        f.mode,
        f.rangeKey,
        f.startDate,
        f.endDate
      )
    } else {
      data = await window.electron?.ipcRenderer.invoke(
        'matches:getPage',
        pageIndex,
        pageSize,
        myIds,
        oppoIds,
        f.mode,
        f.rangeKey
      )
    }
    if (currentReq === reqIdRef.current) setRows(data)
  }

  useEffect(() => {
    setPage(0)
    fetchFilteredCount(debouncedFilters)
    fetchPage(0, rowsPerPage, debouncedFilters)
  }, [debouncedFilters, rowsPerPage])

  useEffect(() => {
    fetchPage(page, rowsPerPage, debouncedFilters)
  }, [page])

  useEffect(() => {
    const handler = (): void => {
      fetchPage(pageRef.current, rowsPerPageRef.current, filtersRef.current)
      fetchFilteredCount(filtersRef.current)
    }
    const unsub = window.electron?.ipcRenderer.on('matches:needRefetch', handler)
    return () => {
      unsub && unsub()
    }
  }, [])

  const handleChangePage = (_: unknown, newPage: number): void => setPage(newPage)
  const handleChangeRowsPerPage = (e: ChangeEvent<HTMLInputElement>): void => {
    setRowsPerPage(+e.target.value)
    setPage(0)
  }
  const totalPages = Math.max(1, Math.ceil(totalCount / rowsPerPage))

  const openEdit = (id: number) => setEditId(id)
  const closeEdit = () => setEditId(null)

  const requestDelete = (id: number) => setConfirmDelete({ open: true, id })
  const handleConfirmDelete = async (ok: boolean) => {
    if (!ok || !confirmDelete.id) {
      setConfirmDelete({ open: false, id: null })
      return
    }
    try {
      await window.electron.ipcRenderer.invoke('matches:delete', confirmDelete.id)
      // 刷新
      fetchPage(pageRef.current, rowsPerPageRef.current, filtersRef.current)
      fetchFilteredCount(filtersRef.current)
    } finally {
      setConfirmDelete({ open: false, id: null })
    }
  }

  console.log(rows)
  return (
    <Box p={2}>
      <SearchBar filters={filters} onFiltersChange={onFiltersChange} />

      {/* 分頁控制 */}
      <Box display="flex" alignItems="center" justifyContent="space-between" mt={1} mb={1.5}>
        <Typography variant="button">
          頁數 {totalCount > 0 ? page + 1 : 0} / {totalCount > 0 ? totalPages : 0}
        </Typography>
        <TablePagination
          component="div"
          count={totalCount}
          page={page}
          onPageChange={handleChangePage}
          rowsPerPage={rowsPerPage}
          onRowsPerPageChange={handleChangeRowsPerPage}
          rowsPerPageOptions={PAGE_SIZE_OPTIONS}
          labelRowsPerPage="每頁筆數"
          labelDisplayedRows={({ from, to }) => `${from} - ${to} 共 ${totalCount} 筆`}
          showFirstButton
          showLastButton
        />
      </Box>

      {/* 表格 */}
      <TableContainer component={Paper}>
        <Table>
          <TableHead>
            <TableRow>
              <TableCell sx={{ textAlign: 'right' }}>我方職業</TableCell>
              <TableCell sx={{ textAlign: 'right' }}>對方職業</TableCell>
              <TableCell sx={{ textAlign: 'right' }}>先 / 後攻</TableCell>
              <TableCell sx={{ textAlign: 'right' }}>勝 / 敗</TableCell>
              <TableCell sx={{ textAlign: 'center' }}>模式</TableCell>
              <TableCell sx={{ textAlign: 'right' }}>BP</TableCell>
              <TableCell sx={{ textAlign: 'center' }}>標籤 / 備註</TableCell>
              <TableCell sx={{ textAlign: 'right' }}>開始時間</TableCell>
              <TableCell sx={{ textAlign: 'center', width: 96 }}>操作</TableCell>
            </TableRow>
          </TableHead>
          <TableBody>
            {rows &&
              rows.map((m) => (
                <TableRow
                  key={m.id}
                  sx={{
                    minHeight: '70px',
                    height: '70px',
                    borderLeft:
                      m.result === null
                        ? '5px solid #f5faf64f'
                        : m.result
                          ? '5px solid #00ff664f'
                          : '5px solid #c81f3daf'
                  }}
                >
                  <TableCell sx={{ textAlign: 'right', color: classesMap[m.my_class]?.color }}>
                    <Typography fontSize={'small'}>{classesMap[m.my_class]?.label}</Typography>
                    <Typography
                      fontSize={'small'}
                      color={!m.my_deck?.name && 'gray'}
                      sx={{ opacity: 0.9 }}
                    >
                      {m.my_deck?.name ? m.my_deck?.name : '未設置'}
                    </Typography>
                  </TableCell>
                  <TableCell sx={{ textAlign: 'right', color: classesMap[m.oppo_class]?.color }}>
                    <Typography fontSize={'small'}>{classesMap[m.oppo_class]?.label}</Typography>
                    <Typography
                      fontSize={'small'}
                      color={!m.oppo_deck?.name && 'gray'}
                      sx={{ opacity: 0.9 }}
                    >
                      {m.oppo_deck?.name ? m.oppo_deck?.name : '未設置'}
                    </Typography>
                  </TableCell>
                  <TableCell sx={{ textAlign: 'right' }}>
                    {m.play_order === 'first' ? (
                      <Box display="flex" alignItems="center" justifyContent="end">
                        <LooksOneTwoToneIcon fontSize="small" sx={{ mr: 0.5 }} color="primary" />
                        先攻
                      </Box>
                    ) : (
                      <Box display="flex" alignItems="center" justifyContent="end">
                        <LooksTwoTwoToneIcon fontSize="small" sx={{ mr: 0.5 }} color="secondary" />
                        後攻
                      </Box>
                    )}
                  </TableCell>
                  <TableCell
                    sx={{
                      textAlign: 'right',
                      color: m.result == null ? 'gray' : m.result ? '#00ff668c' : '#c81f3ede'
                    }}
                  >
                    {m.result === true ? '勝' : m.result === false ? '敗' : '未紀錄'}
                  </TableCell>
                  <TableCell sx={{ textAlign: 'center' }}>
                    {m.mode ? (
                      <Chip
                        variant="outlined"
                        size="small"
                        color={modesMap[m.mode].color}
                        label={modesMap[m.mode].label}
                      />
                    ) : (
                      '-'
                    )}
                  </TableCell>
                  <TableCell
                    sx={{
                      textAlign: 'right',
                      color: m.bp ? (Number(m.bp) > 0 ? '#00ff668c' : '#c81f3ede') : 'gray',
                      fontFamily: 'monospace'
                    }}
                  >
                    {m.bp ?? '-'}
                  </TableCell>

                  {/* 標籤／備註（縮排顯示，避免表格太胖） */}
                  <TableCell sx={{ textAlign: 'center' }}>
                    <RowTagsAndNote matchId={m.id} />
                  </TableCell>

                  <TableCell
                    sx={{ textAlign: 'right', fontFamily: 'monospace' }}
                    title={String(new Date(m.playedAt).toLocaleString())}
                  >
                    {(() => {
                      const dt = new Date(m.playedAt)
                      const parts = new Intl.DateTimeFormat('zh-TW', {
                        month: 'numeric',
                        day: '2-digit',
                        hour: '2-digit',
                        minute: '2-digit',
                        hour12: false
                      }).formatToParts(dt)
                      const month = parts.find((p) => p.type === 'month')?.value
                      const day = parts.find((p) => p.type === 'day')?.value
                      const hourValue = parts.find((p) => p.type === 'hour')?.value ?? ''
                      const hourNum = Number(hourValue)
                      const { label, icon } = getPeriodByHour(hourNum)
                      const hour = hourValue.padStart(2, '0')
                      const minute = parts.find((p) => p.type === 'minute')?.value
                      return (
                        <Box display="flex" justifyContent="end" alignItems="center">
                          {month}月{day}日{icon}
                          {`${label} `}
                          {hour}:{minute}
                        </Box>
                      )
                    })()}
                  </TableCell>

                  <TableCell sx={{ textAlign: 'center' }}>
                    <Tooltip title="編輯">
                      <IconButton size="small" onClick={() => openEdit(m.id)}>
                        <EditIcon fontSize="small" />
                      </IconButton>
                    </Tooltip>
                    <Tooltip title="刪除">
                      <IconButton size="small" color="error" onClick={() => requestDelete(m.id)}>
                        <DeleteOutlineIcon fontSize="small" />
                      </IconButton>
                    </Tooltip>
                  </TableCell>
                </TableRow>
              ))}
            {rows.length === 0 && (
              <TableRow>
                <TableCell colSpan={9} align="center">
                  無符合資料
                </TableCell>
              </TableRow>
            )}
          </TableBody>
        </Table>
      </TableContainer>

      {/* 編輯對話框 */}
      <MatchEditDialog
        open={!!editId}
        matchId={editId}
        onClose={closeEdit}
        onSaved={() => {
          fetchPage(pageRef.current, rowsPerPageRef.current, filtersRef.current)
          fetchFilteredCount(filtersRef.current)
        }}
        onDeleted={() => {
          fetchPage(pageRef.current, rowsPerPageRef.current, filtersRef.current)
          fetchFilteredCount(filtersRef.current)
        }}
      />

      {/* 刪除確認 */}
      <ConfirmDialog
        open={confirmDelete.open}
        title="刪除此對戰紀錄？"
        message="此操作無法復原。"
        onClose={handleConfirmDelete}
      />
    </Box>
  )
}

export default MatchList

// --- 內部：小元件：列上顯示 Tag + 備註圖示 ---
const RowTagsAndNote: React.FC<{ matchId: number }> = ({ matchId }) => {
  const [tags, setTags] = useState<{ id: number; name: string }[] | null>(null)
  const [hasNote, setHasNote] = useState<boolean>(false)

  useEffect(() => {
    let mounted = true
    ;(async () => {
      const m = await window.electron.ipcRenderer.invoke('matches:getById', matchId)
      if (!mounted) return
      setHasNote(!!m?.note)
      const t = (m?.tags ?? []).map((x: any) => x.tag)
      setTags(t)
    })()
    return () => {
      mounted = false
    }
  }, [matchId])

  if (!tags)
    return (
      <Typography variant="body2" color="text.secondary">
        …
      </Typography>
    )

  const shown = tags.slice(0, 2)
  const more = tags.length - shown.length

  return (
    <Stack
      direction="row"
      spacing={0.5}
      alignItems="center"
      justifyContent="center"
      sx={{ flexWrap: 'nowrap', overflow: 'hidden' }}
    >
      {shown.map((t) => (
        <Chip key={t.id} size="small" variant="outlined" label={t.name} />
      ))}
      {more > 0 && <Chip size="small" label={`+${more}`} />}
      {hasNote && (
        <Tooltip title="有備註">
          <NoteAltOutlinedIcon fontSize="small" sx={{ ml: 0.5, color: 'text.secondary' }} />
        </Tooltip>
      )}
    </Stack>
  )
}

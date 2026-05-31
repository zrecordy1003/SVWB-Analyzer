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
  Stack,
  Collapse,
  Divider
} from '@mui/material'
import KeyboardArrowDownIcon from '@mui/icons-material/KeyboardArrowDown'
import KeyboardArrowRightIcon from '@mui/icons-material/KeyboardArrowRight'
import LooksOneTwoToneIcon from '@mui/icons-material/LooksOneTwoTone'
import LooksTwoTwoToneIcon from '@mui/icons-material/LooksTwoTwoTone'
import EditIcon from '@mui/icons-material/Edit'
import DeleteOutlineIcon from '@mui/icons-material/DeleteOutline'
import WbSunnyIcon from '@mui/icons-material/WbSunny'
import NightsStayIcon from '@mui/icons-material/NightsStay'
import BrightnessHighIcon from '@mui/icons-material/BrightnessHigh'
import WbTwilightIcon from '@mui/icons-material/WbTwilight'
import BedtimeIcon from '@mui/icons-material/Bedtime'
import SunnySnowingIcon from '@mui/icons-material/SunnySnowing'
import AccessTimeIcon from '@mui/icons-material/AccessTime'

import { classesMap, modesMap } from '@renderer/map/classMap'
import { Deck, Match } from '@prisma/client'
import SearchBar from './component/SearchBar'
import MatchEditDialog from './component/MatchEditDialog'
import ConfirmDialog from '../Common/ConfirmDialog'
import { useDecksTags } from '../../hooks/useDecksTags'
import type { QueryPayload } from '@shared/types'

/** --- UI 常數（固定欄寬，避免換行） --- */
const COL_W = {
  myClass: 140,
  oppoClass: 140,
  order: 90,
  result: 60,
  mode: 110,
  bp: 90,
  cr: 96, // 新增：當場 CR
  crDelta: 96, // 新增：本局 CR 增減
  duration: 120,
  time: 200,
  actions: 108
} as const

const PAGE_SIZE_OPTIONS = [5, 10]

/** 若你專案已有型別，這兩個型別只是輔助說明 */
type SearchFilters = any
type OnFiltersChange = (patch: Partial<SearchFilters>) => void

function useDebounced<T>(value: T, delay = 200): T {
  const [v, setV] = useState(value)
  useEffect(() => {
    const id = setTimeout(() => setV(value), delay)
    return () => clearTimeout(id)
  }, [value, delay])
  return v
}

/** 時段圖示與文案 */
const getPeriodByHour = (hour?: number): { label: string; icon: React.JSX.Element } => {
  if (hour === undefined || Number.isNaN(hour)) return { label: '', icon: <></> }
  if (hour >= 0 && hour < 6)
    return { label: '凌晨', icon: <SunnySnowingIcon sx={{ color: '#7986cb' }} /> }
  if (hour >= 6 && hour < 12) return { label: '早上', icon: <WbSunnyIcon sx={{ color: 'gold' }} /> }
  if (hour === 12) return { label: '中午', icon: <BrightnessHighIcon sx={{ color: '#ffb74d' }} /> }
  if (hour > 12 && hour < 18)
    return { label: '下午', icon: <WbTwilightIcon sx={{ color: '#f16a1c' }} /> }
  if (hour >= 18 && hour < 20)
    return { label: '傍晚', icon: <BedtimeIcon sx={{ color: '#ff8a65' }} /> }
  return { label: '晚上', icon: <NightsStayIcon sx={{ color: '#78909c' }} /> }
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

function buildPayload(f: any): QueryPayload {
  let start: string | null = null
  let end: string | null = null
  if (f.rangeKey === 'custom' && f.startDate && f.endDate) {
    start = new Date(f.startDate).toISOString()
    end = new Date(f.endDate).toISOString()
  }
  return {
    myClassIds: (f.my ?? []).map((c: any) => String(c.id)),
    oppoClassIds: (f.oppo ?? []).map((c: any) => String(c.id)),
    mode: f.mode ?? null,
    rangeKey: f.rangeKey,
    start,
    end,
    myDeckIds: (f.decks ?? []).map((d: any) => Number(d.id)),
    tagIds: (f.tags ?? []).map((t: any) => Number(t.id)),
    note: f.note ?? 'any',
    crMin: f.crEnabled && typeof f.crMin === 'number' ? f.crMin : null,
    crMax: f.crEnabled && typeof f.crMax === 'number' ? f.crMax : null
  }
}

/** 額外資料：避免 N+1 改為列表載入後批次抓 */
type MatchExtras = { tags: { id: number; name: string }[]; note: string | null }
type MatchRow = Match & {
  my_deck?: Deck | null
  oppo_deck?: Deck | null
  tags?: { tag: { id: number; name: string } }[]
}

function buildExtrasMap(rows: MatchRow[]): Record<number, MatchExtras> {
  const map: Record<number, MatchExtras> = {}
  rows.forEach((row) => {
    map[row.id] = {
      tags: (row.tags ?? []).map((x) => x.tag),
      note: row.note ?? null
    }
  })
  return map
}

const MatchList = (): React.JSX.Element => {
  const { allDecks, allTags, refreshDecks, refreshTags } = useDecksTags()
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
  const onFiltersChange: OnFiltersChange = (patch) => setFilters((f: any) => ({ ...f, ...patch }))

  const [rows, setRows] = useState<MatchRow[]>([])
  const [totalCount, setTotalCount] = useState<number>(0)
  const [page, setPage] = useState<number>(0)
  const [rowsPerPage, setRowsPerPage] = useState<number>(PAGE_SIZE_OPTIONS[0])
  const debouncedFilters = useDebounced(filters, 200)

  const reqIdRef = useRef(0)
  const filtersRef = useRef(filters)
  useEffect(() => void (filtersRef.current = filters), [filters])
  const pageRef = useRef(page)
  useEffect(() => void (pageRef.current = page), [page])
  const rowsPerPageRef = useRef(rowsPerPage)
  useEffect(() => void (rowsPerPageRef.current = rowsPerPage), [rowsPerPage])
  const filterQueryKeyRef = useRef('')

  // 編輯 / 刪除
  const [editId, setEditId] = useState<number | null>(null)
  const [confirmDelete, setConfirmDelete] = useState<{ open: boolean; id: number | null }>({
    open: false,
    id: null
  })

  // 展開狀態與 extras（一次抓）
  const [openRows, setOpenRows] = useState<Set<number>>(new Set())
  const [extrasMap, setExtrasMap] = useState<Record<number, MatchExtras>>({})

  // IPC helpers
  const fetchFilteredCount = async (f: any): Promise<void> => {
    const payload = buildPayload(f)
    const count: number = await window.electron?.ipcRenderer.invoke('matches:count', payload)
    setTotalCount(count)
  }

  const fetchPage = async (pageIndex: number, pageSize: number, f: any): Promise<void> => {
    const currentReq = ++reqIdRef.current
    const payload = { pageIndex, pageSize, ...buildPayload(f) }
    const data: MatchRow[] = await window.electron?.ipcRenderer.invoke('matches:getPage', payload)
    if (currentReq === reqIdRef.current) {
      setRows(data)
      setExtrasMap(buildExtrasMap(data))
    }
  }

  // 初始、變更條件 → 重算總數。條件變更時先回到第一頁，避免重複查詢。
  useEffect(() => {
    const queryKey = JSON.stringify({ filters: debouncedFilters, rowsPerPage })
    const queryChanged = filterQueryKeyRef.current !== queryKey
    if (!queryChanged) return
    if (page !== 0) {
      setPage(0)
      return
    }

    filterQueryKeyRef.current = queryKey
    fetchFilteredCount(debouncedFilters)
  }, [debouncedFilters, rowsPerPage, page])

  // 換頁只需要重抓當頁資料，不需要重算 count。
  useEffect(() => {
    fetchPage(page, rowsPerPage, debouncedFilters)
  }, [page, rowsPerPage, debouncedFilters])

  // 外部通知需要重撈
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

  /** 展開開關（含只在有資料時才可展開） */
  const toggleRow = (id: number, enable: boolean) => {
    if (!enable) return
    setOpenRows((prev) => {
      const next = new Set(prev)
      next.has(id) ? next.delete(id) : next.add(id)
      return next
    })
  }

  /** 時間 cell 內容（固定不換行） */
  const renderTime = (playedAt: Date | string) => {
    const dt = new Date(playedAt)
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
      <Box
        component="span"
        sx={{
          display: 'inline-flex',
          alignItems: 'center',
          gap: 0.5,
          whiteSpace: 'nowrap',
          verticalAlign: 'middle'
        }}
      >
        <span>
          {month}月{day}日
        </span>
        <Box component="span" sx={{ display: 'inline-flex', alignItems: 'center' }}>
          {icon}
        </Box>
        <span>{label}</span>
        <span>
          {hour}:{minute}
        </span>
      </Box>
    )
  }

  /** 是否可展開（有標籤或備註才展示展開 UI） */
  const canExpand = (id: number) => {
    const ex = extrasMap[id]
    return !!(ex && (ex.note || (ex.tags && ex.tags.length > 0)))
  }

  return (
    <Box p={2}>
      {/* {JSON.stringify(allDecks)}
      {JSON.stringify(allTags)} */}
      <SearchBar
        filters={filters}
        onFiltersChange={onFiltersChange}
        deckOptions={allDecks /* e.g., Array<{id,name}> */}
        tagOptions={allTags /* e.g., Array<{id,name}> */}
        refreshDecks={refreshDecks}
        refreshTags={refreshTags}
      />

      {/* 分頁控制 */}
      <Box display="flex" alignItems="center" justifyContent="space-between" mt={1} mb={1.5}>
        <Typography variant="button">
          <Box display={'flex'} alignItems={'center'} gap={2}>
            <Box>
              頁數 {totalCount > 0 ? page + 1 : 0} /{' '}
              {totalCount > 0 ? Math.max(1, Math.ceil(totalCount / rowsPerPage)) : 0}
            </Box>
            <Box display={'flex'} flexDirection={'column'}>
              <Typography variant="caption">左鍵：展開標籤、備註</Typography>
              <Typography variant="caption">右鍵：編輯</Typography>
            </Box>
          </Box>
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
      <TableContainer component={Paper} sx={{ overflowX: 'auto' }}>
        <Table sx={{ tableLayout: 'fixed', minWidth: 1060 }}>
          <TableHead>
            <TableRow>
              <TableCell sx={{ width: COL_W.myClass, textAlign: 'right', whiteSpace: 'nowrap' }}>
                我方職業
              </TableCell>
              <TableCell sx={{ width: COL_W.oppoClass, textAlign: 'right', whiteSpace: 'nowrap' }}>
                對方職業
              </TableCell>
              <TableCell sx={{ width: COL_W.order, textAlign: 'right', whiteSpace: 'nowrap' }}>
                先 / 後攻
              </TableCell>
              <TableCell sx={{ width: COL_W.result, textAlign: 'right', whiteSpace: 'nowrap' }}>
                勝 / 敗
              </TableCell>
              <TableCell sx={{ width: COL_W.mode, textAlign: 'center', whiteSpace: 'nowrap' }}>
                模式
              </TableCell>
              <TableCell sx={{ width: COL_W.bp, textAlign: 'right', whiteSpace: 'nowrap' }}>
                ΔBP
              </TableCell>
              {/* 新增：CR 與 ΔCR */}
              <TableCell sx={{ width: COL_W.cr, textAlign: 'right', whiteSpace: 'nowrap' }}>
                CR
              </TableCell>
              <TableCell sx={{ width: COL_W.crDelta, textAlign: 'right', whiteSpace: 'nowrap' }}>
                ΔCR
              </TableCell>
              <TableCell sx={{ width: COL_W.duration, textAlign: 'center', whiteSpace: 'nowrap' }}>
                時長
              </TableCell>
              <TableCell sx={{ width: COL_W.time, textAlign: 'right', whiteSpace: 'nowrap' }}>
                開始時間
              </TableCell>
              <TableCell sx={{ width: COL_W.actions, textAlign: 'center', whiteSpace: 'nowrap' }}>
                操作
              </TableCell>
            </TableRow>
          </TableHead>
          <TableBody>
            {rows?.map((m) => {
              const expanded = openRows.has(m.id)
              const expandable = canExpand(m.id)

              const bpColor =
                m.bp == null
                  ? 'gray'
                  : Number(m.bp) === 0
                    ? 'text.primary'
                    : Number(m.bp) > 0
                      ? '#00c853'
                      : '#c81f3e'

              // const cr = readCR(m as any)
              // const crDelta = readCRDelta(m as any)
              // const crDeltaColor =
              //   crDelta == null
              //     ? 'gray'
              //     : crDelta === 0
              //       ? 'text.primary'
              //       : crDelta > 0
              //         ? '#00c853'
              //         : '#c81f3e'

              return (
                <React.Fragment key={m.id}>
                  <TableRow
                    sx={{
                      minHeight: 70,
                      height: 70,
                      borderLeft:
                        m.result === null
                          ? '5px solid #f5faf64f'
                          : m.result
                            ? '5px solid #00ff664f'
                            : '5px solid #c81f3daf',
                      position: 'relative',
                      transition: 'background-color 0.3s ease, box-shadow 0.3s ease',
                      '&:hover': {
                        backgroundColor: 'rgba(255, 255, 255, 0.05)', // 柔和高亮
                        boxShadow: '0 2px 8px rgba(0,0,0,0.25)', // 提升立體感
                        cursor: 'pointer'
                      }
                    }}
                    onClick={() => toggleRow(m.id, expandable)}
                    onContextMenu={() => openEdit(m.id)}
                  >
                    {/* 我方職業 + 浮動展開鈕 */}
                    <TableCell
                      sx={{
                        position: 'relative',
                        width: COL_W.myClass,
                        textAlign: 'right',
                        whiteSpace: 'nowrap'
                      }}
                    >
                      {expandable ? (
                        <Box position={'absolute'} left={'5px'}>
                          <IconButton
                            aria-label="expand row"
                            size="small"
                            onClick={(e) => {
                              e.stopPropagation()
                              toggleRow(m.id, expandable)
                            }}
                          >
                            {expanded ? <KeyboardArrowDownIcon /> : <KeyboardArrowRightIcon />}
                          </IconButton>
                        </Box>
                      ) : null}
                      <Typography
                        fontSize="small"
                        sx={{ color: classesMap[m.my_class]?.color }}
                        noWrap
                      >
                        {classesMap[m.my_class]?.label}
                      </Typography>
                      <Typography
                        fontSize="small"
                        color={!m.my_deck?.name ? 'gray' : classesMap[m.my_class].color}
                        sx={{
                          opacity: 0.9,
                          maxWidth: COL_W.myClass - 16,
                          overflow: 'hidden',
                          textOverflow: 'ellipsis',
                          whiteSpace: 'nowrap',
                          ml: 'auto'
                        }}
                        title={m.my_deck?.name || undefined}
                      >
                        {m.my_deck?.name || '未設置'}
                      </Typography>
                    </TableCell>

                    {/* 對方職業 */}
                    <TableCell
                      sx={{ width: COL_W.oppoClass, textAlign: 'right', whiteSpace: 'nowrap' }}
                    >
                      <Typography
                        fontSize="small"
                        sx={{ color: classesMap[m.oppo_class]?.color }}
                        noWrap
                      >
                        {classesMap[m.oppo_class]?.label}
                      </Typography>
                      <Typography
                        fontSize="small"
                        color={!m.oppo_deck?.name ? 'gray' : classesMap[m.oppo_class].color}
                        sx={{
                          opacity: 0.9,
                          maxWidth: COL_W.oppoClass - 16,
                          overflow: 'hidden',
                          textOverflow: 'ellipsis',
                          whiteSpace: 'nowrap',
                          ml: 'auto'
                        }}
                        title={m.oppo_deck?.name || undefined}
                      >
                        {m.oppo_deck?.name || '未設置'}
                      </Typography>
                    </TableCell>

                    {/* 先 / 後攻 */}
                    <TableCell
                      sx={{ width: COL_W.order, textAlign: 'right', whiteSpace: 'nowrap' }}
                    >
                      {m.play_order === 'first' ? (
                        <Box
                          display="flex"
                          alignItems="center"
                          justifyContent="end"
                          sx={{ whiteSpace: 'nowrap' }}
                        >
                          <LooksOneTwoToneIcon fontSize="small" sx={{ mr: 0.5 }} color="primary" />
                          先攻
                        </Box>
                      ) : (
                        <Box
                          display="flex"
                          alignItems="center"
                          justifyContent="end"
                          sx={{ whiteSpace: 'nowrap' }}
                        >
                          <LooksTwoTwoToneIcon
                            fontSize="small"
                            sx={{ mr: 0.5 }}
                            color="secondary"
                          />
                          後攻
                        </Box>
                      )}
                    </TableCell>

                    {/* 勝 / 敗 */}
                    <TableCell
                      sx={{
                        width: COL_W.result,
                        textAlign: 'right',
                        whiteSpace: 'nowrap',
                        color: m.result == null ? 'gray' : m.result ? '#00c853' : '#c81f3e'
                      }}
                    >
                      {m.result === true ? '勝' : m.result === false ? '敗' : '未紀錄'}
                    </TableCell>

                    {/* 模式 */}
                    <TableCell
                      sx={{ width: COL_W.mode, textAlign: 'center', whiteSpace: 'nowrap' }}
                    >
                      {m.mode ? (
                        <Chip
                          variant="outlined"
                          size="small"
                          color={modesMap[m.mode].color}
                          label={modesMap[m.mode].label}
                        />
                      ) : (
                        '—'
                      )}
                    </TableCell>

                    {/* BP */}
                    <TableCell
                      sx={{
                        width: COL_W.bp,
                        textAlign: 'right',
                        whiteSpace: 'nowrap',
                        color: bpColor,
                        fontFamily: 'monospace'
                      }}
                      title={m.bp == null ? '-' : String(m.bp)}
                    >
                      {m.bp ?? '—'}
                    </TableCell>

                    {/* 新增：CR */}
                    <TableCell
                      sx={{
                        width: COL_W.cr,
                        textAlign: 'right',
                        whiteSpace: 'nowrap',
                        fontFamily: 'monospace',
                        color: m.delta_cr === null ? 'gray' : undefined
                      }}
                      // title={cr == null ? '-' : String(cr)}
                    >
                      {m.current_cr ?? '—'}
                    </TableCell>

                    {/* 新增：ΔCR */}
                    <TableCell
                      sx={{
                        width: COL_W.crDelta,
                        textAlign: 'right',
                        whiteSpace: 'nowrap',
                        fontFamily: 'monospace',
                        color:
                          m.delta_cr === null
                            ? 'gray'
                            : Number(m.delta_cr) === 0
                              ? 'text.primary'
                              : Number(m.delta_cr) > 0
                                ? '#00c853'
                                : '#c81f3e'
                      }}
                      // title={crDelta == null ? '-' : String(crDelta)}
                    >
                      {m.delta_cr ?? '—'}
                    </TableCell>

                    {/* 時長 */}
                    <TableCell
                      sx={{ width: COL_W.duration, textAlign: 'center', whiteSpace: 'nowrap' }}
                    >
                      <Chip
                        size="small"
                        sx={{ fontFamily: 'monospace' }}
                        icon={<AccessTimeIcon />}
                        label={
                          m.durationTime != null
                            ? `${Math.floor(m.durationTime / 60)}:${String(m.durationTime % 60).padStart(2, '0')}`
                            : '—'
                        }
                      />
                    </TableCell>

                    {/* 開始時間（固定不換行） */}
                    <TableCell
                      sx={{
                        width: COL_W.time,
                        textAlign: 'right',
                        whiteSpace: 'nowrap',
                        fontFamily: 'monospace'
                      }}
                      title={String(new Date(m.playedAt).toLocaleString())}
                    >
                      {renderTime(m.playedAt)}
                    </TableCell>

                    {/* 操作 */}
                    <TableCell
                      sx={{ width: COL_W.actions, textAlign: 'center', whiteSpace: 'nowrap' }}
                    >
                      <Tooltip title="編輯">
                        <IconButton
                          size="small"
                          onClick={(e) => {
                            e.stopPropagation()
                            openEdit(m.id)
                          }}
                        >
                          <EditIcon fontSize="small" />
                        </IconButton>
                      </Tooltip>
                      <Tooltip title="刪除">
                        <IconButton
                          size="small"
                          color="error"
                          onClick={(e) => {
                            e.stopPropagation()
                            requestDelete(m.id)
                          }}
                        >
                          <DeleteOutlineIcon fontSize="small" />
                        </IconButton>
                      </Tooltip>
                    </TableCell>
                  </TableRow>

                  {/* 展開內容（只有有資料才可能展開） */}
                  {expandable && (
                    <TableRow>
                      {/* colSpan 更新為目前欄位總數：11 */}
                      <TableCell colSpan={11} sx={{ p: 0, bgcolor: 'background.default' }}>
                        <Collapse in={expanded} timeout="auto" unmountOnExit>
                          <Box sx={{ px: 2, py: 1.5 }}>
                            <Stack
                              direction="row"
                              spacing={2}
                              alignItems="flex-start"
                              flexWrap="wrap"
                            >
                              {/* 標籤區 */}
                              <Box>
                                <Typography variant="caption" sx={{ opacity: 0.7 }}>
                                  標籤
                                </Typography>
                                <Box sx={{ mt: 0.5, display: 'flex', gap: 0.5, flexWrap: 'wrap' }}>
                                  {extrasMap[m.id]?.tags?.length ? (
                                    extrasMap[m.id].tags.map((t) => (
                                      <Chip
                                        key={t.id}
                                        size="small"
                                        variant="outlined"
                                        label={t.name}
                                      />
                                    ))
                                  ) : (
                                    <Typography variant="body2" color="text.secondary">
                                      —
                                    </Typography>
                                  )}
                                </Box>
                              </Box>

                              <Divider flexItem orientation="vertical" />

                              {/* 備註區 */}
                              <Box sx={{ minWidth: 240, flex: 1 }}>
                                <Typography variant="caption" sx={{ opacity: 0.7 }}>
                                  備註
                                </Typography>
                                <Typography
                                  variant="body2"
                                  sx={{ mt: 0.5, whiteSpace: 'pre-wrap', wordBreak: 'break-word' }}
                                  color={extrasMap[m.id]?.note ? 'text.primary' : 'text.secondary'}
                                >
                                  {extrasMap[m.id]?.note || '—'}
                                </Typography>
                              </Box>
                            </Stack>
                          </Box>
                        </Collapse>
                      </TableCell>
                    </TableRow>
                  )}
                </React.Fragment>
              )
            })}

            {rows.length === 0 && (
              <TableRow>
                {/* colSpan 同樣對齊 11 欄 */}
                <TableCell colSpan={11} align="center">
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

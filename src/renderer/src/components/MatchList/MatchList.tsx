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
  Typography
} from '@mui/material'
import LooksOneTwoToneIcon from '@mui/icons-material/LooksOneTwoTone'
import LooksTwoTwoToneIcon from '@mui/icons-material/LooksTwoTwoTone'
import WbSunnyIcon from '@mui/icons-material/WbSunny'
import NightsStayIcon from '@mui/icons-material/NightsStay'
import BrightnessHighIcon from '@mui/icons-material/BrightnessHigh'
import WbTwilightIcon from '@mui/icons-material/WbTwilight'
import BedtimeIcon from '@mui/icons-material/Bedtime'
import SunnySnowingIcon from '@mui/icons-material/SunnySnowing'

import { classesMap, modesMap } from '@renderer/map/classMap'
import { Match } from '@prisma/client'
import SearchBar, { Filters as SearchFilters, OnFiltersChange } from './component/SearchBar'

const PAGE_SIZE_OPTIONS = [5, 10]

// 防抖 hook
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
          sx={{ color: '#7986cb', verticalAlign: 'middle', ml: '7px', mr: '4px' }}
        />
      )
    }
  if (hour >= 6 && hour < 12)
    return {
      label: '早上',
      icon: <WbSunnyIcon sx={{ color: 'gold', verticalAlign: 'middle', ml: '7px', mr: '4px' }} />
    }
  if (hour === 12)
    return {
      label: '中午',
      icon: (
        <BrightnessHighIcon
          sx={{ color: '#ffb74d', verticalAlign: 'middle', ml: '7px', mr: '4px' }}
        />
      )
    }
  if (hour > 12 && hour < 18)
    return {
      label: '下午',
      icon: (
        <WbTwilightIcon sx={{ color: '#f16a1c', verticalAlign: 'middle', ml: '7px', mr: '4px' }} />
      )
    }
  if (hour >= 18 && hour < 20)
    return {
      label: '傍晚',
      icon: <BedtimeIcon sx={{ color: '#ff8a65', verticalAlign: 'middle', ml: '7px', mr: '4px' }} />
    }
  return {
    label: '晚上',
    icon: (
      <NightsStayIcon sx={{ color: '#78909c', verticalAlign: 'middle', ml: '7px', mr: '4px' }} />
    )
  }
}

const MatchList = (): React.JSX.Element => {
  // 1) 狀態
  const today = new Date()
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

  const [filters, setFilters] = useState<SearchFilters>({
    my: [],
    oppo: [],
    mode: null, // 預設不限
    rangeKey: 'today',
    startDate: startOf(today),
    endDate: endOf(today)
  })

  const onFiltersChange: OnFiltersChange = (patch) => setFilters((f) => ({ ...f, ...patch }))

  const [rows, setRows] = useState<Match[]>([])
  const [totalCount, setTotalCount] = useState<number>(0)
  const [page, setPage] = useState<number>(0)
  const [rowsPerPage, setRowsPerPage] = useState<number>(PAGE_SIZE_OPTIONS[0])

  // 2) 防抖 / 競態
  const debouncedFilters = useDebounced(filters, 200)
  const reqIdRef = useRef(0)

  // 3) Refs 給外部 refetch 使用
  const filtersRef = useRef(filters)
  const pageRef = useRef(page)
  const rowsPerPageRef = useRef(rowsPerPage)
  useEffect(() => {
    filtersRef.current = filters
  }, [filters])
  useEffect(() => {
    pageRef.current = page
  }, [page])
  useEffect(() => {
    rowsPerPageRef.current = rowsPerPage
  }, [rowsPerPage])

  // 4) IPC 呼叫
  const fetchFilteredCount = async (f: SearchFilters): Promise<void> => {
    const myIds = f.my.map((c) => c.id)
    const oppoIds = f.oppo.map((c) => c.id)
    try {
      // mode 允許 null
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
    } catch (err) {
      console.error('[MatchList] count error:', err)
    }
  }

  const fetchPage = async (
    pageIndex: number,
    pageSize: number,
    f: SearchFilters
  ): Promise<void> => {
    const myIds = f.my.map((c) => c.id)
    const oppoIds = f.oppo.map((c) => c.id)
    const currentReq = ++reqIdRef.current
    try {
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

      // 只有最後一次請求可以寫入
      if (currentReq === reqIdRef.current) setRows(data)
    } catch (err) {
      console.error('[MatchList] fetchPage error:', err)
    }
  }

  // 5) filters / page 驅動資料
  useEffect(() => {
    // filters 或 page size 改變：重置 page=0 + 抓第一頁
    setPage(0)
    fetchFilteredCount(debouncedFilters)
    fetchPage(0, rowsPerPage, debouncedFilters)
  }, [debouncedFilters, rowsPerPage])

  useEffect(() => {
    // 只換頁
    fetchPage(page, rowsPerPage, debouncedFilters)
  }, [page])

  // 6) 外部觸發重抓
  useEffect(() => {
    const handler = (): void => {
      fetchPage(pageRef.current, rowsPerPageRef.current, filtersRef.current)
    }
    const unsub = window.electron?.ipcRenderer.on('matches:needRefetch', handler)
    return () => {
      unsub && unsub()
    }
  }, [])

  // 7) Handlers
  const handleChangePage = (_: unknown, newPage: number): void => setPage(newPage)
  const handleChangeRowsPerPage = (e: ChangeEvent<HTMLInputElement>): void => {
    setRowsPerPage(+e.target.value)
    setPage(0)
  }

  const totalPages = Math.max(1, Math.ceil(totalCount / rowsPerPage))

  return (
    <Box p={2}>
      <SearchBar filters={filters} onFiltersChange={onFiltersChange} />

      {/* 分頁控制 */}
      <Box display="flex" alignItems="center" justifyContent="space-between">
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
              <TableCell sx={{ textAlign: 'right' }}>遊戲時長</TableCell>
              <TableCell sx={{ textAlign: 'right' }}>開始時間</TableCell>
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
                    {classesMap[m.my_class]?.label}
                  </TableCell>
                  <TableCell sx={{ textAlign: 'right', color: classesMap[m.oppo_class]?.color }}>
                    {classesMap[m.oppo_class]?.label}
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
                  <TableCell
                    sx={{
                      textAlign: 'right',
                      fontFamily: 'monospace',
                      color: m.durationTime == null ? 'gray' : undefined
                    }}
                  >
                    {m.durationTime
                      ? (() => {
                          const minutes = Math.floor(m.durationTime / 60)
                          const seconds = Math.floor(m.durationTime % 60)
                          return `${minutes}:${String(seconds).padStart(2, '0')}`
                        })()
                      : '無法統計'}
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
                </TableRow>
              ))}
            {rows.length === 0 && (
              <TableRow>
                <TableCell colSpan={8} align="center">
                  無符合資料
                </TableCell>
              </TableRow>
            )}
          </TableBody>
        </Table>
      </TableContainer>
    </Box>
  )
}

export default MatchList

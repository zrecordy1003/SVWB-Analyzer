import React, { useEffect, useState, useRef, ChangeEvent } from 'react'
import {
  Box,
  Table,
  TableBody,
  TableCell,
  TableContainer,
  TableHead,
  TableRow,
  Paper,
  TablePagination,
  TextField,
  Autocomplete
} from '@mui/material'
import LooksOneTwoToneIcon from '@mui/icons-material/LooksOneTwoTone'
import LooksTwoTwoToneIcon from '@mui/icons-material/LooksTwoTwoTone'

import { classes, classesMap, modes } from '@renderer/map/classMap'
import { Match } from '@prisma/client'

type ClassType = (typeof classes)[number]

const PAGE_SIZE_OPTIONS = [5, 10, 20]

const MatchList = (): React.JSX.Element => {
  // 資料與狀態
  const [rows, setRows] = useState<Match[]>([])
  const [totalCount, setTotalCount] = useState<number>(0)
  const [filterMy, setFilterMy] = useState<string>('')
  const [filterOppo, setFilterOppo] = useState<string>('')
  const [filterModes, setFilterModes] = useState<string>('ranked')
  const [page, setPage] = useState<number>(0)
  const [rowsPerPage, setRowsPerPage] = useState<number>(PAGE_SIZE_OPTIONS[0])
  const [cursorMap, setCursorMap] = useState<Record<number, number>>({})

  const filterMyRef = useRef(filterMy)
  const filterOppoRef = useRef(filterOppo)
  const filterModesRef = useRef(filterModes)

  useEffect(() => {
    filterMyRef.current = filterMy
    filterOppoRef.current = filterOppo
  }, [filterMy, filterOppo])

  // 快取 page & rowsPerPage ，供單次 listener 使用
  const pageRef = useRef(page)
  const rowsPerPageRef = useRef(rowsPerPage)

  useEffect(() => {
    pageRef.current = page
  }, [page])
  useEffect(() => {
    rowsPerPageRef.current = rowsPerPage
  }, [rowsPerPage])

  // 從後端取得 filter 過後的總筆數
  const fetchFilteredCount = async (
    myFilter: string,
    oppoFilter: string,
    filterModes: string
  ): Promise<void> => {
    try {
      const count: number = await window.electron.ipcRenderer.invoke(
        'matches:count',
        myFilter,
        oppoFilter,
        filterModes
      )
      setTotalCount(count)
    } catch (err) {
      console.error('[MatchList] count error:', err)
    }
  }

  // 從後端取得 filter 過後 + cursor-pagination 的分頁資料
  const fetchCursorPage = async (
    pageIndex: number,
    pageSize: number,
    myFilter: string,
    oppoFilter: string,
    filterModes: string
  ): Promise<void> => {
    try {
      const cursorId = pageIndex > 0 ? cursorMap[pageIndex] : undefined
      const data: Match[] = await window.electron.ipcRenderer.invoke(
        'matches:getAll',
        pageSize,
        cursorId,
        myFilter,
        oppoFilter,
        filterModes
      )
      setRows(data)
      // 更新下一頁 cursor
      if (data.length > 0) {
        setCursorMap((prev) => ({
          ...prev,
          [pageIndex + 1]: data[data.length - 1].id
        }))
      }
    } catch (err) {
      console.error('[MatchList] fetchCursorPage error:', err)
    }
  }

  // 當 filter 或 rowsPerPage 改變時：重設 page、fetch count & 第一頁資料
  useEffect(() => {
    setPage(0)
    fetchFilteredCount(filterMy, filterOppo, filterModes)
    fetchCursorPage(0, rowsPerPage, filterMy, filterOppo, filterModes)
  }, [filterMy, filterOppo, filterModes, rowsPerPage])

  // page 改變時：fetch 對應頁資料
  useEffect(() => {
    fetchCursorPage(page, rowsPerPage, filterMy, filterOppo, filterModes)
  }, [page])

  // 單次註冊的 IPC listener，用於外部觸發重抓
  useEffect(() => {
    const handler = (): void => {
      // 取用最新的 page, rowsPerPage, filter
      fetchCursorPage(
        pageRef.current,
        rowsPerPageRef.current,
        filterMyRef.current,
        filterOppoRef.current,
        filterModesRef.current
      )
    }

    const unsubscribeRefetch = window.electron.ipcRenderer.on('matches:needRefetch', handler)
    return () => {
      unsubscribeRefetch()
    }
  }, [])

  // Handlers
  const handleChangePage = (_: unknown, newPage: number): void => setPage(newPage)
  const handleChangeRowsPerPage = (e: ChangeEvent<HTMLInputElement>): void =>
    setRowsPerPage(+e.target.value)

  return (
    <Box p={2}>
      {/* 篩選輸入 */}
      <Box mb={2} display="flex" gap={2}>
        {/* 我的職業 */}
        <Autocomplete<ClassType, false, false, false>
          options={classes}
          getOptionLabel={(option) => option.label}
          isOptionEqualToValue={(opt, val) => opt.name === val.name}
          value={classes.find((c) => c.name === filterMy) || null}
          onChange={(_, newVal) => {
            setFilterMy(newVal?.name ?? '')
          }}
          renderInput={(params) => (
            <TextField {...params} label="我方職業" size="small" variant="outlined" />
          )}
          sx={{ width: 200 }}
        />

        {/* 對手職業 */}
        <Autocomplete<ClassType, false, false, false>
          options={classes}
          getOptionLabel={(option) => option.label}
          isOptionEqualToValue={(opt, val) => opt.name === val.name}
          value={classes.find((c) => c.name === filterOppo) || null}
          onChange={(_, newVal) => {
            setFilterOppo(newVal?.name ?? '')
          }}
          renderInput={(params) => (
            <TextField {...params} label="對方職業" size="small" variant="outlined" />
          )}
          sx={{ width: 200 }}
        />

        {/* 模式 */}
        <Autocomplete
          options={modes}
          getOptionLabel={(option) => option}
          isOptionEqualToValue={(opt, val) => opt === val}
          value={modes.find((c) => c === filterModes) || null}
          onChange={(_, newVal) => {
            setFilterModes(newVal ?? '')
          }}
          renderInput={(params) => (
            <TextField {...params} label="模式" size="small" variant="outlined" />
          )}
          sx={{ width: 200 }}
        />
      </Box>

      {/* 資料表格 */}
      <TableContainer component={Paper} sx={{ minHeight: 200 }}>
        <Table size="small">
          <TableHead>
            <TableRow>
              <TableCell sx={{ textAlign: 'right' }}>我方職業</TableCell>
              <TableCell sx={{ textAlign: 'right' }}>對方職業</TableCell>
              <TableCell sx={{ textAlign: 'right' }}>先 / 後攻</TableCell>
              <TableCell sx={{ textAlign: 'right' }}>勝 / 敗</TableCell>
              <TableCell sx={{ textAlign: 'right' }}>模式</TableCell>
              <TableCell sx={{ textAlign: 'right' }}>BP</TableCell>
              <TableCell sx={{ textAlign: 'right' }}>遊戲時長</TableCell>
              <TableCell sx={{ textAlign: 'right' }}>開始時間</TableCell>
              {/* <TableCell>結束時間</TableCell> */}
            </TableRow>
          </TableHead>
          <TableBody>
            {rows &&
              rows.map((m) => (
                <TableRow
                  key={m.id}
                  sx={{
                    borderLeft:
                      m.result === null
                        ? '5px solid #f5faf64f'
                        : m.result === true
                          ? '5px solid #00ff664f'
                          : '5px solid #c81f3daf'
                    // backgroundColor: m.result === true ? '#00ff664f' : '#df7488ef'
                  }}
                >
                  <TableCell sx={{ textAlign: 'right' }}>{classesMap[m.my_class]?.label}</TableCell>
                  <TableCell sx={{ textAlign: 'right' }}>
                    {classesMap[m.oppo_class]?.label}
                  </TableCell>
                  <TableCell sx={{ textAlign: 'right' }}>
                    {m.play_order === 'first' ? (
                      <Box display={'flex'} alignItems={'center'} justifyContent={'end'}>
                        <LooksOneTwoToneIcon fontSize="small" sx={{ mr: 0.5 }} color="primary" />
                        先攻
                      </Box>
                    ) : (
                      <Box display={'flex'} alignItems={'center'} justifyContent={'end'}>
                        <LooksTwoTwoToneIcon fontSize="small" sx={{ mr: 0.5 }} color="secondary" />
                        後攻
                      </Box>
                    )}
                  </TableCell>
                  <TableCell
                    sx={{
                      textAlign: 'right',
                      color: m.result === null ? 'gray' : null
                    }}
                  >
                    {m.result === true ? '勝利' : m.result === false ? '' : '未紀錄'}
                  </TableCell>
                  <TableCell
                    sx={{
                      textAlign: 'right'
                    }}
                  >
                    {m.mode ? m.mode : '-'}
                  </TableCell>
                  <TableCell
                    sx={{
                      textAlign: 'right'
                    }}
                  >
                    {m.bp ? m.bp : '-'}
                  </TableCell>
                  <TableCell
                    sx={{
                      textAlign: 'right',
                      fontFamily: 'monospace',
                      color: m.durationTime === null ? 'gray' : null
                    }}
                  >
                    {m.durationTime
                      ? (() => {
                          const durationTime = m.durationTime
                          const minutes = Math.floor(durationTime / 60)
                          const seconds = Math.floor(durationTime % 60)
                          const secStr = seconds.toString().padStart(2, '0')
                          return `${minutes}:${secStr}`
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
                        hour12: true
                      }).formatToParts(dt)

                      // 從 parts 裡各別抓值
                      const month = parts.find((p) => p.type === 'month')?.value
                      const day = parts.find((p) => p.type === 'day')?.value
                      const period = parts.find((p) => p.type === 'dayPeriod')?.value // 上午/下午
                      const hour = parts.find((p) => p.type === 'hour')?.value
                      const minute = parts.find((p) => p.type === 'minute')?.value

                      // 組合字串
                      return `${month}月${day}日 ${period} ${hour}:${minute}`
                    })()}
                  </TableCell>
                  {/* <TableCell>{m.endedAt ? new Date(m.endedAt).toLocaleString() : '-'}</TableCell> */}
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

      {/* 分頁控制 */}
      <TablePagination
        component="div"
        count={totalCount}
        page={page}
        onPageChange={handleChangePage}
        rowsPerPage={rowsPerPage}
        onRowsPerPageChange={handleChangeRowsPerPage}
        rowsPerPageOptions={PAGE_SIZE_OPTIONS}
        labelRowsPerPage={'每頁筆數'}
        labelDisplayedRows={({ from, to }) => `${from} ~ ${to} 共 ${totalCount} 筆`}
      />
    </Box>
  )
}

export default MatchList

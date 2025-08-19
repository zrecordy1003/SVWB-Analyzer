import React, { useEffect, useState, useRef, ChangeEvent, useMemo } from 'react'
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
  Autocomplete,
  Chip,
  Typography,
  useTheme,
  Checkbox
} from '@mui/material'

import LooksOneTwoToneIcon from '@mui/icons-material/LooksOneTwoTone'
import LooksTwoTwoToneIcon from '@mui/icons-material/LooksTwoTwoTone'
import WbSunnyIcon from '@mui/icons-material/WbSunny'
import NightsStayIcon from '@mui/icons-material/NightsStay'
import BrightnessHighIcon from '@mui/icons-material/BrightnessHigh'
import WbTwilightIcon from '@mui/icons-material/WbTwilight'
import BedtimeIcon from '@mui/icons-material/Bedtime'
import SunnySnowingIcon from '@mui/icons-material/SunnySnowing'

import { classes, classesMap, modes, modesMap } from '@renderer/map/classMap'
import { Match } from '@prisma/client'
import { DatePicker, LocalizationProvider } from '@mui/x-date-pickers'
import { AdapterDateFns } from '@mui/x-date-pickers/AdapterDateFns'
import { zhTW as pickersZhTW } from '@mui/x-date-pickers/locales'
import { zhTW as dfZhTW } from 'date-fns/locale'

type ClassType = (typeof classes)[number]

const PAGE_SIZE_OPTIONS = [5, 10]

const translations = {
  startDateLabel: '開始日期',
  endDateLabel: '結束日期'
}

const getPeriodByHour = (hour: number | undefined): { label: string; icon: React.JSX.Element } => {
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
        <WbTwilightIcon
          sx={{ color: '#f16a1cff', verticalAlign: 'middle', ml: '7px', mr: '4px' }}
        />
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
  // 資料與狀態
  const [rows, setRows] = useState<Match[]>([])
  const [totalCount, setTotalCount] = useState<number>(0)
  const [filterMy, setFilterMy] = useState<ClassType[]>([])
  const [filterOppo, setFilterOppo] = useState<ClassType[]>([])
  const [filterModes, setFilterModes] = useState<string>('ranked')
  const [page, setPage] = useState<number>(0)
  const [rowsPerPage, setRowsPerPage] = useState<number>(PAGE_SIZE_OPTIONS[0])

  const filterMyRef = useRef(filterMy)
  const filterOppoRef = useRef(filterOppo)
  const filterModesRef = useRef(filterModes)

  const today = new Date()
  const [startDate, setStartDate] = useState<Date | null>(
    new Date(today.getFullYear(), today.getMonth(), today.getDate(), 0, 0, 0, 0)
  )
  const [endDate, setEndDate] = useState<Date | null>(
    new Date(today.getFullYear(), today.getMonth(), today.getDate(), 23, 59, 59, 999)
  )

  const [openStart, setOpenStart] = useState(false)
  const [openEnd, setOpenEnd] = useState(false)

  useEffect(() => {
    filterMyRef.current = filterMy
    filterOppoRef.current = filterOppo
    filterModesRef.current = filterModes
  }, [filterMy, filterOppo, filterModes])

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
    myFilter: ClassType[],
    oppoFilter: ClassType[],
    modeValue: string,
    start: Date | null,
    end: Date | null
  ): Promise<void> => {
    try {
      const count: number = await window.electron?.ipcRenderer.invoke(
        'matches:count',
        myFilter.map((c) => c.id),
        oppoFilter.map((c) => c.id),
        modeValue,
        start,
        end
      )
      setTotalCount(count)
    } catch (err) {
      console.error('[MatchList] count error:', err)
    }
  }

  // Offset 分頁抓取
  const fetchPage = async (
    pageIndex: number,
    pageSize: number,
    myFilter: ClassType[],
    oppoFilter: ClassType[],
    modeValue: string,
    start: Date | null,
    end: Date | null
  ): Promise<void> => {
    try {
      const data: Match[] = await window.electron?.ipcRenderer.invoke(
        'matches:getPage',
        pageIndex,
        pageSize,
        myFilter.map((c) => c.id),
        oppoFilter.map((c) => c.id),
        modeValue,
        start,
        end
      )
      setRows(data)
    } catch (err) {
      console.error('[MatchList] fetchPage error:', err)
    }
  }

  // 當 filter 或 rowsPerPage 改變時：重設 page、fetch count & 第一頁資料
  useEffect(() => {
    setPage(0)
    fetchFilteredCount(filterMy, filterOppo, filterModes, startDate, endDate)
    fetchPage(0, rowsPerPage, filterMy, filterOppo, filterModes, startDate, endDate)
  }, [filterMy, filterOppo, filterModes, startDate, endDate, rowsPerPage])

  // page 改變時：fetch 對應頁資料
  useEffect(() => {
    fetchPage(page, rowsPerPage, filterMy, filterOppo, filterModes, startDate, endDate)
  }, [page])

  // 外部觸發重抓
  useEffect(() => {
    const handler = (): void => {
      fetchPage(
        pageRef.current,
        rowsPerPageRef.current,
        filterMyRef.current,
        filterOppoRef.current,
        filterModesRef.current,
        startDate,
        endDate
      )
    }

    const unsubscribeRefetch = window.electron?.ipcRenderer.on('matches:needRefetch', handler)
    return () => {
      unsubscribeRefetch()
    }
  }, [])

  // Handlers
  const handleChangePage = (_: unknown, newPage: number): void => setPage(newPage)
  const handleChangeRowsPerPage = (e: ChangeEvent<HTMLInputElement>): void => {
    setRowsPerPage(+e.target.value)
    setPage(0) // EN: reset to first page when page size changes
  }

  const datePickerStyle = useMemo(
    () => ({
      day: {
        sx: {
          '&.MuiPickersDay-dayOutsideMonth': {
            opacity: 0.35
          },
          '&.Mui-disabled': {
            opacity: 1,
            color: 'text.disabled',
            backgroundColor: 'rgba(255,255,255,0.06)',
            border: '1px dashed',
            borderColor: 'divider',
            position: 'relative'
          },
          '&.Mui-selected.Mui-disabled': {
            backgroundColor: 'action.disabledBackground',
            color: 'text.disabled'
          }
        }
      }
    }),
    []
  )

  const theme = useTheme()
  const modePaletteKey = modesMap[filterModes]?.color || 'primary'
  const inputColor = theme.palette[modePaletteKey].main

  const totalPages = Math.max(1, Math.ceil(totalCount / rowsPerPage))

  return (
    <Box p={2}>
      {/* 篩選輸入 */}
      <Box mb={2} display="flex" gap={2}>
        {/* 我方職業 */}
        <Autocomplete
          openText=""
          multiple
          disableCloseOnSelect
          options={classes}
          getOptionLabel={(option) => option.label}
          isOptionEqualToValue={(opt, val) => opt.id === val.id}
          value={filterMy}
          onChange={(_, newVal) => setFilterMy(newVal)}
          renderInput={(params) => <TextField {...params} label="我方職業" variant="outlined" />}
          renderOption={(props, option, { selected }) => (
            <li {...props}>
              <Checkbox
                checked={selected}
                size="small"
                sx={{
                  color: option.color,
                  '&.Mui-checked': {
                    color: option.color
                  }
                }}
              />
              <Typography color={option.color}>{option.label}</Typography>
            </li>
          )}
          renderTags={(value, getTagProps) => {
            const limit = 2
            const visibleTags = value.slice(0, limit)
            const extraCount = value.length - limit

            return [
              ...visibleTags.map((option, index) => (
                <Chip
                  // @ts-ignore key
                  key={option.name}
                  label={option.label}
                  {...getTagProps({ index })}
                  sx={{
                    background: `${option.color}22`,
                    color: option.color,
                    fontWeight: 600,
                    borderRadius: '1.3em',
                    marginRight: 0.5,
                    marginBottom: 0.5,
                    fontSize: '0.95em',
                    border: 'none'
                  }}
                />
              )),
              extraCount > 0 && <Chip key="extra" label={`+${extraCount}`} />
            ].filter(Boolean)
          }}
          slotProps={{
            listbox: {
              sx: {
                maxHeight: 'none'
              }
            }
          }}
          sx={{ minWidth: 347 }}
        />

        {/* 對方職業 */}
        <Autocomplete
          openText=""
          multiple
          disableCloseOnSelect
          options={classes}
          getOptionLabel={(option) => option.label}
          isOptionEqualToValue={(opt, val) => opt.id === val.id}
          value={filterOppo}
          onChange={(_, newVal) => setFilterOppo(newVal)}
          renderInput={(params) => <TextField {...params} label="對方職業" variant="outlined" />}
          renderOption={(props, option, { selected }) => (
            <li {...props}>
              <Checkbox
                checked={selected}
                size="small"
                sx={{
                  color: option.color,
                  '&.Mui-checked': {
                    color: option.color
                  }
                }}
              />
              <Typography color={option.color}>{option.label}</Typography>
            </li>
          )}
          renderTags={(value, getTagProps) => {
            const limit = 2
            const visibleTags = value.slice(0, limit)
            const extraCount = value.length - limit

            return [
              ...visibleTags.map((option, index) => (
                <Chip
                  // @ts-ignore key
                  key={option.name}
                  label={option.label}
                  {...getTagProps({ index })}
                  sx={{
                    background: `${option.color}22`,
                    color: option.color,
                    fontWeight: 600,
                    borderRadius: '1.3em',
                    marginRight: 0.5,
                    marginBottom: 0.5,
                    fontSize: '0.95em',
                    border: 'none'
                  }}
                />
              )),
              extraCount > 0 && <Chip key="extra" label={`+${extraCount}`} />
            ].filter(Boolean)
          }}
          slotProps={{
            listbox: {
              sx: {
                maxHeight: 'none'
              }
            }
          }}
          sx={{ minWidth: 347 }}
        />

        {/* 模式 */}
        <Autocomplete
          openText=""
          options={modes}
          getOptionLabel={(opt) => opt.label}
          isOptionEqualToValue={(opt, val) => opt.id === val.id}
          value={modes.find((opt) => opt.id === filterModes) || null}
          onChange={(_, newVal) => setFilterModes(newVal?.id ?? '')}
          renderInput={(params) => (
            <TextField
              {...params}
              label="模式"
              variant="outlined"
              sx={{
                '& .MuiInputBase-input': {
                  color: inputColor
                }
              }}
            />
          )}
          renderOption={(props, option) => (
            <li {...props}>
              <Box component="span" />
              <Typography color={option.color}>{option.label}</Typography>
            </li>
          )}
          sx={{ width: 200 }}
        />
      </Box>

      {/* 日期區間 */}
      <Box display={'flex'} gap={2}>
        <Box>
          <LocalizationProvider
            dateAdapter={AdapterDateFns}
            adapterLocale={dfZhTW}
            localeText={pickersZhTW.components.MuiLocalizationProvider.defaultProps.localeText}
          >
            <DatePicker
              reduceAnimations
              label={translations.startDateLabel}
              value={startDate}
              open={openStart}
              onOpen={() => setOpenStart(true)}
              onClose={() => setOpenStart(false)}
              onChange={(date) => setStartDate(date)}
              format="yyyy/MM/dd"
              disableFuture
              slotProps={{
                ...datePickerStyle,
                textField: {
                  fullWidth: true,
                  onClick: () => setOpenStart(true)
                },
                popper: { keepMounted: true }
              }}
            />
          </LocalizationProvider>
        </Box>
        <Box>
          <LocalizationProvider
            dateAdapter={AdapterDateFns}
            adapterLocale={dfZhTW}
            localeText={pickersZhTW.components.MuiLocalizationProvider.defaultProps.localeText}
          >
            <DatePicker
              reduceAnimations
              label={translations.endDateLabel}
              value={endDate}
              open={openEnd}
              onOpen={() => setOpenEnd(true)}
              onClose={() => setOpenEnd(false)}
              onChange={(date) => setEndDate(date)}
              format="yyyy/MM/dd"
              disableFuture
              slotProps={{
                ...datePickerStyle,
                textField: {
                  fullWidth: true,
                  onClick: () => setOpenEnd(true)
                },
                popper: { keepMounted: true }
              }}
            />
          </LocalizationProvider>
        </Box>
      </Box>

      {/* 分頁控制 */}
      <Box display={'flex'} alignItems={'center'} justifyContent={'space-between'}>
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
          labelRowsPerPage={'每頁筆數'}
          labelDisplayedRows={({ from, to }) => `${from} - ${to} 共 ${totalCount} 筆`}
          showFirstButton
          showLastButton
        />
      </Box>

      {/* 資料表格 */}
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
                    borderLeft:
                      m.result === null
                        ? '5px solid #f5faf64f'
                        : m.result === true
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
                      color:
                        m.result === null ? 'gray' : m.result === true ? ' #00ff668c' : ' #c81f3ede'
                    }}
                  >
                    {m.mode === 'custom'
                      ? '不支援'
                      : m.result === true
                        ? '勝'
                        : m.result === false
                          ? '敗'
                          : '未紀錄'}
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
                      color: m.bp ? null : 'gray',
                      fontFamily: 'monospace'
                    }}
                  >
                    {m.bp ? m.bp : '-'}
                  </TableCell>
                  <TableCell
                    sx={{
                      textAlign: 'right',
                      fontFamily: 'monospace',
                      color: m.durationTime === null ? 'gray' : m.mode === 'custom' ? 'gray' : null
                    }}
                    title={m.mode === 'custom' ? '自訂對戰不支援' : ''}
                  >
                    {m.durationTime
                      ? m.mode === 'custom'
                        ? '不支援'
                        : (() => {
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
                        <Box display={'flex'} justifyContent={'end'} alignItems={'center'}>
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

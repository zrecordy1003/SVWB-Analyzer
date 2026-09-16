/**
 * 環境 - 所有使用者的對局彙總後的大環境數據。
 *
 * 這是 app 裡唯一一頁畫的不是使用者自己的資料。分析器回答「我打得怎麼樣」，
 * 這頁回答「現在大家在打什麼、哪個職業強」- 資料來自公開端點 `/v1/meta`，
 * 由 `src/main/ipc/meta.ts` 代為讀取（那支檔案說明了為什麼它不跟著上傳開關走）。
 *
 * 由上而下三塊，順序就是信任的順序：
 *
 * 1. **這份資料有多大**：幾位使用者、幾場觀測、統計窗多長。放在最上面是因為
 *    底下每一個百分比的意義都由它決定，而一個統計頁最容易犯的錯就是先給結論
 *    再讓人自己去找樣本數。
 * 2. **職業層級**：環境佔比畫成一個環，旁邊一張表列各職業勝率（95% 區間收在
 *    勝率的 hover 裡）。環與表共用一個 highlight，滑過任何一邊另一邊會亮。
 * 3. **對位層級**：選一個職業，看它對七個職業的先後手勝率 - 直接用分析器那張
 *    熱圖／長條圖，只是資料換成環境的。計畫 P6 就是這樣寫的：門檻與畫法只能有
 *    一套，否則同一個 52% 在兩頁會讀成兩件事。
 *
 * 伺服器自己附帶的 `caveats` 收在工具列時間戳旁邊的 ⓘ 裡。那幾句不是免責聲明
 * 樣板，是這份資料真正的邊界（樣本是誰、為什麼會重複計、為什麼不能分段位），
 * 所以它們跟著資料走，不寫死在這裡 - 伺服器改了規則，這頁說的話就跟著改。
 * 它們曾經是頁尾一整塊散文，搬進 hover 是因為那是這頁唯一沒有人會讀第二次的
 * 段落；搬走而不是刪掉，是因為少了它們，數字看起來會比實際上更乾淨。
 */
import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import {
  Alert,
  Box,
  Button,
  Collapse,
  Divider,
  IconButton,
  Paper,
  Skeleton,
  Tooltip,
  Typography
} from '@mui/material'
import AlignHorizontalLeftIcon from '@mui/icons-material/AlignHorizontalLeft'
import ExpandMoreRoundedIcon from '@mui/icons-material/ExpandMoreRounded'
import PublicOutlinedIcon from '@mui/icons-material/PublicOutlined'
import RefreshIcon from '@mui/icons-material/Refresh'
import TableChartOutlinedIcon from '@mui/icons-material/TableChartOutlined'

import EmptyState from '@renderer/components/Common/EmptyState'
import InfoHint from '@renderer/components/Common/InfoHint'
import SegmentedControl from '@renderer/components/Common/SegmentedControl'
import { ClassSelect } from '@renderer/components/Common/filters/ClassSelect'
import MatchupBars from '@renderer/components/Analyzer/component/MatchupBars'
import MatchupHeatmap from '@renderer/components/Analyzer/component/MatchupHeatmap'
import { readSetting } from '@renderer/components/Analyzer/filterState'
import { invokeIpc } from '@renderer/ipc'
import { classes } from '@renderer/map/classMap'

import MetaClassTable from './MetaClassTable'
import MetaSharePie from './MetaSharePie'
import {
  metaClassRows,
  metaClassesWithData,
  metaFirstTurnAdvantage,
  metaMatchup
} from './metaModel'

import { META_WINDOW_DAYS, type MetaSnapshot, type MetaWindowDays } from '@shared/meta'
import type { ClassName } from '@shared/domain'

const TOOLBAR_CONTROL_HEIGHT = 36
const NUMERIC = { fontVariantNumeric: 'tabular-nums' } as const

type ChartKind = 'heatmap' | 'bars'

const WINDOW_OPTIONS = META_WINDOW_DAYS.map((days) => ({ id: String(days), label: `${days} 天` }))
const CHART_OPTIONS: Array<{ id: ChartKind; label: string; icon: React.ReactNode }> = [
  { id: 'heatmap', label: '對戰表', icon: <TableChartOutlinedIcon sx={{ fontSize: 16 }} /> },
  { id: 'bars', label: '長條圖', icon: <AlignHorizontalLeftIcon sx={{ fontSize: 16 }} /> }
]

const SETTINGS_KEYS = {
  days: 'meta.days',
  myClass: 'meta.myClass',
  chartKind: 'meta.chartKind',
  /** 「這份資料有多大」那一塊是攤開還是收著。預設收著：它被抱怨的就是佔位。 */
  scaleOpen: 'meta.scaleOpen'
} as const

const isWindowDays = (value: unknown): value is MetaWindowDays =>
  (META_WINDOW_DAYS as readonly number[]).includes(Number(value))

const isClassName = (value: unknown): value is ClassName =>
  classes.some((klass) => String(klass.id) === value)

/** 一個數字加一行標籤。和熱圖上方那排是同一種東西，所以長得一樣。 */
function Metric({
  label,
  value,
  unit,
  hint
}: {
  label: string
  value: string
  unit?: string
  hint?: React.ReactNode
}): React.JSX.Element {
  return (
    <Box>
      <Box display="flex" alignItems="center" gap={0.5}>
        <Typography variant="caption" sx={{ opacity: 0.55, lineHeight: 1.6 }}>
          {label}
        </Typography>
        {hint && <InfoHint title={hint} label={label} />}
      </Box>
      <Box display="flex" alignItems="baseline" gap={0.5}>
        <Typography
          sx={{ ...NUMERIC, fontSize: 20, lineHeight: 1.3, color: 'rgba(255,255,255,0.92)' }}
        >
          {value}
        </Typography>
        {unit && (
          <Typography variant="caption" sx={{ opacity: 0.5 }}>
            {unit}
          </Typography>
        )}
      </Box>
    </Box>
  )
}

export default function MetaPage(): React.JSX.Element {
  const [days, setDays] = useState<MetaWindowDays>(14)
  const [myClass, setMyClass] = useState<ClassName>('elf')
  const [chartKind, setChartKind] = useState<ChartKind>('heatmap')
  /**
   * 「這份資料有多大」那一塊攤開了沒。收著時只剩一行摘要，攤開才是五個數字各佔
   * 一格的原版。和 `days`、`chartKind` 一樣存回設定：一個人每次進來都要多按一下
   * 才看得到他上次已經決定要看的東西，那個開關就等於沒有。
   */
  const [scaleOpen, setScaleOpen] = useState(false)
  const [snapshot, setSnapshot] = useState<MetaSnapshot | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  /**
   * 環與表之間的連動：滑過（或鍵盤停在）哪個職業。放在這裡而不是任一個子元件
   * 裡，因為兩邊都要讀也都要寫 - 一邊持有另一邊就得往上再傳一層。
   */
  const [highlighted, setHighlighted] = useState<string | null>(null)

  /**
   * 存回設定的閘門，和分析器踩過的是同一個坑：讀回來之前就寫，會把存檔用預設
   * 值蓋掉，而使用者只會看到「它不記得我選過什麼」。
   */
  const hydrated = useRef(false)
  /**
   * 設定讀回來了沒。
   *
   * 和上面那個 ref 是同一件事的兩種形態，而且兩種都需要：存檔的閘門只要「現在
   * 能不能寫」，讀不到會重繪；但**抓資料的閘門必須能觸發重繪**，所以它得是
   * state。原本沒有這個閘門，於是每次進這一頁都是先用預設的 14 天發一次請求，
   * 設定讀回來變成 30 天再發一次——其中第一次是使用者從來沒要求看的區間。
   */
  const [ready, setReady] = useState(false)
  /** 這一頁被關掉以後才回來的請求不該再改狀態。 */
  const alive = useRef(true)

  useEffect(() => {
    alive.current = true
    return () => {
      alive.current = false
    }
  }, [])

  useEffect(() => {
    let mounted = true
    void window.settings
      .getAll()
      .then((raw) => {
        if (!mounted || !raw) return
        const storedDays = readSetting(raw, SETTINGS_KEYS.days)
        if (isWindowDays(storedDays)) setDays(Number(storedDays) as MetaWindowDays)
        const storedClass = readSetting(raw, SETTINGS_KEYS.myClass)
        if (isClassName(storedClass)) setMyClass(storedClass)
        const storedChart = readSetting(raw, SETTINGS_KEYS.chartKind)
        if (storedChart === 'heatmap' || storedChart === 'bars') setChartKind(storedChart)
        const storedScaleOpen = readSetting(raw, SETTINGS_KEYS.scaleOpen)
        if (typeof storedScaleOpen === 'boolean') setScaleOpen(storedScaleOpen)
      })
      .catch(() => {})
      .finally(() => {
        if (!mounted) return
        hydrated.current = true
        setReady(true)
      })
    return () => {
      mounted = false
    }
  }, [])

  useEffect(() => {
    if (!hydrated.current) return
    void window.settings
      .setMany({
        [SETTINGS_KEYS.days]: days,
        [SETTINGS_KEYS.myClass]: myClass,
        [SETTINGS_KEYS.chartKind]: chartKind,
        [SETTINGS_KEYS.scaleOpen]: scaleOpen
      })
      .catch(() => {})
  }, [chartKind, days, myClass, scaleOpen])

  const load = useCallback(async (windowDays: MetaWindowDays, refresh: boolean): Promise<void> => {
    setLoading(true)
    try {
      const res = await invokeIpc('meta:fetch', { days: windowDays, refresh })
      if (!alive.current) return
      if (res.ok) {
        setSnapshot(res.data)
        setError(null)
      } else {
        // 舊的那份留著。網路斷一下就把畫面清空，等於用一個暫時的問題換掉使用者
        // 手上還有用的數字；工具列那行「統計於」會說它是什麼時候的。
        setError(res.error)
      }
    } catch (e) {
      // `invokeIpc` 的 reject 不是 `res.ok === false`，它是「這通電話根本沒接通」
      // ——主行程還沒註冊這個頻道（改完 main 沒重啟就是這樣）、preload 是舊的、
      // 或主行程掛了。沒有這個 catch 的話 promise 直接往外拋，下面的
      // `setLoading(false)` 永遠不會跑，整頁就停在骨架上**而且一個字都不說**。
      // 那是最難回報的一種壞法：使用者只會說「沒有顯示資料」。
      if (!alive.current) return
      setError(
        `無法向主程式取得統計（${(e as Error)?.message ?? String(e)}）。如果你剛更新過，重開 app 再試一次。`
      )
    } finally {
      // finally 而不是兩條路各寫一次：漏掉任何一條的代價就是永遠的骨架。
      if (alive.current) setLoading(false)
    }
  }, [])

  useEffect(() => {
    // 等設定讀完才問。差別是一次請求還是兩次，而且省下的那次是問錯區間的那次。
    if (!ready) return
    void load(days, false)
  }, [days, load, ready])

  const doc = snapshot?.document ?? null
  const rows = useMemo(() => metaClassRows(doc), [doc])
  const withData = useMemo(() => metaClassesWithData(doc), [doc])
  const matchup = useMemo(() => metaMatchup(doc, myClass), [doc, myClass])
  const advantage = useMemo(() => metaFirstTurnAdvantage(doc), [doc])

  const hasData = (doc?.cells.length ?? 0) > 0

  const generatedAt = doc?.generatedAt ? new Date(doc.generatedAt) : null
  const fetchedAt = snapshot?.fetchedAt ? new Date(snapshot.fetchedAt) : null

  return (
    <Box
      sx={{
        position: 'relative',
        display: 'flex',
        flexDirection: 'column',
        gap: 1.5,
        flex: 1,
        minHeight: 0
      }}
    >
      {/* ---------- 工具列：統計窗與重新整理 ---------- */}
      <Paper
        variant="outlined"
        sx={{ borderRadius: 2, p: 1.5, display: 'flex', flexDirection: 'column', gap: 1.25 }}
      >
        <Box display="flex" alignItems="center" gap={1.5} flexWrap="wrap">
          <PublicOutlinedIcon sx={{ opacity: 0.6 }} />
          <Typography variant="body2" sx={{ opacity: 0.75 }}>
            所有使用者的對局彙總
          </Typography>

          <Divider orientation="vertical" flexItem sx={{ my: 0.5 }} />

          {/* 天數而不是場數：這裡的問題是「現在的環境長什麼樣」，而環境是隨
              時間變的（改版、新卡包）。分析器問的是自己的近況，所以那裡才是
              「最近 N 場」。 */}
          <SegmentedControl
            options={WINDOW_OPTIONS}
            value={String(days)}
            onChange={(next) => setDays(Number(next) as MetaWindowDays)}
            height={TOOLBAR_CONTROL_HEIGHT}
            minSegmentWidth={64}
            aria-label="統計區間"
          />

          <Box flex={1} />

          {(generatedAt || fetchedAt) && (
            <Typography variant="caption" sx={{ opacity: 0.55, whiteSpace: 'nowrap' }}>
              {generatedAt
                ? `伺服器統計於 ${generatedAt.toLocaleString()}`
                : `更新於 ${fetchedAt?.toLocaleString()}`}
            </Typography>
          )}

          {/*
            但書從頁尾搬到這裡。

            它原本是最底下一個有標題的區塊，而那是這一頁唯一一段沒有人會讀第二次
            的散文——但也是這份資料真正的邊界（樣本是誰、為什麼會重複計、為什麼
            不能分段位），刪掉等於讓數字看起來比它實際上更乾淨。所以是搬進 hover，
            不是拿掉。

            放在時間戳旁邊而不是標題旁邊：它講的是「這份文件」的限制，和「這份
            文件是什麼時候算的」是同一類的事，兩個一起讀才完整。

            內容仍然來自 `doc.caveats`，不寫死在這裡——伺服器改了規則，這頁說的
            話就跟著改。
          */}
          {(doc?.caveats.length ?? 0) > 0 && (
            <InfoHint
              label="這些數字不能讀成什麼"
              maxWidth={420}
              title={
                <Box>
                  <Typography variant="subtitle2" sx={{ mb: 0.75 }}>
                    這些數字不能讀成什麼
                  </Typography>
                  <Box component="ul" sx={{ m: 0, pl: 2.25 }}>
                    {doc?.caveats.map((line) => (
                      <Typography
                        component="li"
                        variant="body2"
                        key={line}
                        sx={{ lineHeight: 1.6 }}
                      >
                        {line}
                      </Typography>
                    ))}
                  </Box>
                </Box>
              }
            />
          )}

          <Tooltip title="重新向伺服器索取（略過快取）">
            <span>
              <IconButton
                size="small"
                disabled={loading}
                onClick={() => void load(days, true)}
                aria-label="重新整理"
              >
                <RefreshIcon fontSize="small" />
              </IconButton>
            </span>
          </Tooltip>
        </Box>
      </Paper>

      {error && (
        <Alert
          severity={snapshot ? 'warning' : 'error'}
          action={
            <Button color="inherit" size="small" onClick={() => void load(days, true)}>
              重試
            </Button>
          }
        >
          {snapshot ? `無法更新（${error}）；以下是上次取得的資料。` : error}
        </Alert>
      )}

      <Box
        sx={{
          flex: 1,
          minHeight: 0,
          overflowY: 'auto',
          display: 'flex',
          flexDirection: 'column',
          gap: 1.5
        }}
      >
        {loading && !snapshot ? (
          <>
            {/* 跟著「這份資料有多大」收起來後的高度走；骨架比它替代的東西高一倍，載入完會跳。 */}
            <Skeleton variant="rounded" height={scaleOpen ? 96 : 44} />
            <Skeleton variant="rounded" height={260} />
            <Skeleton variant="rounded" height={320} />
          </>
        ) : !hasData ? (
          <EmptyState
            title="還沒有足夠的資料"
            description="公開統計要有足夠多的使用者同時打過同一個對位才會發布。過一陣子再回來看，或換一個較長的區間。"
            icon={<PublicOutlinedIcon sx={{ fontSize: 40, opacity: 0.6 }} />}
          />
        ) : (
          <>
            {/* ---------- 這份資料有多大 ----------

                預設收著。這一塊的價值在檔頭那段說了：底下每個百分比的意義由它決定。
                但「決定意義」需要的是**看得到**，不是佔一整張卡的高度——五個 20px
                的數字加標籤攤開來，比職業表還高，而人真正要掃的是職業表。

                收著的時候不是藏起來，是縮成一行：使用者數、場次、區間三個數直接寫
                在標題列上，不用按就讀得到；先手優勢、模式和每個數字的 ⓘ 說明在攤開
                的原版裡。純粹一顆 chevron、收著時什麼都不給的版本不要——那等於把
                「先給結論再讓人自己去找樣本數」這個統計頁最常犯的錯自己犯一次。

                整列都可以點，不只 chevron：一行字加一顆 24px 的按鈕，要人準確點到
                按鈕上才肯開太苛刻。 */}
            <Paper variant="outlined" sx={{ borderRadius: 2, px: 2, py: 1 }}>
              <Box
                role="button"
                tabIndex={0}
                aria-expanded={scaleOpen}
                aria-label={scaleOpen ? '收起資料規模' : '展開資料規模'}
                onClick={() => setScaleOpen((open) => !open)}
                onKeyDown={(event) => {
                  if (event.key === 'Enter' || event.key === ' ') {
                    event.preventDefault()
                    setScaleOpen((open) => !open)
                  }
                }}
                sx={{
                  display: 'flex',
                  alignItems: 'center',
                  gap: 1,
                  cursor: 'pointer',
                  userSelect: 'none',
                  borderRadius: 1,
                  mx: -1,
                  px: 1,
                  '&:hover': { bgcolor: 'action.hover' },
                  outlineOffset: 2,
                  '&:focus-visible': { outline: '2px solid', outlineColor: 'primary.main' }
                }}
              >
                <Typography variant="caption" sx={{ opacity: 0.55, whiteSpace: 'nowrap' }}>
                  這份資料有多大
                </Typography>
                <Typography variant="body2" sx={{ ...NUMERIC, opacity: 0.85, minWidth: 0 }} noWrap>
                  {(doc?.installs ?? 0).toLocaleString()} 位使用者 ・{' '}
                  {(doc?.matches ?? 0).toLocaleString()} 場 ・ {doc?.window.days ?? days} 天
                </Typography>
                <Box flex={1} />
                <ExpandMoreRoundedIcon
                  fontSize="small"
                  sx={{
                    color: 'text.secondary',
                    transition: 'transform .18s',
                    transform: scaleOpen ? 'rotate(180deg)' : 'none'
                  }}
                />
              </Box>

              <Collapse in={scaleOpen} unmountOnExit>
                <Box
                  display="flex"
                  alignItems="flex-start"
                  gap={{ xs: 2.5, md: 4 }}
                  flexWrap="wrap"
                  sx={{ pt: 1.5, pb: 1 }}
                >
                  <Metric
                    label="貢獻的使用者"
                    value={(doc?.installs ?? 0).toLocaleString()}
                    unit="位"
                    hint="這個區間內至少上傳過一次的安裝數。一個人有兩台機器就算兩個。"
                  />
                  <Metric
                    label="觀測場次"
                    value={(doc?.matches ?? 0).toLocaleString()}
                    unit="場"
                    hint="是「被記錄到的次數」而不是「不重複的對局數」：兩個使用者對打時，同一場會被雙方各記一次。"
                  />
                  <Metric
                    label="統計區間"
                    value={`${doc?.window.days ?? days}`}
                    unit={`天（自 ${doc?.window.since ?? '—'}）`}
                  />
                  <Metric
                    label="先手優勢"
                    value={
                      advantage === null
                        ? '—'
                        : `${advantage >= 0 ? '+' : '−'}${Math.abs(advantage).toFixed(1)}`
                    }
                    unit={advantage === null ? undefined : '%'}
                    hint="整個環境合起來，先攻勝率減後攻勝率。"
                  />
                  <Metric
                    label="模式"
                    value={doc?.mode === 'ranked' ? '天梯' : (doc?.mode ?? '—')}
                    hint="公開統計只算天梯，而且只算引擎自己辨識、沒有被手動改過的對局。"
                  />
                </Box>

                {(doc?.sampling.suppressedCells ?? 0) > 0 && (
                  <Typography variant="caption" sx={{ display: 'block', mt: 1.5, opacity: 0.55 }}>
                    另有 {doc?.sampling.suppressedCells} 個對位因為貢獻的使用者不足{' '}
                    {doc?.sampling.minInstallsPerCell} 位而未發布（共{' '}
                    {(doc?.sampling.suppressedMatches ?? 0).toLocaleString()}{' '}
                    場）。單一使用者的對位紀錄等同於那個人的戰績，所以人數不夠時寧可不發布。
                  </Typography>
                )}
              </Collapse>
            </Paper>

            {/* ---------- 職業層級 ---------- */}
            <Paper variant="outlined" sx={{ borderRadius: 2, p: 2 }}>
              <Box display="flex" alignItems="baseline" gap={1} mb={1.5} flexWrap="wrap">
                <Typography variant="h6">職業分佈與勝率</Typography>
                <InfoHint
                  label="佔比與勝率的分母不同"
                  title={
                    <Box sx={{ maxWidth: 320 }}>
                      <Typography variant="body2" sx={{ mb: 0.75 }}>
                        <b>環境佔比</b>數的是「對面」那一側 -
                        你在天梯上遇到誰。對手大多沒有裝這個工具，所以這一側最接近真實環境。
                      </Typography>
                      <Typography variant="body2">
                        <b>使用者勝率</b>數的是「自己」那一側 -
                        只有這個工具的使用者，樣本本來就有偏差。兩個數字回答的是不同的問題。
                      </Typography>
                    </Box>
                  }
                />
                <Typography variant="caption" sx={{ opacity: 0.55 }}>
                  點一列或一塊可以切換下方的對位表
                </Typography>
              </Box>
              {/* 環在左、表在右；容器窄到並排不下時環會折到表的上方，而不是兩者
                  互相擠壓。環的寬度是固定的，表吃剩下的空間。 */}
              <Box display="flex" alignItems="flex-start" gap={{ xs: 2, md: 3 }} flexWrap="wrap">
                <Box display="flex" flexDirection="column" alignItems="center" gap={1}>
                  <Box display="flex" alignItems="center" gap={0.5}>
                    <Typography variant="caption" sx={{ opacity: 0.55 }}>
                      環境佔比
                    </Typography>
                    <InfoHint
                      label="環境佔比的樣本是什麼"
                      title="算的是這個工具的使用者在天梯上遇到的對手，不是整個天梯。使用者少的時候，這個分佈偏向他們打的時段與段位；未達發布門檻的對位也不在分母裡。"
                    />
                  </Box>
                  <MetaSharePie
                    rows={rows}
                    selected={myClass}
                    highlighted={highlighted}
                    onHighlight={setHighlighted}
                    onSelect={(id) => {
                      if (isClassName(id)) setMyClass(id)
                    }}
                  />
                </Box>
                {/* 440 是表格五欄不擠的最小寬：低於這個寬度就讓環折到上面去。 */}
                <Box sx={{ flex: '1 1 440px', minWidth: 0 }}>
                  <MetaClassTable
                    rows={rows}
                    selected={myClass}
                    highlighted={highlighted}
                    onHighlight={setHighlighted}
                    onSelect={(id) => {
                      if (isClassName(id)) setMyClass(id)
                    }}
                  />
                </Box>
              </Box>
            </Paper>

            {/* ---------- 對位層級 ---------- */}
            <Paper
              variant="outlined"
              sx={{ borderRadius: 2, p: 2, display: 'flex', flexDirection: 'column', gap: 1.5 }}
            >
              <Box display="flex" alignItems="center" gap={1.5} flexWrap="wrap">
                <ClassSelect
                  value={myClass}
                  onChange={setMyClass}
                  height={TOOLBAR_CONTROL_HEIGHT}
                />
                <SegmentedControl
                  options={CHART_OPTIONS}
                  value={chartKind}
                  onChange={setChartKind}
                  height={TOOLBAR_CONTROL_HEIGHT}
                  aria-label="圖表種類"
                />
                {!withData.has(myClass) && (
                  <Typography variant="caption" sx={{ opacity: 0.6 }}>
                    這個職業在這個區間還沒有可發布的對位
                  </Typography>
                )}
              </Box>

              {/* 和分析器同一張圖、同一組門檻。差別只有資料來源，而上面那排
                  數字已經說了資料來自哪裡。 */}
              <Box sx={{ minHeight: 360, display: 'flex', flexDirection: 'column' }}>
                {chartKind === 'heatmap' ? (
                  <MatchupHeatmap data={matchup} />
                ) : (
                  <MatchupBars data={matchup} />
                )}
              </Box>
            </Paper>
          </>
        )}
      </Box>
    </Box>
  )
}

/**
 * 環境 - 所有使用者的對局彙總後的大環境數據。
 *
 * 這是 app 裡唯一一頁畫的不是使用者自己的資料。分析器回答「我打得怎麼樣」，
 * 這頁回答「現在大家在打什麼、哪個職業強」- 資料來自公開端點 `/v1/meta`，
 * 由 `src/main/ipc/meta.ts` 代為讀取（那支檔案說明了為什麼它不跟著上傳開關走）。
 *
 * 三塊，順序就是信任的順序：
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
 * 版面：窗夠寬時 2 與 3 左右並排，職業層級在左、對位在右；不夠寬就由上而下疊。
 * 並排不只是塞得下的問題——對位那張圖的長條是直的，容器多高它就多高，疊著放時
 * 它永遠只拿得到頁面最底下剩的那一截，同一張圖在分析器那邊卻是整頁高。讓它自己
 * 佔一整欄，高度的問題就跟著版面一起解了。切換的門檻與左右的分配見
 * `SPLIT_MIN_WIDTH` 與 `CLASS_COLUMN_WIDTH` 的說明。
 *
 * 伺服器自己附帶的 `caveats` 收在工具列時間戳旁邊的 ⓘ 裡。那幾句不是免責聲明
 * 樣板，是這份資料真正的邊界（樣本是誰、為什麼會重複計、為什麼不能分段位），
 * 所以它們跟著資料走，不寫死在這裡 - 伺服器改了規則，這頁說的話就跟著改。
 * 它們曾經是頁尾一整塊散文，搬進 hover 是因為那是這頁唯一沒有人會讀第二次的
 * 段落；搬走而不是刪掉，是因為少了它們，數字看起來會比實際上更乾淨。
 */
import React, { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import {
  Alert,
  Box,
  Button,
  Divider,
  IconButton,
  Paper,
  Skeleton,
  Tooltip,
  Typography
} from '@mui/material'
import AlignHorizontalLeftIcon from '@mui/icons-material/AlignHorizontalLeft'
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

/** 面板內距（`p: 2`）的像素數；下面算欄寬時要把它加回去。 */
const PANEL_PADDING = 16
/** 兩欄之間、以及上下兩塊之間的間距（`gap: 1.5`）。 */
const BLOCK_GAP = 12

/**
 * 並排時左欄（環＋職業表）的寬度。
 *
 * 440 是職業表五欄不擠的最小寬（`MetaClassTable` 的欄位定義），加上面板兩側的
 * 內距。左欄是**固定寬**而不是跟右欄平分：這一塊的內容有一個硬的下限、卻沒有
 * 任何東西能把多出來的寬度用掉——環是固定 200px，表格多給的寬只會變成職業名那
 * 一欄的空白。對位圖則相反，長條的軌道每多一像素就多一點解析度。所以把能長的
 * 那一塊放在會長的那一欄。
 *
 * 環在並排時放在表的**上方**而不是旁邊：旁邊要多 200 + 24 = 224px，那 224px
 * 從對位圖那欄扣，而環只有七塊，直著讀還是橫著讀都一樣。
 */
const CLASS_COLUMN_WIDTH = 440 + PANEL_PADDING * 2

/**
 * 並排時右欄（對位圖）至少要有的寬度。
 *
 * 兩張圖裡比較貪的那張決定這個數：熱圖六欄加五個間距是 536px；長條圖是職業欄
 * 150 + 間距 12 + 先後攻標籤 34 + 數值 52 + 兩個 8px 的欄距，剩下的才是軌道——
 * 軌道低於 300px 時 48% 與 52% 的差是四個像素，這張圖就沒有存在的理由了。所以
 * 150 + 12 + 102 + 300 ≈ 564，加每一列左右各 8px 的內距，取 580。
 *
 * 還有一個不那麼明顯的原因不能讓這欄更窄：熱圖、長條圖、職業表把窄版排法掛在
 * `@media (max-width: 720px)` 上，那量的是**視窗**寬，不是欄寬。一個 1300px
 * 的視窗裡塞一條 450px 的欄，它們仍然會照桌機版畫六欄——然後被截掉。
 */
const MATCHUP_COLUMN_MIN_WIDTH = 580

/**
 * 頁面內容區（不含側欄與 `Main` 的內距）至少要這麼寬才並排。
 *
 * 就是左欄 + 間距 + 右欄的下限，1064px；換成視窗寬度大約是 1064 + 92（側欄）
 * + 48（左右內距）≈ 1200px。視窗的下限是 1100，所以最小視窗仍然是疊著的——
 * 那時右欄只能拿到 476px，比疊著放時整頁寬的圖還難讀，並排在那裡不是改善。
 *
 * 量的是這個元件自己的寬而不是 `useMediaQuery` 的視窗寬：兩者差一個常數沒錯，
 * 但那個常數住在 `App.tsx` 裡，側欄或內距一改，寫在這裡的視窗數字就悄悄錯了。
 * 量自己，不用知道外面長什麼樣。
 */
const SPLIT_MIN_WIDTH = CLASS_COLUMN_WIDTH + BLOCK_GAP + MATCHUP_COLUMN_MIN_WIDTH

/**
 * 疊著放（窗不夠寬）時，對位圖那一塊的最小高度。
 *
 * 並排時用不到這個數：右欄本身就是整頁高，圖跟分析器一樣是 `flex: 1` 吃滿。
 * 疊著放時圖排在環與職業表底下，頁面剩多少它拿多少，而最小視窗（700 高）
 * 扣掉工具列與上面那塊之後剩不到 200px，七列長條會擠成七條線。所以疊著時
 * 給它一個實數，讓整頁捲動而不是把圖壓扁。620 大約是分析器在預設視窗高度
 * 給那張圖的空間，讀起來像同一張圖。
 */
const MATCHUP_STACKED_MIN_H = 620

/** 分析器那邊的原句：捲得動但不畫原生捲軸——它會蓋在最右邊那欄數字上。 */
const HIDDEN_SCROLL_SX = {
  overflowY: 'auto',
  scrollbarWidth: 'none',
  '&::-webkit-scrollbar': { display: 'none' }
} as const

type ChartKind = 'heatmap' | 'bars'

const WINDOW_OPTIONS = META_WINDOW_DAYS.map((days) => ({ id: String(days), label: `${days} 天` }))
const CHART_OPTIONS: Array<{ id: ChartKind; label: string; icon: React.ReactNode }> = [
  { id: 'heatmap', label: '對戰表', icon: <TableChartOutlinedIcon sx={{ fontSize: 16 }} /> },
  { id: 'bars', label: '長條圖', icon: <AlignHorizontalLeftIcon sx={{ fontSize: 16 }} /> }
]

const SETTINGS_KEYS = {
  days: 'meta.days',
  myClass: 'meta.myClass',
  chartKind: 'meta.chartKind'
} as const

const isWindowDays = (value: unknown): value is MetaWindowDays =>
  (META_WINDOW_DAYS as readonly number[]).includes(Number(value))

const isClassName = (value: unknown): value is ClassName =>
  classes.some((klass) => String(klass.id) === value)

/**
 * 這一頁現在有多寬，決定要不要並排。
 *
 * 用 `ResizeObserver` 量根元素，而不是 `useMediaQuery`：理由寫在
 * `SPLIT_MIN_WIDTH` 上。第一次在 layout effect 裡同步量一次，否則第一幀會先
 * 畫疊著的版、observer 回來再跳成並排，換頁的瞬間版面會抖一下。量不到（測試
 * 環境沒有 `ResizeObserver`）就當作不夠寬，疊著放是兩種版面裡比較保守的那種。
 */
function useIsWide(ref: React.RefObject<HTMLElement | null>): boolean {
  const [wide, setWide] = useState(false)
  useLayoutEffect(() => {
    const el = ref.current
    if (!el) return
    const measure = (width: number): void => setWide(width >= SPLIT_MIN_WIDTH)
    measure(el.getBoundingClientRect().width)
    if (typeof ResizeObserver === 'undefined') return
    const observer = new ResizeObserver(([entry]) => {
      if (entry) measure(entry.contentRect.width)
    })
    observer.observe(el)
    return () => observer.disconnect()
  }, [ref])
  return wide
}

/**
 * ⓘ 裡的一列：名稱、值，底下一行但書。
 *
 * 取代了原本那個 20px 大字的 `Metric`。那個尺寸是給版面上的數字用的，而這些
 * 數字已經不在版面上了——它們現在只在滑過去的時候出現，而 tooltip 裡的 20px
 * 會讀成標題而不是資料。
 */
function Row({ k, v, note }: { k: string; v: string; note?: string }): React.JSX.Element {
  return (
    <>
      <Typography variant="caption" sx={{ opacity: 0.55, whiteSpace: 'nowrap', pt: '1px' }}>
        {k}
      </Typography>
      <Box>
        <Typography variant="body2" sx={NUMERIC}>
          {v}
        </Typography>
        {note && (
          <Typography variant="caption" sx={{ display: 'block', opacity: 0.6, lineHeight: 1.5 }}>
            {note}
          </Typography>
        )}
      </Box>
    </>
  )
}

export default function MetaPage(): React.JSX.Element {
  const [days, setDays] = useState<MetaWindowDays>(14)
  const [myClass, setMyClass] = useState<ClassName>('elf')
  const [chartKind, setChartKind] = useState<ChartKind>('heatmap')
  const [snapshot, setSnapshot] = useState<MetaSnapshot | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  /**
   * 環與表之間的連動：滑過（或鍵盤停在）哪個職業。放在這裡而不是任一個子元件
   * 裡，因為兩邊都要讀也都要寫 - 一邊持有另一邊就得往上再傳一層。
   */
  const [highlighted, setHighlighted] = useState<string | null>(null)

  const rootRef = useRef<HTMLDivElement | null>(null)
  const wide = useIsWide(rootRef)

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
        [SETTINGS_KEYS.chartKind]: chartKind
      })
      .catch(() => {})
  }, [chartKind, days, myClass])

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
  const showSkeleton = loading && !snapshot
  const showEmpty = !showSkeleton && !hasData
  /**
   * 空狀態永遠是一欄：它是一段置中的字，並排只會讓它偏到左邊一欄裡。骨架則跟
   * 資料走同一種版面，否則資料回來的那一瞬間兩塊會從上下跳成左右。
   */
  const twoColumn = wide && !showEmpty

  const generatedAt = doc?.generatedAt ? new Date(doc.generatedAt) : null
  const fetchedAt = snapshot?.fetchedAt ? new Date(snapshot.fetchedAt) : null

  return (
    <Box
      ref={rootRef}
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
          {/*
            這格原本是一顆地球圖示加「所有使用者的對局彙總」——一句每次進頁都
            一樣、讀第二次就沒有用的話，佔的還是整條工具列最左邊、視線第一個
            落點的位置。換成這份文件實際有多大：同樣一行的高度，但它每次都不
            一樣，而且它決定了底下每個百分比能不能信。
          */}
          <Box display="flex" alignItems="center" gap={0.75}>
            <Typography variant="body2" sx={{ ...NUMERIC, opacity: 0.85 }} noWrap>
              {(doc?.installs ?? 0).toLocaleString()} 位使用者 ・{' '}
              {(doc?.matches ?? 0).toLocaleString()} 場 ・ {doc?.window.days ?? days} 天
            </Typography>
            {/*
              滑過去才給細節，不是點開。

              這一行的三個數字是常看的，其餘（統計區間起點、先手優勢、模式、
              以及每個數字各自的但書）是偶爾才需要確認的——那正是 ⓘ 的用途，
              而這一頁其他地方本來就是這樣做的。展開式在這裡是多餘的第三種
              互動：同一塊資訊既能點又能滑，讀者得先猜哪一種才有東西。
            */}
            <InfoHint
              label="這份資料有多大"
              maxWidth={420}
              title={
                <Box sx={{ display: 'grid', gridTemplateColumns: 'auto 1fr', gap: '4px 12px' }}>
                  <Row
                    k="貢獻的使用者"
                    v={`${(doc?.installs ?? 0).toLocaleString()} 位`}
                    note="這個區間內至少上傳過一次的安裝數。一個人有兩台機器就算兩個。"
                  />
                  <Row
                    k="觀測場次"
                    v={`${(doc?.matches ?? 0).toLocaleString()} 場`}
                    note="是「被記錄到的次數」而不是「不重複的對局數」：兩個使用者對打時，同一場會被雙方各記一次。"
                  />
                  <Row
                    k="統計區間"
                    v={`${doc?.window.days ?? days} 天（自 ${doc?.window.since ?? '—'}）`}
                  />
                  <Row
                    k="先手優勢"
                    v={
                      advantage === null
                        ? '—'
                        : `${advantage >= 0 ? '+' : '−'}${Math.abs(advantage).toFixed(1)}%`
                    }
                    note="整個環境合起來，先攻勝率減後攻勝率。"
                  />
                  <Row
                    k="模式"
                    v={doc?.mode === 'ranked' ? '天梯' : (doc?.mode ?? '—')}
                    note="公開統計只算天梯，而且只算引擎自己辨識、沒有被手動改過的對局。"
                  />
                  {(doc?.sampling.suppressedCells ?? 0) > 0 && (
                    <Row
                      k="未發布"
                      v={`${doc?.sampling.suppressedCells} 個對位 · ${(doc?.sampling.suppressedMatches ?? 0).toLocaleString()} 場`}
                      note={`貢獻的使用者不足 ${doc?.sampling.minInstallsPerCell} 位。單一使用者的對位紀錄等同於那個人的戰績，所以人數不夠時寧可不發布。`}
                    />
                  )}
                </Box>
              }
            />
          </Box>

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

      {/*
        內容區。並排時是一列、兩欄各自捲，這一層不捲（`overflow: hidden`）：
        外層一捲，右欄那張圖的 `flex: 1` 就會對著一個「跟內容一樣高」的父層算，
        整欄高度的意義就沒了，而且分析器那張圖也是自己捲的。疊著放時退回原本
        的一欄整頁捲——那時對位圖有一個固定的最小高度，內容本來就比頁面高。
      */}
      <Box
        sx={{
          flex: 1,
          minHeight: 0,
          display: 'flex',
          flexDirection: twoColumn ? 'row' : 'column',
          alignItems: 'stretch',
          gap: 1.5,
          overflowY: twoColumn ? 'hidden' : 'auto'
        }}
      >
        {showSkeleton ? (
          <>
            {/* 規模那一塊住在工具列裡，工具列不在這個載入分支底下，所以這裡
                不替它留骨架——留了反而會在資料回來時多塌一格。兩塊骨架對應的
                是環＋職業表與對位圖，並排時就照並排的欄寬與整欄高來畫，
                資料回來時版面不會跳。 */}
            {twoColumn ? (
              <>
                <Skeleton
                  variant="rounded"
                  sx={{ flex: `0 0 ${CLASS_COLUMN_WIDTH}px`, height: 'auto' }}
                />
                <Skeleton variant="rounded" sx={{ flex: 1, height: 'auto' }} />
              </>
            ) : (
              <>
                <Skeleton variant="rounded" height={260} />
                <Skeleton variant="rounded" height={380} />
              </>
            )}
          </>
        ) : showEmpty ? (
          <EmptyState
            title="還沒有足夠的資料"
            description="公開統計要有足夠多的使用者同時打過同一個對位才會發布。過一陣子再回來看，或換一個較長的區間。"
            icon={<PublicOutlinedIcon sx={{ fontSize: 40, opacity: 0.6 }} />}
          />
        ) : (
          <>
            {/* ---------- 職業層級 ---------- */}
            {/*
              並排時這一欄是固定寬、整欄高、自己捲（視窗矮到 700 時表格會超出
              一點）。對位圖那邊沒有 Paper，這裡留著：環、說明、表是三樣東西
              合成一張圖，邊框是把它們讀成一組的那條線；對位圖自己有摘要列、
              尺規和七列，本來就是一個整體。
            */}
            <Paper
              variant="outlined"
              sx={{
                borderRadius: 2,
                p: 2,
                ...(twoColumn
                  ? {
                      flex: `0 0 ${CLASS_COLUMN_WIDTH}px`,
                      minHeight: 0,
                      ...HIDDEN_SCROLL_SX
                    }
                  : {})
              }}
            >
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
                  點一列或一塊可以切換{twoColumn ? '右側' : '下方'}的對位表
                </Typography>
              </Box>
              {/*
                並排時環在表的上方（理由見 `CLASS_COLUMN_WIDTH`）；疊著放時環在
                左、表在右，容器窄到並排不下時環會折到表的上方，而不是兩者互相
                擠壓。環的寬度是固定的，表吃剩下的空間。
              */}
              <Box
                sx={{
                  display: 'flex',
                  flexDirection: twoColumn ? 'column' : 'row',
                  flexWrap: twoColumn ? 'nowrap' : 'wrap',
                  alignItems: twoColumn ? 'stretch' : 'flex-start',
                  gap: twoColumn ? 2 : { xs: 2, md: 3 }
                }}
              >
                <Box
                  display="flex"
                  flexDirection="column"
                  alignItems="center"
                  gap={1}
                  sx={{ alignSelf: twoColumn ? 'center' : 'auto' }}
                >
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
                {/* 440 是表格五欄不擠的最小寬：疊著放、低於這個寬度時就讓環折到
                    上面去。並排時這個 flex-basis 會變成在算高度，所以要換掉。 */}
                <Box sx={twoColumn ? { width: '100%' } : { flex: '1 1 440px', minWidth: 0 }}>
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
            {/*
              沒有 Paper。分析器那張圖直接坐在頁面上，這裡原本包了一層帶邊框、
              `p: 2` 的面板，同一張圖因此比那邊四邊各短 17px，看起來就是另一張
              圖。要「看起來一樣」，容器就得一樣：沒有邊框、沒有內距、`flex: 1`
              把整欄（並排）或剩下的高度（疊著）吃掉。
            */}
            <Box
              sx={{
                flex: 1,
                minWidth: 0,
                display: 'flex',
                flexDirection: 'column',
                gap: 1.5,
                // 並排時整欄高，`minHeight: 0` 讓圖的 `flex: 1` 對著欄高算；
                // 疊著放時給一個實數，理由見 `MATCHUP_STACKED_MIN_H`。
                minHeight: twoColumn ? 0 : MATCHUP_STACKED_MIN_H
              }}
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

              {/*
                和分析器同一張圖、同一組門檻、同一個容器配方：`flex: 1` +
                `minHeight: 0` + 自己捲、不畫捲軸。差別只有資料來源，而上面那排
                數字已經說了資料來自哪裡。`MatchupBars` 內部是 `flex: 1 1 0`，
                容器多高長條就多高——這一塊拿到的高度就是那張圖的大小。
              */}
              <Box sx={{ flex: 1, minHeight: 0, ...HIDDEN_SCROLL_SX }}>
                {chartKind === 'heatmap' ? (
                  <MatchupHeatmap data={matchup} />
                ) : (
                  <MatchupBars data={matchup} />
                )}
              </Box>
            </Box>
          </>
        )}
      </Box>
    </Box>
  )
}

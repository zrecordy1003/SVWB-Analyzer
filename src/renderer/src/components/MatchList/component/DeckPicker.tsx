// src/renderer/components/matches/DeckPicker.tsx
import React from 'react'
import {
  Autocomplete,
  Box,
  CircularProgress,
  Divider,
  ListSubheader,
  TextField,
  Typography
} from '@mui/material'
import { createFilterOptions } from '@mui/material/Autocomplete'
import type { ClassName, DeckCategory } from '@shared/domain'
import ClassIcon from '@renderer/components/Common/ClassIcon'
import DeckBuilder from '@renderer/components/DeckBuilder/DeckBuilder'
import NewDeckDrawer from '@renderer/components/DeckBuilder/NewDeckDrawer'
import { classesMap } from '@renderer/map/classMap'
import { CONTROL_SX, DROPDOWN_PAPER_SX } from '@renderer/components/Common/filters/dropdownSurface'
import AddIcon from '@mui/icons-material/Add'
import { invokeIpc } from '@renderer/ipc'

/* ================================
 * Types
 * ================================ */

type DeckRow = { id: number; name: string; class: ClassName; categoryId: string | null }
/**
 * What `deckCategories:all` actually answers with.
 *
 * This used to be a local `{ id: string; name: string; sort?: number }`, which
 * was narrower than the truth in the way that matters: `sort` is
 * `number | null`, not optional. `sortCategories` coalesces it either way so
 * nothing misbehaved, but the shape was a guess that only compiled because the
 * channel returned `any`. The typed contract is what disagreed.
 */
type Category = DeckCategory

/** 顯示用 Option：帶上 categoryName；__create__ 為空清單時的哨兵。 */
type Option = (DeckRow & { categoryName: string }) & { __create__?: boolean }

/** 回傳給父層的精簡 deck（確保能即時顯示 name） */
export type DeckLite = { id: number; name: string; class: ClassName }

type Props = {
  /**
   * 浮動標籤的文字。省略就不畫標籤——表單自己有一欄標籤時，欄位裡再浮一個
   * 只是把同一件事說第二次。
   */
  label?: string
  /**
   * 和工作列上的控制項同一個長相（`CONTROL_SX`）：淡淡的填色藥丸，不是 MUI
   * 預設那種帶浮動標籤的輪廓輸入框。用在欄位排成一格一格的表單裡。
   */
  compact?: boolean
  /** 若指定，只顯示該職業的牌組 */
  klass?: ClassName
  /** 仍以 deckId 控制選取狀態（避免破壞外部呼叫） */
  value: number | null
  /** 回傳 Deck 物件（父層可直接顯示 name）；null 代表清空 */
  onChange: (deck: DeckLite | null) => void
}

/* ================================
 * Constants & Helpers
 * ================================ */

const UNGROUPED_LABEL = '（未分類）'
const BIG = 9_999_999

/**
 * 新增牌組那個抽屜要疊多高。
 *
 * MUI 的 modal 是 1300，而這個下拉本身就住在對局表單的抽屜裡——照預設的 drawer
 * 層級（1200）開出來會被自己的父抽屜蓋掉。和 `AppDialog` 的 `zIndex` 一樣寫成
 * 一個數字，因為那是這個 app 既有的做法。
 */
const NESTED_DRAWER_Z = 1302

/** 依 sort 排序分類（同 sort 時以 name 排） */
const sortCategories = (a: Category, b: Category) => {
  const sa = a.sort ?? 0
  const sb = b.sort ?? 0
  return sa === sb ? a.name.localeCompare(b.name, 'zh-Hant') : sa - sb
}

/** 將分類陣列做成 map */
const toCatNameMap = (cats: Category[]) => {
  const map = new Map<string, string>()
  cats.forEach((c) => map.set(c.id, c.name))
  return map
}

/**
 * 空清單時唯一的那一列：一個假的 Option，點下去開新增的門。
 *
 * 職業是必要的參數而不是可選的——沒有職業就不知道要新增哪一個職業的牌組，而
 * 「隨便給一個合法值」的舊寫法會在還沒選職業時顯示「新增巫師牌組」，點下去又
 * 什麼都不會發生。
 */
const makeCreateSentinel = (klass: ClassName): Option => ({
  id: -1,
  name: '新增牌組',
  class: klass,
  categoryId: null,
  categoryName: '',
  __create__: true
})

/** 官方過濾器（同時比對 名稱/分類/職業標籤） */
const defaultFilter = createFilterOptions<Option>({
  stringify: (o) => [o.name, o.categoryName, classesMap[o.class]?.label].filter(Boolean).join(' ')
})

/* ================================
 * Component
 * ================================ */

export default function DeckPicker({ label, compact = false, klass, value, onChange }: Props) {
  // ---------- Server state ----------
  const [loading, setLoading] = React.useState(true)
  const [categories, setCategories] = React.useState<Category[]>([])
  const [options, setOptions] = React.useState<Option[]>([])

  /**
   * 新增牌組的兩道門。
   *
   * 編輯與刪除刻意不在這裡：這是一個「挑一副牌」的下拉，而每一列右邊掛兩顆按鈕
   * 之後，掃讀清單時最先看到的是操作而不是牌組名，手一滑就從選牌變成刪牌。改牌
   * 組與刪牌組留在牌組管理與牌組戰績——那兩個地方本來就是為此存在的。
   */
  const [isCreateDrawerOpen, setIsCreateDrawerOpen] = React.useState(false)
  const [isBuilderOpen, setIsBuilderOpen] = React.useState(false)

  /**
   * 重讀分類與牌組，並把讀到的清單交回去。
   *
   * 回傳清單而不是只寫進 state：剛匯入的那副牌要馬上被選起來，而 `setOptions`
   * 之後這一輪 render 還讀不到它。
   */
  const loadDecks = React.useCallback(async (): Promise<Option[]> => {
    const [catRes, deckRes] = await Promise.all([
      invokeIpc('deckCategories:all'),
      invokeIpc('decks:all')
    ])
    if (!catRes?.ok) throw new Error(catRes?.error ?? '讀取分類失敗')
    if (!deckRes?.ok) throw new Error(deckRes?.error ?? '讀取牌組失敗')

    const sortedCats: Category[] = [...catRes.data].sort(sortCategories)
    const catNameMap = toCatNameMap(sortedCats)
    const list: Option[] = (deckRes.data as DeckRow[]).map((d) => ({
      ...d,
      categoryName: d.categoryId ? (catNameMap.get(d.categoryId) ?? '') : ''
    }))

    setCategories(sortedCats)
    setOptions(list)
    return list
  }, [])

  // ---------- Load data once ----------
  React.useEffect(() => {
    let mounted = true
    ;(async () => {
      setLoading(true)
      try {
        await loadDecks()
      } catch (err: any) {
        if (mounted) alert(err?.message ?? '載入失敗')
      } finally {
        if (mounted) setLoading(false)
      }
    })()
    return () => {
      mounted = false
    }
  }, [loadDecks])

  // ---------- Derived maps ----------
  /** id -> sortIndex（未分類視為最大） */
  const catSortIndex = React.useMemo(() => {
    const m = new Map<string, number>()
    categories.forEach((c, i) => m.set(c.id, c.sort ?? i))
    return m
  }, [categories])

  // ---------- Options (filtered + sorted) ----------
  const filteredOptions = React.useMemo(() => {
    const list = options.filter((o) => (klass ? o.class === klass : true))
    list.sort((a, b) => {
      const sa = a.categoryId ? (catSortIndex.get(a.categoryId) ?? BIG) : BIG
      const sb = b.categoryId ? (catSortIndex.get(b.categoryId) ?? BIG) : BIG
      if (sa !== sb) return sa - sb
      return a.name.localeCompare(b.name, 'zh-Hant')
    })
    return list
  }, [options, klass, catSortIndex])

  const selectedOption = React.useMemo(
    () => filteredOptions.find((o) => o.id === value) ?? null,
    [filteredOptions, value]
  )

  // ---------- Handlers ----------
  /**
   * 新增的門帶回一個 deckId 之後：重讀清單，然後把那一副選起來。
   *
   * 「選起來」是這裡和牌組戰績最大的差別。那一頁接著開建構器，因為它就是為了
   * 整理牌組而存在的；這裡是一張正在填的對局紀錄，使用者要的是那一格被填上，
   * 然後回去把剩下的填完。
   */
  const handleDeckArrived = React.useCallback(
    async (deckId: number) => {
      try {
        const list = await loadDecks()
        const found = list.find((d) => d.id === deckId)
        if (found) onChange({ id: found.id, name: found.name, class: found.class })
      } catch (err: any) {
        alert(err?.message ?? '讀取牌組失敗')
      }
    },
    [loadDecks, onChange]
  )

  /* ================================
   * Render
   * ================================ */

  return (
    <>
      <Autocomplete<Option, false, false, false>
        value={selectedOption}
        onChange={(_, opt) => {
          if (opt?.__create__) {
            setIsCreateDrawerOpen(true)
            return
          }
          onChange(opt ? { id: opt.id, name: opt.name, class: opt.class } : null)
        }}
        options={filteredOptions}
        filterOptions={(opts, params) => {
          const filtered = defaultFilter(opts, params)
          if (!loading && filtered.length === 0 && klass) filtered.push(makeCreateSentinel(klass))
          return filtered
        }}
        loading={loading}
        getOptionLabel={(o) => (o.__create__ ? '' : o.name)}
        groupBy={(o) => (o.__create__ ? '' : o.categoryName || UNGROUPED_LABEL)}
        // 有職業時空清單長出「新增牌組」那一列，所以永遠不會走到這句；沒職業時
        // 這句就是答案——先選職業，這個下拉才知道要給什麼。
        noOptionsText={klass ? '' : '先選職業'}
        isOptionEqualToValue={(a, b) => a.id === b.id}
        /*
         * 這裡本來有 `disablePortal`，而那是面板被裁切的原因。
         *
         * 這個下拉住在對局表單的抽屜裡：抽屜的 paper 是 `overflow: hidden`，表單
         * 區又是 `overflowY: auto`——而 CSS 規定另一軸是 `visible` 時會一起變成
         * `auto`，所以它同時也是個橫向捲動容器。`disablePortal` 把面板畫進那個容器
         * 裡面，於是面板的邊被容器裁掉，超出的部分變成橫向捲軸。右邊被切一點、
         * 底下多一條橫軸，都是這同一件事。
         *
         * 交給 portal 畫在 body 底下就完全避開它，而那本來就是 MUI 的預設：
         * Autocomplete 開在 Dialog／Drawer 裡走的就是這條路。
         */
        autoHighlight
        selectOnFocus
        slotProps={{
          paper: { sx: DROPDOWN_PAPER_SX },
          /*
           * 留白放在清單的 `padding` 上，選項自己不帶 `margin`。
           *
           * 反過來算出來的寬度是「容器寬 - 外距」，差一點就超出去；`padding` 是從
           * 容器身上扣的，選項的寬度於是永遠剛好等於內容框。也因此不需要
           * `overflow-x: hidden`——那個屬性做的事就是「把超出的部分切掉」，是在遮
           * 症狀而不是修原因。
           */
          listbox: { style: { maxHeight: 320, padding: 4 } }
        }}
        renderInput={(params) => (
          <TextField
            {...params}
            label={label}
            size={compact ? 'small' : undefined}
            placeholder={compact ? '選擇牌組' : '搜尋或選擇牌組'}
            sx={compact ? { '& .MuiOutlinedInput-root': { ...CONTROL_SX, py: 0 } } : undefined}
            slotProps={{
              input: {
                ...params.InputProps,
                endAdornment: (
                  <>
                    {loading ? <CircularProgress size={18} /> : null}
                    {params.InputProps.endAdornment}
                  </>
                )
              }
            }}
          />
        )}
        renderGroup={(params) => {
          /**
           * 沒有組名（也就是只有那個「新增牌組」哨兵）時，直接把選項交出去。
           *
           * 這裡本來包一層 `<ul>`，而那一層是跑版的真正原因：`<ul>` 有瀏覽器預設
           * 的 `padding-inline-start: 40px`，於是那一列往右縮排 40px、右邊撐出去
           * 同樣的量，面板就長出一條橫向捲軸。清單本身已經是一個 `<ul>` 了，選項
           * 是 `<li>`，中間不需要再多一層。
           */
          if (!params.group) {
            return <React.Fragment key={params.key}>{params.children}</React.Fragment>
          }
          return (
            <li key={params.key}>
              <ListSubheader disableSticky>
                <Typography variant="subtitle1">{params.group}</Typography>
              </ListSubheader>
              {params.children}
              <Divider />
            </li>
          )
        }}
        renderOption={(props, option) => {
          if (option.__create__) {
            // 空清單時唯一的那一列，所以它把整列填滿：一個佔半列的選項旁邊留著
            // 一半空白，看起來像清單沒載完，而不是像一個可以按的東西。虛線框和
            // 牌組戰績那塊「新增牌組」磁磚是同一個手法。
            return (
              <Box
                component="li"
                {...props}
                sx={{
                  display: 'flex',
                  alignItems: 'center',
                  gap: 1.25,
                  // 不給 width、也不給 margin：`li` 是塊級元素，寬度就是清單的
                  // 內容框，留白由清單的 padding 負責。
                  minWidth: 0,
                  px: 1.5,
                  py: 1.5,
                  borderRadius: 2,
                  border: '1px dashed rgba(255,255,255,0.22)',
                  backgroundColor: 'rgba(255,255,255,0.015)',
                  transition: 'border-color .14s, background-color .14s, color .14s',
                  '&.MuiAutocomplete-option': { justifyContent: 'flex-start' },
                  '&:hover, &[aria-selected="true"], &.Mui-focused': {
                    borderColor: 'rgba(140,180,255,0.55)',
                    backgroundColor: 'rgba(122,162,247,0.08)'
                  }
                }}
              >
                <AddIcon fontSize="small" color="primary" sx={{ flexShrink: 0 }} />
                <Box sx={{ minWidth: 0 }}>
                  <Typography variant="body2" fontWeight={800} noWrap>
                    新增{classesMap[option.class].label}牌組
                  </Typography>
                  <Typography variant="caption" color="text.secondary" noWrap display="block">
                    貼上代碼，或自己組
                  </Typography>
                </Box>
              </Box>
            )
          }

          return (
            <Box
              component="li"
              {...props}
              sx={{
                width: '100%',
                display: 'flex',
                alignItems: 'center',
                gap: 1.25,
                minWidth: 0
              }}
            >
              {/* 徽章一顆，牌組名一行，就這樣。
                  原本這裡是「色底 chip 寫著職業名 + 牌組名」，但這個下拉只列同
                  一個職業的牌組——每一列都重複同一個職業名，最該讀的牌組名反而
                  被推到後面。分類也不寫在列上：清單本來就按分類分組，組標題已經
                  寫著「快攻」，每一列右邊再寫一次是同一個字在同一個畫面說兩次。 */}
              <ClassIcon id={option.class} size={20} />
              <Typography noWrap sx={{ flex: 1, minWidth: 0, fontWeight: 600 }}>
                {option.name}
              </Typography>
            </Box>
          )
        }}
      />

      {/* 新增牌組：和牌組戰績那邊同一個元件、同一份內容。抬高 z-index，因為
          這個下拉本身就住在對局表單的抽屜裡。 */}
      {klass && (
        <NewDeckDrawer
          open={isCreateDrawerOpen}
          klass={klass}
          zIndex={NESTED_DRAWER_Z}
          onClose={() => setIsCreateDrawerOpen(false)}
          onOpenDeck={(deckId) => void handleDeckArrived(deckId)}
          onBuildManually={() => setIsBuilderOpen(true)}
        />
      )}

      {/* 手動建立走的是完整的建構器。它沒有回傳 id，所以存完只能重讀清單，
          讓使用者自己挑——比在這裡猜「剛存的是哪一副」老實。

          用到才掛：建構器有一個不看 `open` 的 `cards:poolBootstrap` 訂閱，會在
          卡池補完的過程中重讀卡池。一張對局表單同時有兩個這種下拉，常駐掛著就
          等於每次進度事件多兩次白做的查詢。 */}
      {isBuilderOpen && (
        <DeckBuilder
          open
          categories={categories}
          initialClass={klass}
          onClose={() => setIsBuilderOpen(false)}
          onSaved={() => void loadDecks()}
        />
      )}
    </>
  )
}

import React, { useEffect, useMemo, useState } from 'react'
import {
  Box,
  Card,
  CardHeader,
  CardContent,
  CardActions,
  IconButton,
  Chip,
  Typography,
  TextField,
  Button,
  Tooltip,
  Divider,
  Stack,
  MenuItem,
  Select,
  FormControl,
  InputLabel,
  Dialog,
  DialogTitle,
  DialogContent,
  DialogActions,
  Tabs,
  Tab,
  Autocomplete,
  Paper,
  Switch,
  FormControlLabel
} from '@mui/material'
import EditIcon from '@mui/icons-material/Edit'
import SaveIcon from '@mui/icons-material/Save'
import CloseIcon from '@mui/icons-material/Close'
import AddIcon from '@mui/icons-material/Add'
import LocalOfferIcon from '@mui/icons-material/LocalOffer'
import PlaylistAddIcon from '@mui/icons-material/PlaylistAdd'
import CategoryIcon from '@mui/icons-material/Category'
import BookmarkAddedIcon from '@mui/icons-material/BookmarkAdded'
import { Match, Deck } from '@prisma/client'
import { classesMap } from '@renderer/map/classMap'

/**
 * 注意：
 * - 後端目前沒有備註/標籤欄位 => 先以前端暫存 (localStorage) 實作。
 * - 牌組與分類：允許使用者新增與套用（用 IPC 連線到後端 decks CRUD）。
 *
 * English tip: Keep UI optimistic; rollback on failure.
 */

// ----------- 類型與暫存 -----------
type MatchWithTags = Match & { tags?: { tag: { name: string } }[] }

type DeckCategory = {
  id: string // 用 uuid 或 'aggro' | 'midrange' | 'control' 這類固定 key
  name: string
}

type LocalNote = {
  matchId: number
  text: string
  tags: string[]
}

type LocalState = {
  notes: Record<number, LocalNote> // key: matchId
  tagPool: string[] // 使用者常用標籤清單
  categories: DeckCategory[] // 自訂分類
}

const EMPTY_TAGS: string[] = []

// 預設三種分類
const DEFAULT_CATEGORIES: DeckCategory[] = [
  { id: 'aggro', name: '快攻' },
  { id: 'midrange', name: '中速' },
  { id: 'control', name: '控制' }
]

// localStorage key
const LS_KEY = 'svwb-home-quick-edit'

function loadLocal(): LocalState {
  try {
    const raw = localStorage.getItem(LS_KEY)
    if (!raw) {
      return { notes: {}, tagPool: [], categories: DEFAULT_CATEGORIES }
    }
    const parsed = JSON.parse(raw) as LocalState
    // 保障有預設分類
    if (!parsed.categories || parsed.categories.length === 0) {
      parsed.categories = DEFAULT_CATEGORIES
    }
    return parsed
  } catch {
    return { notes: {}, tagPool: [], categories: DEFAULT_CATEGORIES }
  }
}

function saveLocal(state: LocalState) {
  localStorage.setItem(LS_KEY, JSON.stringify(state))
}

// ----------- IPC 型別（你 main 端實作對應 handler）-----------
type IPC = typeof window.electron.ipcRenderer

// matches:updateBP => (matchId: number, bp: number | null) => Promise<Match>
const updateBP = (ipc: IPC, matchId: number, bp: number | null) =>
  ipc.invoke('matches:updateBP', matchId, bp) as Promise<Match>

// matches:updateNote (目前無後端) => 先略過，之後你可替換成真正 API
// decks:list => Promise<Deck[]>
const listDecks = (ipc: IPC) => ipc.invoke('decks:list') as Promise<Deck[]>

// decks:create => (payload) => Promise<Deck>
const createDeck = (
  ipc: IPC,
  payload: { name: string; class: string; categoryId?: string | null }
) => ipc.invoke('decks:create', payload) as Promise<Deck>

// matches:updateMyDeck => (matchId, deckId|null) => Promise<Match>
const updateMyDeck = (ipc: IPC, matchId: number, deckId: number | null) =>
  ipc.invoke('matches:updateMyDeck', matchId, deckId) as Promise<Match>

// ----------- 子元件：可內聯編輯的 BP 欄位 -----------
function InlineBPField(props: {
  value: number | null | undefined
  onSave: (bp: number | null) => Promise<void>
}) {
  const [editing, setEditing] = useState(false)
  const [draft, setDraft] = useState<string>('')

  useEffect(() => {
    if (editing) {
      setDraft(props.value === null || props.value === undefined ? '' : String(props.value))
    }
  }, [editing])

  const commit = async () => {
    // empty => null，數字格式允許正/負/零
    const s = draft.trim()
    if (s === '') {
      await props.onSave(null)
      setEditing(false)
      return
    }
    if (!/^[-+]?\d+$/.test(s)) return // 簡單防呆
    const n = parseInt(s, 10)
    await props.onSave(Number.isNaN(n) ? null : n)
    setEditing(false)
  }

  if (!editing) {
    return (
      <Stack direction="row" spacing={1} alignItems="center">
        <Typography variant="body2" sx={{ opacity: 0.8 }}>
          BP
        </Typography>
        <Chip
          size="small"
          label={props.value ?? '—'}
          variant="outlined"
          onClick={() => setEditing(true)}
          onDelete={() => setEditing(true)}
          deleteIcon={<EditIcon fontSize="small" />}
        />
      </Stack>
    )
  }

  return (
    <Stack direction="row" spacing={1} alignItems="center">
      <TextField
        size="small"
        autoFocus
        placeholder="e.g. +22 / -15 / 0"
        value={draft}
        onChange={(e) => setDraft(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'Enter') commit()
          if (e.key === 'Escape') setEditing(false)
        }}
        sx={{ width: 140 }}
        inputProps={{ inputMode: 'numeric' }}
      />
      <Tooltip title="Save">
        <IconButton onClick={commit} color="primary">
          <SaveIcon />
        </IconButton>
      </Tooltip>
      <Tooltip title="Cancel">
        <IconButton onClick={() => setEditing(false)}>
          <CloseIcon />
        </IconButton>
      </Tooltip>
    </Stack>
  )
}

// ----------- 子元件：標籤 / 備註（前端暫存） -----------
function NotesAndTags(props: {
  matchId: number
  note: string | null | undefined
  tags: string[] | undefined
  tagPool: string[]
  setTagPool: (pool: string[]) => void
  onAfterSave: (updated: MatchWithTags) => void
}) {
  const initialNote = props.note ?? ''
  const initialTags = props.tags ?? EMPTY_TAGS

  const [open, setOpen] = useState(false)
  const [draftNote, setDraftNote] = useState(initialNote)
  const [draftTags, setDraftTags] = useState<string[]>(initialTags)

  // 來源變了才同步（避免無窮重設）
  useEffect(() => {
    if (draftNote !== initialNote) setDraftNote(initialNote)
    // 簡單淺比較
    if (draftTags.length !== initialTags.length || draftTags.some((v, i) => v !== initialTags[i])) {
      setDraftTags(initialTags)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [initialNote, initialTags])

  const save = async () => {
    const ipc = window.electron.ipcRenderer
    const cleanNote = draftNote.trim()

    // 1) 先更新 note（回傳 Match 可不含 tags）
    await ipc.invoke('matches:updateNote', props.matchId, cleanNote.length ? cleanNote : null)

    // 2) 再套用 tags（回傳 Match，建議包含 tags）
    const updated = (await ipc.invoke('matches:setTags', props.matchId, draftTags)) as MatchWithTags

    // 更新 tagPool（autocomplete 候選）
    const nextPool = Array.from(new Set([...props.tagPool, ...draftTags])).sort()
    props.setTagPool(nextPool)

    // 通知父層用回 DB 回傳的最新資料（含 note/tags）
    props.onAfterSave(updated)

    setOpen(false)
  }

  return (
    <Box>
      <Stack direction="row" spacing={1} alignItems="center" sx={{ mb: 1 }}>
        <LocalOfferIcon fontSize="small" />
        <Typography variant="body2" sx={{ opacity: 0.8 }}>
          備註 / 標籤
        </Typography>
        <Button
          size="small"
          startIcon={<EditIcon />}
          onClick={() => setOpen(true)}
          variant="outlined"
        >
          編輯
        </Button>
      </Stack>

      {/* 顯示區 */}
      <Stack direction="row" spacing={1} flexWrap="wrap">
        {initialNote ? (
          <Chip size="small" variant="outlined" label={initialNote} />
        ) : (
          <Typography variant="body2" sx={{ opacity: 0.6 }}>
            無備註
          </Typography>
        )}
        {(initialTags.length > 0 ? initialTags : EMPTY_TAGS).map((t) => (
          <Chip key={t} size="small" label={t} />
        ))}
        {initialTags.length === 0 && (
          <Typography variant="body2" sx={{ opacity: 0.6 }}>
            無標籤
          </Typography>
        )}
      </Stack>

      {/* 編輯對話框 */}
      <Dialog open={open} onClose={() => setOpen(false)} maxWidth="sm" fullWidth>
        <DialogTitle>備註與標籤</DialogTitle>
        <DialogContent dividers>
          <Stack spacing={2} sx={{ mt: 1 }}>
            <TextField
              label="備註"
              placeholder="輸入文字備註"
              value={draftNote}
              onChange={(e) => setDraftNote(e.target.value)}
              multiline
              minRows={2}
            />
            <Autocomplete<string, true, false, true>
              multiple
              freeSolo
              options={props.tagPool}
              value={draftTags}
              onChange={(_, value) => setDraftTags(value)}
              renderTags={(value, getTagProps) =>
                value.map((option, index) => (
                  <Chip variant="outlined" label={option} {...getTagProps({ index })} />
                ))
              }
              renderInput={(params) => (
                <TextField {...params} label="標籤（可自訂，Enter 建立）" placeholder="新增標籤" />
              )}
            />
          </Stack>
        </DialogContent>
        <DialogActions>
          <Button onClick={() => setOpen(false)}>取消</Button>
          <Button onClick={save} variant="contained" startIcon={<BookmarkAddedIcon />}>
            儲存
          </Button>
        </DialogActions>
      </Dialog>
    </Box>
  )
}

// ----------- 子元件：選牌組 + 新增牌組 / 分類 -----------
function DeckSelect(props: {
  match: Match
  decks: Deck[]
  categories: DeckCategory[]
  onChangeDeck: (deckId: number | null) => Promise<void>
  onCreateDeck: (payload: {
    name: string
    class: string
    categoryId?: string | null
  }) => Promise<Deck>
  onCreateCategory: (name: string) => void
}) {
  const [open, setOpen] = useState(false)
  const [tab, setTab] = useState<'select' | 'create'>('select')

  const [selectedDeckId, setSelectedDeckId] = useState<number | ''>(props.match.my_deckId ?? '')

  useEffect(() => {
    setSelectedDeckId(props.match.my_deckId ?? '')
  }, [props.match.my_deckId])

  const classColor = classesMap[props.match.my_class]?.color
  const classLabel = classesMap[props.match.my_class]?.label

  const grouped = useMemo(() => {
    // 以 categoryId 分群；沒有分類的放「未分類」
    const map = new Map<string, { category?: DeckCategory; items: Deck[] }>()
    const uncategorizedKey = '__uncat__'
    for (const deck of props.decks) {
      // @ts-expect-error 你的 Deck schema 目前沒有 categoryId；等你加欄位後替換
      const cid: string | undefined = deck.categoryId
      const key = cid ?? uncategorizedKey
      if (!map.has(key))
        map.set(key, { category: props.categories.find((c) => c.id === cid), items: [] })
      map.get(key)!.items.push(deck)
    }
    return Array.from(map.entries())
  }, [props.decks, props.categories])

  // 新增 deck
  const [newDeckName, setNewDeckName] = useState('')
  const [newDeckClass, setNewDeckClass] = useState<string>(props.match.my_class)
  const [newDeckCategoryId, setNewDeckCategoryId] = useState<string | ''>('')

  // 新增分類
  const [createCatOpen, setCreateCatOpen] = useState(false)
  const [newCatName, setNewCatName] = useState('')

  const confirmCreateDeck = async () => {
    if (!newDeckName.trim()) return
    const deck = await props.onCreateDeck({
      name: newDeckName.trim(),
      class: newDeckClass,
      categoryId: newDeckCategoryId || undefined
    })
    // 建立後直接套用
    await props.onChangeDeck(deck.id)
    setNewDeckName('')
    setNewDeckCategoryId('')
    setNewDeckClass(props.match.my_class)
    setTab('select')
  }

  const group = grouped.find(([_, g]) => g.items.some((item) => item.id === props.match.my_deckId))

  const deckName = group ? group[1].items[0].name : undefined

  return (
    <Box>
      <Stack direction="row" spacing={1} alignItems="center" sx={{ mb: 1 }}>
        <PlaylistAddIcon fontSize="small" />
        <Typography variant="body2" sx={{ opacity: 0.8 }}>
          我的牌組
        </Typography>
        <Button
          size="small"
          variant="outlined"
          onClick={() => setOpen(true)}
          startIcon={<EditIcon />}
        >
          選擇 / 新增
        </Button>
      </Stack>

      {/* 顯示目前選擇 */}
      <Stack direction="row" spacing={1} alignItems="center" flexWrap="wrap">
        <Chip
          size="small"
          label={props.match.my_deckId ? `${deckName}` : '未選擇'}
          variant="outlined"
        />
        <Chip
          size="small"
          label={classLabel}
          sx={{ bgcolor: `${classColor}22`, color: classColor }}
        />
      </Stack>

      <Dialog open={open} onClose={() => setOpen(false)} maxWidth="md" fullWidth>
        <DialogTitle>選擇 / 新增牌組</DialogTitle>
        <DialogContent dividers>
          <Tabs value={tab} onChange={(_, v) => setTab(v)} sx={{ mb: 2 }}>
            <Tab label="選擇" value="select" />
            <Tab label="新增" value="create" />
          </Tabs>

          {tab === 'select' && (
            <Stack spacing={2}>
              <Typography variant="body2" sx={{ opacity: 0.8 }}>
                依分類分組（你可自訂分類）
              </Typography>
              <Divider />
              <Stack spacing={2}>
                {grouped.map(([key, group]) => (
                  <Paper key={key} variant="outlined" sx={{ p: 1.5 }}>
                    <Stack direction="row" spacing={1} alignItems="center" sx={{ mb: 1 }}>
                      <CategoryIcon fontSize="small" />
                      <Typography variant="subtitle2">
                        {group.category?.name ?? '未分類'}
                      </Typography>
                    </Stack>
                    <Stack direction="row" spacing={1} flexWrap="wrap">
                      {group.items.length === 0 ? (
                        <Typography variant="body2" sx={{ opacity: 0.6 }}>
                          （空）
                        </Typography>
                      ) : (
                        group.items.map((d) => (
                          <Chip
                            key={d.id}
                            label={`${d.name} (#${d.id})`}
                            onClick={() => setSelectedDeckId(d.id)}
                            color={selectedDeckId === d.id ? 'primary' : 'default'}
                            variant={selectedDeckId === d.id ? 'filled' : 'outlined'}
                            sx={{ mb: 1 }}
                          />
                        ))
                      )}
                    </Stack>
                  </Paper>
                ))}
              </Stack>
            </Stack>
          )}

          {tab === 'create' && (
            <Stack spacing={2}>
              <TextField
                label="牌組名稱"
                value={newDeckName}
                onChange={(e) => setNewDeckName(e.target.value)}
                placeholder="輸入新牌組名稱"
                autoFocus
              />
              <FormControl fullWidth>
                <InputLabel id="deck-class-label">職業</InputLabel>
                <Select
                  labelId="deck-class-label"
                  label="職業"
                  value={newDeckClass}
                  onChange={(e) => setNewDeckClass(String(e.target.value))}
                >
                  {Object.entries(classesMap).map(([key, v]) => (
                    <MenuItem key={key} value={key}>
                      <Stack direction="row" spacing={1} alignItems="center">
                        <Chip
                          size="small"
                          sx={{ bgcolor: `${v.color}22`, color: v.color }}
                          label={v.label}
                        />
                        <Typography variant="body2">{key}</Typography>
                      </Stack>
                    </MenuItem>
                  ))}
                </Select>
              </FormControl>

              <FormControl fullWidth>
                <InputLabel id="deck-cat-label">分類</InputLabel>
                <Select
                  labelId="deck-cat-label"
                  label="分類"
                  value={newDeckCategoryId}
                  onChange={(e) => setNewDeckCategoryId(String(e.target.value))}
                >
                  <MenuItem value="">未分類</MenuItem>
                  {props.categories.map((c) => (
                    <MenuItem key={c.id} value={c.id}>
                      {c.name}
                    </MenuItem>
                  ))}
                </Select>
              </FormControl>

              <Stack direction="row" spacing={1} alignItems="center">
                <Button
                  variant="outlined"
                  size="small"
                  startIcon={<CategoryIcon />}
                  onClick={() => setCreateCatOpen(true)}
                >
                  新增分類
                </Button>
              </Stack>
            </Stack>
          )}
        </DialogContent>
        <DialogActions>
          <Button onClick={() => setOpen(false)}>關閉</Button>
          {tab === 'select' ? (
            <Button
              variant="contained"
              startIcon={<SaveIcon />}
              onClick={async () => {
                const id = selectedDeckId === '' ? null : Number(selectedDeckId)
                await props.onChangeDeck(id)
                setOpen(false)
              }}
            >
              套用
            </Button>
          ) : (
            <Button
              variant="contained"
              startIcon={<AddIcon />}
              onClick={confirmCreateDeck}
              disabled={!newDeckName.trim()}
            >
              建立
            </Button>
          )}
        </DialogActions>
      </Dialog>

      {/* 建立分類 */}
      <Dialog open={createCatOpen} onClose={() => setCreateCatOpen(false)}>
        <DialogTitle>新增分類</DialogTitle>
        <DialogContent dividers>
          <TextField
            autoFocus
            label="分類名稱"
            value={newCatName}
            onChange={(e) => setNewCatName(e.target.value)}
            fullWidth
            placeholder="例如：Combo / Tempo / Control"
          />
        </DialogContent>
        <DialogActions>
          <Button onClick={() => setCreateCatOpen(false)}>取消</Button>
          <Button
            onClick={() => {
              const n = newCatName.trim()
              if (!n) return
              props.onCreateCategory(n)
              setNewCatName('')
              setCreateCatOpen(false)
            }}
            variant="contained"
          >
            新增
          </Button>
        </DialogActions>
      </Dialog>
    </Box>
  )
}

// ----------- 主元件：首頁快速編輯卡 -----------
export default function MatchQuickEditCard() {
  const [local, setLocal] = useState<LocalState>(() => loadLocal())
  const [decks, setDecks] = useState<Deck[]>([])
  const [matches, setMatches] = useState<MatchWithTags[]>([])
  const [onlyToday, setOnlyToday] = useState(true)

  const ipc = window.electron.ipcRenderer

  // 載入資料
  useEffect(() => {
    const load = async () => {
      const [d, ms] = await Promise.all([
        listDecks(ipc).catch(() => []),
        ipc.invoke('matches:fetchRecent', 10).catch(() => [])
      ])
      setDecks(d)
      setMatches(ms)
    }
    load()
  }, [])

  const filteredMatches = useMemo(() => {
    if (!onlyToday) return matches
    const start = new Date()
    start.setHours(0, 0, 0, 0)
    return matches.filter((m) => new Date(m.playedAt) >= start)
  }, [matches, onlyToday])

  // BP 更新（Optimistic）
  const handleSaveBP = async (matchId: number, nextBP: number | null) => {
    const prev = matches
    const optimistic = prev.map((m) => (m.id === matchId ? { ...m, bp: nextBP ?? null } : m))
    setMatches(optimistic)
    try {
      const res = await updateBP(ipc, matchId, nextBP)
      setMatches((cur) => cur.map((m) => (m.id === matchId ? res : m)))
    } catch (e) {
      // rollback
      setMatches(prev)
    }
  }

  // 更換我的牌組（Optimistic）
  const handleChangeDeck = async (matchId: number, deckId: number | null) => {
    const prev = matches
    setMatches(prev.map((m) => (m.id === matchId ? { ...m, my_deckId: deckId ?? null } : m)))
    try {
      const res = await updateMyDeck(ipc, matchId, deckId)
      setMatches((cur) => cur.map((m) => (m.id === matchId ? res : m)))
    } catch {
      setMatches(prev)
    }
  }

  // 新增 Deck（呼叫後端建立，成功後合併到 decks）
  const handleCreateDeck = async (payload: {
    name: string
    class: string
    categoryId?: string | null
  }) => {
    const deck = await createDeck(ipc, payload)
    setDecks((ds) => [deck, ...ds])
    return deck
  }

  // 新增分類（前端暫存）
  const handleCreateCategory = (name: string) => {
    const id = `cat_${Date.now()}`
    const next = { ...local, categories: [...local.categories, { id, name }] }
    setLocal(next)
    saveLocal(next)
  }

  return (
    <Card>
      <CardHeader
        title="最近對戰 - 快速編輯"
        subheader="快速修改 BP、備註/標籤、我的牌組"
        action={
          <FormControlLabel
            control={<Switch checked={onlyToday} onChange={(_, v) => setOnlyToday(v)} />}
            label="只看今天"
          />
        }
      />
      <CardContent>
        {filteredMatches.length === 0 ? (
          <Typography variant="body2" sx={{ opacity: 0.7 }}>
            尚無資料。
          </Typography>
        ) : (
          <Stack spacing={1.5}>
            {filteredMatches.map((m) => {
              const myC = classesMap[m.my_class]
              const opC = classesMap[m.oppo_class]
              const win = m.result === true
              return (
                <Paper key={m.id} variant="outlined" sx={{ p: 1.5, borderRadius: 2 }}>
                  <Stack direction="row" spacing={2} alignItems="center" flexWrap="wrap">
                    <Chip
                      size="small"
                      label={win ? '勝' : m.result === false ? '敗' : '未定'}
                      color={win ? 'success' : m.result === false ? 'error' : 'default'}
                    />
                    <Chip
                      size="small"
                      label={myC.label}
                      sx={{ bgcolor: `${myC.color}22`, color: myC.color }}
                    />
                    <Typography variant="body2">vs</Typography>
                    <Chip
                      size="small"
                      label={opC.label}
                      sx={{ bgcolor: `${opC.color}22`, color: opC.color }}
                    />
                    <Typography variant="body2" sx={{ ml: 'auto', opacity: 0.75 }}>
                      {new Date(m.playedAt).toLocaleString()}
                    </Typography>
                  </Stack>

                  <Divider sx={{ my: 1 }} />

                  <Stack
                    direction={{ xs: 'column', sm: 'row' }}
                    spacing={2}
                    alignItems={{ xs: 'flex-start', sm: 'center' }}
                    justifyContent="space-between"
                  >
                    <InlineBPField value={m.bp ?? null} onSave={(bp) => handleSaveBP(m.id, bp)} />

                    <DeckSelect
                      match={m}
                      decks={decks}
                      categories={local.categories}
                      onChangeDeck={(id) => handleChangeDeck(m.id, id)}
                      onCreateDeck={handleCreateDeck}
                      onCreateCategory={handleCreateCategory}
                    />
                  </Stack>

                  <Divider sx={{ my: 1 }} />

                  <NotesAndTags
                    matchId={m.id}
                    note={m.note ?? ''}
                    tags={(m.tags ?? []).map((t) => t.tag.name)}
                    tagPool={local.tagPool}
                    setTagPool={(pool) => {
                      const next = { ...local, tagPool: pool }
                      setLocal(next)
                      saveLocal(next) // 只存 tagPool / categories
                    }}
                    onAfterSave={(updated) => {
                      // 後端回來的最新 match（含 note/tags）
                      setMatches((cur) => cur.map((x) => (x.id === updated.id ? updated : x)))
                    }}
                  />
                </Paper>
              )
            })}
          </Stack>
        )}
      </CardContent>
      {/* <CardActions sx={{ justifyContent: 'flex-end' }}>
        <Tooltip title="到完整歷史頁">
          <IconButton onClick={() => window.electronAPI?.openLink?.('#/history')}>
            <PlaylistAddIcon />
          </IconButton>
        </Tooltip>
      </CardActions> */}
    </Card>
  )
}

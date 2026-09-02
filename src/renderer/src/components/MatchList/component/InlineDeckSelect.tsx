import React from 'react'
import { ButtonBase, ListSubheader, Menu, MenuItem, Typography } from '@mui/material'
import ArrowDropDownIcon from '@mui/icons-material/ArrowDropDown'

/**
 * 卡片上牌組欄的固定字串，也是這個下拉的觸發區。短到只有三個字，是為了讓整個
 * 觸發區（含箭頭）塞得進牌組欄的寬度 - 它就在職業底下，不必再說一次「牌組」。
 */
export const NO_DECK_LABEL = '未設定'

const UNGROUPED_LABEL = '（未分類）'

export type InlineDeckOption = {
  id: number
  name: string
  classId: string | number | null
  categoryName: string | null
}

type Props = {
  /** 只有同職業的牌組會出現在清單裡 */
  klass: string
  options: InlineDeckOption[]
  onSelect: (deckId: number) => void
}

/**
 * 「未設定牌組」這行本身就是下拉的觸發區：補一筆漏掉的牌組是掃讀清單時最常
 * 想做的修正，不值得為它開一次編輯視窗。清單只列同職業的牌組，因為牌組的職業
 * 是固定的，跨職業的選項在這裡永遠是錯的。
 *
 * 只做「選一個牌組」；改名、刪除、新增仍留在編輯視窗與牌組管理頁，避免這個
 * 每列都會出現的小控制項長成第二套牌組管理介面。
 */
const InlineDeckSelect: React.FC<Props> = ({ klass, options, onSelect }) => {
  const [anchorEl, setAnchorEl] = React.useState<HTMLElement | null>(null)

  const choices = React.useMemo(
    () => options.filter((option) => option.classId === klass),
    [options, klass]
  )

  // 同分類的牌組收在一起，順序沿用 useDecksTags 已排好的分類順序
  const groups = React.useMemo(() => {
    const byCategory = new Map<string, InlineDeckOption[]>()
    choices.forEach((option) => {
      const key = option.categoryName || UNGROUPED_LABEL
      const bucket = byCategory.get(key)
      if (bucket) bucket.push(option)
      else byCategory.set(key, [option])
    })
    return Array.from(byCategory, ([name, decks]) => ({ name, decks }))
  }, [choices])

  const close = (): void => setAnchorEl(null)

  return (
    <>
      <ButtonBase
        onClick={(event) => {
          event.stopPropagation()
          setAnchorEl(event.currentTarget)
        }}
        sx={{
          maxWidth: '100%',
          borderRadius: 0.5,
          px: 0.25,
          ml: -0.25,
          color: 'text.disabled',
          transition: 'color 140ms ease-out, background-color 140ms ease-out',
          '&:hover, &.Mui-focusVisible': {
            color: 'text.secondary',
            backgroundColor: 'rgba(255,255,255,0.06)'
          }
        }}
      >
        {/* 這個標籤是固定的三個字，所以刻意不用 `noWrap`：省略號要能省下寬度，
            前提是被省掉的部分比省略號本身寬，而「未設…」並沒有省到什麼，只是
            讓一個本來讀得完的字被吃掉。欄寬已經按它算過（見 MatchCard 的
            `DECK_PLACEHOLDER_WIDTH`），這裡就讓它整個顯示出來。 */}
        <Typography
          variant="body2"
          sx={{
            fontSize: 12.5,
            lineHeight: 1.35,
            fontStyle: 'italic',
            color: 'inherit',
            whiteSpace: 'nowrap',
            flexShrink: 0
          }}
        >
          {NO_DECK_LABEL}
        </Typography>
        <ArrowDropDownIcon sx={{ fontSize: 16, flexShrink: 0 }} />
      </ButtonBase>

      <Menu
        open={!!anchorEl}
        anchorEl={anchorEl}
        onClose={close}
        anchorOrigin={{ vertical: 'bottom', horizontal: 'left' }}
        transformOrigin={{ vertical: 'top', horizontal: 'left' }}
        slotProps={{
          list: { dense: true, sx: { py: 0.5, minWidth: 180 } },
          paper: { sx: { maxHeight: 320 } }
        }}
      >
        {choices.length === 0 && (
          <MenuItem disabled>
            <Typography variant="body2">此職業尚無牌組</Typography>
          </MenuItem>
        )}
        {groups.flatMap((group) => [
          groups.length > 1 ? (
            <ListSubheader key={`header:${group.name}`} disableSticky sx={{ lineHeight: 2 }}>
              {group.name}
            </ListSubheader>
          ) : null,
          ...group.decks.map((deck) => (
            <MenuItem
              key={deck.id}
              onClick={(event) => {
                event.stopPropagation()
                close()
                onSelect(deck.id)
              }}
            >
              <Typography variant="body2" noWrap>
                {deck.name}
              </Typography>
            </MenuItem>
          ))
        ])}
      </Menu>
    </>
  )
}

export default InlineDeckSelect

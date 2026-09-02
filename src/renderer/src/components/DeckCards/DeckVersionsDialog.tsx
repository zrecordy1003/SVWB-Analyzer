/**
 * `DeckVersionsPanel` in a dialog, for screens that have no row to expand.
 *
 * 牌組管理 lays decks out as a grid of fixed-height cards, so its version
 * history opens here rather than inline. The stats are the family's whole
 * record (`rangeKey: 'all'`, grouped per version) - this screen has no date
 * filter of its own to inherit.
 */
import HistoryRoundedIcon from '@mui/icons-material/HistoryRounded'
import AppDialog from '@renderer/components/Common/AppDialog'
import React from 'react'

import DeckVersionsPanel, {
  type CorrectVersionRequest,
  type VersionDeckLike,
  type VersionStat
} from './DeckVersionsPanel'
import type { DeckFamily } from './deckVersions'

type StatsRow = {
  deckId: number | null
  total: number
  wins: number
  winRate: number
  firstPlayedAt?: number | null
  lastPlayedAt?: number | null
}

export default function DeckVersionsDialog<T extends VersionDeckLike>({
  open,
  family,
  zIndex,
  onClose,
  onChanged,
  onCorrect
}: {
  open: boolean
  family: DeckFamily<T> | null
  zIndex?: number
  onClose: () => void
  onChanged?: () => void
  /** Passed through to the panel's 「修正卡表…」. */
  onCorrect?: (request: CorrectVersionRequest) => void
}): React.JSX.Element {
  const [stats, setStats] = React.useState<Map<number, VersionStat> | null>(null)

  const familyKey = family ? family.versions.map((v) => v.deck.id).join(',') : ''

  React.useEffect(() => {
    if (!open || !family) return
    let cancelled = false
    setStats(null)
    void window.electron.ipcRenderer
      .invoke('decks:stats', {
        rangeKey: 'all',
        mode: 'all',
        groupBy: 'deck',
        deckIds: family.versions.map((v) => v.deck.id)
      })
      .then((res: { ok: boolean; data?: StatsRow[] }) => {
        if (cancelled) return
        const map = new Map<number, VersionStat>()
        for (const row of res?.ok ? (res.data ?? []) : []) {
          if (row.deckId !== null) {
            map.set(row.deckId, {
              total: row.total,
              wins: row.wins,
              winRate: row.winRate,
              firstPlayedAt: row.firstPlayedAt ?? null,
              lastPlayedAt: row.lastPlayedAt ?? null
            })
          }
        }
        setStats(map)
      })
      .catch(() => {
        if (!cancelled) setStats(new Map())
      })
    return () => {
      cancelled = true
    }
    // familyKey stands in for the family object, which is rebuilt on every reload.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, familyKey])

  return (
    <AppDialog
      open={open}
      onClose={onClose}
      title={family?.current.name ?? '版本歷史'}
      subtitle={family ? `${family.versions.length} 個版本` : undefined}
      icon={<HistoryRoundedIcon fontSize="small" />}
      zIndex={zIndex}
      maxWidth="sm"
    >
      {family && (
        <DeckVersionsPanel
          family={family}
          stats={stats}
          zIndex={zIndex}
          onChanged={onChanged}
          onCorrect={onCorrect}
        />
      )}
    </AppDialog>
  )
}

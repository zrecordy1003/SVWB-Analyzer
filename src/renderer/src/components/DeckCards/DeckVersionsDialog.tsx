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
import { deckStatsResource } from '@renderer/resources'

// `type StatsRow` was here - a local restatement of `DeckStatsRow`, which the
// resource now supplies typed. One less shape to keep in step.

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
  /**
   * Through the shared `decks:stats` cache, not a fetch of its own.
   *
   * This was a `useState` plus an effect with its own error handling, its own
   * cancellation flag, and no de-duplication against the deck-performance page
   * behind it - which asks the same channel. Sharing the resource means opening
   * this dialog can hit a warm answer, and a `matches:needRefetch` refreshes
   * both from one request.
   *
   * The query is `null` while the dialog is closed or has no family, so it
   * issues nothing until there is something to ask about.
   */
  const versionIds = family ? family.versions.map((v) => v.deck.id) : []
  const familyKey = versionIds.join(',')
  const query = React.useMemo(
    () =>
      open && family
        ? ([
            {
              rangeKey: 'all' as const,
              mode: 'all' as const,
              groupBy: 'deck' as const,
              deckIds: versionIds
            }
          ] as const)
        : null,
    // `familyKey` stands in for the family object, which is rebuilt on every
    // reload; depending on the array would refetch for each new identity.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [open, familyKey]
  )
  const { data: rows } = deckStatsResource.use(query ? [query[0]] : null)

  /**
   * `null` until the first answer, which the render below reads as "loading".
   * A failed query leaves `rows` null and the dialog says loading rather than
   * claiming every version has no games - the previous version turned an
   * error into an empty Map, which looks exactly like a real answer.
   */
  const stats = React.useMemo(() => {
    if (!rows) return null
    const map = new Map<number, VersionStat>()
    for (const row of rows) {
      if (row.deckId === null) continue
      map.set(row.deckId, {
        total: row.total,
        wins: row.wins,
        winRate: row.winRate,
        firstPlayedAt: row.firstPlayedAt ?? null,
        lastPlayedAt: row.lastPlayedAt ?? null
      })
    }
    return map
  }, [rows])

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

/**
 * What the provenance columns add up to.
 *
 * `provenance.ts` records one row's history; this reads all of them back. The
 * question it exists to answer is not "how many matches were edited" - it is
 * whether the engine's own doubts predict the corrections people actually make.
 *
 * That is a real experiment with a real outcome. If matches carrying
 * `weak-mode-accepted` get their mode corrected far more often than unflagged
 * ones, the flag has predictive power and can gate what is worth aggregating.
 * If the two rates are the same, the flag is decoration and the gate has to be
 * built out of something else - which is worth knowing BEFORE any of it is
 * published, not after.
 *
 * Pure, like `provenance.ts`: the caller does the reading, this does the
 * counting.
 */
import type { FlagBreakdown, ProvenanceStats, ProvenanceTransition } from '../../shared/types.js'
import { OBSERVED_COLUMNS } from './provenance.js'

export type { FlagBreakdown, ProvenanceStats, ProvenanceTransition }

/**
 * Columns whose before/after values are worth tabulating.
 *
 * `bp` and `playedAt` are excluded on purpose: a transition table keyed on
 * continuous values has one row per observation and says nothing. They are
 * still counted as changes, just without their values.
 */
const CATEGORICAL_COLUMNS = ['result', 'play_order', 'my_class', 'oppo_class', 'mode'] as const

/** One row, projected down to what this module reads. */
export type ProvenanceRow = {
  source: string | null
  result: number | null
  play_order: string | null
  my_class: string | null
  oppo_class: string | null
  mode: string | null
  bp: number | null
  playedAt: number | null
  observed: string | null
  edited_fields: string | null
  recog_flags: string | null
}

/** `SELECT source, COUNT(*) ... GROUP BY source`, as handed in. */
export type SourceCount = { source: string | null; count: number }

function parseArray(raw: string | null): string[] {
  if (!raw) return []
  try {
    const parsed: unknown = JSON.parse(raw)
    return Array.isArray(parsed) ? parsed.filter((v): v is string => typeof v === 'string') : []
  } catch {
    return []
  }
}

function parseObject(raw: string | null): Record<string, unknown> | null {
  if (!raw) return null
  try {
    const parsed: unknown = JSON.parse(raw)
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : null
  } catch {
    return null
  }
}

/** Stable, readable labels for the transition table. */
function label(field: string, value: unknown): string {
  if (value === null || value === undefined) return '(空)'
  if (field === 'result') return value === 1 || value === true ? '勝' : '敗'
  return String(value)
}

export function summariseProvenance(
  sources: readonly SourceCount[],
  rows: readonly ProvenanceRow[]
): ProvenanceStats {
  const bySource = { engine: 0, manual: 0, unknown: 0 }
  let total = 0
  for (const { source, count } of sources) {
    total += count
    if (source === 'engine') bySource.engine += count
    else if (source === 'manual') bySource.manual += count
    else bySource.unknown += count
  }

  const editedByField: Record<string, number> = {}
  const flagged: Record<string, FlagBreakdown> = {}
  const transitionCounts = new Map<string, ProvenanceTransition>()
  let editedMatches = 0
  let correctedMatches = 0

  // The cross-tab is restricted to engine-written rows: a pre-provenance row
  // could never have been flagged, so counting it as "unflagged" would pad the
  // comparison group with matches that never had the chance to be either.
  let engineFlagged = 0
  let engineFlaggedCorrected = 0
  let engineCorrected = 0

  for (const row of rows) {
    const edits = parseArray(row.edited_fields)
    const flags = parseArray(row.recog_flags)

    // "Corrected" is narrower than "edited": only an overwrite of something a
    // statistic reads. A note or a deck assignment leaves the observation
    // intact, and counting it here would drown the signal in bookkeeping.
    const corrected = edits.some((field) => (OBSERVED_COLUMNS as readonly string[]).includes(field))

    if (edits.length) editedMatches += 1
    if (corrected) correctedMatches += 1
    for (const field of edits) editedByField[field] = (editedByField[field] ?? 0) + 1

    // A row may carry several flags and is counted under each: the question is
    // per-flag predictive power, not a partition of the rows.
    for (const flag of flags) {
      const held = (flagged[flag] ??= { matches: 0, corrected: 0 })
      held.matches += 1
      if (corrected) held.corrected += 1
    }

    if (row.source === 'engine') {
      if (corrected) engineCorrected += 1
      if (flags.length) {
        engineFlagged += 1
        if (corrected) engineFlaggedCorrected += 1
      }
    }

    const observed = parseObject(row.observed)
    if (!observed) continue
    for (const field of CATEGORICAL_COLUMNS) {
      // An absent key means "not recorded", which is not the same as a recorded
      // null. Treating the two alike invents a transition out of every column
      // the snapshot happens not to carry.
      if (!(field in observed)) continue
      const before = observed[field] ?? null
      const after = row[field] ?? null
      if (Object.is(before, after)) continue
      const from = label(field, before)
      const to = label(field, after)
      // JSON rather than a delimiter: a class or mode value can contain
      // anything, and a collided key would silently merge two transitions.
      const key = JSON.stringify([field, from, to])
      const held = transitionCounts.get(key)
      if (held) held.count += 1
      else transitionCounts.set(key, { field, from, to, count: 1 })
    }
  }

  return {
    total,
    bySource,
    editedMatches,
    correctedMatches,
    editedByField,
    flagged,
    unflagged: {
      matches: Math.max(0, bySource.engine - engineFlagged),
      corrected: Math.max(0, engineCorrected - engineFlaggedCorrected)
    },
    transitions: [...transitionCounts.values()].sort((a, b) => b.count - a.count)
  }
}

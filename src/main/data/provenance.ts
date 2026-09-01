/**
 * What a user edit records about itself.
 *
 * An edit used to be a plain overwrite: the engine read `weekendPlaza`, the
 * user corrected it to `ranked`, and what the engine had seen was gone. That
 * loses two different things at once. The obvious one is trust - a row that has
 * been rewritten by hand cannot be told apart from one the engine wrote, so no
 * statistic can say which of its inputs were observed. The less obvious one is
 * that every correction is a free label: the rate at which people change
 * `weekendPlaza` back to `ranked` IS the measured false-positive rate of that
 * probe, and it was being thrown away on every save.
 *
 * So an edit becomes an overlay. The engine's values are snapshotted once, the
 * first time an edit would destroy them, and the columns a person touched are
 * recorded by name.
 *
 * Everything here is pure: it takes the row as it stands and the values about
 * to be written, and returns the provenance columns to write alongside them.
 * The callers are `ipc/matches.ts`; nothing in this file talks to a database.
 */

/**
 * Columns a person may edit through the UI.
 *
 * An allowlist rather than "whatever is in the payload", so a column added
 * later is a deliberate decision here instead of silently joining - or silently
 * missing from - the record.
 *
 * `year` / `month` / `day` are absent on purpose: they are derived from
 * `playedAt` at the point of the write, so recording them would report three
 * edits for one act. `tags` is not a column at all - it lives in `MatchTag` -
 * and is passed in separately by the caller.
 */
export const EDITABLE_COLUMNS = [
  'result',
  'play_order',
  'my_class',
  'oppo_class',
  'mode',
  'bp',
  'durationTime',
  'playedAt',
  'note',
  'my_deckId',
  'oppo_deckId'
] as const

export type EditableColumn = (typeof EDITABLE_COLUMNS)[number]

/**
 * The engine-observed columns a statistic can read.
 *
 * This is the set worth snapshotting. `note`, `my_deckId` and `oppo_deckId` are
 * excluded because no statistic reads them, and `durationTime` because it is
 * derived from the engine's own clock rather than recognised from the screen.
 */
export const OBSERVED_COLUMNS = [
  'result',
  'play_order',
  'my_class',
  'oppo_class',
  'mode',
  'bp',
  'playedAt'
] as const

export type ObservedColumn = (typeof OBSERVED_COLUMNS)[number]

/** The subset of a `Match` row this module reads. */
export type ProvenanceSource = {
  [K in EditableColumn]?: unknown
} & {
  observed?: string | null
  edited_fields?: string | null
}

export type ProvenancePatch = {
  observed?: string
  edited_fields?: string
}

/**
 * Which editable columns this write actually changes.
 *
 * Compared by value, never by presence. The edit dialog sends its whole form on
 * every save, so a payload that mentions `my_class` says nothing about whether
 * anyone changed it - treating presence as an edit would mark a row as
 * hand-written the moment someone opened the dialog and pressed save.
 */
export function changedColumns(
  current: ProvenanceSource,
  values: Record<string, unknown>
): EditableColumn[] {
  return EDITABLE_COLUMNS.filter(
    (column) =>
      column in values && !Object.is(normalise(values[column]), normalise(current[column]))
  )
}

/** `undefined` and `null` both mean "no value"; the DB only ever holds `null`. */
function normalise(value: unknown): unknown {
  return value === undefined ? null : value
}

function parseList(raw: string | null | undefined): string[] {
  if (!raw) return []
  try {
    const parsed: unknown = JSON.parse(raw)
    return Array.isArray(parsed)
      ? parsed.filter((item): item is string => typeof item === 'string')
      : []
  } catch {
    // A row whose JSON we cannot read is not a reason to fail the user's edit.
    return []
  }
}

/**
 * The provenance columns to write alongside a user edit.
 *
 * Returns `null` when nothing changed, so a no-op save leaves no trace.
 *
 * `extraFields` carries edits that are not columns of `Match` - `'tags'` is the
 * only one today.
 */
export function provenancePatch(
  current: ProvenanceSource,
  values: Record<string, unknown>,
  extraFields: readonly string[] = []
): ProvenancePatch | null {
  const changed: string[] = [...changedColumns(current, values), ...extraFields]
  if (changed.length === 0) return null

  const patch: ProvenancePatch = {}

  const known = new Set(parseList(current.edited_fields))
  const before = known.size
  for (const field of changed) known.add(field)
  // Only write the column when the set actually grew - re-editing the same
  // field twice is one fact, and rewriting an identical array on every save
  // would churn the row for nothing.
  if (known.size !== before) {
    patch.edited_fields = JSON.stringify([...known])
  }

  // Snapshot once, and only when this edit is about to destroy something a
  // statistic reads. A note or a deck assignment leaves the observation intact,
  // so it must not consume the one chance to record it.
  const destroysAnObservation = changed.some((field) =>
    (OBSERVED_COLUMNS as readonly string[]).includes(field)
  )
  if (!current.observed && destroysAnObservation) {
    const snapshot: Record<string, unknown> = {}
    for (const column of OBSERVED_COLUMNS) snapshot[column] = normalise(current[column])
    patch.observed = JSON.stringify(snapshot)
  }

  return Object.keys(patch).length ? patch : null
}

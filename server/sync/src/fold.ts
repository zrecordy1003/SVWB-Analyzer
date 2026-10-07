/**
 * The fold: the one place the server reads a payload.
 *
 * When the cron retires an idle device, its snapshot and segments are merged
 * into a single new snapshot. The rule (docs/sync-protocol.md): for each
 * `(tbl, uid)` keep the line with the greatest `ts`; on equal `ts` the line
 * that appears LATER wins.
 *
 * Pure on purpose - strings in, string out, no storage - so it can be tested
 * as a property of its input rather than through a fake bucket.
 *
 * Properties the tests hold it to:
 *   - exactly one line per `(tbl, uid)` survives, and it is the max-`ts` one;
 *   - idempotent: folding a folded text changes nothing;
 *   - with distinct timestamps the result does not depend on input order
 *     (so a retried or reordered fold cannot corrupt a log);
 *   - deletes are kept as tombstones. Dropping one would resurrect the row on
 *     every device that had not yet applied it.
 *
 * Lines that cannot be keyed (not JSON, no string `tbl`/`uid`, no finite `ts`)
 * are dropped and counted. The protocol allows a torn last line, and a client
 * cannot apply a line it cannot key either.
 */

export interface FoldResult {
  /** The new snapshot: a header line, then the surviving lines, newline-terminated. */
  text: string
  /** Surviving change lines. */
  lines: number
  /** Lines discarded because they could not be keyed. */
  dropped: number
}

interface Survivor {
  ts: number
  /** Position in the input; the tie-break for the output order. */
  order: number
  line: string
}

export function foldJsonl(
  texts: readonly string[],
  header: { device: string; seq: number }
): FoldResult {
  const winners = new Map<string, Survivor>()
  let schemaVersion: number | null = null
  let lastHeader: Record<string, unknown> | null = null
  let dropped = 0
  let order = 0

  for (const text of texts) {
    for (const raw of text.split('\n')) {
      const line = raw.endsWith('\r') ? raw.slice(0, -1) : raw
      if (line.trim() === '') continue
      let parsed: unknown
      try {
        parsed = JSON.parse(line)
      } catch {
        dropped++
        continue
      }
      if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
        dropped++
        continue
      }
      const row = parsed as Record<string, unknown>

      // A header is an object with no `tbl`. Segments each carry one; the fold
      // keeps the last as the template and the highest schemaVersion, since the
      // merged snapshot must not claim to be older than the newest data in it.
      if (row.tbl === undefined) {
        lastHeader = row
        if (typeof row.schemaVersion === 'number' && Number.isFinite(row.schemaVersion)) {
          schemaVersion = Math.max(schemaVersion ?? row.schemaVersion, row.schemaVersion)
        }
        continue
      }

      if (
        typeof row.tbl !== 'string' ||
        typeof row.uid !== 'string' ||
        row.tbl === '' ||
        row.uid === '' ||
        typeof row.ts !== 'number' ||
        !Number.isFinite(row.ts)
      ) {
        dropped++
        continue
      }
      // JSON.stringify of a pair: no separator character can be forged by a
      // table name or uid containing it.
      const key = JSON.stringify([row.tbl, row.uid])
      const current = winners.get(key)
      // `>=`: on a tie the later line wins.
      if (!current || row.ts >= current.ts) winners.set(key, { ts: row.ts, order: order, line })
      order++
    }
  }

  const merged: Record<string, unknown> = { v: 1, ...(lastHeader ?? {}) }
  merged.device = header.device
  merged.seq = header.seq
  if (schemaVersion !== null) merged.schemaVersion = schemaVersion

  const survivors = [...winners.values()].sort((a, b) => a.ts - b.ts || a.order - b.order)
  const out = [JSON.stringify(merged), ...survivors.map((s) => s.line)]
  return { text: out.join('\n') + '\n', lines: survivors.length, dropped }
}

/**
 * The file format of a run of changes, and nothing else.
 *
 * One JSON object per line: a header, then one entry per changed row. JSONL
 * because it can be written by appending and because a torn last line (a
 * crashed upload, a truncated download) costs that one line instead of the
 * whole file. The Worker reads only `tbl`, `uid` and `ts` of each line, and
 * only when folding a retired device's history; everything else here is
 * opaque to it. The contract is `docs/sync-protocol.md`.
 */
import { createHash } from 'node:crypto'
import type { SyncTable } from './merge.js'
import { SYNC_TABLES } from './merge.js'

export const SEGMENT_FORMAT = 1

/** A segment closes when it reaches either of these, whichever comes first. */
export const MAX_SEGMENT_ENTRIES = 1000
/** Well under the server's 1 MB, with room for the header and for multibyte text. */
export const MAX_SEGMENT_BYTES = 512 * 1024

export interface SegmentHeader {
  v: typeof SEGMENT_FORMAT
  /** The newest migration the writer had applied. Readers older than this must not apply it. */
  schemaVersion: number
  device: string
  seq: number
  /** The writer's clock high-water mark when it wrote this. */
  hlc: number
}

export interface Entry {
  tbl: SyncTable
  uid: string
  op: 'upsert' | 'delete'
  ts: number
  /** Present on an upsert. Foreign keys are uids here, never local integer ids. */
  row?: Record<string, unknown>
  /** A match's tags, by uid - the whole set, replacing whatever the reader has. */
  tagUids?: string[]
  /** A deck's cards - the whole list, replacing whatever the reader has. */
  cards?: Array<{ cardId: number; count: number }>
}

export interface Segment {
  header: SegmentHeader
  entries: Entry[]
  /** Lines that could not be read. A torn tail is normal; anything else is worth a log line. */
  skipped: number
}

export function serializeSegment(header: SegmentHeader, entries: readonly Entry[]): string {
  const lines = [JSON.stringify(header)]
  for (const entry of entries) lines.push(JSON.stringify(entry))
  return lines.join('\n') + '\n'
}

/** The size one entry adds to a segment, counting the newline. */
export function entryBytes(entry: Entry): number {
  return Buffer.byteLength(JSON.stringify(entry), 'utf8') + 1
}

/**
 * Cut a list of entries into segments that fit the limits.
 *
 * An entry larger than the byte limit on its own still gets a segment to
 * itself rather than being dropped: losing a row silently is worse than one
 * oversized upload, and the server will say so loudly if it really is too big.
 */
export function splitEntries(entries: readonly Entry[]): Entry[][] {
  const out: Entry[][] = []
  let current: Entry[] = []
  let bytes = 0
  for (const entry of entries) {
    const size = entryBytes(entry)
    if (
      current.length > 0 &&
      (current.length >= MAX_SEGMENT_ENTRIES || bytes + size > MAX_SEGMENT_BYTES)
    ) {
      out.push(current)
      current = []
      bytes = 0
    }
    current.push(entry)
    bytes += size
  }
  if (current.length > 0) out.push(current)
  return out
}

function isHeader(value: unknown): value is SegmentHeader {
  if (typeof value !== 'object' || value === null) return false
  const h = value as Record<string, unknown>
  return (
    h.v === SEGMENT_FORMAT &&
    Number.isInteger(h.schemaVersion) &&
    typeof h.device === 'string' &&
    h.device.length > 0 &&
    Number.isInteger(h.seq) &&
    typeof h.hlc === 'number'
  )
}

function asEntry(value: unknown): Entry | null {
  if (typeof value !== 'object' || value === null) return null
  const e = value as Record<string, unknown>
  if (!SYNC_TABLES.includes(e.tbl as SyncTable)) return null
  if (typeof e.uid !== 'string' || e.uid.length === 0) return null
  if (e.op !== 'upsert' && e.op !== 'delete') return null
  if (typeof e.ts !== 'number' || !Number.isFinite(e.ts)) return null
  if (e.op === 'upsert' && (typeof e.row !== 'object' || e.row === null)) return null
  const entry: Entry = { tbl: e.tbl as SyncTable, uid: e.uid, op: e.op, ts: e.ts }
  if (e.op === 'upsert') {
    entry.row = e.row as Record<string, unknown>
    if (Array.isArray(e.tagUids) && e.tagUids.every((t) => typeof t === 'string')) {
      entry.tagUids = e.tagUids as string[]
    }
    if (
      Array.isArray(e.cards) &&
      e.cards.every(
        (c) =>
          typeof c === 'object' &&
          c !== null &&
          Number.isInteger((c as { cardId?: unknown }).cardId) &&
          Number.isInteger((c as { count?: unknown }).count)
      )
    ) {
      entry.cards = e.cards as Array<{ cardId: number; count: number }>
    }
  }
  return entry
}

/**
 * Read a segment, forgivingly.
 *
 * A missing or unreadable header is the one thing that is fatal - without it
 * there is no way to know whether this build may apply the file - so that
 * returns null. A bad line after it is skipped and counted.
 */
export function parseSegment(text: string): Segment | null {
  const lines = text.split('\n')
  let header: SegmentHeader | null = null
  const entries: Entry[] = []
  let skipped = 0
  for (const raw of lines) {
    const line = raw.trim()
    if (line === '') continue
    let parsed: unknown
    try {
      parsed = JSON.parse(line)
    } catch {
      if (header === null) return null
      skipped++
      continue
    }
    if (header === null) {
      if (!isHeader(parsed)) return null
      header = parsed
      continue
    }
    const entry = asEntry(parsed)
    if (entry) entries.push(entry)
    else skipped++
  }
  return header ? { header, entries, skipped } : null
}

/**
 * The hash of a segment's wire text, in the form the server wants.
 *
 * SHA-256 hex, sent as `X-Content-SHA256`: the server uses it to tell a retry of
 * the same upload (fine) from a different body at the same seq (a conflict).
 */
export function contentHash(text: string): string {
  return createHash('sha256').update(text, 'utf8').digest('hex')
}

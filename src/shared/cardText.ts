/**
 * The portal's card-text markup, turned into something renderable.
 *
 * `skill_text` is not plain text. It carries a small tag language, and showing
 * it raw is why a tooltip reads
 *
 *   【<color=Keyword>守護</color>】\n<hr><ev>【<color=Keyword>進化時</color>】…</ev>
 *
 * instead of a card. Surveyed across all seven classes (2,695 texts), exactly
 * six tags occur:
 *
 *   <color=Keyword>…</color>  2775x  a game keyword; `Keyword` is the ONLY value
 *   <hr>                       676x  a rule between sections; void, no closing tag
 *   <ev>…</ev>                 264x  the evolve ability
 *   <ridx=N>…</ridx>           231x  one numbered option of a 【模式】 choice
 *   <sev>…</sev>               119x  the super-evolve ability
 *   <nobr>…</nobr>               3x  typographic only, keeps a number unbroken
 *
 * Anything else is stripped while keeping its content: an unrecognised tag is a
 * portal change, and text with a stray marker in it is still readable while a
 * dropped clause is silently wrong.
 *
 * Pure and tested on purpose - this is the one piece of the tooltip that can be
 * wrong without looking wrong.
 */

/** A run of text within a line. */
export type CardTextInline = { keyword: boolean; text: string }

export type CardTextVariant =
  /** Ordinary ability text. */
  | 'body'
  /** `<ev>` - what the card does when it evolves. */
  | 'evolve'
  /** `<sev>` - what it does on a super-evolve. */
  | 'superEvolve'
  /** `<ridx=N>` - one option of a 【模式】 choice. */
  | 'mode'

export type CardTextSegment = {
  variant: CardTextVariant
  /** 0-based, only on `mode` segments. The text usually repeats it as （1）. */
  index?: number
  /** True when an `<hr>` preceded this segment. */
  divider: boolean
  lines: CardTextInline[][]
}

const BLOCK_RE = /<hr\s*\/?>|<(ev|sev)>([\s\S]*?)<\/\1>|<ridx=(\d+)>([\s\S]*?)<\/ridx>/g
const COLOR_RE = /<color=[^>]*>([\s\S]*?)<\/color>/g
/** Whatever is left after the known tags are consumed. */
const UNKNOWN_TAG_RE = /<\/?[a-zA-Z][^>]*>/g

/** Split one block's text into lines of keyword/plain runs. */
function parseLines(raw: string): CardTextInline[][] {
  return raw
    .split('\n')
    .map((line) => {
      const runs: CardTextInline[] = []
      let cursor = 0

      COLOR_RE.lastIndex = 0
      for (let m = COLOR_RE.exec(line); m !== null; m = COLOR_RE.exec(line)) {
        if (m.index > cursor) runs.push({ keyword: false, text: line.slice(cursor, m.index) })
        runs.push({ keyword: true, text: m[1] })
        cursor = m.index + m[0].length
      }
      if (cursor < line.length) runs.push({ keyword: false, text: line.slice(cursor) })

      return runs
        .map((run) => ({ ...run, text: run.text.replace(UNKNOWN_TAG_RE, '') }))
        .filter((run) => run.text !== '')
    })
    .filter((line) => line.length > 0)
}

function push(
  out: CardTextSegment[],
  variant: CardTextVariant,
  raw: string,
  divider: boolean,
  index?: number
): boolean {
  const lines = parseLines(raw)
  if (lines.length === 0) return false
  out.push(index === undefined ? { variant, divider, lines } : { variant, index, divider, lines })
  return true
}

/**
 * Parse `skill_text` into blocks.
 *
 * Returns an empty array for empty input, so a card with no ability renders
 * nothing rather than an empty box.
 */
export function parseCardText(raw: string | null | undefined): CardTextSegment[] {
  if (!raw) return []

  const segments: CardTextSegment[] = []
  // Carried onto the NEXT segment: `<hr>` is a rule before what follows, and
  // attaching it to the preceding block would draw a line under the last one.
  let pendingDivider = false
  let cursor = 0

  BLOCK_RE.lastIndex = 0
  for (let m = BLOCK_RE.exec(raw); m !== null; m = BLOCK_RE.exec(raw)) {
    if (m.index > cursor) {
      if (push(segments, 'body', raw.slice(cursor, m.index), pendingDivider)) pendingDivider = false
    }

    if (m[0].startsWith('<hr')) {
      pendingDivider = true
    } else if (m[1]) {
      const variant: CardTextVariant = m[1] === 'ev' ? 'evolve' : 'superEvolve'
      if (push(segments, variant, m[2], pendingDivider)) pendingDivider = false
    } else if (m[3] !== undefined) {
      if (push(segments, 'mode', m[4], pendingDivider, Number(m[3]))) pendingDivider = false
    }

    cursor = m.index + m[0].length
  }

  if (cursor < raw.length) push(segments, 'body', raw.slice(cursor), pendingDivider)

  return segments
}

/** Flatten to plain text - for `alt`, `title`, and anywhere markup cannot go. */
export function cardTextToPlain(raw: string | null | undefined): string {
  return parseCardText(raw)
    .map((segment) => segment.lines.map((line) => line.map((run) => run.text).join('')).join('\n'))
    .join('\n')
}

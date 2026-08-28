/**
 * Ranked keeps two mutually exclusive scoring systems: below Grand Master the
 * result screen only reports BP, above it only MP (with CR as the season
 * standing). What the reader wants first is the same in both cases - how much
 * this one match moved them - so the delta is the headline and the running
 * totals are secondary.
 */
export interface MatchScoreFields {
  bp?: number | null
  mp?: number | null
  delta_mp?: number | null
  current_cr?: number | null
  delta_cr?: number | null
}

export interface MatchScore {
  /** The change this match caused. Absent when only a standing was captured. */
  delta: { unit: string; value: number } | null
  /** Running totals, e.g. "MP 12,480 · CR 2,104". */
  totals: string | null
}

const numberFormatter = new Intl.NumberFormat('zh-TW')

/** `null` when the match carries no score at all (free matches, practice). */
export function matchScore(match: MatchScoreFields): MatchScore | null {
  const totalParts: string[] = []
  if (match.mp != null) totalParts.push(`MP ${numberFormatter.format(match.mp)}`)
  if (match.current_cr != null) totalParts.push(`CR ${numberFormatter.format(match.current_cr)}`)
  const totals = totalParts.length > 0 ? totalParts.join(' · ') : null

  // Order matters: BP and MP never coexist, and ΔCR is only a fallback for a
  // Grand Master match whose ΔMP was not captured.
  const delta =
    match.bp != null
      ? { unit: 'BP', value: match.bp }
      : match.delta_mp != null
        ? { unit: 'MP', value: match.delta_mp }
        : match.delta_cr != null
          ? { unit: 'CR', value: match.delta_cr }
          : null

  if (delta == null && totals == null) return null
  return { delta, totals }
}

export const signedNumber = (value: number): string =>
  `${value > 0 ? '+' : ''}${numberFormatter.format(value)}`

/** Green for gained, red for lost, neutral for a match that moved nothing. */
export const deltaColor = (value: number | null | undefined): string => {
  if (value == null || value === 0) return 'text.secondary'
  return value > 0 ? '#69d8a8' : '#f0829a'
}

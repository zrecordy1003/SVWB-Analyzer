/**
 * Labels and number formats shared by the 卡片 table and its drill-down.
 *
 * Separate from the components so the two files export only components (fast
 * refresh needs that) and so the drawer cannot print a delta one way and the
 * table another.
 */

export const KIND_LABEL: Record<string, string> = {
  follower: '從者',
  spell: '法術',
  amulet: '護符'
}

export const RARITY_LABEL: Record<number, string> = { 1: '銅', 2: '銀', 3: '金', 4: '虹' }

export const fmtRate = (rate: number | null): string =>
  rate === null ? '—' : `${rate.toFixed(1)}%`

/** `+4.2` / `−3.1`, with a real minus sign. */
export const fmtDelta = (delta: number | null): string =>
  delta === null ? '—' : `${delta >= 0 ? '+' : '−'}${Math.abs(delta).toFixed(1)}`

/** 「從者 ・ 金 ・ 2 / 3」 - the small line under a card's name. */
export function cardMetaLine(card: {
  kind: string | null
  rarity: number | null
  atk?: number | null
  life?: number | null
}): string {
  return [
    card.kind ? KIND_LABEL[card.kind] : null,
    card.rarity ? RARITY_LABEL[card.rarity] : null,
    card.kind === 'follower' && card.atk != null && card.life != null
      ? `${card.atk} / ${card.life}`
      : null
  ]
    .filter(Boolean)
    .join(' ・ ')
}

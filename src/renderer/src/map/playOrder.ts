export interface PlayOrderOption {
  label: string
  color: string
  bgColor: string
  borderColor: string
  glow: string
}

/**
 * Play order decides more about a match than anything else on the card, so it
 * gets its own colour identity instead of sharing the muted caption tone:
 * cyan for going first, magenta for going second, used identically in the
 * match list and the HUD.
 */
export const playOrders: Record<string, PlayOrderOption> = {
  first: {
    label: '先攻',
    color: '#66D8F5',
    bgColor: 'rgba(102,216,245,0.16)',
    borderColor: 'rgba(102,216,245,0.45)',
    glow: 'rgba(102,216,245,0.28)'
  },
  second: {
    label: '後攻',
    color: '#E87AC5',
    bgColor: 'rgba(232,122,197,0.16)',
    borderColor: 'rgba(232,122,197,0.45)',
    glow: 'rgba(232,122,197,0.28)'
  }
}

/** Unknown or missing order is recorded as 後攻 everywhere else in the app. */
export const playOrderOf = (order?: string | null): PlayOrderOption =>
  playOrders[order ?? ''] ?? playOrders.second

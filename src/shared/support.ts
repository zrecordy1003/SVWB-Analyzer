/**
 * Donation links and the milestone thresholds behind the one-time prompt.
 *
 * Shared by main (tray, IPC) and renderer (About page, prompt) so there is a
 * single place to change a URL.
 *
 * Support here is voluntary and buys nothing - no paid features, no
 * sponsor-only build. That is not only a product choice: `ASSETS_POLICY.md`
 * forbids using Cygames assets for paid features, goods or other commercial
 * purposes, so a fully free tool with a tip jar is the only shape that stays
 * inside the project's own policy.
 */

/** Which surface sent the user to the link. */
export type SupportSource = 'about' | 'tray' | 'milestone'

export type SupportLink = {
  key: 'ecpay' | 'kofi'
  /** Button label in the UI. */
  label: string
  /** One line under the label: payment methods, who it suits. */
  note: string
  url: string
  /**
   * Append `?src=` so the platform's own dashboard shows which surface people
   * actually come from - the app itself records nothing. Off for the ECPay
   * page, whose handling of unknown query strings is not something we control.
   */
  tagSource: boolean
}

/**
 * Ko-fi (or any second platform) goes here when there is an account for it:
 * add an entry with `tagSource: true`, and the About page, the tray and the
 * prompt all pick it up with no further changes.
 */
export const SUPPORT_LINKS: SupportLink[] = [
  {
    key: 'ecpay',
    label: '歐付寶贊助',
    note: '信用卡、ATM、超商代碼',
    // A p.opay.tw short link resolves through a redirect, so leave the query
    // string alone rather than risk it being dropped or rejected.
    url: 'https://p.opay.tw/EYvPO',
    tagSource: false
  }
]

/** The link the tray's single menu item opens. */
export const PRIMARY_SUPPORT_LINK = SUPPORT_LINKS[0]

export function supportUrl(link: SupportLink, src: SupportSource): string {
  if (!link.tagSource) return link.url
  const separator = link.url.includes('?') ? '&' : '?'
  return `${link.url}${separator}src=svwb-analyzer-${src}`
}

/** Matches recorded before the prompt is worth showing. */
export const SUPPORT_MATCH_MILESTONE = 100
/** Completed launches before the prompt is worth showing. */
export const SUPPORT_LAUNCH_MILESTONE = 20

/** Why the prompt fired. Each reason fires at most once, ever. */
export type SupportMilestone = 'matches' | 'launches'

export type SupportPromptPayload = {
  reason: SupportMilestone
  matchCount: number
  launchCount: number
}

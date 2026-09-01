/**
 * The shape of the update conversation between main and the renderer.
 *
 * Release notes arrive from GitHub as HTML (the releases Atom feed renders the
 * markdown body for us). Main flattens that to plain text before it crosses the
 * IPC boundary, so the renderer never has to decide whether to trust a string
 * enough to put it in the DOM as markup - see `toPlainText` in `main/updates`.
 */

/**
 * Which surface a check or download belongs to, and therefore which one gets
 * the events it produces.
 *
 * Both surfaces are mounted at once and listen to the same broadcast, so an
 * untagged flow reaches both. It names the *surface*, not who pressed what: the
 * background dialog's own 下載 button is still `'background'`, otherwise its
 * progress events would be delivered to the Settings panel instead of to it.
 */
export type UpdateSource = 'background' | 'settings'

/** One release's notes. `version` carries no leading `v`. */
export type ReleaseNote = {
  version: string
  /** Plain text. Lines beginning `• ` came from list items. */
  body: string
}

/** What the renderer needs to describe an update to the user. */
export type UpdateSummary = {
  version: string
  releaseDate?: string
  /**
   * Newest first. More than one entry when the user skipped versions -
   * `fullChangelog` is on, so they see everything they missed, not just the
   * newest release's notes.
   */
  releaseNotes: ReleaseNote[]
  /**
   * Full installer size in bytes, when the feed reports it. This is the
   * worst case: a differential download transfers only the changed blocks, so
   * the progress bar's own total is usually far smaller.
   */
  size?: number
}

export type UpdateProgress = {
  percent: number
  transferred: number
  total: number
  bytesPerSecond: number
}

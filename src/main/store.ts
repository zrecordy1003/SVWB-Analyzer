import Store from 'electron-store'

/**
 * The single persisted-settings store for the main process.
 *
 * There used to be five separate `new Store()` calls (index, hud, analyzer,
 * updates, smartClose). They all resolve to the same config.json, but only two
 * declared any defaults - so a module that constructed its own bare instance
 * read `undefined` for every key the user had not explicitly changed yet.
 *
 * That is not a cosmetic problem. `settings.diagnostics` is opt-out, and reading
 * it from the default-less instance in the analyzer meant `=== true` would have
 * silently disabled diagnostics for every user who had never opened Settings -
 * which is why that call site had to be written as `!== false`. Declaring the
 * defaults in exactly one place removes the whole class of bug.
 *
 * Anything with a default belongs here. Add the key to `AppStoreSchema` and to
 * `defaults` together, so the type and the runtime value cannot drift.
 */
export type ClosePref = 'minimize' | 'exit'

export type AppSettings = {
  hudShow: boolean
  /** Show the HUD only while the game window has focus. Default on. */
  hudFollowGame: boolean
  askBeforeExit: boolean
  onCloseBehavior: ClosePref
  enableNotifications: boolean
  autoCheckUpdates: boolean
  /**
   * Download a found update without asking. Opt-in, because it spends the
   * user's bandwidth on their behalf - differential download keeps that to the
   * changed blocks, but it is still their connection.
   */
  autoDownloadUpdates: boolean
  /** Opt-out: local-only recording of recognition anomalies. Never uploaded. */
  diagnostics: boolean
  /**
   * Show card art in deck views. **Default ON.**
   *
   * This was opt-in at first, on the reasoning that art is not needed for
   * win-rate analysis. A deck you cannot recognise at a glance turned out to be
   * the wrong trade, so the default flipped.
   *
   * What has NOT changed is why the switch exists at all. Card art is the one
   * thing this app displays that Cygames has granted no licence for - it is
   * fetched by the user's own machine and cached there, never bundled - and
   * their guidelines let them withdraw permission at any time. Turning this off
   * still makes the whole feature a no-op without touching a component, because
   * the `svwb-card://` handler answers with a transparent pixel. Keep it that
   * way. See docs/deck-import-plan.md, decision D-6.
   */
  cardImages: boolean
  /**
   * Language for card names, skill text and card art.
   *
   * The portal takes this as a custom `Lang` request header - not a query
   * parameter, not `Accept-Language` - and serves a different image file per
   * language, so it is part of the image cache path too.
   */
  cardLang: 'ja' | 'en' | 'cht' | 'chs' | 'ko'
}

/**
 * State behind the one-time support prompt. Deliberately minimal: a lifetime
 * launch counter, the milestones already shown, and a hard opt-out. There is no
 * "remind me later" - each milestone gets exactly one appearance, so an ignored
 * prompt is an answer too.
 */
export type SupportState = {
  /** 「不再顯示」. Never prompt again; the About page stays available. */
  optedOut: boolean
  /** Completed app launches. */
  launchCount: number
  /** Milestones already shown (`'matches'` / `'launches'`). */
  shown: string[]
}

export type AppStoreSchema = {
  settings: AppSettings
  hudOpacity: number
  hudCompact: boolean
  hudBounds: Electron.Rectangle | null
  /** Days of history behind the HUD's matchup stats; null means all matches. */
  hudStatsDays: number | null
  /** Matches behind the HUD's win/loss tally. One of 10 / 15 / 20 / 30. */
  hudRecentCount: number
  /** Game mode the HUD is scoped to; 'all' means no filter. */
  hudModeFilter: string
  mainWindowBounds: Electron.Rectangle | null
  support: SupportState
}

export const store = new Store<AppStoreSchema>({
  defaults: {
    settings: {
      hudShow: true,
      hudFollowGame: true,
      askBeforeExit: true,
      onCloseBehavior: 'minimize',
      enableNotifications: true,
      autoCheckUpdates: true,
      autoDownloadUpdates: false,
      diagnostics: true,
      cardImages: true,
      cardLang: 'cht'
    },
    hudOpacity: 0.85,
    hudCompact: true,
    hudBounds: null,
    hudStatsDays: 7,
    hudRecentCount: 10,
    hudModeFilter: 'all',
    mainWindowBounds: null,
    support: {
      optedOut: false,
      launchCount: 0,
      shown: []
    }
  }
})

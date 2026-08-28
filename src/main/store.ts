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
  /** Opt-out: local-only recording of recognition anomalies. Never uploaded. */
  diagnostics: boolean
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
      diagnostics: true
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

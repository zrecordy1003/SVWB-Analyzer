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
   * Opt-out: anonymous usage statistics. **Default ON, from 1.3.0.**
   *
   * The only thing in this app that talks to a server we run. What it sends is
   * defined by `src/shared/telemetry.ts` and built by
   * `src/main/telemetry/rollup.ts`: version, platform, and per-day counts of
   * matches by class / mode / result. Nothing a person typed. The settings page
   * shows the exact payload, and the switch turns it off for good.
   *
   * It was opt-in until 1.3.0, and the reason it changed is arithmetic: a
   * buried switch gets single-digit participation, and a matchup table built
   * from single digits is worse than no table. What did NOT change is that
   * nothing is sent from a machine that has not been told - `true` here is not
   * enough on its own, the one-time notice has to have been shown as well (see
   * `telemetryPromptShown` and the gate in `main/telemetry/telemetry.ts`).
   *
   * Read through `main/telemetry/telemetry.ts`, never directly: that module
   * owns the timers that follow the value, and the notice gate.
   */
  telemetry: boolean
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
  /**
   * Whether the one-time 「已開啟匿名統計」 notice has been shown. **Uploads are
   * blocked until it is true**, so this is not cosmetic: it is the promise that
   * no machine ever sends anything before being told what is being sent and how
   * to stop it. One appearance per install, like the support prompt.
   *
   * The key kept its old name through the 1.3.0 opt-in-to-opt-out change so
   * that installs which had already seen the toast are not shown a second one.
   */
  telemetryPromptShown: boolean
  /**
   * Whether the 1.3.0 default flip has been applied to this install (see
   * `settings.telemetry`). Set once, so that turning telemetry off afterwards
   * sticks across upgrades.
   */
  telemetryDefaultFlipped: boolean
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
      telemetry: true,
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
    },
    telemetryPromptShown: false,
    telemetryDefaultFlipped: false
  }
})

/**
 * The 1.3.0 opt-in-to-opt-out flip, applied once per install.
 *
 * Changing the default above only reaches installs that have never written
 * their settings; everyone else has a literal `"telemetry": false` on disk,
 * put there by the schema default rather than by any decision. Nobody could
 * have decided: no build before 1.3.0 shipped an endpoint, so the switch was
 * disabled and the toast never appeared. That stored `false` therefore means
 * "never asked", not "no", and this rewrites it once.
 *
 * The flag is what keeps it once. After this runs, an off switch is a real
 * answer and every later upgrade leaves it alone.
 *
 * This does not make anything send. The notice gate in
 * `main/telemetry/telemetry.ts` still holds until the user has been told.
 */
if (store.get('telemetryDefaultFlipped') !== true) {
  store.set('settings.telemetry', true)
  store.set('telemetryDefaultFlipped', true)
}

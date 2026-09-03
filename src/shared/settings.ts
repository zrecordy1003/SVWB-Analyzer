/**
 * The persisted settings, as a shape both processes speak.
 *
 * These lived in `src/main/store.ts` next to the `electron-store` instance,
 * which is where they are written - but the renderer READS every one of them
 * through the `window.settings` bridge, and until now it read them as `any`:
 * `get<T = any>(key: string)` cannot tell a typo from a key, or a boolean from
 * a number. The bridge is typed by key against `AppStoreSchema` now, which is
 * why the schema has to be here.
 *
 * `settings:*` is deliberately NOT in `src/shared/ipc.ts`. That contract maps
 * each channel to one function type, and `settings:get` is not one function -
 * its return depends on which key it was given, which needs a generic method
 * rather than a uniform entry. Typing the bridge is where the value was
 * anyway; the raw channel is a key/value pipe.
 */

/** A window rectangle, structurally. */
export type WindowBounds = { x: number; y: number; width: number; height: number }

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
   * Launch with Windows.
   *
   * Declared here late: the Settings page has written this key for as long as
   * the switch has existed, but the schema did not know about it, so it had no
   * default and main could not read it. The switch's real effect goes through
   * the `settings:startOnBoot` message, which registers the login item; this
   * value is what the switch renders from on the next visit.
   */
  startOnBoot: boolean
  /**
   * Also written by the Settings page and also missing from the schema until
   * now. Nothing in `src/main` reads it yet - `updates.ts` acts on
   * `autoDownloadUpdates` and waits for the user to press install - so it is a
   * stored preference with no consumer. Left in rather than deleted because
   * the switch is on screen and does persist.
   */
  autoInstallUpdates: boolean
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
   *
   * There is no longer a switch in Settings, and a stored `false` is normalised
   * to `true` at startup - see the note below `store`. The mechanism is intact;
   * only the user-facing way into it is gone.
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
  hudBounds: WindowBounds | null
  /** Days of history behind the HUD's matchup stats; null means all matches. */
  hudStatsDays: number | null
  /** Matches behind the HUD's win/loss tally. One of 10 / 15 / 20 / 30. */
  hudRecentCount: number
  /** Game mode the HUD is scoped to; 'all' means no filter. */
  hudModeFilter: string
  mainWindowBounds: WindowBounds | null
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

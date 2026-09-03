import Store from 'electron-store'

/**
 * The schema moved to `shared/settings.ts` because the renderer reads every
 * one of these keys and was reading them as `any`. Re-exported here so this
 * module's many callers - and `store.get`/`store.set` themselves - are
 * unchanged. The `electron-store` instance below is still the only writer.
 */
export type {
  AppSettings,
  AppStoreSchema,
  ClosePref,
  SupportState,
  WindowBounds
} from '../shared/settings.js'
import type { AppStoreSchema } from '../shared/settings.js'

export const store = new Store<AppStoreSchema>({
  defaults: {
    settings: {
      hudShow: true,
      hudFollowGame: true,
      askBeforeExit: true,
      onCloseBehavior: 'minimize',
      enableNotifications: true,
      autoCheckUpdates: true,
      startOnBoot: false,
      autoInstallUpdates: false,
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

/**
 * Card art is on, full stop.
 *
 * The 「卡片圖像」 switch that used to own `settings.cardImages` was removed from
 * Settings, which left anyone who had turned it off with no way back: no art,
 * no class emblems, and nothing in the UI to explain why. A stored `false` is
 * therefore a value nobody can act on any more, so it is normalised away here -
 * once, at startup, before the protocol handler or any window reads it.
 *
 * The key itself stays. It is the kill switch the guidelines make necessary
 * (see docs/deck-import-plan.md, 「合規要求」): every path that answers with a
 * transparent pixel or falls back to a colour swatch is still wired up and
 * still tested. What is gone is the ability to be stuck in that state by
 * accident. If permission is ever withdrawn, put the switch back in Settings -
 * do not go looking for the handler.
 */
if (store.get('settings')?.cardImages !== true) {
  store.set('settings.cardImages', true)
}

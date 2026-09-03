# Project Status and Roadmap

Last updated: 2026-09-03

This document is the central project status record. It summarizes the current architecture and the
future changes that should still be considered. More focused notes live in:

- `docs/architecture.md` — the shipped architecture, in brief.
- `docs/engine-refactor-plan.md` — why the engine has this shape, and what was rejected.
- `docs/performance-improvement-notes.md`
- `docs/recognition-optimization-status.md`
- `docs/telemetry-dau-plan.md` — anonymous usage statistics: what is uploaded, when, and where.
- `docs/meta-stats-plan.md` — match provenance and cross-user meta stats. Upload side implemented;
  the public chart is deferred to a later release.

> Rewritten 2026-08-29. The previous revision described the pre-engine architecture (a forked JS
> analyzer, Prisma, `src/main/forkedImageAnalyzer.ts`). None of those exist any more; the sections
> below were re-checked against the tree rather than edited in place.

## Current Architecture

### Runtime layout

- `svwb-engine.exe` (Rust, one process) owns the whole perception chain: Windows Graphics Capture,
  frame normalization, template recognition, the state machine, and the SQLite writes for matches.
  Nothing is written to disk as an image along the way.
- Electron main is a thin supervisor: it validates the game window by PID/executable path, sends
  `attach`/`detach` over the engine's stdin, answers the engine's number-reading requests with
  tesseract.js, broadcasts events to the renderer, and keeps diagnostics.
- The engine and the host talk JSON Lines both ways. See `tools/engine/src/host.rs` and
  `src/main/recognition/engine.ts`.
- Renderer (React + MUI) and the HUD read the same SQLite file through Kysely + better-sqlite3.
  Both sides run WAL, so UI reads never block the engine's writes.
- Runtime writable files use Electron `userData` paths instead of the installation directory.

### Engine structure (`tools/engine/`)

Layered outermost first; nothing below `frame_source` performs I/O, which is what makes all of it
testable without a game, a database, or Electron.

- `frame_source.rs` / `capture_source.rs` — where frames come from (a file, or live WGC capture).
- `frame.rs` — one normalised frame.
- `templates.rs` — the template store and matching against it.
- `calibration.rs` — measured windows, scales, thresholds, timings. Single source of truth for ROIs.
- `reading.rs` — scores to an interpreted `machine::Reading`.
- `machine.rs` (+ `machine/tick.rs`, `machine/scenarios.rs`) — `(phase, reading, now)` to a decision,
  as a pure function. Observing and acting are deliberately separated.
- `phase.rs` — where the machine is in one match's life.
- `accumulate.rs` — debouncing and multi-frame consensus.
- `store.rs` — match persistence, and the migration runner.
- `protocol.rs` — the JSON Lines contract with the host.
- `numbers.rs` — the `NumberReader` seam the host answers through.
- `live.rs` / `replay.rs` / `host.rs` / `diagnostics.rs` — the drivers.

### Main process structure (`src/main/`)

- `index.ts` — app lifecycle, splash/main window creation, the 1s game-detection poll, the 16ms
  foreground-focus ticker, tray/HUD wiring, and the handful of IPC handlers that close over this
  file's state.
- `paths.ts` — runtime paths under `app.getPath('userData')`: capture, tools, tesseract cache,
  diagnostics.
- `store.ts` — `electron-store` settings.
- `recognition/`
  - `engine.ts` — supervises the engine process, applies its events, owns the engine-local
    `ref -> Match.id` mapping.
  - `engineNumbers.ts` — the tesseract.js side of `readNumber`.
  - `svwbDetector.ts` — game detection by PID and executable path, not window title.
  - `diagnosticsRecorder.ts` / `diagnosticsBundle.ts` — local-only anomaly accounting and export.
- `data/db/`
  - `client.ts` — Kysely over better-sqlite3, plus the boundary mappers (epoch ms to `Date`,
    0/1 to `boolean`).
  - `initDb.ts` — runs `svwb-engine migrate` synchronously before anything reads.
- `ipc/` — `matches.ts`, `decks.ts`, `tags.ts`, `settings.ts`, `diagnostics.ts`, `helper.ts`.
- `windows/` — `hud.ts`, `tray.ts`, `smartClose.ts`, `exitConfirmDialog.ts`, `exitChoiceDialog.ts`.
- `telemetry/` — `rollup.ts` (match rows to counting buckets, pure), `telemetry.ts` (opt-out
  state, schedule, upload, IPC), `config.ts` (the endpoint). See `docs/telemetry-dau-plan.md`.
- `updates.ts`, `startOnBoot/`, `support/supportPrompt.ts`, `utils/broadcast.ts`.

### Renderer structure

- `src/renderer/src/components/` — Analyzer, MatchList, DeckManager, DeckPerformance, Settings,
  Update, Diagnostics, About, and shared pieces under `Common/`.
- `src/renderer/src/hudcomponents/HudApp/` — the HUD shell, `Recent.tsx`, `HudInsights.tsx`,
  `MatchupCard.tsx`, and the pointer-passthrough hook.
- `src/renderer/src/hooks/useDecksTags.ts` — renderer-side reference data cache for decks, tags and
  categories; invalidated by the `reference-data:changed` broadcast.
- `src/renderer/src/map/classMap.ts` — class and mode metadata used by the main UI and the HUD.
- `src/shared/domain.ts` — the domain vocabulary (`ClassName` / `GameMode` / `PlayOrder` and the
  model shapes), owned by this repo rather than generated by an ORM.
- `src/shared/types.ts` — cross-process types (`GameStatus`, `BattleStatus`, `QueryPayload`, stats).

### Database and migrations

- No ORM. `resources/migrations/*.sql` is the schema's single source of truth, applied by
  `svwb-engine migrate`, which also maintains `schema_migrations`. One owner, so two appliers cannot
  race at startup.
- Current migrations: `001_init`, `002_add_updated_column`, `003_add_sort_column_and_isdefault`,
  `004_add_cr_column`, `005_add_perf_indexes`, `006_add_mp_columns`,
  `007_add_match_list_filter_indexes`, `008_add_provenance`, `009_add_deck_import`,
  `010_add_card_pool`, `011_add_deck_family`, `012_add_telemetry_state`.
- The engine writes match recording; the UI writes user edits (decks, tags, notes) and does all
  reads.

### Tests

- `cargo test` (`tools/`) — state machine scenarios (each one corresponding to a past incident), the
  calibration table, consensus/debounce, `store` against the shipped migrations, and 15 fixture
  tests over 44 of the 47 committed PNGs in `tests/fixtures/captures/`.
- `pnpm engine:replay` — five recordings driven through the _shipped_ state machine end to end,
  including BP value assertions read through the host's tesseract.
- `pnpm test` (vitest, node environment) — `tests/main/` (migrations, IPC contract smoke, query
  plans, ranked winrate, support prompt) and `tests/renderer/` (pure helpers: confidence, filter
  state, relative time). 48 tests.
- `pnpm vision:verify` — the cargo tests plus clippy, the OCR oracle, and engine/addon parity.
- `pnpm test:e2e` (Playwright, driving the real Electron app) - `tests/e2e/`: splash, HUD window,
  class-emblem protocol round trip, the update flow against `SVWB_UPDATE_SIM`, and the
  deck-versioning rules read back through the real preload bridge. 22 tests, ~51s. The build is a
  `setup` project the suite depends on, so it cannot run against stale bundles.
- `pnpm typecheck` is three projects: `tsconfig.node.json` (main, preload),
  `tsconfig.web.json` (renderer) and `tsconfig.tests.json` (`tests/`, which nothing checked at
  all until 2026-09-03). The last uses `moduleResolution: bundler`, because that is what vitest
  and Playwright actually do.
- `.github/workflows/telemetry-worker.yml` type-checks `server/telemetry/` on any change to it
  or to `src/shared/telemetry.ts`. Its own workflow: the Worker is a standalone pnpm project
  whose install pulls wrangler and workerd, and GitHub's path filters are per-workflow.
- `.github/workflows/ci.yml` runs on `windows-latest` as three parallel jobs: `typescript`
  (typecheck, lint, bundle build), `rust` (engine build, vitest, the vision addon build,
  `vision:verify`, the replay) and `e2e` (engine build, then the Playwright suite with
  `--grep-invert @network`). vitest sits with Rust because it needs the engine binary; `e2e` is
  separate because it is the only job that has to download the Electron binary.

## Completed Work

### The engine refactor

- Capture, recognition, the state machine and match persistence moved out of the forked JS analyzer
  into one Rust process.
- The state machine became a pure `(phase, reading, now)` function, which is what let the incident
  history buried in `forkedImageAnalyzer.ts`'s comments become `#[test]`s — and let the 953-line
  hand-copied mirror of it in the test suite be deleted.
- The `svwb.png` intermediate is gone; no frame data lands on disk.
- Probes now all run every tick, and "this signal is only trustworthy in this phase" is a stated,
  testable phase check rather than the physical position of a `match()` call inside a nested `if`.

### Prisma removal

- Kysely + better-sqlite3 replaced Prisma, removing the 21MB query engine, the generated types, and
  the per-call IPC to that engine.
- The domain vocabulary moved from `@prisma/client` (imported in 24 files) into `src/shared/domain.ts`.
- The short-lived stats cache that existed to hide Prisma's per-call overhead was deleted with it.
- Migrations moved to the engine.

### Recognition robustness

- ROIs are measured in a normalised 1280x720 space, with `calibration.rs` as the single source.
- Numbers use multi-frame consensus: static values (BP, ΔMP, ΔCR) take a majority vote; animated
  running totals (MP, CR) require two consecutive agreeing frames, so a counting animation's first
  frame is not mistaken for the result.
- An unrecognised mode is recorded as `unknown`, never silently folded into `unranked`.
- Matches opened during a replay/history playback are deleted rather than left blank.
- Fixture coverage now spans 1280 windowed and 1920 fullscreen layouts across ranked, 2Pick, CPU,
  custom and history screens.

### Performance

- Match list uses keyset pagination on a `(playedAt, id)` index, with a row-value comparison that
  seeks into the index instead of degrading to a scan.
- Relation loading is three queries regardless of page size.
- `MatchList` is virtualized (`@tanstack/react-virtual`).
- Renderer reference data is cached and invalidated by IPC broadcast.
- The foreground-focus check is a read-only `GetForegroundWindow` poll rather than a global
  `SetWinEventHook`, deliberately: the hook is enumerable by anti-cheat on a machine where the user
  plays other games. Measured at 19.4us per call.

### Package size

- OpenCV was removed entirely; recognition is a self-contained Rust addon plus the engine.
- Prisma's query engine is no longer shipped.

### HUD

- Compact mode, opacity control, click-through toggle, and manual dragging are implemented.
- The HUD distinguishes "game not detected" from "no matches yet" via the `game:status` broadcast.
- Recent matches show class, mode, BP, play order, win/loss and time hierarchy, with loading, empty
  and error states.

## Future Changes

## Priority 1: Close the verification gaps

These are the gaps that make the rest of the test suite less meaningful than it looks.

### The replay check does not actually run in CI

`tests/fixtures/captures/**/*.mp4` is gitignored, so a clean checkout has no recordings and the CI
replay step reports a skip. It is a local-only check today.

To make it a real gate: commit the recordings through Git LFS (the repo already uses LFS for
`*.dll` and `*.gz`), then drop the skip branch in `.github/workflows/ci.yml`.

### The Electron host layer has no UNIT tests — done, with a judgement

The E2E suite covers the host from the outside and runs in CI. What it could
not reach was the stateful interior, because nearly every branch needs a real
game window and a real `hwnd`. Both halves are now addressed, and the second
one differently from the first.

**The poll loop.** `src/main/gamePoll.ts` is a pure
`decidePoll(state, observation) -> { state, actions }`, the same shape
`tools/engine/src/machine.rs` has, with the clock, the OS and the windows on
the caller's side - so a thirty-minute timeout is a number in a test.
`tests/main/gamePoll.test.ts` has 20 cases. The extraction was
behaviour-preserving and they passed on the first run; two things it pinned
that had only been implicit are that the capture attach is re-issued on EVERY
capturable tick (the recovery mechanism after an engine restart - nothing else
signals that it came back) and that `idleNoticeSent` debounced a notification
that is commented out, so it is gone.

It also found a real inconsistency, fixed in the commit after: the idle rule
stopped the analyzer and left `capturing` true, so the renderer's indicator and
the HUD's `game:status.capturing` claimed capture was live for the whole idle
period. Ten lines to see once the decision was a value; invisible in six
interleaved `let`s.

**The engine supervisor, and why it got less.** `engine.ts` is 395 lines and
almost none of it is a decision: `startEngine` is configure/spawn/stream
wiring, and `handle` is a dispatcher whose every case is a `broadcast(...)` or
a `setStatus(IDLE_STATUS)`, because the engine has finished the work before it
emits. The one part with content is the `statusChanged` field mapping, which
has an incident behind it - this event speaks the HUD's names while
`matchStarted` speaks the database's, and crossing them once left the opponent
blank mid-battle. That is `battleStatusEvent.ts` with five cases.

What remains untested there is the guards around I/O: the double-start check,
`send()`'s writability test, the attach/detach no-ops after the process is
gone. Reaching them means mocking `child_process`, and they are guards rather
than logic. Recorded as a decision, not carried as debt.

### Packaged app smoke test

Half done. `tests/e2e/packaged.spec.ts` asserts the resource list and the fresh-profile migration
against a real package: set `SVWB_E2E_EXECUTABLE` to an installed or `--dir`-unpacked executable
and the whole E2E suite drives that instead of `out/`. It is skipped when the variable is unset,
and it is not wired into CI - packaging needs the Rust binaries, so it belongs in the release
pipeline rather than on every push.

Still by hand, and still worth automating on top of that seam:

- `svwb-engine.exe`, `svwb-vision.node` and `svwb-capture-tool.exe` are present under `resources/`.
- `resources/migrations` is included and readable, and `svwb-engine migrate` succeeds.
- New install creates the DB under `userData`; an existing DB migrates.
- `eng.traineddata.gz` is present and tesseract can decompress it into the cache dir.
- Templates are readable by the engine.
- HUD launches and can hide/show; the analyzer can start/stop without crashing.

### Renderer has no COMPONENT test coverage

Still deliberate — the jsdom + vitest projects setup is decided but deferred. Revisit when the
renderer stops being the part that changes most.

What changed is that it is no longer unchecked: `tests/renderer/` covers the pure helpers, the
E2E suite drives real components through the real preload bridge, and `tsconfig.tests.json`
type-checks all of it. Rendering a component in isolation is the gap, not "the renderer".

## Priority 2: Schema and boundary integrity — done

All three items here are closed. Kept rather than deleted, because two of them were findings
about _documentation being wrong_, which is a failure mode this project keeps hitting.

### The schema is mirrored in three places — done

`TABLE_COLUMNS` in `client.ts` lists every column as values. A `satisfies` clause and a
`NoUncheckedColumn` type refuse a wrong or a missing name at compile time, and
`tests/main/dbSchemaMirror.test.ts` compares the lists against `pragma_table_info` on a database
brought up by `svwb-engine migrate`. Migrations, the list and the interfaces must all agree;
removing one column makes both halves fail, and both name it.

### The column-ownership contract is stated but not enforced — corrected

The claim was false, and the claim is what got fixed rather than the code: both sides write
`updatedAt` on purpose (it is what the UI's optimistic lock compares against) and the engine
clears `my_deckId` for deckless modes. `store.rs`'s header now states the real division. It also
still described the UI as reading through Prisma, which has not been true since Kysely replaced
it.

### `update_match` is not atomic — was already fixed

A stale entry, and worth recording as one. `store.rs` takes `unchecked_transaction()` at the top
of `update_match` and commits at the end, and has for some time.

## Priority 3: Host-side structure

### The IPC contract is untyped where it matters — done

`src/shared/ipc.ts` declares each channel as a function type; `handleIpc` /
`invokeIpc` are the two ends, and `IpcSendContract` / `onIpc` / `sendIpc` cover
the fire-and-forget direction. 71 of the 81 distinct `invoke` channels and all
4 renderer-to-main `send` channels are typed, and the renderer has **no** raw
`ipcRenderer.invoke` left - the 33 call sites that skipped the preload bridge
with a bare string are gone. `global.d.ts` derives from the contract rather
than restating it.

Remaining: `diagnostics:*` (4), which needs `DiagnosticsSummary` moved out of
`recognition/diagnosticsBundle.ts`. And `settings:*` (7) is deliberately typed
at the BRIDGE rather than in the contract - `settings:get`'s return depends on
which key it was given, which needs a generic method, and a map of one function
type per channel cannot express that. Worth knowing before trying to "finish"
it.

The compiler found nine defects on the way in, all of the same family - a
`null`, an `undefined` or a wrong shape that nothing could see through an
`any`:

- `matches:create` can return `null`; the renderer passed it straight to a
  callback declared as taking a match.
- The edit dialog could write `NULL`, or the empty string, into `play_order`,
  `my_class` and `oppo_class` - all three NOT NULL. Two `as ClassName` casts
  were what hid it.
- `battle:getStatus` returns `undefined` before the analyzer starts, and that
  went into `setState`.
- `hud:setOpacity` resolves to `number | undefined`, not `number`.
- `update:check` answers two different shapes - the real updater adds `info`,
  the dev simulator does not.
- `matches.fetchRecent` was declared `Promise<any[]>`.
- `DeckPicker`'s local `Category` had `sort` optional where the column is
  `number | null`.
- `BattleStatus.tsx`'s local `BattleState` was wider than the real thing and
  had no `mode`, so its initial state was missing a field.
- `settings.startOnBoot`: the page sent `'s:startOnBoot'` and main listens on
  `'settings:startOnBoot'`. Unreachable today - the switch is commented out -
  but it had never worked.

And five type declarations that were duplicates of something in `shared/`:
`RankedWinrateQuery` (restated in three places, wrong in four fields in one of
them), `AppSettingsInner`, `Category`, `BattleState`, plus `OnCloseBehavior` /
`PortalLang` / `ThemeType` as local aliases.

### Duplicated types - done

`QueryPayload` and `RangeKey` are now imported from `src/shared/types.js` and re-exported from
`ipc/matches.ts`, the same way `BattleStatus` was fixed.

### Dead compatibility layers in `ipc/matches.ts` - done

`normalizeCountArgs` / `normalizePageArgs` are gone, and `matches:count`, `matches:queryList` and
`matches:getPage` now take a typed `QueryPayload` instead of `...args: unknown[]`.
`matches:getPageWithExtras` was deleted outright: it was byte-for-byte `matches:getPage` behind a
positional-argument preamble, with no caller anywhere in `src/` or `tests/`.

### Renderer has no data layer

Components call IPC directly and hold their own `useState`; `decks:all` is invoked from four
separate places with no shared cache or invalidation. The symptom is component size —
`DeckManagerControl.tsx` is 1055 lines with 23 `useState` calls, which is an unwritten reducer.

## Priority 4: Query and data performance

### Expand query-plan tests

Current coverage is deck/date and mode/date paths. Add:

- Ranked winrate grouping.
- Deck result aggregation.
- CR range filtering.
- Tag-filtered match list queries.
- Combined date range and mode queries.

### Profile large local datasets

Generate databases at 1,000 / 10,000 / 50,000 matches, with many tags per match and many
decks/categories, and measure: match list initial load, filter changes, page changes, deck analysis
open, ranked winrate chart query, HUD recent fetch.

## Priority 5: Recognition tuning

### Threshold tuning

- Record confidence scores per fixture.
- Tune thresholds by recognition type.
- Keep saving low-confidence examples through the diagnostics recorder.
- Document acceptable failure behavior.

### Template updates

New card sets do not affect recognition — individual cards are not recognised. Templates and ROIs
only need updating when the UI, class/mode icons, result screens or number regions change. Keep raw
screenshot samples from before and after every such change; everything under
`tests/fixtures/captures/` is asserted.

### `tests/fixtures/analyzer/manifest.json` was an empty harness — deleted

`cases` was `[]` from the day it was added, so the test reading it asserted nothing; it had
already lost a second case guarded by `it.skipIf(cases.length === 0)`, which skipped in exactly
the situation where it would have failed. Removed along with `tests/analyzer/fixtures.test.ts`
and `tests/helpers/analyzerFixtures.ts`. The still-true half of its README is now
`tests/fixtures/README.md`.

## Priority 6: Telemetry and DAU

Recording is implemented and the Worker is deployed (2026-09-02); the in-app chart is not. See
`docs/telemetry-dau-plan.md` for what ships and `docs/meta-stats-plan.md` for the decisions behind
the bucket model.

What exists:

- `src/main/telemetry/` uploads one payload per install: version, platform, and the last 14 UTC
  days of matches as counting buckets `(tier, mode, my class, opponent class, play order, result)`.
  Opt-out since 1.3.0 (`settings.telemetry`, default on), and uploading is blocked until the
  one-time toast has told the user - both conditions, so no machine sends before being told.
  Settings shows the exact JSON and turns it off in one click.
- `server/telemetry/` is the Cloudflare Worker + D1 that receives it. `/v1/admin/overview` gives
  the maintainer active installs (today / 7d / 30d) and the version split; `/v1/meta` is the public
  ranked matchup aggregate the future sidebar page and web version will read.
- `pnpm telemetry:report` prints the maintainer view.
- It is live at `https://telemetry.svwb-analyzer.workers.dev`, and that URL is compiled into
  `src/main/telemetry/config.ts`. A shipped copy only ever talks to the URL it was built with, so
  moving the endpoint means a release, and the old one has to keep answering meanwhile.
  `server/telemetry/smoke.mjs` (`pnpm smoke`) drives a running Worker over real HTTP and D1 to
  cover the SQL and routing the vitest suites cannot reach.

The read side and the storage were audited before going public (2026-09-03), and three things
came out of it that are worth stating here rather than only in commit messages:

- **`/v1/meta` was publishing an individual.** It is public and unauthenticated, and with one
  contributing install every cell on it was that person's own match record. A cell is now
  published only once `META_MIN_INSTALLS_PER_CELL` separate installs stand behind it, and what
  is withheld is counted (`sampling.suppressedCells`) rather than silently missing.
- **One grinder was the meta.** The aggregate was a plain `SUM(count)`. No install now counts
  for more than `META_MAX_PER_INSTALL_CELL` in any one cell, applied per (install, cell) across
  the window, scaling the win count rather than truncating it - truncation drags a lopsided
  record toward even, which manufactures a signal instead of damping one. Each cell also carries
  `installs`, `rawWins` and `rawTotal`, so the cap can be audited from the document.
- **Nothing was ever deleted.** A nightly `scheduled` handler keeps 120 days of `buckets` and
  `match_days` and 400 of `activity`; `installs` is never pruned.

Also: two rate limiters on `/v1/ingest` (per IP and per install) and one on `/v1/meta`, declared
as optional bindings that fail OPEN - telemetry going quiet is a worse bug than accepting too
much for an afternoon, and the cost is that a limiter which is not working is silent, so the
README carries a curl loop that proves it after a deploy. `/v1/meta` honours
`Cache-Control: no-cache`, without which a deploy does not change what the public sees for
fifteen minutes and `smoke.mjs` cannot assert anything about the document's content.

`installs.first_seen` and `installs.uploads` had both been written since the first migration and
read by nothing. `/v1/admin/overview` now reports new installs per day and upload volume per
active install, which are the two operational questions active-install counts cannot answer.

What is deliberately not done yet:

- **Nothing has been released with the endpoint in it yet.** Every version in the wild was built
  with an empty `BUILT_IN_ENDPOINT` and will never send; the switch only comes alive in the next
  package. So there is no data to look at until then, however healthy the Worker is.
- **No sidebar page.** The plan is to ship recording first, let the aggregate accumulate, and add
  the 「環境統計」 page in a later release once there is enough data and the numbers have been
  sanity-checked against the provenance cross-tab (`docs/meta-stats-plan.md` P0b).
- The event-style product analytics the original plan sketched (`deck_analysis_opened`,
  `capture_failed`, ...) were dropped: the daily upload already answers the DAU and version
  questions, and feature-usage events would need a different, per-event pipeline for little gain.

Rules that still hold: never send before the notice has been shown; never collect screenshots, OCR
text, deck names, notes, tags, local paths, usernames or complete match records; network failure
must never affect app behavior. The default went from off to on on 2026-09-02 because a buried
opt-in switch gets single-digit participation and a matchup table built from single digits is worse
than no table; what did not move is that the user is told, in the app, before anything leaves.
The tests in `tests/main/telemetry*.test.ts` pin the payload shape and the notice gate.

## Priority 7: AI-assisted recognition

Do not introduce AI as the next step unless fixture evidence shows template/anchor/OCR is
insufficient.

Possible uses: fallback classification when template confidence is low, adaptive element detection
under unusual scaling, post-processing uncertain OCR regions.

Risks: larger install, more runtime cost, more failure modes, more privacy review, harder
deterministic tests.

Approach: measure which recognition cases actually fail, try anchors/thresholds/ROI/OCR
preprocessing first, and if AI is still needed isolate it behind an optional provider interface that
is disabled by default.

## Priority 8: UI and UX follow-ups

### HUD

Still needs visual validation on top of the game: transparent background over bright and dark areas,
drag area usability, slider usability, loading state while refreshing, battle status layout with
long class labels.

Potential future work: visual regression screenshots for the HUD.

### Deck analysis

- Better empty states.
- More compact high-density mode.
- Export/share summaries.
- Drill-down from deck stats to a filtered match list.
- Saved filters.

### Settings

- Capture/debug sample controls.
- Clear cache/debug samples action.

## Priority 9: Release and maintainability

### Release smoke checklist

Fresh install; upgrade install with an existing DB; install under a read-only directory; run from a
path with spaces; run with a non-ASCII Windows username; run without the game open; run with the
game open; start/stop the analyzer repeatedly; hide/show the HUD repeatedly; update flow.

### Repository hygiene

- `clearCaptureImage()` and the `getCapture*` helpers are gone. They deleted an `svwb.png` the
  pipeline stopped producing at the engine refactor; the one remaining effect was that `ensureDir`
  created an empty `capture/` directory in every profile on every launch.
- The splash window asked for `../preload/splash-preload.js`, which no entry in
  `electron.vite.config.ts` builds and which does not exist in `out/preload/`. Electron logged a
  load failure and carried on. The splash talks to nothing, so the request was removed rather than
  the file added.
- eslint has `@typescript-eslint/no-explicit-any` off, with ~43 `any` uses in `src/`.
- ~60 `console.log`/`console.error` calls stand in for logging, with no levels and no persistence.

Two earlier entries here were wrong when re-checked against the tree and have been dropped:
`pnpm-workspace.yaml`'s placeholder is long since filled in, and `test/` holds only empty
directories that git does not track - it exists on one machine, not in the repository.

### Documentation

Keep these synchronized:

- `docs/architecture.md` — the shipped architecture.
- `docs/engine-refactor-plan.md` — decision record.
- `docs/project-status-roadmap.md` — this file: central status and future work.
- `docs/performance-improvement-notes.md`
- `docs/recognition-optimization-plan.md`
- `docs/recognition-optimization-status.md`
- `docs/telemetry-dau-plan.md` — anonymous usage statistics: what is uploaded, when, and where.
- `docs/meta-stats-plan.md` — match provenance and cross-user meta stats. Upload side implemented;
  the public chart is deferred to a later release.

### Code quality gates

- `pnpm test`
- `pnpm lint`
- `pnpm typecheck`
- `pnpm vision:verify`
- `pnpm build`

Use fixture tests before changing recognition thresholds.

## Current Assessment

The perception layer is in good shape and always was: one process owns capture through
persistence, the state machine is a pure function with scenario tests tied to real past
incidents, and the fixture and replay suites are substantial.

What has changed is that the things _around_ it are now checked. The E2E suite runs in CI and
has already earned its place twice - catching a chunk cycle that stopped the renderer dead while
the build reported success, and catching a telemetry guard that was inert because
`document.hidden` reads `false` in a window that has never been shown. `tests/` is type-checked,
which found three real defects on its first run. The UI's schema mirror is asserted rather than
requested in a comment. The Worker has a type gate.

A pattern worth naming, because it recurred at every level: **the documentation was wrong more
often than the code was.** `update_match` was already transactional, `store.rs` still described
a Prisma that had been deleted and a column-ownership split that never existed,
`telemetry.ts` said the setting defaulted to off when it had defaulted to on for a day,
`pnpm-workspace.yaml`'s placeholder was long since filled in, and `test/` was a directory git
does not track. Three of the entries in this file were stale in the same way. When something
here says a thing is broken, check the tree before believing it.

The second pattern: **several tests were vacuous**, and none of them looked it. A skipped case
guarded by the condition that would have failed it; `expect.poll(...).not.toBe(true)` passing on
its first sample; a smoke assertion that read a cached response predating the code under test; a
threshold assertion that was true only against an empty database. Every one of those was written
in good faith. The lesson taken was to mutation-test anything load-bearing - remove the code and
watch the test go red - which is now done for the schema mirror, the notice guard and the tests
typecheck.

Two things stand ahead of any further recognition work, both untouched:

1. **The poll loop and the engine supervisor have no unit tests.** `index.ts`'s 1s poll holds
   six pieces of mutable state in one closure and decides capture attach/detach, analyzer
   lifecycle, idle shutdown and notification debouncing. E2E cannot reach most of its branches
   without a running game; extracting a pure `decide(prevState, observation) -> actions` would
   make it testable with the vitest setup that already exists.
2. **The UI's SQLite reads run on the main process's event loop.** better-sqlite3 is
   synchronous, so a slow query costs HUD focus tracking and engine event handling as well as
   the screen that asked. See `docs/performance-improvement-notes.md`. It is the one remaining
   architectural performance problem rather than a constant factor, and it wants its own branch:
   it changes the execution environment of all 84 IPC handlers.

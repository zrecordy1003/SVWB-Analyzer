# Project Status and Roadmap

Last updated: 2026-09-02

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

### The Electron host layer has no UNIT tests

The E2E suite now covers the host from the outside, and runs in CI - window creation, the preload
bridge, the protocol handler, the update flow, the versioning rules through real IPC. It caught a
renderer-breaking chunk cycle on its first run after the bundle work, which the build reported as
success. What it does not do is exercise the two stateful paths directly:

- `src/main/index.ts`'s poll loop holds six pieces of mutable state in one closure and decides
  capture attach/detach, analyzer lifecycle, idle shutdown and notification debouncing. No unit
  tests, and E2E cannot reach most of its branches without a running game.
- `src/main/recognition/engine.ts`'s spawn/restart/re-attach path. Same.

Neither needs jsdom. Extracting the poll into a pure `decide(prevState, observation) -> actions`
would make it testable with the vitest setup that already exists, and is now the highest
value-per-hour item on this list.

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

### Renderer has no test coverage

Deliberate for now — the jsdom + vitest projects setup is decided but deferred. Revisit when the
renderer stops being the part that changes most.

## Priority 2: Schema and boundary integrity

### The schema is mirrored in three places

`resources/migrations/*.sql` is the source of truth, but it is hand-mirrored in
`tools/engine/src/store.rs` (Rust writes) and `src/main/data/db/client.ts` (`MatchRow`). The Rust
side is checked by a cargo test against the shipped migrations; the TypeScript side is checked by a
comment. Add an equivalent assertion so a new column cannot land on one side only.

### The column-ownership contract is stated but not enforced

`store.rs`'s header says the engine and the UI "touch different columns". They do not: the engine
writes `updatedAt` (which is what the UI's optimistic lock compares against) and can null
`my_deckId`, a user-edited column. Either enforce the split or correct the stated contract — a
contract that is wrong is worse than one that is absent.

### `update_match` is not atomic

It issues up to eight independent `UPDATE`s. A crash part-way leaves a half-applied patch. Wrap it
in a transaction.

## Priority 3: Host-side structure

### The IPC contract is untyped where it matters

`src/renderer/src/global.d.ts` is hand-written and has no link to the `ipcMain.handle` return types
it describes, so a change in main compiles clean in the renderer. Separately, the renderer bypasses
preload in 26 places via `window.electron.ipcRenderer.invoke('decks:all')` and friends — every
decks/tags/matches mutation channel has no preload wrapper at all.

Suggested: one `src/shared/ipc.ts` declaring channel names with their payload and return types;
preload generated from it, main registered against it. No framework needed.

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

### `tests/fixtures/analyzer/manifest.json` is still an empty harness

Either populate it or delete it — the real fixture coverage lives in `tools/engine/tests/fixtures.rs`
and the capture directories, and an empty second harness only suggests coverage that is not there.

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

The perception layer is in good shape: one process owns capture through persistence, the state
machine is a pure function with scenario tests tied to real past incidents, and the fixture and
replay suites are substantial.

The weak half is still the Electron host, but less of it than before. The E2E suite runs in CI now,
so window creation, the preload bridge, the protocol handler, the update flow and the versioning
rules are verified on every push - and it earned that place immediately by catching a chunk cycle
that stopped the renderer dead while the build reported success. What remains untested is the
stateful interior: the 1s poll loop in `index.ts` and the engine supervisor, which is where the
remaining hard-to-reproduce bugs will come from. The renderer still has no data layer, which is
what is driving component size.

Two things stand ahead of any further recognition work:

1. Extract the poll loop into a pure `decide(prevState, observation) -> actions` and test it. E2E
   cannot reach those branches without a running game; a pure function needs neither.
2. Move the UI's SQLite reads off the main process's event loop (see
   `docs/performance-improvement-notes.md`). It is the one remaining architectural performance
   problem rather than a constant factor, and it is why a slow query costs HUD focus tracking and
   engine event handling and not just the screen that asked.

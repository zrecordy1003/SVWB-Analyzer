# Recognition Optimization Status

This document tracks the current state of recognition, performance, correctness, and architecture improvements.

## Completed

### Read-only install path safety

- Runtime capture files now use `app.getPath('userData')`.
- Runtime capture tool copy now uses `userData/tools`.
- OCR cache now uses `userData`.
- This avoids writing screenshots or cache files into a read-only install directory.

### Analyzer correctness

- Analyzer now owns an `activeMatchId` after creating a match.
- Follow-up writes for BP, CR, mode, result, and deck clearing target the active match id.
- This avoids updating the latest match accidentally if the user edits or deletes data while analyzer is running.
- Statistics cache invalidation is triggered after analyzer and IPC writes.

### OCR worker lifecycle

- Tesseract worker is reused inside the analyzer utility process.
- Worker is terminated on analyzer stop.
- Recognition failures reset the worker so the next OCR attempt can rebuild it.

### Game area coordinate mapping

- The analyzer now estimates a centered 16:9 game rectangle.
- Base `1280x720` ROI coordinates are mapped into that game rectangle instead of the whole screenshot.
- This improves behavior when capture includes letterboxing or a different window size.

### Template matching robustness

- Template matching now uses a fast first pass.
- If confidence is low, it falls back to multi-scale matching with nearby scale factors.
- Applied to class, emblem, play order, mode, history, result, and OCR cursor checks.

### Anchor-aware positioning

- Shared recognition geometry, template matching, template scaling, and anchor helpers were split into `src/main/recognition`.
- Ranked and 2Pick mode detection now use top-right mode anchors.
- BP/current CR/delta CR OCR regions can be offset from detected mode anchors.
- Result and mid-result detection use anchor-style search helpers.
- Fixed ROI fallback is still preserved when an anchor is not found.

### Debug samples

- Low-confidence ROI samples can be saved by setting `DEBUG_ANALYZER_SAMPLES=1`.
- Samples are written under the capture directory in `debug-samples`.
- This is intended for threshold tuning, anchor design, or future model training.

### Performance

- Analyzer logs are gated behind `DEBUG_ANALYZER=1`.
- Analyzer polling uses dynamic intervals for active, idle, and history-cooldown states.
- Deck stats and ranked winrate queries use short-lived caches with write invalidation.
- MatchList avoids N+1 IPC calls for tags/notes.
- MatchList no longer recalculates count on pure page changes.

### Package size

- Production packaging now includes only required OpenCV runtime DLLs.
- Debug OpenCV DLLs/PDBs, include files, and lib files are no longer bundled.
- Build no longer runs `prisma migrate dev`.

### Automated tests

- Vitest was added with a Node test environment and an OpenCV mock for pure logic tests.
- Recognition tests cover game-rect mapping, ROI clamping, anchor-aware offsets, template scaling cache behavior, and template matching fallback behavior.
- Stats cache versioning is covered by a focused unit test.
- Database migration smoke tests apply all bundled SQL migrations to a fresh SQLite database and verify idempotence.
- IPC smoke tests cover deck/category/tag creation, duplicate deck validation, paged match loading with tags, and deck statistics.
- SQLite query-plan tests verify key match queries use the intended deck/date and mode/date indexes.
- Analyzer fixture manifest tests are in place so real screenshots can be added later without changing the fixture format.
- Current verification passes with test, lint, typecheck, diff-check, and production build.

## Not Fully Done

### Real gameplay validation

Static checks and builds pass, but the recognition pipeline still needs real-world validation:

- resized game window
- letterboxed capture
- ranked result screen
- 2Pick result screen
- OCR for BP/current CR/delta CR
- history playback detection
- HUD battle state updates

### Anchor coverage depth

Anchor-aware positioning exists for the highest-risk mode/OCR/result areas, but it is not yet exhaustive.

Still worth improving:

- add fixture-backed confidence thresholds per anchor type
- expand anchor strategy to class/emblem/play-order/history if real screenshots show drift
- validate tolerance for non-centered capture, extra window chrome, and unusual DPI scaling

### Query plan validation depth

SQLite `EXPLAIN QUERY PLAN` tests now cover high-value deck/date and mode/date paths.

Still worth expanding:

- ranked winrate grouping query
- deck result aggregation query
- CR range query

### Automated runtime tests

Current verification includes:

- unit tests
- lint
- typecheck
- diff-check
- build

Still missing:

- analyzer fixture-image tests
- packaged app smoke test

## Current Assessment

The optimization work is materially improved but not complete.

The project is in a better state for:

- read-only install safety
- lower background overhead
- more stable match updates
- smaller packaged OpenCV resources
- better resilience to window-size changes

The main remaining risk is recognition correctness under real user capture conditions. That needs fixture images and real gameplay verification before calling the recognition pipeline complete.

## Recommended Next Steps

1. Collect fixture screenshots for common states and resolutions.
2. Add analyzer fixture tests for class, play order, mode, history, and result detection.
3. Add real screenshot fixtures to the analyzer fixture harness.
4. Run packaged app smoke test after OpenCV packaging changes.
5. Expand `EXPLAIN QUERY PLAN` coverage for Deck stats, ranked winrate, and CR range queries.
6. Use fixture failures to decide whether class/emblem/play-order/history need anchors too.

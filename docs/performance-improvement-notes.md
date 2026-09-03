# Performance Improvement Notes

This document tracks project-wide performance improvements and the intended implementation order.

> Reviewed 2026-09-03. The "Current Status" list below predates the engine refactor and the Prisma
> removal, and still names both - read it as history. What is true today is in the two sections
> immediately after it.

## The one architectural problem left

**The UI's SQLite reads run synchronously on the main process's event loop.**

`data/db/client.ts` opens better-sqlite3, which is a synchronous driver, and all 84
`ipcMain.handle` callbacks run on it. That same event loop also carries:

- the 16ms foreground-focus ticker (`index.ts`),
- the 1s game-detection poll,
- the engine's stdout JSON Lines, parsed and applied,
- every window message.

So the cost of one slow query is not "that screen is slow". It is: the HUD drops a dozen frames of
focus tracking, engine events queue up behind it, and every other IPC call waits. Everything else
in this file is a constant factor; this is the shape.

The fix is the one already applied to perception: give the work its own process. `src/main/data/`
and `src/main/ipc/` can move into a `utilityProcess` close to wholesale, leaving main as the
supervisor it already is for the engine. Not attempted yet because it changes the execution
environment of every handler and deserves its own branch and its own test pass.

Cheaper mitigations, done:

- The focus ticker no longer runs when the game is not running and the HUD is already off screen.
  It used to make ~62 native calls a second from launch to quit regardless.
- `battle:recog` was deleted. It carried exactly `gameStatus.capturing` and was sent on every
  one-second tick, while `game:status` carries the same fact only on change and has a
  `game:getStatus` catch-up for a window that opens late. `BattleStatus` reads the latter now.

## Renderer bundle (2026-09-03)

The `manualChunks` object form was placing React inside `vendor-chart`, so **both** entries had to
load 120KB of `chart.js` to get React - and `chart.js` has exactly one consumer in the app, the
HUD's doughnut. Measured eager payload before and after:

| Entry       | Before | After |
| ----------- | ------ | ----- |
| Main window | 846KB  | 730KB |
| HUD         | 751KB  | 635KB |

`chart.js` is now reached only through a lazy `HudDonut`, so the main window never loads it and the
HUD loads it with its first completed match. Three things were learned doing this, and all three
are written up at the `manualChunks` function in `electron.vite.config.ts` rather than here:

- object values are resolved as entry modules, so `'react-dom'` does not match `react-dom/client`
  and the fix fails _quietly_;
- naming `scheduler` fails _loudly_ - pnpm does not hoist it;
- splitting React and MUI into separate chunks made them import each other through Vite's shared
  CommonJS interop helper, and the renderer died at load with `Cannot access 'In' before
initialization`. The build reported success. The E2E suite caught it.

Also removed: `vite-plugin-compression`. It emitted a `.gz` beside every chunk and `build.files`
ships `out/**`, so ~370KB of compressed copies went into the installer that nothing can read - the
renderer loads over `file://`, where there is no server to negotiate an encoding.

## Query work (2026-09-03)

`decks:all` read the **entire** `DeckCard` table on every call and grouped it in JS. That was a
reasonable trade when a deck was edited in place; versioning changed the denominator, because every
edit of a played deck forks a new Deck row plus its ~40 card rows and archived versions are never
removed. The read is now scoped to the decks being returned, so the handler's cost stops tracking
how long the user has owned the app. No new index needed: `DeckCard`'s `PRIMARY KEY (deckId,
cardId)` already serves `WHERE deckId IN (...)`.

## Current Status

The high-priority performance work is implemented and covered by static checks, unit tests, smoke
tests, and production build verification.

Completed:

- MatchList avoids duplicate page/count work and no longer performs N+1 detail IPC calls for visible rows.
- Main-process database access uses the shared Prisma client instead of ad hoc clients.
- Tesseract OCR workers are reused inside the analyzer utility process.
- Analyzer logs are gated and polling intervals are dynamic.
- Deck stats and ranked winrate queries use short-lived caches with write invalidation.
- Deck/tag/category reference data is cached in the renderer and invalidated through IPC broadcasts.
- OpenCV production packaging now includes only required runtime DLLs.
- SQLite indexes were added, and query-plan smoke tests verify the high-value deck/date and mode/date paths.

Not finished:

- Real gameplay recognition performance still needs fixture screenshots and live validation.
- Packaged app smoke testing is still needed for OpenCV, Prisma, migrations, and capture-tool resources.
- Query-plan coverage should be expanded for ranked winrate grouping, deck result aggregation, and CR range queries.
- Large local datasets should be profiled before deciding whether to add table virtualization or deeper query caching.
- DAU/telemetry is planned but not implemented.

## High priority

1. Reduce duplicate match list loading.
   - `MatchList` should not call page queries twice when filters change.
   - Keep page reset and page loading in one effect.

2. Remove match list N+1 IPC calls.
   - Fetch tags and notes with the paged match query.
   - Avoid calling `matches:getById` once per visible row.

3. Use one Prisma client.
   - All main-process IPC/database helpers should use `getPrisma()`.
   - Avoid creating ad hoc `new PrismaClient()` instances.

4. Reuse Tesseract OCR workers.
   - Creating a worker per OCR call is expensive.
   - Keep a lazy worker in the analyzer utility process and terminate it on stop.

## Medium priority

5. Gate analyzer logs and lower background cost.
   - Keep verbose logs behind `DEBUG_ANALYZER=1`.
   - Use dynamic polling intervals for cooldown and non-critical states.

6. Reduce repeated SQLite aggregation work.
   - Prefer grouping by `result` once and aggregating in JS instead of separate total/win queries.
   - Use maps instead of repeated `find()` lookups in aggregation results.

7. Add query-focused SQLite indexes after observing usage.
   - Candidates: `[my_deckId, playedAt]`, `[result, my_deckId, playedAt]`, `[current_cr, playedAt]`, `[mode, playedAt]`.

## Frontend follow-ups

8. Share deck/tag/category data through a renderer cache or context.
   - Several components independently request the same reference data.

9. Cache short-lived chart/stat query results by query key.
   - Clear cache on `matches:needRefetch`.

10. Consider virtualization if match tables grow beyond small page sizes.

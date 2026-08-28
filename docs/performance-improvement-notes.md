# Performance Improvement Notes

This document tracks project-wide performance improvements and the intended implementation order.

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

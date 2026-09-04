-- Remember what each (install, date) already holds, so an upload can stop
-- rewriting the days that have not changed.
--
-- The problem this fixes, measured: 91 installs were producing 120,424 D1 row
-- writes in 24 hours against the free tier's 100,000, and every one of those
-- days was rewritten on every upload whether or not anything in it had moved.
-- The client sends the whole 14-day window every time - deliberately, it is how
-- a deleted or corrected match propagates without any change tracking on either
-- side - so the write cost scaled as `uploads x window` and had nothing to do
-- with how many matches were actually recorded. An install that launches the app
-- and plays a session uploads five or six times a day, and only ever changes
-- today.
--
-- `ALTER TABLE ... ADD COLUMN` with no default is metadata-only in SQLite, so
-- this migration itself writes ~no rows - which matters, because the reason it
-- exists is that there is no write budget left to run anything expensive.
--
-- Existing rows get NULL, which reads as "unknown, write it". So the first
-- upload after this deploys costs exactly what today's uploads cost, and every
-- one after that is cheap. Nothing needs backfilling.

ALTER TABLE match_days ADD COLUMN content_hash TEXT;

-- One semantic shift worth writing down: `received_at` now means "when this
-- day's CONTENT last changed", not "when this day was last uploaded". A skipped
-- day keeps its old value. Nothing reads the column today, and the per-upload
-- heartbeat lives in `activity` (keyed on the day the upload arrived), which is
-- still written every time - so this costs nothing now. It would quietly break
-- anything later built on `received_at` as a freshness signal, which is why it
-- is written here rather than discovered then.

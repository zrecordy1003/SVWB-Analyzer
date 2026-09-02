-- Telemetry storage. Applied with `wrangler d1 migrations apply`.
--
-- Two questions, two pairs of tables.
--
-- "Who is running what": `installs` is one row per anonymous install id, with
-- the version and platform it last reported; `activity` is one row per install
-- per UTC day an upload ARRIVED. Active users on a date = rows in `activity`
-- for that date. Nothing about matches lives here.
--
-- "What is being recorded": `match_days` is one row per install per UTC day a
-- match was PLAYED, with the totals; `buckets` is the breakdown. Both are
-- replaced wholesale on every upload for the (install, date) pair, so an edit
-- or deletion in the app is reflected on the next upload and nothing here is
-- ever incremented.

CREATE TABLE IF NOT EXISTS installs (
  install_id  TEXT PRIMARY KEY,
  first_seen  TEXT NOT NULL,   -- ISO 8601, server clock
  last_seen   TEXT NOT NULL,
  app_version TEXT NOT NULL,
  platform    TEXT NOT NULL,
  arch        TEXT NOT NULL,
  locale      TEXT NOT NULL,
  uploads     INTEGER NOT NULL DEFAULT 0
);

CREATE INDEX IF NOT EXISTS installs_last_seen ON installs (last_seen);

CREATE TABLE IF NOT EXISTS activity (
  install_id  TEXT NOT NULL,
  date        TEXT NOT NULL,   -- YYYY-MM-DD, UTC, day of receipt
  app_version TEXT NOT NULL,
  PRIMARY KEY (install_id, date)
);

CREATE INDEX IF NOT EXISTS activity_date ON activity (date);

CREATE TABLE IF NOT EXISTS match_days (
  install_id  TEXT NOT NULL,
  date        TEXT NOT NULL,   -- YYYY-MM-DD, UTC, day the matches were played
  matches     INTEGER NOT NULL, -- sum of bucket counts
  abandoned   INTEGER NOT NULL, -- result never recorded
  manual      INTEGER NOT NULL, -- typed in by hand; never bucketed
  received_at TEXT NOT NULL,
  PRIMARY KEY (install_id, date)
);

CREATE INDEX IF NOT EXISTS match_days_date ON match_days (date);

CREATE TABLE IF NOT EXISTS buckets (
  install_id  TEXT NOT NULL,
  date        TEXT NOT NULL,
  tier        TEXT NOT NULL,   -- clean | edited | flagged | legacy
  mode        TEXT NOT NULL,
  my_class    TEXT NOT NULL,
  oppo_class  TEXT NOT NULL,
  play_order  TEXT NOT NULL,
  result      TEXT NOT NULL,   -- win | loss
  count       INTEGER NOT NULL,
  PRIMARY KEY (install_id, date, tier, mode, my_class, oppo_class, play_order, result)
);

-- The public aggregate filters on date, mode and tier, then groups on the rest.
CREATE INDEX IF NOT EXISTS buckets_date_mode_tier ON buckets (date, mode, tier);

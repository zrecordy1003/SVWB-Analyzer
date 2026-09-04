-- Add the CR band to `buckets`.
--
-- The band is part of the bucket's identity, not an attribute of it: two
-- otherwise identical matches played at different CR are two buckets. So it
-- has to go into the PRIMARY KEY, and SQLite cannot alter a primary key - hence
-- a rebuild rather than an `ALTER TABLE ... ADD COLUMN`.
--
-- Existing rows become `unknown`, which is the truth about them: they were
-- uploaded by a schema-1 client that never looked at CR. That is the same value
-- a current client sends for a match whose CR it could not read, and the two
-- are deliberately indistinguishable here - neither says anything about the
-- rank the match was played at.
--
-- Safe to run against live data: the rebuild carries every existing row over,
-- and the ingest path replaces rows per `(install_id, date)` wholesale rather
-- than upserting on the primary key, so a widened key cannot orphan anything.

CREATE TABLE buckets_new (
  install_id  TEXT NOT NULL,
  date        TEXT NOT NULL,
  tier        TEXT NOT NULL,   -- clean | edited | flagged | legacy
  mode        TEXT NOT NULL,
  my_class    TEXT NOT NULL,
  oppo_class  TEXT NOT NULL,
  play_order  TEXT NOT NULL,
  -- One of CR_BANDS' keys, or 'unknown'. See src/shared/crBands.ts; the cut
  -- points are the game's and must not be moved once shipped, because old rows
  -- are never recomputed.
  cr_band     TEXT NOT NULL DEFAULT 'unknown',
  result      TEXT NOT NULL,   -- win | loss
  count       INTEGER NOT NULL,
  PRIMARY KEY (install_id, date, tier, mode, my_class, oppo_class, play_order, cr_band, result)
);

INSERT INTO buckets_new
  (install_id, date, tier, mode, my_class, oppo_class, play_order, cr_band, result, count)
SELECT
  install_id, date, tier, mode, my_class, oppo_class, play_order, 'unknown', result, count
FROM buckets;

DROP TABLE buckets;

ALTER TABLE buckets_new RENAME TO buckets;

-- The public aggregate still filters on date, mode and tier and groups on the
-- rest, so the original index is recreated unchanged.
CREATE INDEX IF NOT EXISTS buckets_date_mode_tier ON buckets (date, mode, tier);

-- The rank-split read (`/v1/admin/overview`) adds cr_band to that filter. A
-- separate index rather than a wider one: the public path is the hot one and
-- must keep a leading-column match on exactly what it filters.
CREATE INDEX IF NOT EXISTS buckets_date_tier_band ON buckets (date, tier, cr_band);

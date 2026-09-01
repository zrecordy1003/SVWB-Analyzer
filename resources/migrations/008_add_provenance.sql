-- Provenance: where a row's values came from.
--
-- The statistics this app draws are only worth what their inputs are worth, and
-- until now a Match row carried no record of who wrote it. `updatedAt` cannot
-- answer that question - the engine writes it on every patch and on insert
-- (`store.rs`), so it is non-NULL from birth for every row.
--
-- `source` is deliberately NULLABLE rather than `NOT NULL DEFAULT 'engine'`.
-- Rows that predate this migration may or may not have been edited by hand and
-- there is no way to find out; defaulting them to 'engine' would assert a
-- provenance nobody verified. NULL means exactly that: unknown.
--
--   NULL       pre-008, provenance unknown
--   'engine'   inserted by svwb-engine, written explicitly at insert time
--   'manual'   reserved: no such path exists today, and adding one would remove
--              the only guarantee these statistics rest on. See
--              docs/meta-stats-plan.md.
ALTER TABLE "Match" ADD COLUMN "source" TEXT;

-- The engine's own values, snapshotted the first time a user edit overwrites
-- one of them. Written by the UI, not the engine - an edit is an overlay, and
-- what was observed must survive it. Unwritten until the UI side lands.
ALTER TABLE "Match" ADD COLUMN "observed" TEXT;

-- Which columns a user has edited, as a JSON array of column names. Per-column
-- rather than a whole-row flag: the common edits are deck, note and tags, none
-- of which feed any statistic, and a row-level flag would discard clean
-- observations along with them. Written by the UI only.
ALTER TABLE "Match" ADD COLUMN "edited_fields" TEXT;

-- 'weak' | 'strong' | 'authoritative' - the engine's `Confidence` for the mode
-- it settled on.
--
-- Recorded for diagnosis and after-the-fact analysis, NOT as a trust gate. The
-- ordering means "which signal may overrule which" and not "how likely this is
-- correct": ranked is deliberately Strong (the 2Pick result screen scores
-- 0.757-0.787 against the BP template, so the ranked probe must not be able to
-- overrule the one that can tell them apart), while weekendPlaza is
-- Authoritative despite being the probe with no verified positive sample.
-- Gating on 'authoritative' would drop every ranked match and keep the least
-- trustworthy mode. See `protocol.rs` and docs/meta-stats-plan.md R-1.
ALTER TABLE "Match" ADD COLUMN "mode_confidence" TEXT;

-- The svwb-engine version that recorded the row, so a recognition change can be
-- correlated with the data it produced.
ALTER TABLE "Match" ADD COLUMN "engine_version" TEXT;

-- The diagnostics this match raised about itself, as a JSON array of kinds
-- ('mode-guessed', 'weak-mode-accepted', ...).
--
-- The diagnostics recorder already counts these, but only globally - it can say
-- "the plaza probe fired 12 times today" and never "these are the 12 matches".
-- Without the link, a known-unreliable reading is indistinguishable from a
-- clean one at the row level.
ALTER TABLE "Match" ADD COLUMN "recog_flags" TEXT;

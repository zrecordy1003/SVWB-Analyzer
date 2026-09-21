-- The opening hand, as counts.
--
-- One row per (install, date, tier, mode, my class, opponent class, play order,
-- card, kept, rest-of-hand band, result). The unit is a COPY of a card in a
-- pre-mulligan hand, not a match: a hand holding two of something contributes
-- two observations, which is what the client's local advisor counts and
-- therefore what makes the cross-player estimate comparable to it.
--
-- WHY `rest_band` IS IN THE KEY. Whether a player keeps a card is strongly
-- predicted by what the other three cards were, and so is whether they win.
-- Comparing kept against swapped without conditioning on the rest of the hand
-- compares two different populations wearing one card's name - on the project's
-- own seeded fixture the crude gap is ~31 points where the adjusted one is ~4.
-- The band cannot be recovered later: it is computed from the hand, and the
-- hand is never uploaded. A version of this table without it would be years of
-- data supporting a number nobody should act on.
--
-- `rest_band` is NULLABLE, and null is a real value: the client could not price
-- one of the three companions because its `Card` row has no cost. Those rows
-- are usable at the pooled rungs and excluded from the stratified one, exactly
-- as the local advisor treats them. A band computed from two of three
-- companions is not a noisier band, it is the wrong one.
--
-- Replaced wholesale per (install, date) like `buckets`, so an edited or
-- deleted match propagates on the next upload with no change tracking on
-- either side.

CREATE TABLE IF NOT EXISTS opening_buckets (
  install_id  TEXT    NOT NULL,
  date        TEXT    NOT NULL,   -- UTC, the day the match was PLAYED
  tier        TEXT    NOT NULL,   -- clean | edited | flagged | legacy
  mode        TEXT    NOT NULL,
  my_class    TEXT    NOT NULL,
  oppo_class  TEXT    NOT NULL,
  play_order  TEXT    NOT NULL,
  card_id     INTEGER NOT NULL,   -- portal card id; names a card, not a person
  kept        INTEGER NOT NULL,   -- 1 = survived the mulligan, 0 = thrown back
  rest_band   INTEGER,            -- 0..2, or NULL when a companion cost is unknown
  result      TEXT    NOT NULL,   -- win | loss
  count       INTEGER NOT NULL
);

-- No PRIMARY KEY, and that is the one thing here worth defending.
--
-- `buckets` has one, over all of its dimensions. It works there because none of
-- them is nullable: SQLite treats NULLs as distinct in a UNIQUE index, so a
-- primary key containing `rest_band` would not actually prevent duplicate
-- unbanded rows - it would only look like it did. A key that enforces the
-- constraint for two thirds of the rows and silently not for the rest is worse
-- than no key, because the next person reads it as a guarantee.
--
-- Nothing depends on the constraint anyway: every write path deletes the whole
-- (install, date) before inserting, and the client deduplicates before sending.
CREATE INDEX IF NOT EXISTS opening_buckets_install_date
  ON opening_buckets(install_id, date);

-- The read path: one matchup's cards, newest window first. Leads with `date`
-- so the nightly prune is a range scan on an index that already exists, which
-- is the same reason `buckets_date_mode_tier` leads with it.
CREATE INDEX IF NOT EXISTS opening_buckets_date_card
  ON opening_buckets(date, tier, my_class, oppo_class, play_order, card_id);

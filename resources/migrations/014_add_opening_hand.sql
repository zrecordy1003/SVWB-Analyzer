-- The opening hand, one row per card position.
--
-- A row and not four columns on Match, because the question this table exists
-- to answer is "how did I do when I kept this card", and that is a join rather
-- than a scan across eight columns. See docs/opening-hand-plan.md.
--
-- WHAT IS WRITTEN TODAY: only `swapped`, and only for `stage = 'pre'`. The
-- engine reads the mulligan panel's GEOMETRY - a card being thrown away is moved
-- into the row above, so which of the four went is legible without recognising
-- any card at all. `cardId` stays NULL until card recognition lands; the column
-- is here now so that filling it later is an UPDATE rather than a migration.
--
-- `cardId` has NO foreign key to Card, the same stance 009's DeckCard and 010's
-- CardPool take: Card is a cache of someone else's data and may be evicted,
-- refetched in another language, or never fetched at all. A row that outlives
-- its Card row should degrade to "card 10573310, details unknown", not break the
-- query.
--
-- The foreign key that IS here points at Match and cascades. Deleting a match
-- deletes its hand; nothing else owns these rows. Deliberately not touching the
-- Deck family, whose ON DELETE SET NULL fires the sync-outbox triggers.
CREATE TABLE IF NOT EXISTS MatchOpeningCard (
  matchId    INTEGER NOT NULL,
  -- 'pre'  the hand as dealt, before the swap
  -- 'post' the hand the match was actually played with
  stage      TEXT    NOT NULL,
  -- 0..3, left to right on the mulligan panel. The panel keeps a card in its
  -- own column when it moves between the two rows, so the index is stable
  -- across both stages.
  slot       INTEGER NOT NULL,

  -- NULL means "not recognised", which is a real state and not a failure: it is
  -- what every row says until card recognition exists.
  cardId     INTEGER,
  -- How sure the recognition was, kept for tuning the thresholds and for
  -- deciding whether a batch of rows is fit to compute a win rate from.
  confidence REAL,
  -- 'pre' rows only: was this card thrown away? 0/1, never NULL once the panel
  -- was read - "the panel was never read" is the absence of the rows.
  swapped    INTEGER,
  -- Which layer decided `cardId`: 'numeric', 'name', 'art-portal',
  -- 'art-observed'. NULL while cardId is NULL.
  decidedBy  TEXT,

  PRIMARY KEY (matchId, stage, slot),

  FOREIGN KEY(matchId) REFERENCES Match(id) ON DELETE CASCADE
);

-- "Which matches had this card in hand" is the whole point of the table.
CREATE INDEX IF NOT EXISTS idx_openingcard_cardId ON MatchOpeningCard(cardId);

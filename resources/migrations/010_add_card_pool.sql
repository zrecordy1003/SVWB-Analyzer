-- The card pool: which cards are playable, per format.
--
-- Migration 009 gave us a `Card` table, but only ever populated from the decks
-- a user imported - enough to display a deck, nowhere near enough to build one.
-- These two tables are what turn that cache into a browsable pool. See
-- docs/deck-import-plan.md, stage C.
--
-- Deliberately NOT stored as a column on Card. Legality is a property of the
-- (card, format) pair, not of the card: the same card is in Unlimited and out
-- of Rotation, and a boolean per format on Card would need a migration every
-- time Cygames adds one.

-- ---------- CardPool ----------
-- Membership plus the portal's own display order for the format.
--
-- `sortIndex` comes from `sort_card_id_list`, so a pool grid can present cards
-- in the order players are used to seeing them without re-deriving a sort that
-- would inevitably differ.
--
-- No foreign key to Card, for the same reason 009's DeckCard has none: Card is
-- a cache of somebody else's data and may be evicted, refetched in another
-- language, or simply absent. A pool row that outlives its Card row should
-- degrade to "card 10573310, details unknown", not break the query.
CREATE TABLE IF NOT EXISTS CardPool (
  battleFormat INTEGER NOT NULL,
  cardId       INTEGER NOT NULL,
  sortIndex    INTEGER NOT NULL,

  PRIMARY KEY (battleFormat, cardId)
);

CREATE INDEX IF NOT EXISTS idx_cardpool_format_sort ON CardPool(battleFormat, sortIndex);

-- ---------- CardPoolSync ----------
-- When each (class, format, language) slice was last fetched, and how big it was.
--
-- Needed because a partial sync is indistinguishable from a complete one by
-- looking at Card rows alone: a user who imported one witch deck has witch
-- cards on disk, but not the witch POOL. Without this the editor could not tell
-- "nothing to fetch" from "nothing fetched yet".
--
-- Keyed by language as well as class because `name` and `skillText` are
-- language-dependent; switching the app's language makes every slice stale even
-- though the card ids did not change.
CREATE TABLE IF NOT EXISTS CardPoolSync (
  classId      INTEGER NOT NULL,
  battleFormat INTEGER NOT NULL,
  lang         TEXT NOT NULL,
  cardCount    INTEGER NOT NULL,
  syncedAt     DATETIME NOT NULL,

  PRIMARY KEY (classId, battleFormat, lang)
);

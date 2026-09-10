-- Card illustrations, reduced to something comparable.
--
-- One row is one 32x36 grayscale reduction of a card's illustration - 1152
-- bytes - which is what the engine compares the mulligan panel against. See
-- `tools/engine/src/fingerprint.rs` and docs/opening-hand-plan.md.
--
-- NOT card art. A fingerprint cannot be shown to anyone and is not worth
-- showing: it is a thousand grey samples kept so that two pictures can be told
-- apart. The card images themselves stay where they already are - in the user's
-- own disk cache, fetched by the user's own machine (`src/main/data/cardImages.ts`).
--
-- `source` is the provenance, and there will be two:
--
--   'portal'    computed from the official card image. One per card and
--               algorithm version, replaced rather than accumulated.
--   'observed'  computed from a card seen on screen and identified by other
--               means. Several per card, because the whole point is to cover
--               the alternate illustrations the portal does not publish. NOT
--               WRITTEN YET - the mechanism is planned, not built.
--
-- `algoVersion` is `fingerprint::ALGO_VERSION`. Vectors from different versions
-- are not comparable, so the reader filters on it and a bump simply orphans the
-- old rows. There is deliberately no migration path for a fingerprint: it is
-- derived data and recomputing it from images already on disk is cheap.
--
-- `seenAt` is in the key so that 'observed' rows can accumulate. A 'portal' row
-- is unique per (cardId, algoVersion) by convention rather than by constraint -
-- the writer deletes before it inserts. A constraint would have to be dropped
-- the moment 'observed' rows arrive.
--
-- No foreign key to Card, the same stance 009's DeckCard and 010's CardPool
-- take: Card is a cache of someone else's data and may be evicted or refetched.
-- A fingerprint that outlives its Card row is still a usable fingerprint.
CREATE TABLE IF NOT EXISTS CardArtSample (
  cardId      INTEGER NOT NULL,
  source      TEXT    NOT NULL,
  algoVersion INTEGER NOT NULL,
  seenAt      DATETIME NOT NULL,
  vector      BLOB    NOT NULL,

  PRIMARY KEY (cardId, source, algoVersion, seenAt)
);

-- The engine's only query: "every fingerprint for these cards, at this version".
CREATE INDEX IF NOT EXISTS idx_cardartsample_version
  ON CardArtSample(algoVersion, cardId);

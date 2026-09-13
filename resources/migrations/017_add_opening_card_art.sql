-- The picture of a card nobody could name yet.
--
-- Not a picture: a fingerprint, 1152 bytes, the same 32x36 grey reduction the
-- engine compares against (`tools/engine/src/fingerprint.rs`). The illustration
-- itself is never stored - it would be twenty times larger and every use of it
-- would begin by reducing it to this anyway.
--
-- WHY KEEP IT. Naming a card needs the card's official art to already be
-- fingerprinted, and that takes a download of the class pool - about 88MB, a few
-- seconds on a fast line and several minutes on a slow one. Matches played
-- before that finishes could be named perfectly well; the evidence was simply
-- thrown away the moment the panel left the screen. So it is kept instead, and
-- the match is named as soon as the pool arrives.
--
-- IT DELETES ITSELF. On a successful retry the row gets its `cardId` and this
-- column is set back to NULL, so the space is borrowed rather than spent: eight
-- slots is 9KB, and only until the answer is known.
--
-- `artAlgoVersion` is the `fingerprint::ALGO_VERSION` this vector was computed
-- with. A vector from another version cannot be compared with today's
-- references, so a bump makes these rows useless - they are dropped rather than
-- migrated, for the same reason the fingerprints themselves are.
ALTER TABLE MatchOpeningCard ADD COLUMN artVector BLOB;
ALTER TABLE MatchOpeningCard ADD COLUMN artAlgoVersion INTEGER;

-- The retry pass's only question: "which slots are still waiting for a name".
CREATE INDEX IF NOT EXISTS idx_openingcard_unnamed
  ON MatchOpeningCard(artAlgoVersion)
  WHERE cardId IS NULL AND artVector IS NOT NULL;

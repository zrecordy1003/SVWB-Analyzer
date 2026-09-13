-- Which class a fingerprint's card belongs to.
--
-- The engine matches a mulligan panel against candidates, and the tighter the
-- candidate set the wider the winner's lead: measured on five recordings, going
-- from 63 candidates to a whole class pool of 175 cost at most 0.05 of margin
-- (smallest 0.505 -> 0.456, against a 0.30 threshold) while turning 8 named
-- slots out of 12 into 12 out of 12. Class is the one bound worth having - it is
-- read off the versus screen before the panel appears and is not a guess - so
-- this column is what lets the engine apply it.
--
-- A STRING, and the engine's own vocabulary ('witch', 'dragon', ...) plus
-- 'neutral', not the portal's numeric `class_id`. That is deliberate: the
-- portal's ids and this app's class names have the same members in a DIFFERENT
-- ORDER (bishop and nightmare are swapped), and `src/shared/deckImport.ts`'s
-- `CLASS_ID_TO_NAME` is the single place that knows the translation. Storing the
-- name here means the engine never needs a copy of that table, and a copy is
-- exactly what would rot: nothing would fail loudly if it went stale, matches
-- would just quietly be compared against the wrong class's cards.
--
-- NULL means "indexed before this column existed" - such a row still works, it
-- simply cannot be narrowed by class, so the engine treats it as a candidate for
-- every class rather than dropping it.
ALTER TABLE CardArtSample ADD COLUMN class TEXT;

-- The engine's query is "every fingerprint for this class, at this version".
CREATE INDEX IF NOT EXISTS idx_cardartsample_class
  ON CardArtSample(algoVersion, class);

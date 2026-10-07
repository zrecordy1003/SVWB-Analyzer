-- A name for a row that is the same on every machine.
--
-- `id` is AUTOINCREMENT, so two machines both have a match 1. It stays exactly
-- what it was - the keyset paging, the deck-version ordering and `familyId = id`
-- all stand on it being a single monotonic integer - and becomes a local
-- surrogate. `uid` is the identity a second machine can be told about.
-- See docs/account-sync-plan.md, difficulty 1.
--
-- 32 lowercase hex characters (16 random bytes). The engine cannot reach a UUID
-- crate without a new dependency, and SQLite already has `randomblob`, so every
-- writer - the backfill below, the engine's INSERT, the UI's - produces the same
-- shape without one.
--
-- NO DEFAULT, ON PURPOSE. A default would make a writer that forgot the column
-- succeed and quietly produce a row that can never be synced. Leaving it NULL
-- lets `tests/main/syncIds.test.ts` fail on the forgetful path instead. It is
-- also not NOT NULL: `ALTER TABLE ... ADD COLUMN` cannot add one without a
-- default, and a CHECK/trigger refusal would turn a missed writer into a lost
-- match, which is the worse failure.
--
-- Only the three tables with an AUTOINCREMENT key. `DeckCategory.id` is already
-- a global random string and needs nothing; `MatchTag` and `DeckCard` travel
-- inside their parent row.
ALTER TABLE "Match" ADD COLUMN "uid" TEXT;
ALTER TABLE "Deck"  ADD COLUMN "uid" TEXT;
ALTER TABLE "Tag"   ADD COLUMN "uid" TEXT;

-- `randomblob` is non-deterministic, so SQLite evaluates it once per row. There
-- are no triggers on these tables, so this does not touch `updatedAt` - the
-- value the UI's optimistic lock compares against.
UPDATE "Match" SET "uid" = lower(hex(randomblob(16))) WHERE "uid" IS NULL;
UPDATE "Deck"  SET "uid" = lower(hex(randomblob(16))) WHERE "uid" IS NULL;
UPDATE "Tag"   SET "uid" = lower(hex(randomblob(16))) WHERE "uid" IS NULL;

-- UNIQUE tolerates many NULLs, so a row written without one is not rejected
-- here; the test is what catches it.
CREATE UNIQUE INDEX IF NOT EXISTS idx_match_uid ON "Match"("uid");
CREATE UNIQUE INDEX IF NOT EXISTS idx_deck_uid  ON "Deck"("uid");
CREATE UNIQUE INDEX IF NOT EXISTS idx_tag_uid   ON "Tag"("uid");

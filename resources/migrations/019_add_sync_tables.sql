-- The ledger cross-device sync keeps about the rows it has seen and the rows it owes.
--
-- All of it is sync's own: the triggers below fire on the engine's INSERTs too
-- (which is the whole point of triggers), but nothing outside src/main/sync
-- reads these tables. See docs/account-sync-plan.md.
--
-- Nothing here leaves the machine by itself. The triggers only ever write to a
-- local table, and an outbox nobody drains is one row per changed record -
-- cheap, and exactly what "turn sync on" needs to find on day one.

-- Small facts that must outlive `settings:clear`: this machine's device id, the
-- hybrid-logical-clock high-water mark, the next segment number, one cursor per
-- remote device. Same reasoning as 012_add_telemetry_state.sql for living here.
CREATE TABLE IF NOT EXISTS "SyncState" (
  "key"       TEXT PRIMARY KEY,
  "value"     TEXT NOT NULL,
  "updatedAt" INTEGER NOT NULL
);

-- Who is dirty. Keyed by row, so a match edited fifty times is one entry and
-- the entry says WHEN it last changed (ms) - that moment, not the moment of the
-- upload, is what last-writer-wins compares. `delete` is terminal: uids are
-- never reused, so an upsert can never follow it.
CREATE TABLE IF NOT EXISTS "SyncOutbox" (
  "tbl"       TEXT NOT NULL,
  "uid"       TEXT NOT NULL,
  "op"        TEXT NOT NULL CHECK ("op" IN ('upsert', 'delete')),
  "changedAt" INTEGER NOT NULL,
  PRIMARY KEY ("tbl", "uid")
);

-- The last known state of every row sync has touched, whoever wrote it. A
-- deleted row stays here as a tombstone (`deletedAt`), because a tombstone is
-- what stops an older upsert arriving late from bringing it back.
CREATE TABLE IF NOT EXISTS "SyncRowMeta" (
  "tbl"       TEXT NOT NULL,
  "uid"       TEXT NOT NULL,
  "ts"        INTEGER NOT NULL,
  "device"    TEXT NOT NULL,
  "deletedAt" INTEGER,
  PRIMARY KEY ("tbl", "uid")
);

-- Two machines each made a tag called "practice". The one with the smaller uid
-- wins, and the loser's uid is remembered here so references to it (a match's
-- tag list, a deck's category) can still be followed.
CREATE TABLE IF NOT EXISTS "SyncAlias" (
  "tbl"     TEXT NOT NULL,
  "fromUid" TEXT NOT NULL,
  "toUid"   TEXT NOT NULL,
  PRIMARY KEY ("tbl", "fromUid")
);

-- A reference to a row that has not arrived yet (segments are pulled per
-- device, so order is not guaranteed). The field is left empty meanwhile and
-- filled in when the parent turns up.
CREATE TABLE IF NOT EXISTS "SyncPending" (
  "tbl"    TEXT NOT NULL,
  "uid"    TEXT NOT NULL,
  "field"  TEXT NOT NULL,
  "refTbl" TEXT NOT NULL,
  "refUid" TEXT NOT NULL,
  PRIMARY KEY ("tbl", "uid", "field", "refUid")
);

-- "Remote changes are being applied, do not write them down." The apply
-- transaction inserts the one row first and deletes it before commit, so
-- nothing outside that transaction ever sees it. Sufficient because SQLite has
-- a single writer: the engine's INSERT cannot land in the middle of that
-- transaction, it waits and its trigger runs after the flag is gone. That
-- holds only if the whole apply is ONE transaction - see syncApply.ts.
CREATE TABLE IF NOT EXISTS "SyncSuppress" (
  "one" INTEGER PRIMARY KEY CHECK ("one" = 1)
);

-- ---- the triggers -------------------------------------------------------
--
-- Triggers rather than application code because the engine writes Match rows
-- straight into SQLite and nothing in src/main would ever see them.
--
-- DEMO DATA NEVER SYNCS. tools/seed-opening-demo.mjs writes ~1700 fabricated
-- matches marked source = 'demo-seed' and decks marked sourceRef = 'demo-seed';
-- sync takes whole tables, so without the guard below they would be uploaded as
-- the user's real games - which is exactly what happened to telemetry on
-- 2026-09-17. The guard lives here, in the database, so that it does not depend
-- on any writer remembering anything.

CREATE TRIGGER IF NOT EXISTS sync_match_ai AFTER INSERT ON "Match"
WHEN NEW."uid" IS NOT NULL AND NEW."source" IS NOT 'demo-seed' AND NOT EXISTS (SELECT 1 FROM "SyncSuppress")
BEGIN
  INSERT INTO "SyncOutbox"("tbl","uid","op","changedAt")
  VALUES ('Match', NEW."uid", 'upsert', (CAST(strftime('%s','now') AS INTEGER) * 1000 + CAST(substr(strftime('%f','now'), 4) AS INTEGER)))
  ON CONFLICT("tbl","uid") DO UPDATE SET
    "op" = CASE WHEN "SyncOutbox"."op" = 'delete' THEN 'delete' ELSE 'upsert' END,
    "changedAt" = excluded."changedAt";
END;

CREATE TRIGGER IF NOT EXISTS sync_match_au AFTER UPDATE ON "Match"
WHEN NEW."uid" IS NOT NULL AND NEW."source" IS NOT 'demo-seed' AND NOT EXISTS (SELECT 1 FROM "SyncSuppress")
BEGIN
  INSERT INTO "SyncOutbox"("tbl","uid","op","changedAt")
  VALUES ('Match', NEW."uid", 'upsert', (CAST(strftime('%s','now') AS INTEGER) * 1000 + CAST(substr(strftime('%f','now'), 4) AS INTEGER)))
  ON CONFLICT("tbl","uid") DO UPDATE SET
    "op" = CASE WHEN "SyncOutbox"."op" = 'delete' THEN 'delete' ELSE 'upsert' END,
    "changedAt" = excluded."changedAt";
END;

CREATE TRIGGER IF NOT EXISTS sync_match_ad AFTER DELETE ON "Match"
WHEN OLD."uid" IS NOT NULL AND OLD."source" IS NOT 'demo-seed' AND NOT EXISTS (SELECT 1 FROM "SyncSuppress")
BEGIN
  INSERT INTO "SyncOutbox"("tbl","uid","op","changedAt")
  VALUES ('Match', OLD."uid", 'delete', (CAST(strftime('%s','now') AS INTEGER) * 1000 + CAST(substr(strftime('%f','now'), 4) AS INTEGER)))
  ON CONFLICT("tbl","uid") DO UPDATE SET "op" = 'delete', "changedAt" = excluded."changedAt";
END;

CREATE TRIGGER IF NOT EXISTS sync_deck_ai AFTER INSERT ON "Deck"
WHEN NEW."uid" IS NOT NULL AND NEW."sourceRef" IS NOT 'demo-seed' AND NOT EXISTS (SELECT 1 FROM "SyncSuppress")
BEGIN
  INSERT INTO "SyncOutbox"("tbl","uid","op","changedAt")
  VALUES ('Deck', NEW."uid", 'upsert', (CAST(strftime('%s','now') AS INTEGER) * 1000 + CAST(substr(strftime('%f','now'), 4) AS INTEGER)))
  ON CONFLICT("tbl","uid") DO UPDATE SET
    "op" = CASE WHEN "SyncOutbox"."op" = 'delete' THEN 'delete' ELSE 'upsert' END,
    "changedAt" = excluded."changedAt";
END;

CREATE TRIGGER IF NOT EXISTS sync_deck_au AFTER UPDATE ON "Deck"
WHEN NEW."uid" IS NOT NULL AND NEW."sourceRef" IS NOT 'demo-seed' AND NOT EXISTS (SELECT 1 FROM "SyncSuppress")
BEGIN
  INSERT INTO "SyncOutbox"("tbl","uid","op","changedAt")
  VALUES ('Deck', NEW."uid", 'upsert', (CAST(strftime('%s','now') AS INTEGER) * 1000 + CAST(substr(strftime('%f','now'), 4) AS INTEGER)))
  ON CONFLICT("tbl","uid") DO UPDATE SET
    "op" = CASE WHEN "SyncOutbox"."op" = 'delete' THEN 'delete' ELSE 'upsert' END,
    "changedAt" = excluded."changedAt";
END;

CREATE TRIGGER IF NOT EXISTS sync_deck_ad AFTER DELETE ON "Deck"
WHEN OLD."uid" IS NOT NULL AND OLD."sourceRef" IS NOT 'demo-seed' AND NOT EXISTS (SELECT 1 FROM "SyncSuppress")
BEGIN
  INSERT INTO "SyncOutbox"("tbl","uid","op","changedAt")
  VALUES ('Deck', OLD."uid", 'delete', (CAST(strftime('%s','now') AS INTEGER) * 1000 + CAST(substr(strftime('%f','now'), 4) AS INTEGER)))
  ON CONFLICT("tbl","uid") DO UPDATE SET "op" = 'delete', "changedAt" = excluded."changedAt";
END;

CREATE TRIGGER IF NOT EXISTS sync_tag_ai AFTER INSERT ON "Tag"
WHEN NEW."uid" IS NOT NULL AND NOT EXISTS (SELECT 1 FROM "SyncSuppress")
BEGIN
  INSERT INTO "SyncOutbox"("tbl","uid","op","changedAt")
  VALUES ('Tag', NEW."uid", 'upsert', (CAST(strftime('%s','now') AS INTEGER) * 1000 + CAST(substr(strftime('%f','now'), 4) AS INTEGER)))
  ON CONFLICT("tbl","uid") DO UPDATE SET
    "op" = CASE WHEN "SyncOutbox"."op" = 'delete' THEN 'delete' ELSE 'upsert' END,
    "changedAt" = excluded."changedAt";
END;

CREATE TRIGGER IF NOT EXISTS sync_tag_au AFTER UPDATE ON "Tag"
WHEN NEW."uid" IS NOT NULL AND NOT EXISTS (SELECT 1 FROM "SyncSuppress")
BEGIN
  INSERT INTO "SyncOutbox"("tbl","uid","op","changedAt")
  VALUES ('Tag', NEW."uid", 'upsert', (CAST(strftime('%s','now') AS INTEGER) * 1000 + CAST(substr(strftime('%f','now'), 4) AS INTEGER)))
  ON CONFLICT("tbl","uid") DO UPDATE SET
    "op" = CASE WHEN "SyncOutbox"."op" = 'delete' THEN 'delete' ELSE 'upsert' END,
    "changedAt" = excluded."changedAt";
END;

CREATE TRIGGER IF NOT EXISTS sync_tag_ad AFTER DELETE ON "Tag"
WHEN OLD."uid" IS NOT NULL AND NOT EXISTS (SELECT 1 FROM "SyncSuppress")
BEGIN
  INSERT INTO "SyncOutbox"("tbl","uid","op","changedAt")
  VALUES ('Tag', OLD."uid", 'delete', (CAST(strftime('%s','now') AS INTEGER) * 1000 + CAST(substr(strftime('%f','now'), 4) AS INTEGER)))
  ON CONFLICT("tbl","uid") DO UPDATE SET "op" = 'delete', "changedAt" = excluded."changedAt";
END;

-- DeckCategory's primary key is already a global random string, so it is its own uid.

CREATE TRIGGER IF NOT EXISTS sync_category_ai AFTER INSERT ON "DeckCategory"
WHEN NOT EXISTS (SELECT 1 FROM "SyncSuppress")
BEGIN
  INSERT INTO "SyncOutbox"("tbl","uid","op","changedAt")
  VALUES ('DeckCategory', NEW."id", 'upsert', (CAST(strftime('%s','now') AS INTEGER) * 1000 + CAST(substr(strftime('%f','now'), 4) AS INTEGER)))
  ON CONFLICT("tbl","uid") DO UPDATE SET
    "op" = CASE WHEN "SyncOutbox"."op" = 'delete' THEN 'delete' ELSE 'upsert' END,
    "changedAt" = excluded."changedAt";
END;

CREATE TRIGGER IF NOT EXISTS sync_category_au AFTER UPDATE ON "DeckCategory"
WHEN NOT EXISTS (SELECT 1 FROM "SyncSuppress")
BEGIN
  INSERT INTO "SyncOutbox"("tbl","uid","op","changedAt")
  VALUES ('DeckCategory', NEW."id", 'upsert', (CAST(strftime('%s','now') AS INTEGER) * 1000 + CAST(substr(strftime('%f','now'), 4) AS INTEGER)))
  ON CONFLICT("tbl","uid") DO UPDATE SET
    "op" = CASE WHEN "SyncOutbox"."op" = 'delete' THEN 'delete' ELSE 'upsert' END,
    "changedAt" = excluded."changedAt";
END;

CREATE TRIGGER IF NOT EXISTS sync_category_ad AFTER DELETE ON "DeckCategory"
WHEN NOT EXISTS (SELECT 1 FROM "SyncSuppress")
BEGIN
  INSERT INTO "SyncOutbox"("tbl","uid","op","changedAt")
  VALUES ('DeckCategory', OLD."id", 'delete', (CAST(strftime('%s','now') AS INTEGER) * 1000 + CAST(substr(strftime('%f','now'), 4) AS INTEGER)))
  ON CONFLICT("tbl","uid") DO UPDATE SET "op" = 'delete', "changedAt" = excluded."changedAt";
END;

-- A match's tag list and a deck's card list travel inside the parent's entry
-- (the whole set, replaced as one), so a change to either marks the PARENT
-- dirty. The SELECT finding the parent is what keeps a cascade quiet: when a
-- match is deleted its MatchTag rows go with it and there may be no parent left
-- to mark - and a `delete` entry is never downgraded back to an upsert anyway.

CREATE TRIGGER IF NOT EXISTS sync_matchtag_ai AFTER INSERT ON "MatchTag"
WHEN NOT EXISTS (SELECT 1 FROM "SyncSuppress")
BEGIN
  INSERT INTO "SyncOutbox"("tbl","uid","op","changedAt")
  SELECT 'Match', p."uid", 'upsert', (CAST(strftime('%s','now') AS INTEGER) * 1000 + CAST(substr(strftime('%f','now'), 4) AS INTEGER))
  FROM "Match" p
  WHERE p."id" = NEW."matchId" AND p."uid" IS NOT NULL AND p."source" IS NOT 'demo-seed'
  ON CONFLICT("tbl","uid") DO UPDATE SET
    "op" = CASE WHEN "SyncOutbox"."op" = 'delete' THEN 'delete' ELSE 'upsert' END,
    "changedAt" = excluded."changedAt";
END;

CREATE TRIGGER IF NOT EXISTS sync_matchtag_ad AFTER DELETE ON "MatchTag"
WHEN NOT EXISTS (SELECT 1 FROM "SyncSuppress")
BEGIN
  INSERT INTO "SyncOutbox"("tbl","uid","op","changedAt")
  SELECT 'Match', p."uid", 'upsert', (CAST(strftime('%s','now') AS INTEGER) * 1000 + CAST(substr(strftime('%f','now'), 4) AS INTEGER))
  FROM "Match" p
  WHERE p."id" = OLD."matchId" AND p."uid" IS NOT NULL AND p."source" IS NOT 'demo-seed'
  ON CONFLICT("tbl","uid") DO UPDATE SET
    "op" = CASE WHEN "SyncOutbox"."op" = 'delete' THEN 'delete' ELSE 'upsert' END,
    "changedAt" = excluded."changedAt";
END;

CREATE TRIGGER IF NOT EXISTS sync_deckcard_ai AFTER INSERT ON "DeckCard"
WHEN NOT EXISTS (SELECT 1 FROM "SyncSuppress")
BEGIN
  INSERT INTO "SyncOutbox"("tbl","uid","op","changedAt")
  SELECT 'Deck', p."uid", 'upsert', (CAST(strftime('%s','now') AS INTEGER) * 1000 + CAST(substr(strftime('%f','now'), 4) AS INTEGER))
  FROM "Deck" p
  WHERE p."id" = NEW."deckId" AND p."uid" IS NOT NULL AND p."sourceRef" IS NOT 'demo-seed'
  ON CONFLICT("tbl","uid") DO UPDATE SET
    "op" = CASE WHEN "SyncOutbox"."op" = 'delete' THEN 'delete' ELSE 'upsert' END,
    "changedAt" = excluded."changedAt";
END;

CREATE TRIGGER IF NOT EXISTS sync_deckcard_au AFTER UPDATE ON "DeckCard"
WHEN NOT EXISTS (SELECT 1 FROM "SyncSuppress")
BEGIN
  INSERT INTO "SyncOutbox"("tbl","uid","op","changedAt")
  SELECT 'Deck', p."uid", 'upsert', (CAST(strftime('%s','now') AS INTEGER) * 1000 + CAST(substr(strftime('%f','now'), 4) AS INTEGER))
  FROM "Deck" p
  WHERE p."id" = NEW."deckId" AND p."uid" IS NOT NULL AND p."sourceRef" IS NOT 'demo-seed'
  ON CONFLICT("tbl","uid") DO UPDATE SET
    "op" = CASE WHEN "SyncOutbox"."op" = 'delete' THEN 'delete' ELSE 'upsert' END,
    "changedAt" = excluded."changedAt";
END;

CREATE TRIGGER IF NOT EXISTS sync_deckcard_ad AFTER DELETE ON "DeckCard"
WHEN NOT EXISTS (SELECT 1 FROM "SyncSuppress")
BEGIN
  INSERT INTO "SyncOutbox"("tbl","uid","op","changedAt")
  SELECT 'Deck', p."uid", 'upsert', (CAST(strftime('%s','now') AS INTEGER) * 1000 + CAST(substr(strftime('%f','now'), 4) AS INTEGER))
  FROM "Deck" p
  WHERE p."id" = OLD."deckId" AND p."uid" IS NOT NULL AND p."sourceRef" IS NOT 'demo-seed'
  ON CONFLICT("tbl","uid") DO UPDATE SET
    "op" = CASE WHEN "SyncOutbox"."op" = 'delete' THEN 'delete' ELSE 'upsert' END,
    "changedAt" = excluded."changedAt";
END;

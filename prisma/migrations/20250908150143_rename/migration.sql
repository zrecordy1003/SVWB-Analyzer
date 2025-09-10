/*
  Warnings:

  - You are about to drop the column `cr` on the `Match` table. All the data in the column will be lost.
  - You are about to drop the column `crDelta` on the `Match` table. All the data in the column will be lost.

*/
-- RedefineTables
PRAGMA defer_foreign_keys=ON;
PRAGMA foreign_keys=OFF;
CREATE TABLE "new_Match" (
    "id" INTEGER NOT NULL PRIMARY KEY AUTOINCREMENT,
    "result" BOOLEAN,
    "play_order" TEXT NOT NULL,
    "my_class" TEXT NOT NULL,
    "oppo_class" TEXT NOT NULL,
    "my_deckId" INTEGER,
    "oppo_deckId" INTEGER,
    "mode" TEXT,
    "bp" INTEGER,
    "current_cr" INTEGER,
    "delta_cr" INTEGER,
    "durationTime" INTEGER,
    "playedAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "endedAt" DATETIME,
    "year" INTEGER,
    "month" INTEGER,
    "day" INTEGER,
    "note" TEXT,
    "updatedAt" DATETIME DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "Match_my_deckId_fkey" FOREIGN KEY ("my_deckId") REFERENCES "Deck" ("id") ON DELETE SET NULL ON UPDATE CASCADE,
    CONSTRAINT "Match_oppo_deckId_fkey" FOREIGN KEY ("oppo_deckId") REFERENCES "Deck" ("id") ON DELETE SET NULL ON UPDATE CASCADE
);
INSERT INTO "new_Match" ("bp", "day", "durationTime", "endedAt", "id", "mode", "month", "my_class", "my_deckId", "note", "oppo_class", "oppo_deckId", "play_order", "playedAt", "result", "updatedAt", "year") SELECT "bp", "day", "durationTime", "endedAt", "id", "mode", "month", "my_class", "my_deckId", "note", "oppo_class", "oppo_deckId", "play_order", "playedAt", "result", "updatedAt", "year" FROM "Match";
DROP TABLE "Match";
ALTER TABLE "new_Match" RENAME TO "Match";
CREATE INDEX "idx_match_playedAt_id" ON "Match"("playedAt", "id");
CREATE INDEX "idx_match_ymd_id" ON "Match"("year", "month", "day", "id");
CREATE INDEX "idx_match_mode" ON "Match"("mode");
CREATE INDEX "idx_match_my_class" ON "Match"("my_class");
CREATE INDEX "idx_match_oppo_class" ON "Match"("oppo_class");
CREATE INDEX "idx_match_ranked_myclass_playedAt" ON "Match"("mode", "my_class", "playedAt");
PRAGMA foreign_keys=ON;
PRAGMA defer_foreign_keys=OFF;

-- RedefineTables
PRAGMA defer_foreign_keys=ON;
PRAGMA foreign_keys=OFF;
CREATE TABLE "new_Match" (
    "id" INTEGER NOT NULL PRIMARY KEY AUTOINCREMENT,
    "result" BOOLEAN NOT NULL,
    "my_class" TEXT NOT NULL,
    "oppo_class" TEXT NOT NULL,
    "my_deckId" INTEGER,
    "oppo_deckId" INTEGER,
    "playedAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "Match_my_deckId_fkey" FOREIGN KEY ("my_deckId") REFERENCES "Deck" ("id") ON DELETE SET NULL ON UPDATE CASCADE,
    CONSTRAINT "Match_oppo_deckId_fkey" FOREIGN KEY ("oppo_deckId") REFERENCES "Deck" ("id") ON DELETE SET NULL ON UPDATE CASCADE
);
INSERT INTO "new_Match" ("id", "my_class", "my_deckId", "oppo_class", "oppo_deckId", "playedAt", "result") SELECT "id", "my_class", "my_deckId", "oppo_class", "oppo_deckId", "playedAt", "result" FROM "Match";
DROP TABLE "Match";
ALTER TABLE "new_Match" RENAME TO "Match";
PRAGMA foreign_keys=ON;
PRAGMA defer_foreign_keys=OFF;

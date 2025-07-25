/*
  Warnings:

  - You are about to drop the `Deckk` table. If the table is not empty, all the data it contains will be lost.
  - You are about to drop the column `deckId` on the `Match` table. All the data in the column will be lost.
  - You are about to drop the column `opponent` on the `Match` table. All the data in the column will be lost.
  - You are about to drop the column `opponent_deckId` on the `Match` table. All the data in the column will be lost.
  - Added the required column `my_class` to the `Match` table without a default value. This is not possible if the table is not empty.
  - Added the required column `my_deckId` to the `Match` table without a default value. This is not possible if the table is not empty.
  - Added the required column `oppo_class` to the `Match` table without a default value. This is not possible if the table is not empty.
  - Added the required column `oppo_deckId` to the `Match` table without a default value. This is not possible if the table is not empty.

*/
-- DropTable
PRAGMA foreign_keys=off;
DROP TABLE "Deckk";
PRAGMA foreign_keys=on;

-- RedefineTables
PRAGMA defer_foreign_keys=ON;
PRAGMA foreign_keys=OFF;
CREATE TABLE "new_Match" (
    "id" INTEGER NOT NULL PRIMARY KEY AUTOINCREMENT,
    "result" BOOLEAN NOT NULL,
    "my_class" TEXT NOT NULL,
    "oppo_class" TEXT NOT NULL,
    "my_deckId" INTEGER NOT NULL,
    "oppo_deckId" INTEGER NOT NULL,
    "playedAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "Match_my_deckId_fkey" FOREIGN KEY ("my_deckId") REFERENCES "Deck" ("id") ON DELETE RESTRICT ON UPDATE CASCADE,
    CONSTRAINT "Match_oppo_deckId_fkey" FOREIGN KEY ("oppo_deckId") REFERENCES "Deck" ("id") ON DELETE RESTRICT ON UPDATE CASCADE
);
INSERT INTO "new_Match" ("id", "playedAt", "result") SELECT "id", "playedAt", "result" FROM "Match";
DROP TABLE "Match";
ALTER TABLE "new_Match" RENAME TO "Match";
PRAGMA foreign_keys=ON;
PRAGMA defer_foreign_keys=OFF;

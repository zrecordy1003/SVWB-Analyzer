/*
  Warnings:

  - You are about to drop the column `ssclass` on the `Deckk` table. All the data in the column will be lost.
  - Added the required column `ssddclass` to the `Deckk` table without a default value. This is not possible if the table is not empty.

*/
-- RedefineTables
PRAGMA defer_foreign_keys=ON;
PRAGMA foreign_keys=OFF;
CREATE TABLE "new_Deckk" (
    "id" INTEGER NOT NULL PRIMARY KEY AUTOINCREMENT,
    "name" TEXT NOT NULL,
    "ssddclass" TEXT NOT NULL,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
);
INSERT INTO "new_Deckk" ("createdAt", "id", "name") SELECT "createdAt", "id", "name" FROM "Deckk";
DROP TABLE "Deckk";
ALTER TABLE "new_Deckk" RENAME TO "Deckk";
PRAGMA foreign_keys=ON;
PRAGMA defer_foreign_keys=OFF;

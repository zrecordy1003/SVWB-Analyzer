-- RedefineTables
PRAGMA defer_foreign_keys=ON;
PRAGMA foreign_keys=OFF;
CREATE TABLE "new_Deck" (
    "id" INTEGER NOT NULL PRIMARY KEY AUTOINCREMENT,
    "name" TEXT NOT NULL,
    "class" TEXT NOT NULL,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME DEFAULT CURRENT_TIMESTAMP,
    "isDefault" BOOLEAN NOT NULL DEFAULT false,
    "categoryId" TEXT,
    CONSTRAINT "Deck_categoryId_fkey" FOREIGN KEY ("categoryId") REFERENCES "DeckCategory" ("id") ON DELETE SET NULL ON UPDATE CASCADE
);
INSERT INTO "new_Deck" ("categoryId", "class", "createdAt", "id", "name", "updatedAt") SELECT "categoryId", "class", "createdAt", "id", "name", "updatedAt" FROM "Deck";
DROP TABLE "Deck";
ALTER TABLE "new_Deck" RENAME TO "Deck";
CREATE INDEX "Deck_categoryId_idx" ON "Deck"("categoryId");
CREATE INDEX "Deck_class_idx" ON "Deck"("class");
PRAGMA foreign_keys=ON;
PRAGMA defer_foreign_keys=OFF;

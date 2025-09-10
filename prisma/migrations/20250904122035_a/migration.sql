-- CreateTable
CREATE TABLE "DeckCategory" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "name" TEXT NOT NULL,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME DEFAULT CURRENT_TIMESTAMP
);

-- CreateTable
CREATE TABLE "Deck" (
    "id" INTEGER NOT NULL PRIMARY KEY AUTOINCREMENT,
    "name" TEXT NOT NULL,
    "class" TEXT NOT NULL,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME DEFAULT CURRENT_TIMESTAMP,
    "categoryId" TEXT,
    CONSTRAINT "Deck_categoryId_fkey" FOREIGN KEY ("categoryId") REFERENCES "DeckCategory" ("id") ON DELETE SET NULL ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "Tag" (
    "id" INTEGER NOT NULL PRIMARY KEY AUTOINCREMENT,
    "name" TEXT NOT NULL,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME DEFAULT CURRENT_TIMESTAMP
);

-- CreateTable
CREATE TABLE "MatchTag" (
    "matchId" INTEGER NOT NULL,
    "tagId" INTEGER NOT NULL,

    PRIMARY KEY ("matchId", "tagId"),
    CONSTRAINT "MatchTag_matchId_fkey" FOREIGN KEY ("matchId") REFERENCES "Match" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "MatchTag_tagId_fkey" FOREIGN KEY ("tagId") REFERENCES "Tag" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "Match" (
    "id" INTEGER NOT NULL PRIMARY KEY AUTOINCREMENT,
    "result" BOOLEAN,
    "play_order" TEXT NOT NULL,
    "my_class" TEXT NOT NULL,
    "oppo_class" TEXT NOT NULL,
    "my_deckId" INTEGER,
    "oppo_deckId" INTEGER,
    "mode" TEXT,
    "bp" INTEGER,
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

-- CreateIndex
CREATE UNIQUE INDEX "DeckCategory_name_key" ON "DeckCategory"("name");

-- CreateIndex
CREATE INDEX "Deck_categoryId_idx" ON "Deck"("categoryId");

-- CreateIndex
CREATE INDEX "Deck_class_idx" ON "Deck"("class");

-- CreateIndex
CREATE UNIQUE INDEX "Tag_name_key" ON "Tag"("name");

-- CreateIndex
CREATE INDEX "MatchTag_tagId_idx" ON "MatchTag"("tagId");

-- CreateIndex
CREATE INDEX "idx_match_playedAt_id" ON "Match"("playedAt", "id");

-- CreateIndex
CREATE INDEX "idx_match_ymd_id" ON "Match"("year", "month", "day", "id");

-- CreateIndex
CREATE INDEX "idx_match_mode" ON "Match"("mode");

-- CreateIndex
CREATE INDEX "idx_match_my_class" ON "Match"("my_class");

-- CreateIndex
CREATE INDEX "idx_match_oppo_class" ON "Match"("oppo_class");

-- CreateIndex
CREATE INDEX "idx_match_ranked_myclass_playedAt" ON "Match"("mode", "my_class", "playedAt");

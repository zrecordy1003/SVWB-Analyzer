-- CreateTable
CREATE TABLE "Deck" (
    "id" INTEGER NOT NULL PRIMARY KEY AUTOINCREMENT,
    "name" TEXT NOT NULL,
    "class" TEXT NOT NULL,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
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
    "year" INTEGER,
    "month" INTEGER,
    "day" INTEGER,
    "playedAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "endedAt" DATETIME,
    CONSTRAINT "Match_my_deckId_fkey" FOREIGN KEY ("my_deckId") REFERENCES "Deck" ("id") ON DELETE SET NULL ON UPDATE CASCADE,
    CONSTRAINT "Match_oppo_deckId_fkey" FOREIGN KEY ("oppo_deckId") REFERENCES "Deck" ("id") ON DELETE SET NULL ON UPDATE CASCADE
);

-- CreateIndex
CREATE INDEX "Match_playedAt_idx" ON "Match"("playedAt");

-- CreateIndex
CREATE INDEX "Match_year_month_day_idx" ON "Match"("year", "month", "day");

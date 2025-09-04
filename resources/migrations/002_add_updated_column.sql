-- DeckCategory
ALTER TABLE "DeckCategory" ADD COLUMN "updatedAt" DATETIME;

-- Deck
ALTER TABLE "Deck" ADD COLUMN "updatedAt" DATETIME;

-- Tag
ALTER TABLE "Tag" ADD COLUMN "updatedAt" DATETIME;

-- Match
ALTER TABLE "Match" ADD COLUMN "updatedAt" DATETIME;

ALTER TABLE "DeckCategory" ADD COLUMN "sort" INTEGER;

UPDATE "DeckCategory" SET sort = 1 WHERE name = '快攻';
UPDATE "DeckCategory" SET sort = 2 WHERE name = '中速';
UPDATE "DeckCategory" SET sort = 3 WHERE name = '控制';

ALTER TABLE "Deck" ADD COLUMN "isDefault" INTEGER NOT NULL DEFAULT 0;
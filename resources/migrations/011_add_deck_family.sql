-- Deck versioning: immutable Deck rows linked by familyId.
--
-- A deck's card list freezes the moment a Match references it; editing a
-- played deck forks a new Deck row instead of overwriting the old one. The
-- generations of one deck share a familyId. See docs/deck-versioning-plan.md.

-- 同一副牌歷代版本的共同 id。新建牌組時等於自己的 id，fork 時繼承來源的值。
-- 統計要「這副牌一路以來」就 GROUP BY 這個，要「這一份卡表」就 GROUP BY id。
ALTER TABLE "Deck" ADD COLUMN "familyId" INTEGER;

-- 封存時間。NULL = 未封存。
-- 有對局引用的牌組不再硬刪，因為在這個模型裡 Deck 那一列就是卡表本身；
-- 硬刪一列有戰績的牌組，等於刪掉那幾十場對局的內容。
ALTER TABLE "Deck" ADD COLUMN "archivedAt" DATETIME;

-- 既有牌組各自成家（真的回填：複製既有資料，不含任何猜測）。
UPDATE "Deck" SET "familyId" = "id" WHERE "familyId" IS NULL;

CREATE INDEX IF NOT EXISTS idx_deck_familyId ON Deck(familyId);

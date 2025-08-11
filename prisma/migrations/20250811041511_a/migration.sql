-- DropIndex
DROP INDEX "Match_year_month_day_idx";

-- DropIndex
DROP INDEX "Match_playedAt_idx";

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

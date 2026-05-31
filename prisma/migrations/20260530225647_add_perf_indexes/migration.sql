-- CreateIndex
CREATE INDEX "idx_match_mydeck_playedAt" ON "Match"("my_deckId", "playedAt");

-- CreateIndex
CREATE INDEX "idx_match_result_mydeck_playedAt" ON "Match"("result", "my_deckId", "playedAt");

-- CreateIndex
CREATE INDEX "idx_match_currentcr_playedAt" ON "Match"("current_cr", "playedAt");

-- CreateIndex
CREATE INDEX "idx_match_mode_playedAt" ON "Match"("mode", "playedAt");

-- Match-list class filters sort by most recent match first.
CREATE INDEX IF NOT EXISTS idx_match_myclass_playedAt_id ON "Match" ("my_class", "playedAt", "id");
CREATE INDEX IF NOT EXISTS idx_match_oppoclass_playedAt_id ON "Match" ("oppo_class", "playedAt", "id");

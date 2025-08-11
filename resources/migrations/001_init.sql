PRAGMA foreign_keys=ON;

CREATE TABLE IF NOT EXISTS Deck (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  name       TEXT NOT NULL,
  class      TEXT NOT NULL,
  createdAt  DATETIME NOT NULL DEFAULT (CURRENT_TIMESTAMP)
);

CREATE TABLE IF NOT EXISTS Match (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  result       INTEGER,
  play_order   TEXT NOT NULL,
  my_class     TEXT NOT NULL,
  oppo_class   TEXT NOT NULL,
  my_deckId    INTEGER,
  oppo_deckId  INTEGER,
  mode         TEXT,
  bp           INTEGER,
  durationTime INTEGER,
  year         INTEGER,
  month        INTEGER,
  day          INTEGER,
  playedAt     DATETIME NOT NULL DEFAULT (CURRENT_TIMESTAMP),
  endedAt      DATETIME,
  FOREIGN KEY(my_deckId)  REFERENCES Deck(id) ON DELETE SET NULL ON UPDATE CASCADE,
  FOREIGN KEY(oppo_deckId) REFERENCES Deck(id) ON DELETE SET NULL ON UPDATE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_match_playedAt_id ON Match(playedAt, id);
CREATE INDEX IF NOT EXISTS idx_match_ymd_id     ON Match(year, month, day, id);
CREATE INDEX IF NOT EXISTS idx_match_mode       ON Match(mode);
CREATE INDEX IF NOT EXISTS idx_match_my_class   ON Match(my_class);
CREATE INDEX IF NOT EXISTS idx_match_oppo_class ON Match(oppo_class);

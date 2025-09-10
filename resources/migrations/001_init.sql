PRAGMA foreign_keys=ON;

-- ---------- DeckCategory ----------
CREATE TABLE IF NOT EXISTS DeckCategory (
  id        TEXT PRIMARY KEY,
  name      TEXT NOT NULL UNIQUE,
  createdAt DATETIME NOT NULL DEFAULT (CURRENT_TIMESTAMP)
);

-- ---------- Deck ----------
CREATE TABLE IF NOT EXISTS Deck (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  name       TEXT NOT NULL,
  class      TEXT NOT NULL,
  createdAt  DATETIME NOT NULL DEFAULT (CURRENT_TIMESTAMP),

  categoryId TEXT,
  FOREIGN KEY(categoryId) REFERENCES DeckCategory(id) ON DELETE SET NULL
);

CREATE INDEX IF NOT EXISTS idx_deck_categoryId ON Deck(categoryId);
CREATE INDEX IF NOT EXISTS idx_deck_class      ON Deck(class);

-- ---------- Tag ----------
CREATE TABLE IF NOT EXISTS Tag (
  id        INTEGER PRIMARY KEY AUTOINCREMENT,
  name      TEXT NOT NULL UNIQUE,
  createdAt DATETIME NOT NULL DEFAULT (CURRENT_TIMESTAMP)
);

-- ---------- Match ----------
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

  note         TEXT, -- 新增的備註欄位

  FOREIGN KEY(my_deckId)   REFERENCES Deck(id) ON DELETE SET NULL ON UPDATE CASCADE,
  FOREIGN KEY(oppo_deckId) REFERENCES Deck(id) ON DELETE SET NULL ON UPDATE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_match_playedAt_id           ON Match(playedAt, id);
CREATE INDEX IF NOT EXISTS idx_match_ymd_id                ON Match(year, month, day, id);
CREATE INDEX IF NOT EXISTS idx_match_mode                  ON Match(mode);
CREATE INDEX IF NOT EXISTS idx_match_my_class              ON Match(my_class);
CREATE INDEX IF NOT EXISTS idx_match_oppo_class            ON Match(oppo_class);
CREATE INDEX IF NOT EXISTS idx_match_ranked_myclass_playedAt ON Match(mode, my_class, playedAt);

-- ---------- MatchTag (many-to-many between Match and Tag) ----------
CREATE TABLE IF NOT EXISTS MatchTag (
  matchId INTEGER NOT NULL,
  tagId   INTEGER NOT NULL,

  PRIMARY KEY (matchId, tagId),

  FOREIGN KEY(matchId) REFERENCES Match(id) ON DELETE CASCADE,
  FOREIGN KEY(tagId)   REFERENCES Tag(id)   ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_matchtag_tagId ON MatchTag(tagId);

INSERT INTO DeckCategory (id, name) VALUES ('aggro', '快攻')
  ON CONFLICT(name) DO NOTHING;

INSERT INTO DeckCategory (id, name) VALUES ('midrange', '中速')
  ON CONFLICT(name) DO NOTHING;

INSERT INTO DeckCategory (id, name) VALUES ('control', '控制')
  ON CONFLICT(name) DO NOTHING;
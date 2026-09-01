-- Deck contents: what a deck actually is, rather than just what it is called.
--
-- Until now a Deck was a label - name, class, category - and nothing more. It
-- could answer "what is this label's win rate" but never "what is this list of
-- 40 cards' win rate". These tables are the missing axis. See
-- docs/deck-import-plan.md.
--
-- Every column added to Deck is NULLABLE. Decks created by hand predate imports
-- and must keep working untouched; NULL here means "not imported", exactly as
-- migration 008 used NULL to mean "provenance unknown".

-- 'code'  imported from a 4-character in-game deck code
-- 'hash'  imported from a share link / long deck hash
-- 'local' built or edited inside this app
-- NULL    created by hand, pre-009
ALTER TABLE "Deck" ADD COLUMN "sourceKind" TEXT;

-- The long deck hash (`1.7.cQnG....`), which has no expiry and can be resolved
-- again at any time. Deliberately NOT the 4-character code: those expire three
-- minutes after issue and are then recycled to somebody else's deck, so one is
-- worthless as an identifier the moment it is stored.
ALTER TABLE "Deck" ADD COLUMN "sourceRef" TEXT;

-- A stable key for "this is the same 40 cards", derived from the card list
-- itself (see `fingerprintDeck` in src/shared/deckImport.ts). This is what
-- duplicate detection compares - not the source code, for the reason above.
ALTER TABLE "Deck" ADD COLUMN "fingerprint" TEXT;

-- 1 rotation / 2 unlimited / 3 infinity / 4 starter, as the portal numbers them.
ALTER TABLE "Deck" ADD COLUMN "battleFormat" INTEGER;

-- The deck's cover card. Stored because writing a deck back out to the game
-- requires it (`key_card_id` in the getDeckHash payload), and re-deriving it
-- after the fact would guess at a choice the user already made.
ALTER TABLE "Deck" ADD COLUMN "keyCardId" INTEGER;

ALTER TABLE "Deck" ADD COLUMN "importedAt" DATETIME;

-- The whole API response as received.
--
-- Not a convenience: a deck imported from a 4-character code CANNOT be fetched
-- again, because the code is dead three minutes after it was issued. Whatever
-- is not captured at import time is gone for good. Keeping the raw payload is
-- what lets a later feature read a field this migration did not think to model,
-- without asking every user to re-import.
ALTER TABLE "Deck" ADD COLUMN "rawJson" TEXT;

CREATE INDEX IF NOT EXISTS idx_deck_fingerprint ON Deck(fingerprint);

-- ---------- DeckCard ----------
-- The deck list itself: one row per distinct card, with how many copies.
-- Cascades on delete because a card list has no meaning without its deck.
CREATE TABLE IF NOT EXISTS DeckCard (
  deckId  INTEGER NOT NULL,
  cardId  INTEGER NOT NULL,
  count   INTEGER NOT NULL,

  PRIMARY KEY (deckId, cardId),

  FOREIGN KEY(deckId) REFERENCES Deck(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_deckcard_cardId ON DeckCard(cardId);

-- ---------- Card ----------
-- Card master data, cached from the portal and shared across decks.
--
-- No foreign key from DeckCard to here on purpose. The deck list is the fact we
-- were given; the card details are a cache of someone else's data that may be
-- absent, stale, or in the wrong language. A missing Card row must degrade to
-- "card 10573310, details unknown", never to a failed import.
--
-- `lang` records which language the text columns were fetched in, because
-- `name` and `skillText` are language-dependent: switching the app's language
-- makes every row here stale in a way `updatedAt` alone cannot express.
CREATE TABLE IF NOT EXISTS Card (
  cardId         INTEGER PRIMARY KEY,
  name           TEXT NOT NULL,
  cost           INTEGER,
  type           INTEGER,
  class          INTEGER,
  rarity         INTEGER,
  atk            INTEGER,
  life           INTEGER,
  skillText      TEXT,
  tribes         TEXT,     -- JSON array, as stored
  deckEnabledNum INTEGER,  -- the portal's own per-card copy limit
  imageHash      TEXT,     -- pairs with the /card/ image path
  bannerHash     TEXT,     -- pairs with the /list/ image path; NOT interchangeable
  isToken        INTEGER NOT NULL DEFAULT 0,
  lang           TEXT NOT NULL,
  updatedAt      DATETIME NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_card_class_cost ON Card(class, cost);

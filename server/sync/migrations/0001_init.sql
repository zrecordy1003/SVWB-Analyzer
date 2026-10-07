-- Sync storage. Applied with `wrangler d1 migrations apply`.
--
-- Timestamps are epoch milliseconds (INTEGER) everywhere.
--
-- Nothing here is, or may become, an install id. The telemetry Worker's
-- `install_id` is a different system whose whole claim is that it cannot be
-- joined to a person; this database is exactly the thing that can. A test
-- (tests/server/sync) fails if either name ever shows up in this schema.
--
-- Write amplification is a design input, not an afterthought: this project's
-- telemetry database once hit D1's free-tier write wall at 91 installs because
-- every upload rewrote a 14-day window. So: `lastSeenAt` is only bumped when it
-- is 10+ minutes stale, an account row is only rewritten when email or name
-- changed, and a segment is one INSERT. D1 bills every INDEX write as a row
-- written too, so there are no secondary indexes: every hot query below is a
-- prefix of a primary key.

-- One row per Google account. The key is Google's `sub`, never the email:
-- an email can be renamed, a `sub` cannot.
CREATE TABLE IF NOT EXISTS accounts (
  sub       TEXT PRIMARY KEY,
  email     TEXT NOT NULL,   -- display only
  name      TEXT,
  createdAt INTEGER NOT NULL,
  -- Sum of every segment and snapshot this account holds in R2. Maintained
  -- with relative updates (`bytesUsed = bytesUsed + ?`), so two concurrent
  -- pushes cannot overwrite each other's arithmetic.
  bytesUsed INTEGER NOT NULL DEFAULT 0
);

-- One row per (account, device). Device ids are made up by the client, so they
-- are only unique WITHIN an account; keying on both means one account can never
-- squat or probe another's ids.
CREATE TABLE IF NOT EXISTS devices (
  sub             TEXT NOT NULL,
  id              TEXT NOT NULL,
  name            TEXT NOT NULL,
  appVersion      TEXT NOT NULL,
  createdAt       INTEGER NOT NULL,
  lastSeenAt      INTEGER NOT NULL,
  lastPushAt      INTEGER,              -- NULL until the first push
  -- Set when a cron fold retires the device; cleared when it signs in again.
  retiredAt       INTEGER,
  -- Set by revoke / logout; cleared when the device signs in again.
  revokedAt       INTEGER,
  -- When the device last came back from retired/revoked. Restarts the 90-day
  -- idle clock; without it a revived device is retired again the next night.
  revivedAt       INTEGER,
  -- SHA-256 (hex) of the current refresh token. Kept on a retired device so it
  -- can be told "retired" rather than a generic refusal; NULLed on revoke.
  refreshHash     TEXT,
  -- The one before it. Presenting it means a token was used twice, i.e. copied.
  prevRefreshHash TEXT,
  maxSeq          INTEGER NOT NULL DEFAULT -1,
  -- Read off the first line of the latest segment/snapshot. The only thing the
  -- server learns about the payload besides the fold keys.
  schemaVersion   INTEGER,
  -- Segments with seq <= snapshotSeq are folded into the snapshot (NULL = none).
  snapshotSeq     INTEGER,
  snapshotBytes   INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (sub, id)
) WITHOUT ROWID;

-- The index of what is in R2, so a sync round lists from D1 (cheap reads)
-- instead of R2 `list` (Class A, the metered operation; account-sync-plan
-- "成本粗算"). `sha256` is what makes PUT idempotent without a second R2 call.
CREATE TABLE IF NOT EXISTS segments (
  sub       TEXT NOT NULL,
  device    TEXT NOT NULL,
  seq       INTEGER NOT NULL,
  bytes     INTEGER NOT NULL,
  sha256    TEXT NOT NULL,
  createdAt INTEGER NOT NULL,
  PRIMARY KEY (sub, device, seq)
) WITHOUT ROWID;

-- Login hand-off between /auth/callback and POST /v1/auth/token. Single use
-- (the row is deleted by the exchange), 5 minutes, bound to the PKCE challenge.
-- Only the SHA-256 of the grant is stored.
CREATE TABLE IF NOT EXISTS grants (
  hash      TEXT PRIMARY KEY,
  sub       TEXT NOT NULL,
  email     TEXT NOT NULL,
  name      TEXT,
  challenge TEXT NOT NULL,
  expiresAt INTEGER NOT NULL
) WITHOUT ROWID;

-- Sync rounds per account per UTC day ("YYYY-MM-DD"). Old days are pruned by
-- the cron.
CREATE TABLE IF NOT EXISTS rounds (
  sub TEXT NOT NULL,
  day TEXT NOT NULL,
  n   INTEGER NOT NULL,
  PRIMARY KEY (sub, day)
) WITHOUT ROWID;

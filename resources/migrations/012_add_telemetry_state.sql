-- State the telemetry uploader must not lose.
--
-- One row per key. Today that is the anonymous install id, and the timestamp
-- and outcome of the last upload. It lives in the database rather than in
-- electron-store's config.json for the reason docs/meta-stats-plan.md D-5
-- gives for the upload watermark: `settings:clear` wipes config.json and the
-- database survives it, and a lost install id means this machine is counted
-- twice from then on.
--
-- Written by the UI process only; the engine never reads or writes it.
CREATE TABLE IF NOT EXISTS "TelemetryState" (
  "key"       TEXT PRIMARY KEY,
  "value"     TEXT NOT NULL,
  "updatedAt" INTEGER NOT NULL
);

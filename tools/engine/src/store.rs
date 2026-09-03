//! Persisting matches: SQLite, owned by the engine.
//!
//! This closes the last gap in "one process owns the perception chain": the
//! machine decides, and the decision lands in the database without crossing a
//! process boundary. The host keeps reading the same file for the UI (WAL lets
//! readers run against a writer), and keeps writing USER edits - deck names,
//! tags, notes.
//!
//! # Who writes what, stated correctly
//!
//! This header used to say the two sides "touch different columns". They do
//! not, and a contract that is wrong is worse than one that is absent, so here
//! is the real division:
//!
//!   - The engine owns every observation column on `Match` - classes, play
//!     order, mode, result, the numbers, the provenance columns.
//!   - The UI owns the user's own data: `note`, the tag join, `Deck` and
//!     everything hanging off it, and `my_deckId` when a person assigns one.
//!   - **Both write `updatedAt`**, and that is deliberate rather than
//!     overlooked: it is what the UI's optimistic lock compares against, so a
//!     write here has to move it or a stale edit would silently win.
//!   - **The engine also clears `my_deckId`** (`clear_my_deck`), which is a
//!     user-edited column. It happens when a mode turns out to be one with no
//!     deck - 2Pick - so the row cannot keep a deck the user picked for a
//!     match that did not have one.
//!
//! Adding a column: `resources/migrations/*.sql` is the source of truth, and
//! it is mirrored here and in `src/main/data/db/client.ts`. Both mirrors are
//! now asserted against the shipped migrations - Rust by the tests below,
//! TypeScript by `tests/main/dbSchemaMirror.test.ts` - so a column that lands
//! on one side only fails a test rather than surfacing as an `undefined` in
//! whichever screen reads it first.
//!
//! # Storage conventions
//!
//! These were established by Prisma, which no longer exists in this project -
//! Kysely replaced it on the UI side. They are kept because a shipped database
//! already holds values in these shapes, not because anything still requires
//! them:
//!
//!   - `DateTime` columns are **epoch milliseconds as INTEGER** (verified
//!     against a real user database, not the Prisma docs).
//!   - `result` is INTEGER 0/1.
//!   - `year`/`month`/`day` are **local** time, matching JS `getFullYear()` -
//!     they exist for date-bucketed queries in the user's own timezone.
//!   - `durationTime` is whole seconds from `playedAt` to the result write.
//!
//! # Migrations move here too (判斷題 D-5)
//!
//! One owner, handed over in one change: the engine applies
//! `resources/migrations/*.sql` and maintains `schema_migrations`; the JS
//! `initDb.ts` logic is deleted in the same commit. Two appliers racing at
//! startup was the failure mode D-5 exists to prevent.

use std::path::Path;

use rusqlite::Connection;

use crate::protocol::{Confidence, GameMode, MatchPatch};
use crate::machine::VersusScreen;

pub struct MatchStore {
    conn: Connection,
}

#[derive(Debug)]
pub struct StoreError(pub String);

impl std::fmt::Display for StoreError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(f, "{}", self.0)
    }
}

impl From<rusqlite::Error> for StoreError {
    fn from(e: rusqlite::Error) -> Self {
        StoreError(e.to_string())
    }
}

fn epoch_ms() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis() as i64)
        .unwrap_or(0)
}

/// The serialised form of a mode - the exact string the column holds.
fn mode_text(mode: GameMode) -> &'static str {
    match mode {
        GameMode::Ranked => "ranked",
        GameMode::Unranked => "unranked",
        GameMode::Cpu => "cpu",
        GameMode::WeekendPlaza => "weekendPlaza",
        GameMode::Custom => "custom",
        GameMode::TwoPick => "twoPick",
        GameMode::Unknown => "unknown",
    }
}

/// The serialised form of a confidence - the exact string the column holds.
fn confidence_text(confidence: Confidence) -> &'static str {
    match confidence {
        Confidence::Weak => "weak",
        Confidence::Strong => "strong",
        Confidence::Authoritative => "authoritative",
    }
}

impl MatchStore {
    pub fn open(path: &Path) -> Result<Self, StoreError> {
        if let Some(parent) = path.parent() {
            std::fs::create_dir_all(parent).map_err(|e| StoreError(e.to_string()))?;
        }
        let conn = Connection::open(path)?;
        // WAL so the UI's readers never block on our writes; busy_timeout so a
        // user edit committing at the same instant retries instead of failing.
        conn.pragma_update(None, "journal_mode", "WAL")?;
        conn.pragma_update(None, "foreign_keys", "ON")?;
        conn.pragma_update(None, "busy_timeout", 5000)?;
        Ok(Self { conn })
    }

    /// Apply every pending `NNN_name.sql`, oldest first, each in its own
    /// transaction. Ported from `initDb.ts`, which this replaces outright.
    pub fn apply_migrations(&mut self, dir: &Path) -> Result<u32, StoreError> {
        self.conn.execute_batch(
            "CREATE TABLE IF NOT EXISTS schema_migrations (
               version     INTEGER PRIMARY KEY,
               name        TEXT,
               applied_at  TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
             );",
        )?;

        let mut applied: Vec<i64> = Vec::new();
        {
            let mut q = self.conn.prepare("SELECT version FROM schema_migrations")?;
            let rows = q.query_map([], |r| r.get(0))?;
            for v in rows {
                applied.push(v?);
            }
        }

        let mut pending: Vec<(i64, String, std::path::PathBuf)> = Vec::new();
        for entry in std::fs::read_dir(dir).map_err(|e| StoreError(e.to_string()))?.flatten() {
            let path = entry.path();
            let Some(name) = path.file_name().and_then(|s| s.to_str()) else { continue };
            // NNN_name.sql, same shape initDb.ts accepted.
            let Some((digits, rest)) = name.split_once('_') else { continue };
            if digits.len() != 3 || !rest.to_ascii_lowercase().ends_with(".sql") {
                continue;
            }
            let Ok(version) = digits.parse::<i64>() else { continue };
            if applied.contains(&version) {
                continue;
            }
            pending.push((version, rest.trim_end_matches(".sql").to_string(), path));
        }
        pending.sort_by_key(|(v, _, _)| *v);

        // Back up before the first schema change, never on a quiet start.
        // Losing a backup must not stop the migration: the backup is insurance,
        // the migration is the product.
        if !pending.is_empty() {
            let _ = back_up_keeping_five(self.conn.path().map(Path::new));
        }

        let count = pending.len() as u32;
        for (version, name, path) in pending {
            let sql = std::fs::read_to_string(&path).map_err(|e| StoreError(e.to_string()))?;
            let tx = self.conn.transaction()?;
            tx.execute_batch(&sql)?;
            tx.execute(
                "INSERT INTO schema_migrations(version, name) VALUES (?1, ?2)",
                rusqlite::params![version, name],
            )?;
            tx.commit()?;
        }
        Ok(count)
    }

    /// Open a match row the moment the battle is recognised.
    ///
    /// Written immediately, not at finalize: the HUD shows the running match,
    /// and a crash mid-battle should leave a row (with a result if the splash
    /// was reached) rather than nothing.
    pub fn insert_match(&self, versus: &VersusScreen, mode: Option<GameMode>) -> Result<i64, StoreError> {
        let now = epoch_ms();
        let (year, month, day) = local_ymd();

        // The player's default deck for this class is pre-filled, as the JS
        // `addMatch` did; 2Pick later clears it via the patch.
        let my_deck: Option<i64> = self
            .conn
            .query_row(
                "SELECT id FROM Deck WHERE class = ?1 AND isDefault = 1 LIMIT 1",
                [format!("{:?}", versus.my_class).to_lowercase()],
                |r| r.get(0),
            )
            .ok();

        // `source` is written explicitly rather than left to a column default:
        // the default has to stay NULL so that rows predating the provenance
        // migration keep saying "unknown" instead of claiming to be ours.
        self.conn.execute(
            "INSERT INTO Match (result, play_order, my_class, oppo_class, my_deckId,
                                mode, year, month, day, playedAt, updatedAt,
                                source, engine_version)
             VALUES (NULL, ?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?9, 'engine', ?10)",
            rusqlite::params![
                format!("{:?}", versus.play_order).to_lowercase(),
                format!("{:?}", versus.my_class).to_lowercase(),
                format!("{:?}", versus.oppo_class).to_lowercase(),
                my_deck,
                mode.map(mode_text),
                year,
                month,
                day,
                now,
                env!("CARGO_PKG_VERSION"),
            ],
        )?;
        Ok(self.conn.last_insert_rowid())
    }

    /// Fold a patch into the row. Absent fields are untouched, never cleared.
    ///
    /// One transaction, because one patch is one fact about the match. A result
    /// arrives with its BP, and up to eight statements below write them; a crash
    /// between two of them used to leave a half-applied patch on disk - a
    /// recorded match whose result says one thing and whose numbers were never
    /// written. `unchecked_transaction` rather than `transaction` so the method
    /// keeps taking `&self`: the alternative is `&mut` all the way up through
    /// `live::persist` and `LiveOptions`, which buys nothing here - one process
    /// owns this connection.
    pub fn update_match(&self, id: i64, patch: &MatchPatch) -> Result<(), StoreError> {
        let now = epoch_ms();
        let tx = self.conn.unchecked_transaction()?;

        if patch.clear_my_deck == Some(true) {
            self.conn.execute(
                "UPDATE Match SET my_deckId = NULL, updatedAt = ?2 WHERE id = ?1",
                rusqlite::params![id, now],
            )?;
        }
        if let Some(mode) = patch.mode {
            // The confidence rides with the mode in one statement, so a crash
            // between two writes cannot leave the row claiming one signal's
            // mode with another signal's confidence.
            self.conn.execute(
                "UPDATE Match SET mode = ?2, mode_confidence = ?3, updatedAt = ?4
                 WHERE id = ?1",
                rusqlite::params![
                    id,
                    mode_text(mode),
                    patch.mode_confidence.map(confidence_text),
                    now
                ],
            )?;
        }
        if let Some(flags) = &patch.recog_flags {
            self.append_recog_flags(id, flags, now)?;
        }
        if let Some(result) = patch.result {
            // The result carries the end of the battle with it, as the JS
            // version did: endedAt is this write, duration is whole seconds
            // since the row was opened.
            self.conn.execute(
                "UPDATE Match SET result = ?2, endedAt = ?3,
                        durationTime = CAST((?3 - playedAt) / 1000 AS INTEGER),
                        updatedAt = ?3
                 WHERE id = ?1",
                rusqlite::params![id, result as i64, now],
            )?;
        }
        for (column, value) in [
            ("bp", patch.bp),
            ("mp", patch.mp),
            ("delta_mp", patch.delta_mp),
            ("current_cr", patch.current_cr),
            ("delta_cr", patch.delta_cr),
        ] {
            if let Some(v) = value {
                self.conn.execute(
                    &format!("UPDATE Match SET {column} = ?2, updatedAt = ?3 WHERE id = ?1"),
                    rusqlite::params![id, v, now],
                )?;
            }
        }
        tx.commit()?;
        Ok(())
    }

    /// Union the flags into whatever the row already holds.
    ///
    /// Read-modify-write rather than an overwrite: a mid-match patch carries
    /// only the flags raised so far, and the row may already hold one from an
    /// earlier patch. A union is also idempotent, which matters because the
    /// machine re-sends its accumulated set when the match closes.
    fn append_recog_flags(&self, id: i64, flags: &[String], now: i64) -> Result<(), StoreError> {
        if flags.is_empty() {
            return Ok(());
        }
        let held: Option<String> = self
            .conn
            .query_row("SELECT recog_flags FROM Match WHERE id = ?1", [id], |r| r.get(0))
            .unwrap_or(None);
        let mut merged: Vec<String> = held
            .as_deref()
            .and_then(|raw| serde_json::from_str::<Vec<String>>(raw).ok())
            .unwrap_or_default();
        for flag in flags {
            if !merged.iter().any(|held| held == flag) {
                merged.push(flag.clone());
            }
        }
        let encoded = serde_json::to_string(&merged).map_err(|e| StoreError(e.to_string()))?;
        self.conn.execute(
            "UPDATE Match SET recog_flags = ?2, updatedAt = ?3 WHERE id = ?1",
            rusqlite::params![id, encoded, now],
        )?;
        Ok(())
    }

    /// Remove a row the analyzer decided must not exist - a replay started over
    /// an open match. Deleting, not blanking: a blanked row is a recorded match
    /// with missing fields, which is exactly the wrong outcome.
    pub fn delete_match(&self, id: i64) -> Result<(), StoreError> {
        self.conn.execute("DELETE FROM Match WHERE id = ?1", [id])?;
        Ok(())
    }
}

/// `year/month/day` in local time, as JS `getFullYear()` et al. produced them.
fn local_ymd() -> (i32, u32, u32) {
    use chrono::Datelike;
    let now = chrono::Local::now();
    (now.year(), now.month(), now.day())
}

/// Copy the db aside and keep the five newest backups, as `initDb.ts` did.
fn back_up_keeping_five(db: Option<&Path>) -> std::io::Result<()> {
    let Some(db) = db.filter(|p| p.exists()) else { return Ok(()) };
    let Some(dir) = db.parent() else { return Ok(()) };
    let Some(stem) = db.file_stem().and_then(|s| s.to_str()) else { return Ok(()) };

    let stamp = epoch_ms();
    std::fs::copy(db, dir.join(format!("{stem}.{stamp}.bak.db")))?;

    let mut backups: Vec<_> = std::fs::read_dir(dir)?
        .flatten()
        .map(|e| e.path())
        .filter(|p| {
            p.file_name()
                .and_then(|n| n.to_str())
                .is_some_and(|n| n.starts_with(&format!("{stem}.")) && n.ends_with(".bak.db"))
        })
        .collect();
    backups.sort();
    for stale in backups.iter().take(backups.len().saturating_sub(5)) {
        let _ = std::fs::remove_file(stale);
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::protocol::{ClassName, PlayOrder};

    fn store_with_schema() -> MatchStore {
        let mut store = MatchStore {
            conn: Connection::open_in_memory().expect("in-memory db"),
        };
        let migrations = Path::new(env!("CARGO_MANIFEST_DIR")).join("../../resources/migrations");
        let applied = store.apply_migrations(&migrations).expect("shipped migrations apply");
        assert!(applied >= 7, "the shipped migration set should apply in full");
        store
    }

    fn versus() -> VersusScreen {
        VersusScreen {
            my_class: ClassName::Witch,
            oppo_class: ClassName::Bishop,
            play_order: PlayOrder::Second,
        }
    }

    /// The UI still reads through Prisma, so the formats must match what a real
    /// user database holds: epoch-millisecond integers, 0/1 results, lowercase
    /// enum strings.
    #[test]
    fn rows_match_the_prisma_formats() {
        let store = store_with_schema();
        let id = store.insert_match(&versus(), Some(GameMode::Cpu)).unwrap();

        let (played_type, play_order, my_class, mode): (String, String, String, String) = store
            .conn
            .query_row(
                "SELECT typeof(playedAt), play_order, my_class, mode FROM Match WHERE id = ?1",
                [id],
                |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?, r.get(3)?)),
            )
            .unwrap();
        assert_eq!(played_type, "integer", "Prisma DateTime is epoch ms, not text");
        assert_eq!(play_order, "second");
        assert_eq!(my_class, "witch");
        assert_eq!(mode, "cpu");
    }

    /// The result write carries endedAt and durationTime with it, as the JS
    /// `modifyMatchResult` did - the HUD and the list both read them.
    #[test]
    fn a_result_carries_the_end_of_the_battle() {
        let store = store_with_schema();
        let id = store.insert_match(&versus(), None).unwrap();
        store
            .update_match(id, &MatchPatch { result: Some(false), ..Default::default() })
            .unwrap();

        let (result, ended, duration): (i64, Option<i64>, Option<i64>) = store
            .conn
            .query_row(
                "SELECT result, endedAt, durationTime FROM Match WHERE id = ?1",
                [id],
                |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?)),
            )
            .unwrap();
        assert_eq!(result, 0, "false is 0, not NULL");
        assert!(ended.is_some());
        assert_eq!(duration, Some(0), "opened and closed within a second");
    }

    /// Absent patch fields must leave columns untouched - `None` means "not
    /// resolved by this patch", never "clear it".
    #[test]
    fn an_absent_field_is_not_a_clear() {
        let store = store_with_schema();
        let id = store.insert_match(&versus(), None).unwrap();
        store.update_match(id, &MatchPatch { bp: Some(8), ..Default::default() }).unwrap();
        store
            .update_match(id, &MatchPatch { mode: Some(GameMode::Ranked), ..Default::default() })
            .unwrap();

        let bp: Option<i64> = store
            .conn
            .query_row("SELECT bp FROM Match WHERE id = ?1", [id], |r| r.get(0))
            .unwrap();
        assert_eq!(bp, Some(8), "a later patch without bp must not erase it");
    }

    /// Abandoning deletes the row outright. A blanked row would be a phantom
    /// match in the history, skewing every statistic that counts rows.
    #[test]
    fn an_abandoned_match_leaves_no_row() {
        let store = store_with_schema();
        let id = store.insert_match(&versus(), None).unwrap();
        store.delete_match(id).unwrap();
        let count: i64 = store
            .conn
            .query_row("SELECT COUNT(*) FROM Match WHERE id = ?1", [id], |r| r.get(0))
            .unwrap();
        assert_eq!(count, 0);
    }

    /// A row the engine wrote says so, and says which build wrote it. `source`
    /// has to be written explicitly - the column default stays NULL so that
    /// pre-provenance rows keep admitting their provenance is unknown.
    #[test]
    fn an_inserted_row_carries_its_provenance() {
        let store = store_with_schema();
        let id = store.insert_match(&versus(), Some(GameMode::Cpu)).unwrap();

        let (source, version): (Option<String>, Option<String>) = store
            .conn
            .query_row("SELECT source, engine_version FROM Match WHERE id = ?1", [id], |r| {
                Ok((r.get(0)?, r.get(1)?))
            })
            .unwrap();
        assert_eq!(source.as_deref(), Some("engine"));
        assert_eq!(version.as_deref(), Some(env!("CARGO_PKG_VERSION")));
    }

    /// The engine never writes the columns the UI owns. `edited_fields` is the
    /// UI's record of what a person changed; an engine write to it would make
    /// every statistic that reads it meaningless.
    #[test]
    fn the_engine_never_writes_the_ui_owned_columns() {
        let store = store_with_schema();
        let id = store.insert_match(&versus(), None).unwrap();
        store
            .update_match(
                id,
                &MatchPatch {
                    mode: Some(GameMode::Ranked),
                    mode_confidence: Some(Confidence::Strong),
                    result: Some(true),
                    bp: Some(8),
                    recog_flags: Some(vec!["mode-corrected".into()]),
                    ..Default::default()
                },
            )
            .unwrap();

        let (observed, edited): (Option<String>, Option<String>) = store
            .conn
            .query_row("SELECT observed, edited_fields FROM Match WHERE id = ?1", [id], |r| {
                Ok((r.get(0)?, r.get(1)?))
            })
            .unwrap();
        assert_eq!(observed, None, "`observed` belongs to the UI's overlay");
        assert_eq!(edited, None, "`edited_fields` belongs to the UI's overlay");
    }

    /// The confidence is written by the same statement as the mode it justifies,
    /// and a correction replaces both.
    #[test]
    fn a_mode_correction_replaces_its_confidence_too() {
        let store = store_with_schema();
        let id = store.insert_match(&versus(), None).unwrap();
        store
            .update_match(
                id,
                &MatchPatch {
                    mode: Some(GameMode::WeekendPlaza),
                    mode_confidence: Some(Confidence::Weak),
                    ..Default::default()
                },
            )
            .unwrap();
        store
            .update_match(
                id,
                &MatchPatch {
                    mode: Some(GameMode::Ranked),
                    mode_confidence: Some(Confidence::Strong),
                    ..Default::default()
                },
            )
            .unwrap();

        let (mode, confidence): (String, String) = store
            .conn
            .query_row("SELECT mode, mode_confidence FROM Match WHERE id = ?1", [id], |r| {
                Ok((r.get(0)?, r.get(1)?))
            })
            .unwrap();
        assert_eq!(mode, "ranked");
        assert_eq!(confidence, "strong", "a stale confidence would outrank its own mode");
    }

    /// Flags accumulate across patches and never duplicate - the machine re-sends
    /// its whole accumulated set when the match closes.
    #[test]
    fn recognition_flags_union_rather_than_overwrite() {
        let store = store_with_schema();
        let id = store.insert_match(&versus(), None).unwrap();
        store
            .update_match(
                id,
                &MatchPatch {
                    recog_flags: Some(vec!["weak-mode-accepted".into()]),
                    ..Default::default()
                },
            )
            .unwrap();
        store
            .update_match(
                id,
                &MatchPatch {
                    recog_flags: Some(vec![
                        "weak-mode-accepted".into(),
                        "ranked-no-numbers".into(),
                    ]),
                    ..Default::default()
                },
            )
            .unwrap();

        let raw: String = store
            .conn
            .query_row("SELECT recog_flags FROM Match WHERE id = ?1", [id], |r| r.get(0))
            .unwrap();
        let flags: Vec<String> = serde_json::from_str(&raw).unwrap();
        assert_eq!(flags, vec!["weak-mode-accepted", "ranked-no-numbers"]);
    }

    /// One patch is one fact, so a patch that fails part-way must leave no part
    /// of itself behind. Provoked with a mode the column's own CHECK cannot
    /// reject - instead the row is removed under the write, so the later
    /// statements in the same patch have nothing to hit and the earlier ones
    /// must roll back with them.
    #[test]
    fn a_patch_that_fails_part_way_leaves_nothing_behind() {
        let store = store_with_schema();
        let id = store.insert_match(&versus(), None).unwrap();
        store.update_match(id, &MatchPatch { bp: Some(3), ..Default::default() }).unwrap();

        // A trigger that refuses the second statement of the patch below.
        store
            .conn
            .execute_batch(
                "CREATE TRIGGER refuse_result BEFORE UPDATE OF result ON Match
                 BEGIN SELECT RAISE(ABORT, 'no'); END;",
            )
            .unwrap();

        let outcome = store.update_match(
            id,
            &MatchPatch {
                mode: Some(GameMode::Ranked),
                mode_confidence: Some(Confidence::Strong),
                result: Some(true),
                bp: Some(9),
                ..Default::default()
            },
        );
        assert!(outcome.is_err(), "the refused statement must surface as an error");

        let (mode, bp): (Option<String>, Option<i64>) = store
            .conn
            .query_row("SELECT mode, bp FROM Match WHERE id = ?1", [id], |r| {
                Ok((r.get(0)?, r.get(1)?))
            })
            .unwrap();
        assert_eq!(mode, None, "the mode written before the failure must roll back");
        assert_eq!(bp, Some(3), "and the row must still hold what it held before the patch");
    }

    /// Migrations are idempotent: a second pass applies nothing.
    #[test]
    fn migrations_apply_once() {
        let mut store = store_with_schema();
        let migrations = Path::new(env!("CARGO_MANIFEST_DIR")).join("../../resources/migrations");
        assert_eq!(store.apply_migrations(&migrations).unwrap(), 0);
    }
}

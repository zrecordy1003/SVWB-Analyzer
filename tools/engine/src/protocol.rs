//! The wire contract between the engine and its host (Electron main).
//!
//! One JSON object per line, events on stdout and commands on stdin. The event
//! rate is single digits per second, so serialisation cost is irrelevant and
//! being able to `> log.jsonl` a session, or read one in a text editor, is worth
//! more than any binary format would buy.
//!
//! Nothing in this module may depend on Electron, on a database handle, or on
//! the capture backend. It is the seam that lets `svwb-engine replay` exercise
//! the real state machine with no host at all.

use serde::{Deserialize, Serialize};

// ---------------------------------------------------------------- domain enums

/// Mirrors the `ClassName` values stored in SQLite. The serialised form is the
/// exact string the `Match.my_class` / `oppo_class` columns already hold, so a
/// value can cross the wire and land in the column unchanged.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum ClassName {
    Elf,
    Royal,
    Witch,
    Dragon,
    Bishop,
    Nightmare,
    Nemesis,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum PlayOrder {
    First,
    Second,
}

/// Mirrors the `GameMode` values stored in SQLite.
///
/// `Unknown` is deliberately distinct from `Unranked`: a mode we failed to
/// recognise must not be silently folded into the free-play statistics. See the
/// comment on the same enum in `prisma/schema.prisma`.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum GameMode {
    Ranked,
    Unranked,
    Cpu,
    WeekendPlaza,
    Custom,
    TwoPick,
    Unknown,
}

/// How much a mode signal can be trusted, and therefore whether it may overwrite
/// one already recorded. Ported from `MODE_CONFIDENCE` in
/// `src/main/recognition/forkedImageAnalyzer.ts`.
///
/// Ordering is the whole point, so this derives `Ord` rather than carrying a
/// hand-written lookup table: a weak signal may never overwrite an
/// authoritative one, and the type system now says so.
#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum Confidence {
    /// Broad, uncalibrated search with no verified positive sample.
    Weak,
    /// Calibrated window, requires two consecutive frames.
    Strong,
    /// Read off the result screen, verified 1.000 on its own layout.
    Authoritative,
}

// -------------------------------------------------------------------- match ref

/// Engine-assigned handle for one match, unique within a run.
///
/// **This is not a database id.** Until the engine owns persistence (plan P4)
/// the host creates the row and holds the `MatchRef -> Match.id` mapping. The
/// engine must never learn the database id, or the state machine becomes
/// untestable without a database - which is the defect this whole plan exists
/// to remove. When P4 lands the mapping collapses, not this type.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(transparent)]
pub struct MatchRef(pub u64);

// ------------------------------------------------------------------ match patch

/// Fields the engine has newly resolved for a match.
///
/// Every event that reports progress carries the values themselves, never just
/// "something changed, go and re-query". The old `postMessage({type:
/// 'modifyMode'})` fired 13 times per match as a bare refetch signal; once
/// number writes are batched (plan D-1) such a signal would race its own write
/// and the renderer would read back the previous value. Carrying the value
/// removes the race and the 13 round trips together.
///
/// `None` means "not resolved on this event", never "cleared".
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MatchPatch {
    #[serde(skip_serializing_if = "Option::is_none")]
    pub mode: Option<GameMode>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub result: Option<bool>,
    /// Below Grand Master: BP gained this match. Mutually exclusive with the
    /// MP/CR block - a match carries one scoring system or the other, never both.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub bp: Option<i32>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub mp: Option<i32>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub delta_mp: Option<i32>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub current_cr: Option<i32>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub delta_cr: Option<i32>,
    /// 2Pick brings its own deck, so the pre-filled default deck must be cleared.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub clear_my_deck: Option<bool>,
    /// How much the `mode` in this patch can be trusted.
    ///
    /// Always carried WITH a mode, never on its own, so a correction replaces
    /// the confidence along with the value it justified. Recorded for later
    /// analysis, not used as a trust gate - see the note on [`Confidence`].
    #[serde(skip_serializing_if = "Option::is_none")]
    pub mode_confidence: Option<Confidence>,
    /// Diagnostics this match raised about itself, by kind.
    ///
    /// The same facts already reach the host as [`Change::Noted`], but a note
    /// carries no match reference - it says "the plaza probe fired", never "it
    /// fired on this match". Riding along the patch is what ties the two
    /// together, and it reuses a path that already ends in the row.
    ///
    /// [`Change::Noted`]: crate::machine::Change::Noted
    #[serde(skip_serializing_if = "Option::is_none")]
    pub recog_flags: Option<Vec<String>>,
}

impl MatchPatch {
    pub fn is_empty(&self) -> bool {
        *self == Self::default()
    }
}

// ---------------------------------------------------------------- battle status

/// What the HUD shows while a battle is on screen.
///
/// Note the vocabulary shift against [`Event::MatchStarted`]: this carries
/// `ownClass` / `enemyClass` while a match carries `myClass` / `oppoClass`. That
/// is not an oversight. The renderer already consumes the former and the `Match`
/// columns already store the latter; unifying them would mean editing the
/// renderer, which this refactor deliberately leaves alone. One of the two names
/// has to survive on each side of the wire, so each side keeps the one it has.
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct BattleStatus {
    pub in_battle: bool,
    pub own_class: Option<ClassName>,
    pub enemy_class: Option<ClassName>,
    pub play_order: Option<PlayOrder>,
    /// The mode of the battle in progress, as soon as anything knows it.
    ///
    /// `None` while it is still open, which is a real state and not a gap: a
    /// ranked match has no mode evidence at all until its result screen. 2Pick
    /// and CPU do better - both are labelled before the first card is played -
    /// and this field exists so the host learns that at the same moment the
    /// engine does, rather than at the end of the match.
    pub mode: Option<GameMode>,
}

// ----------------------------------------------------------------------- events

/// Engine -> host. One per line on stdout.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(tag = "event", rename_all = "camelCase", rename_all_fields = "camelCase")]
pub enum Event {
    /// Templates loaded, first frame not yet processed.
    Ready {
        version: String,
        templates_loaded: u32,
    },

    /// A new match began. The host is expected to create the row and remember
    /// the `MatchRef -> id` mapping (see [`MatchRef`]).
    MatchStarted {
        r#ref: MatchRef,
        my_class: ClassName,
        oppo_class: ClassName,
        play_order: PlayOrder,
        /// A pre-battle CPU label may already have decided the mode.
        #[serde(skip_serializing_if = "Option::is_none")]
        mode: Option<GameMode>,
    },

    /// Fields resolved mid-match. May fire several times per match.
    MatchUpdated { r#ref: MatchRef, patch: MatchPatch },

    /// The match is closed. No further events carry this `ref`.
    ///
    /// `patch` repeats every field the engine holds, not just the ones resolved
    /// on this tick, so a host that missed an earlier event still converges.
    MatchFinished { r#ref: MatchRef, patch: MatchPatch },

    /// An open match was discarded, not finished.
    ///
    /// The host must DELETE the row it created for this `ref`, never write it as
    /// a result. A replay shows the same versus screen, play-order overlay and
    /// battlefield as a real match, so whatever was open when one started cannot
    /// be trusted - and a row written with an empty patch is a recorded match
    /// with missing fields, which is exactly the wrong outcome.
    MatchAbandoned { r#ref: MatchRef },

    /// HUD state. Fires on change only, not every tick.
    StatusChanged(BattleStatus),

    /// A replay is on screen and nothing may be recorded.
    ReplaySuppressionChanged { suppressed: bool },

    /// Something worth keeping pixels or a counter for. Mirrors the existing
    /// `diagnosticsRecorder` surface.
    Diagnostic {
        kind: String,
        label: String,
        #[serde(skip_serializing_if = "Option::is_none")]
        detail: Option<serde_json::Value>,
    },

    /// Ask the host to read one number out of a binarised crop.
    ///
    /// The only event that expects an answer: the host replies with
    /// `{"numberRead":true,"id":<id>,"text":<string|null>}` on stdin. `text` is
    /// null when it could not be read - unreadable, never "absent for good", so
    /// the engine retries on the next frame.
    ///
    /// `png` is base64. A crop is a few hundred bytes, so this costs nothing
    /// next to sending the whole canvas or writing it to disk.
    ReadNumber { id: u64, png: String },

    /// Capture began or ended, with proof of flow.
    ///
    /// `frames_seen` is how many frames the analyzer actually consumed in the
    /// session that just ended (0 while attaching). It exists because "attached
    /// but no frames" and "no game on screen" are indistinguishable from the
    /// outside, and that ambiguity is exactly what a user's "my match wasn't
    /// recorded" report needs resolved.
    CaptureChanged { attached: bool, frames_seen: u64 },

    /// The first decoded frame after an attach reached the analyzer.
    ///
    /// A successful WGC attach only proves that Windows accepted the target;
    /// this event is the positive proof that pixels actually crossed the
    /// capture boundary. The dimensions are the source image before the
    /// normalisation to the fixed 1280x720 recognition canvas.
    CaptureFrameReceived { width: u32, height: u32 },

    /// Windows Graphics Capture refused the requested target.
    ///
    /// Kept separate from a general recoverable `Failed` event so the host can
    /// make the capture indicator truthful without guessing from an error
    /// message.
    CaptureAttachFailed { hwnd: u64, message: String },

    /// A score that came close to its threshold without clearing it.
    ///
    /// Silent unless inside the near-miss band, so this is safe to emit every
    /// tick. Aggregated on the host: it can fire continuously, and what matters
    /// is how often and how bad, not each occurrence.
    NearMiss { label: String, score: f64, threshold: f64 },

    /// Emitted only when a tick misses its budget; a healthy run is silent.
    SlowTick { elapsed_ms: u64, budget_ms: u64 },

    /// Recoverable unless `fatal`, in which case the process is exiting.
    Failed { message: String, fatal: bool },
}

// --------------------------------------------------------------------- commands

/// Host -> engine. One per line on stdin.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(tag = "command", rename_all = "camelCase", rename_all_fields = "camelCase")]
pub enum Command {
    /// Begin processing frames.
    Start,
    /// Stop processing and exit cleanly.
    Stop,
    /// Point capture at a verified game window. The host owns window
    /// detection (node-window-manager is an Electron binding); the engine owns
    /// everything after the HWND. Idempotent: attaching to the current target
    /// is a no-op, attaching to a new one replaces it.
    Attach { hwnd: u64 },
    /// Stop capturing but keep running. The host sends this when the game
    /// minimises - WGC cannot capture a minimised window - and re-attaches on
    /// restore.
    Detach,
    /// Applied at any time; unset fields keep their current value.
    Configure {
        #[serde(skip_serializing_if = "Option::is_none")]
        diagnostics_enabled: Option<bool>,
    },
}

#[cfg(test)]
mod tests {
    use super::*;

    /// The serialised forms are the strings already stored in SQLite. If these
    /// drift, existing rows stop round-tripping. The awkward values are
    /// `weekendPlaza` and `twoPick`: they are camelCase in the column while
    /// every ClassName is a single lowercase word.
    #[test]
    fn domain_enums_serialise_to_the_stored_strings() {
        assert_eq!(serde_json::to_string(&ClassName::Nightmare).unwrap(), "\"nightmare\"");
        assert_eq!(serde_json::to_string(&PlayOrder::Second).unwrap(), "\"second\"");
        assert_eq!(serde_json::to_string(&GameMode::WeekendPlaza).unwrap(), "\"weekendPlaza\"");
        assert_eq!(serde_json::to_string(&GameMode::TwoPick).unwrap(), "\"twoPick\"");
        assert_eq!(serde_json::to_string(&GameMode::Unknown).unwrap(), "\"unknown\"");
    }

    #[test]
    fn capture_observability_events_use_the_host_protocol_shape() {
        assert_eq!(
            serde_json::to_value(Event::CaptureFrameReceived { width: 1920, height: 1080 })
                .unwrap(),
            serde_json::json!({
                "event": "captureFrameReceived",
                "width": 1920,
                "height": 1080
            })
        );
        assert_eq!(
            serde_json::to_value(Event::CaptureAttachFailed {
                hwnd: 42,
                message: "access denied".into(),
            })
            .unwrap(),
            serde_json::json!({
                "event": "captureAttachFailed",
                "hwnd": 42,
                "message": "access denied"
            })
        );
    }

    /// An empty patch must not serialise into a wall of nulls; the host reads
    /// "absent" as "not resolved", and a null would be indistinguishable from a
    /// deliberate clear.
    #[test]
    fn absent_patch_fields_are_omitted_not_nulled() {
        let mut patch = MatchPatch::default();
        assert_eq!(serde_json::to_string(&patch).unwrap(), "{}");
        patch.bp = Some(124);
        assert_eq!(serde_json::to_string(&patch).unwrap(), "{\"bp\":124}");
    }

    /// Multi-word fields must reach the host as camelCase.
    ///
    /// Regression test: `rename_all` on an enum renames its VARIANTS, not the
    /// fields inside them, so this file originally shipped `templates_loaded`
    /// and `diagnostics_enabled` over the wire. Only `rename_all_fields`
    /// reaches struct-variant fields. Every field here is deliberately
    /// multi-word - a single-word field cannot catch this.
    #[test]
    fn struct_variant_fields_are_camel_cased() {
        let line = serde_json::to_string(&Event::Ready {
            version: "0.1.0".into(),
            templates_loaded: 42,
        })
        .unwrap();
        assert_eq!(line, "{\"event\":\"ready\",\"version\":\"0.1.0\",\"templatesLoaded\":42}");

        let line = serde_json::to_string(&Event::SlowTick { elapsed_ms: 612, budget_ms: 500 }).unwrap();
        assert_eq!(line, "{\"event\":\"slowTick\",\"elapsedMs\":612,\"budgetMs\":500}");
    }

    /// The tag lives beside the payload, so a host can switch on one field
    /// without a nested match on shape.
    #[test]
    fn events_are_internally_tagged() {
        let line = serde_json::to_string(&Event::MatchUpdated {
            r#ref: MatchRef(7),
            patch: MatchPatch { bp: Some(124), ..Default::default() },
        })
        .unwrap();
        assert_eq!(line, "{\"event\":\"matchUpdated\",\"ref\":7,\"patch\":{\"bp\":124}}");
    }

    /// The HUD reads this shape verbatim (`engine.ts` case 'statusChanged' ->
    /// `battle:status` broadcast -> HudApp). A newtype variant in an
    /// internally-tagged enum flattens its struct - if that ever changes, the
    /// HUD goes blank mid-battle with no error anywhere.
    #[test]
    fn status_changed_flattens_into_the_hud_shape() {
        let line = serde_json::to_string(&Event::StatusChanged(BattleStatus {
            in_battle: true,
            own_class: Some(ClassName::Witch),
            enemy_class: Some(ClassName::Royal),
            play_order: Some(PlayOrder::First),
            mode: Some(GameMode::TwoPick),
        }))
        .unwrap();
        assert_eq!(
            line,
            "{\"event\":\"statusChanged\",\"inBattle\":true,\"ownClass\":\"witch\",\"enemyClass\":\"royal\",\"playOrder\":\"first\",\"mode\":\"twoPick\"}"
        );
    }

    /// An unresolved mode must reach the host as an explicit `null`, not as an
    /// absent key. The HUD distinguishes "this match is 2Pick" from "nothing
    /// knows yet", and the second one is what tells it to fall back to the last
    /// recorded match instead of holding a stale filter.
    #[test]
    fn an_unresolved_mode_is_sent_as_null() {
        let line = serde_json::to_string(&Event::StatusChanged(BattleStatus {
            in_battle: true,
            own_class: Some(ClassName::Witch),
            enemy_class: Some(ClassName::Royal),
            play_order: Some(PlayOrder::First),
            mode: None,
        }))
        .unwrap();
        assert!(line.contains("\"mode\":null"), "{line}");
    }

    #[test]
    fn commands_round_trip() {
        let line = "{\"command\":\"configure\",\"diagnosticsEnabled\":false}";
        match serde_json::from_str::<Command>(line).unwrap() {
            Command::Configure { diagnostics_enabled } => {
                assert_eq!(diagnostics_enabled, Some(false))
            }
            other => panic!("parsed as {other:?}"),
        }
    }

    #[test]
    fn confidence_orders_weak_below_authoritative() {
        assert!(Confidence::Weak < Confidence::Strong);
        assert!(Confidence::Strong < Confidence::Authoritative);
    }
}

//! The state machine's vocabulary: what a tick observed, and what it decided.
//!
//! The whole point of this module is that deciding is a PURE function of
//! (phase, reading, now). No image, no database, no message port. That is what
//! lets the incident history buried in `forkedImageAnalyzer.ts`'s comments
//! become `#[test]`s - most of those incidents are about timing and ordering,
//! and reproducing them needed a recording only because the decision logic could
//! not be reached any other way. A [`Reading`] can be written by hand in three
//! lines.
//!
//! # Observing and acting are separated on purpose
//!
//! [`Reading`] carries what the probes saw, thresholded but otherwise
//! unjudged. Whether a given observation may be ACTED ON is the machine's
//! decision, and depends on the phase.
//!
//! This is not a stylistic split. In the JS analyzer the two were the same
//! thing: a probe ran where it was allowed to matter, so "only trust the plaza
//! label on the result screen" was encoded as the physical position of the
//! `match()` call inside a nested `if`. That is how `plazaDetect` came to be
//! read in a branch that never assigned it, and it is why the plaza probe used
//! to run every tick of a battle and record a ranked match as `weekendPlaza`.
//! Here every probe runs every tick - they are calibrated and cheap now - and
//! the rule "plaza is a result-screen signal" is a phase check that can be
//! stated, tested, and found.

mod tick;

#[cfg(test)]
mod scenarios;

use crate::accumulate::{Agreement, Consensus, Debounce};
use crate::calibration::{self, ScoreSystemHit};
use crate::phase::Phase;
use crate::protocol::{ClassName, Confidence, GameMode, MatchPatch, MatchRef, PlayOrder};
use crate::templates::Hit;

// ------------------------------------------------------------------- observing

/// The versus screen, read as a whole.
///
/// One value rather than three fields because a match may only start when all
/// three are present: `:883` required `myValid && oppoValid && turnValid`, and
/// `:900`-ish then threw if any of the three names came back null. A type that
/// cannot hold two of three removes the second check.
#[derive(Debug, Clone, Copy, PartialEq, Eq, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct VersusScreen {
    pub my_class: ClassName,
    pub oppo_class: ClassName,
    pub play_order: PlayOrder,
}

/// A weak signal that needs a position, not just a score.
///
/// A UI label is pixel-stable on the normalised canvas; drifting card text is
/// not. Carrying the position is what lets the machine require stability across
/// ticks instead of accepting a single frame.
#[derive(Debug, Clone, Copy, PartialEq, Eq, serde::Serialize)]
pub struct Located {
    pub x: u32,
    pub y: u32,
}

impl From<&Hit> for Located {
    fn from(hit: &Hit) -> Self {
        Self { x: hit.x, y: hit.y }
    }
}

/// Everything one tick's probes said, thresholded but not yet judged.
///
/// Every field is an observation about THIS frame. Nothing here persists; all
/// accumulation (debounces, two-tick agreement, deadlines) is state and lives in
/// the machine. That division is what made the five module-level `*Detect`
/// variables a bug source - they looked like observations and behaved like
/// state.
#[derive(Debug, Clone, Copy, Default, PartialEq, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Reading {
    /// "開始播放對戰紀錄" - a replay just STARTED.
    pub replay_banner: bool,
    /// The playback chrome - a replay is STILL RUNNING.
    pub replay_chrome: bool,

    /// All three of my class, the opponent's class and the play order were read.
    pub versus: Option<VersusScreen>,

    /// The centred WIN/LOSE splash thrown up when the battle ends.
    pub battle_end_splash: Option<bool>,
    /// The banner on the final result screen. `Some(true)` is a win.
    pub final_result: Option<bool>,

    /// Which point system the result screen shows, and where its label landed.
    pub score_system: Option<ScoreSystemHit>,

    /// The CPU deck label on the pre-battle screen, this frame only.
    pub cpu_pre_battle: bool,
    /// The CPU deck label anywhere it is shown (pre-battle or result).
    pub cpu_anywhere: bool,
    pub two_pick: bool,

    /// The 2Pick階級 label on the VERSUS screen, either player's row.
    ///
    /// Separate from `two_pick` because they answer at different times and one
    /// is far more useful than the other: this one is on screen as the match
    /// starts, `two_pick` only on the result screen after the reward carousel
    /// has finished turning - if it turns that far at all.
    pub two_pick_versus: bool,
    pub custom_room: bool,
    /// Numbers read off this frame. `None` means "not readable now" - the
    /// cursor is over the digits, the text did not parse, or the field is not on
    /// this layout - never "absent for good". Supplied by a `NumberReader`, so
    /// the machine is indifferent to whether they came from OCR or templates.
    pub numbers: NumberReads,

    /// Scores worth watching even when they cleared - or missed - their
    /// threshold.
    ///
    /// A score drifting to just under its threshold is the failure a user can
    /// never report, because nothing visibly breaks until it drifts far enough.
    /// These are the three the shipped analyzer watched, and they are carried
    /// rather than judged here so `reading` stays free of diagnostics.
    pub watched: [WatchedScore; 3],

    /// The weekend-plaza label: where it landed and how well it scored.
    ///
    /// Both are needed. The position feeds the stability check, and the score
    /// goes into the diagnostic capture - this probe has no verified positive
    /// sample, so the score that convinced it is the only way to tell a real
    /// plaza result from yet another false positive.
    pub plaza: Option<(Located, f64)>,
}

impl Reading {
    /// Whether a replay is on screen by either signal.
    ///
    /// Neither is sufficient alone. The banner says a replay BEGAN and is gone a
    /// second later, so on its own it can only arm a blind timer - measured, a
    /// 1280 replay ran 37s with no protection once one expired, while a longer
    /// timer swallows a real match started right after an early exit. The chrome
    /// cannot start the latch either: it is not on screen during the versus
    /// screen, which is precisely what needs suppressing.
    pub fn shows_replay(&self) -> bool {
        self.replay_banner || self.replay_chrome
    }
}

/// One probe's score against the threshold it was measured for.
#[derive(Debug, Clone, Copy, PartialEq, Default, serde::Serialize)]
pub struct WatchedScore {
    pub label: &'static str,
    pub score: f64,
    pub threshold: f64,
}

/// One frame's readings of the five number fields.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct NumberReads {
    /// Below Grand Master, and 2Pick. Static once drawn.
    pub bp: Option<i32>,
    /// Gained this match. Static once drawn.
    pub delta_mp: Option<i32>,
    /// Cumulative. ANIMATES - counts up frame by frame.
    pub total_mp: Option<i32>,
    /// Static once drawn.
    pub delta_cr: Option<i32>,
    /// Cumulative. ANIMATES.
    pub total_cr: Option<i32>,
}

/// Which block of numbers a result screen owes, decided from its score-system
/// label. The two are mutually exclusive: below Grand Master the screen shows BP
/// and no CR at all; above it, MP replaces BP and CR appears alongside.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum NumberBlock {
    Bp,
    Mp,
}

// --------------------------------------------------------------------- deciding

/// A mode signal offered to the machine, with the weight behind it.
///
/// Pairing the value with its confidence at the point of observation means a
/// caller cannot supply one without the other - the JS version kept `mode` and
/// `modeConfidence` as two module-level variables and had to remember to write
/// both, every time, at eight separate call sites.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct ModeSignal {
    pub mode: GameMode,
    pub confidence: Confidence,
}

/// One semantic thing a tick decided. The unit the host acts on.
///
/// The JS analyzer interleaved 21 database calls and 13 `postMessage`s with the
/// detection logic that produced them, so "what does a tick change" could only
/// be answered by reading all 700 lines. A tick now returns this list and an
/// outer layer turns it into events and writes; the machine itself performs no
/// I/O and so can be tested at all.
#[derive(Debug, Clone, PartialEq)]
pub enum Change {
    /// A row must be created. The host allocates the id and remembers the
    /// `MatchRef -> id` mapping (see [`MatchRef`]).
    MatchStarted {
        r#ref: MatchRef,
        versus: VersusScreen,
        /// A pre-battle hint that was still valid when the match began.
        mode: Option<GameMode>,
    },

    /// Fields resolved on an open match. Carries values, never a bare
    /// "something changed" - see 判斷題 D-4.
    MatchUpdated { r#ref: MatchRef, patch: MatchPatch },

    /// The match is closed. `patch` repeats every field the machine holds, not
    /// only this tick's, so a host that missed an earlier change still
    /// converges on the right row.
    MatchFinished { r#ref: MatchRef, patch: MatchPatch },

    /// An open match was thrown away because a replay started.
    ///
    /// Distinct from [`Change::MatchFinished`] on purpose: a replay shows the
    /// same versus screen and battlefield as a real match, so whatever was open
    /// when one began cannot be trusted and must not be written as a result.
    MatchAbandoned { r#ref: MatchRef },

    /// Replay suppression began or ended. The HUD needs it, and so does anyone
    /// reading a session log to explain a missing match.
    ReplaySuppression { active: bool },

    /// Something worth a diagnostic capture or a counter.
    ///
    /// `detail` is structured on purpose. The JS equivalent carried
    /// `{ roi, rawText, scores, thresholds }`, and these diagnostics are the
    /// ONLY channel by which a silent failure is ever reported - a near-miss
    /// score with the label in an unexpected place is a layout shift, while the
    /// same score in the right place is a stale template, and a `kind` plus a
    /// `label` cannot tell those apart.
    Noted { kind: &'static str, label: String, detail: Option<serde_json::Value> },
}

// ---------------------------------------------------------------- the machine

/// The state machine itself: everything that persists between ticks.
///
/// `tick` takes `&mut self` and returns what changed. An earlier draft had it
/// return an `Outcome { phase, changes }`, which was wrong - it assumed
/// [`Phase`] was the whole state. It is not: the mode and its confidence, the
/// fields resolved so far, three debounces, the per-number consensus and the
/// `MatchRef` counter all persist too, and none of them belong in a phase.
///
/// Purity is not lost by mutating. What makes this testable is that it performs
/// no I/O - no image decoding, no database, no message port - so a test supplies
/// a [`Reading`] and an `Instant` and reads back a `Vec<Change>`. Immutability
/// was never the property that mattered.
pub struct Machine {
    phase: Phase,
    /// Next handle to hand out. Engine-local; see [`MatchRef`].
    next_ref: u64,

    /// Mode and the weight behind it, for the open match. One field rather than
    /// two, so it is impossible to update the mode and forget the confidence -
    /// which the JS version had to remember at eight separate call sites.
    mode: Option<ModeSignal>,
    /// Fields resolved so far for the open match.
    collected: MatchPatch,

    /// Mode signals that need several frames before they count.
    ///
    /// `ranked` is here because the score-system anchor is a 250x250 window over
    /// the top-right of the screen and the app's own HUD sits inside it: on
    /// `2pick-1920-fullscreen-lose` it fired on the HUD's 階級對戰 badge in 2 of
    /// 85 frames, at 0.759 against a 0.7 threshold. One frame used to be enough
    /// to brand a whole match.
    ///
    /// It is worth being clear about what this does NOT fix, because the
    /// tempting conclusion is wrong. The anchor also fires on the 2Pick result
    /// screen's own 「BP 100」 - 0.757-0.787, nine frames running - so no number
    /// of frames tells the two apart. That is why the ranked signal is only
    /// `Strong` and why the mode is decided on the versus screen instead.
    cpu: Debounce,
    plaza: Debounce,
    custom: Debounce,
    ranked: Debounce,
    two_pick_versus: Debounce,

    /// Which block this result screen owes, once its label has been read.
    owed: Option<NumberBlock>,
    /// One consensus per field. Rebuilt per match, because the agreement rule
    /// differs by field and a settled value must not leak into the next match.
    bp: Consensus,
    delta_mp: Consensus,
    total_mp: Consensus,
    delta_cr: Consensus,
    total_cr: Consensus,
}

impl Machine {
    pub fn new() -> Self {
        Self {
            phase: Phase::default(),
            next_ref: 1,
            mode: None,
            collected: MatchPatch::default(),
            cpu: Debounce::consecutive(REQUIRED_HITS),
            // The only one that carried a position check in the source. It is
            // the default here; see `accumulate::Debounce`.
            plaza: Debounce::stable(REQUIRED_HITS, calibration::POSITION_TOLERANCE_PX),
            custom: Debounce::stable(REQUIRED_HITS, calibration::POSITION_TOLERANCE_PX),
            // The label drifts horizontally during the count-up animation, so
            // the position check would reject the true signal it exists to
            // protect. Consecutive frames alone; the anchor's false positives
            // are sporadic rather than sustained.
            ranked: Debounce::consecutive(REQUIRED_HITS),
            // The versus screen stays up for about ten seconds, so asking for a
            // second frame costs 500ms of a twenty-tick window and rules out the
            // single-frame false positive.
            two_pick_versus: Debounce::consecutive(REQUIRED_HITS),
            owed: None,
            bp: static_value(),
            delta_mp: static_value(),
            total_mp: animated_value(),
            delta_cr: static_value(),
            total_cr: animated_value(),
        }
    }

    pub fn phase(&self) -> Phase {
        self.phase
    }

    /// Hand out the next match handle.
    fn allocate_ref(&mut self) -> MatchRef {
        let handle = MatchRef(self.next_ref);
        self.next_ref += 1;
        handle
    }

    /// Forget everything about the open match.
    ///
    /// Both `MatchAbandoned` (a replay started) and `MatchFinished` land here.
    /// The JS version cleared thirteen variables by hand at three sites, and the
    /// replay path missed `plazaDetect` - which is the B-1 defect.
    fn clear_match_state(&mut self) {
        self.mode = None;
        self.collected = MatchPatch::default();
        self.cpu.reset();
        self.plaza.reset();
        self.custom.reset();
        self.ranked.reset();
        self.two_pick_versus.reset();
        self.owed = None;
        self.bp = static_value();
        self.delta_mp = static_value();
        self.total_mp = animated_value();
        self.delta_cr = static_value();
        self.total_cr = animated_value();
    }

    /// Offer a mode signal. `true` if it was taken.
    ///
    /// A weak signal is accepted only while nothing better is known, and never
    /// prevents an authoritative one from correcting it later.
    fn offer_mode(&mut self, signal: ModeSignal) -> bool {
        match self.mode {
            Some(current) if signal.confidence < current.confidence => false,
            Some(current) if current.mode == signal.mode => false,
            _ => {
                self.mode = Some(signal);
                true
            }
        }
    }
}

impl Default for Machine {
    fn default() -> Self {
        Self::new()
    }
}

/// Consecutive frames a weak signal needs. Two, throughout: enough that a
/// single-frame false positive cannot land, few enough to catch a label that is
/// only briefly on screen.
const REQUIRED_HITS: u32 = 2;

/// Readings a static value needs before it is believed.
///
/// Three, not one. The result screen offers five to ten readings and the shipped
/// analyzer used the first; three is enough to outvote a single bad read while
/// still settling well inside the hold.
const STATIC_AGREEMENT: usize = 3;

/// Static once drawn: BP, gained MP, delta CR.
fn static_value() -> Consensus {
    Consensus::new(Agreement::Tally(STATIC_AGREEMENT))
}

/// Counts up on screen: the cumulative MP and CR totals. Only consecutive
/// equality proves the animation has stopped.
fn animated_value() -> Consensus {
    Consensus::new(Agreement::Consecutive)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_reading_is_writable_by_hand() {
        // The point of the whole split: reproducing a timing incident needs no
        // image, no template store and no recording.
        let reading = Reading { replay_banner: true, ..Default::default() };
        assert!(reading.shows_replay());

        let reading = Reading { replay_chrome: true, ..Default::default() };
        assert!(reading.shows_replay(), "the chrome alone must hold the latch");

        assert!(!Reading::default().shows_replay());
    }

    /// Abandoning and finishing must stay different values. Collapsing them
    /// would write a replay's frames into the match it interrupted, which is the
    /// exact failure the suppression latch exists to prevent.
    #[test]
    fn abandoning_is_not_finishing() {
        let abandoned = Change::MatchAbandoned { r#ref: MatchRef(1) };
        let finished =
            Change::MatchFinished { r#ref: MatchRef(1), patch: MatchPatch::default() };
        assert_ne!(abandoned, finished);
    }

    /// A diagnostic must be able to carry the evidence, not just a label.
    #[test]
    fn a_note_can_carry_structured_evidence() {
        let note = Change::Noted {
            kind: "mode-unattributable",
            label: "result".into(),
            detail: Some(serde_json::json!({ "scoreSystem": 0.41, "threshold": 0.7 })),
        };
        match note {
            Change::Noted { detail: Some(d), .. } => assert_eq!(d["threshold"], 0.7),
            other => panic!("lost the evidence: {other:?}"),
        }
    }
}

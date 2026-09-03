//! Where the analyzer is in the life of one match.
//!
//! This replaces four module-level variables in
//! `src/main/recognition/forkedImageAnalyzer.ts` - `inBattle`, `isMatchRecord`,
//! `isResultMidDetect` and `activeMatchId` - which between them encoded one
//! state machine across 2 x 2 x 2 x (null or not) combinations, of which only a
//! handful are legal and nothing prevented the rest.
//!
//! The shape below was derived by enumerating every read and write of those
//! four variables, not by reading the code's intent. Two things fell out of that
//! enumeration that a summary would have missed, and both are recorded here
//! because they change the design:
//!
//!   1. `inBattle` IS NOT STATE. It is recomputed from this tick's probes at
//!      `:872` (`if (!isMatchRecord) inBattle = myValid && oppoValid &&
//!      turnValid`) and its only read is eight lines later at `:883`, inside a
//!      branch that requires `!isMatchRecord` - so the recompute always ran
//!      first. Its three `inBattle = false` assignments (`:603`, `:969`, `:996`)
//!      are therefore dead: nothing reads them before the next tick overwrites
//!      them. The `inBattle` in the outgoing IPC payloads is a literal, not this
//!      variable. So it is a per-tick derived value and does not appear here.
//!
//!   2. Pre-battle mode detection IS NOT A PHASE. `:783` gates it on
//!      `activeMatchId === null && !isMatchRecord && !isResultMidDetect`, i.e.
//!      exactly [`Phase::Idle`], and it mutates none of the four variables - it
//!      only parks a hint with a TTL. An earlier draft of this enum had a
//!      `PreBattle` variant; enumerating the writes showed there is no such
//!      state, only data carried by `Idle`.

use std::time::Instant;

use crate::protocol::{GameMode, MatchRef};

/// A mode signal read before the match row exists, valid for a short window.
///
/// The CPU deck label is visible during deck selection, before there is
/// anything to attach it to. It is a calibrated probe that already required two
/// consecutive frames, so it is trusted as `Confidence::Strong` when the match
/// does start - but the result screen may still correct it.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct ModeHint {
    pub mode: GameMode,
    /// After this, the hint is stale and must be ignored rather than applied to
    /// whatever match happens to start next.
    pub expires: Instant,
}

impl ModeHint {
    pub fn is_valid_at(&self, now: Instant) -> bool {
        now < self.expires
    }
}

/// What a closing match is still waiting for.
///
/// These are two genuinely different waits, not one with a longer timer, and
/// conflating them is what the `ocrGraceUntil === 0` guard at `:988` was
/// standing in for.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Awaiting {
    /// The end-of-battle splash was seen; the final result screen has not been.
    ///
    /// The outcome is already known and persisted - it is read off the splash -
    /// but mode and numbers live on the screen that follows.
    ///
    /// This wait is BLIND, and that is what makes it different from the other
    /// one. The game fills the gap with full-screen reward panels that wait for
    /// a click: they cover the result banner, no calibrated probe matches them,
    /// and the player decides how long they stay. So there is nothing to read
    /// and no honest deadline to read it by - `backstop` is a fuse for a capture
    /// that died, not a budget for the screen to arrive in, and the wait is
    /// meant to end on evidence long before it.
    ///
    /// Two clocks, because the wait and the believing are different questions.
    /// `believe_until` is short and measured - a custom room or a practice match
    /// puts its own label up within it, and that is the only place either mode
    /// is ever read. Past it the screen is assumed to be reward art and nothing
    /// it seems to say is acted on; see [`Phase::trusts_probes_at`].
    FinalScreen { believe_until: Instant, backstop: Instant },

    /// The final result screen is up and the match is held open so number
    /// reading can retry.
    ///
    /// Without this hold, the score-system label and the result banner cross
    /// their thresholds on the same tick, so a cursor over the digits or an
    /// unsettled count-up animation lost the value permanently - the screen
    /// stays up for 2.5s+ but there was only ever one attempt.
    ///
    /// `floor` is a SECOND, independent reason to stay open, and it is not the
    /// numbers. The result screen's reward strip is a carousel, and the 2Pick階級
    /// label - the only evidence a match was 2Pick - is the last panel to rotate
    /// in, measured at 5.5s after the banner. `deadline` alone was 5s, so a 2Pick
    /// match closed half a second before the one probe that could identify it,
    /// and was filed as ranked. `deadline` restarts when a late label hands the
    /// hold something to owe; `floor` is set once and never moves, so it bounds
    /// the wait rather than extending it.
    Numbers { deadline: Instant, floor: Instant },
}

impl Awaiting {
    pub fn deadline(self) -> Instant {
        match self {
            Awaiting::FinalScreen { backstop, .. } => backstop,
            Awaiting::Numbers { deadline, .. } => deadline,
        }
    }

    pub fn is_expired_at(self, now: Instant) -> bool {
        now >= self.deadline()
    }
}

/// The analyzer's position in one match's life.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Phase {
    /// No match open. The only phase in which a new one may start, and the only
    /// one in which pre-battle mode detection runs.
    Idle { hint: Option<ModeHint> },

    /// A row exists and the battle is on screen.
    InBattle { match_id: MatchRef },

    /// The battle is over and the outcome is known; the row is still open.
    Resolving { match_id: MatchRef, result: bool, awaiting: Awaiting },

    /// A replay is on screen. Nothing may be recorded, and any open match is
    /// discarded rather than finished - a replay shows the same versus screen,
    /// play-order overlay and battlefield as a real match, so whatever was open
    /// when one started cannot be trusted.
    ReplaySuppressed { until: Instant },
}

impl Default for Phase {
    fn default() -> Self {
        Phase::Idle { hint: None }
    }
}

impl Phase {
    /// The match this phase is about, if any.
    ///
    /// Replaces the `activeMatchId !== null` test that guarded 21 call sites.
    /// Those guards existed because the id and the phase could disagree; here
    /// they cannot, so the guard becomes a destructuring rather than a check
    /// that might have been forgotten.
    pub fn match_id(self) -> Option<MatchRef> {
        match self {
            Phase::InBattle { match_id } | Phase::Resolving { match_id, .. } => Some(match_id),
            Phase::Idle { .. } | Phase::ReplaySuppressed { .. } => None,
        }
    }

    /// Whether a new match may begin.
    ///
    /// `:883` spelled this `inBattle && !isMatchRecord && !isResultMidDetect`,
    /// where the first conjunct is this tick's probe result and the other two
    /// are the phase. Only the phase part belongs here.
    pub fn accepts_new_match(self) -> bool {
        matches!(self, Phase::Idle { .. })
    }

    /// Whether probes that can still decide the mode should run.
    ///
    /// Every such probe in `analyzeOnce` was guarded on `activeMatchId !== null`,
    /// which is this.
    pub fn is_open(self) -> bool {
        self.match_id().is_some()
    }

    /// Whether the final-result branch may fire.
    ///
    /// `:988` spelled this `activeMatchId !== null && ocrGraceUntil === 0 &&
    /// (...)`. The `ocrGraceUntil === 0` half is a re-entry guard: once the
    /// match is held open for numbers, the branch that started the hold must not
    /// run again and restart it. Here that is structural - `Awaiting::Numbers`
    /// simply is not `FinalScreen`.
    pub fn accepts_final_screen(self) -> bool {
        matches!(
            self,
            Phase::InBattle { .. }
                | Phase::Resolving { awaiting: Awaiting::FinalScreen { .. }, .. }
        )
    }

    /// Whether the final result screen has actually been SEEN.
    ///
    /// `Resolving` is not the same question and used to be asked in its place.
    /// The difference did not matter while the blind wait was capped at fifteen
    /// seconds; now that it runs for as long as the player leaves a reward
    /// screen up, it decides whether a probe fires thirty times against the
    /// result screen or twelve hundred times against reward art.
    ///
    /// Every result-screen probe is a calibrated window at a fixed position.
    /// During the blind wait those positions hold whatever the reward panel
    /// draws there, so a hit means nothing - the plaza probe has no verified
    /// positive sample to begin with, and the score-system anchor already
    /// false-positives on the app's own HUD. This is the guard that keeps a long
    /// wait from becoming a long exposure.
    pub fn on_result_screen(self) -> bool {
        matches!(self, Phase::Resolving { awaiting: Awaiting::Numbers { .. }, .. })
    }

    /// Whether this phase is waiting blind for the final screen.
    pub fn is_blind_wait(self) -> bool {
        matches!(self, Phase::Resolving { awaiting: Awaiting::FinalScreen { .. }, .. })
    }

    /// Whether a probe firing now is worth acting on.
    ///
    /// Only ever false during the blind wait, and only after its measured
    /// window has passed. Inside that window the screen is one the game put up
    /// on its own - a custom room's panel, a practice match's deck label - and
    /// reading it is how those two modes are identified at all. Past it the
    /// player is sitting on a reward screen of their own accord, for as long as
    /// they like, with unrelated art under every calibrated window.
    ///
    /// The distinction matters because the wait no longer ends. Fifteen seconds
    /// of a probe that false-positives now and then is the exposure this
    /// codebase already accepted and measured against; ten minutes of it is not
    /// the same bet, and nothing about the extra time makes the answer better.
    pub fn trusts_probes_at(self, now: Instant) -> bool {
        match self {
            Phase::Resolving { awaiting: Awaiting::FinalScreen { believe_until, .. }, .. } => {
                now < believe_until
            }
            _ => true,
        }
    }

    /// Whether digits are worth reading - the one expensive probe.
    ///
    /// Excludes the blind wait: the numbers live on the final result screen, so
    /// by definition none are on screen before it arrives. Without this, a
    /// player who leaves a reward screen up for ten minutes costs twelve hundred
    /// round trips to Tesseract for a screen that has no digits on it.
    pub fn wants_numbers(self) -> bool {
        self.is_open() && !self.is_blind_wait()
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::time::Duration;

    fn t0() -> Instant {
        Instant::now()
    }

    fn in_battle() -> Phase {
        Phase::InBattle { match_id: MatchRef(1) }
    }

    fn awaiting_final(now: Instant) -> Phase {
        Phase::Resolving {
            match_id: MatchRef(1),
            result: true,
            awaiting: Awaiting::FinalScreen {
                believe_until: now + Duration::from_secs(15),
                backstop: now + Duration::from_secs(600),
            },
        }
    }

    fn awaiting_numbers(now: Instant) -> Phase {
        Phase::Resolving {
            match_id: MatchRef(1),
            result: true,
            awaiting: Awaiting::Numbers {
                deadline: now + Duration::from_secs(5),
                floor: now + Duration::from_secs(5),
            },
        }
    }

    /// Each of the four guard expressions in `analyzeOnce` must select exactly
    /// one shape here. This is the coverage argument for the enum: if a guard
    /// admitted two shapes, or none, the port would have lost a state.
    #[test]
    fn every_analyzer_guard_maps_onto_exactly_one_shape() {
        let now = t0();
        let all =
            [Phase::default(), in_battle(), awaiting_final(now), awaiting_numbers(now),
             Phase::ReplaySuppressed { until: now + Duration::from_secs(15) }];

        // `:883`  inBattle && !isMatchRecord && !isResultMidDetect  -> start
        let starts: Vec<_> = all.iter().filter(|p| p.accepts_new_match()).collect();
        assert_eq!(starts.len(), 1, "exactly one phase may start a match");

        // `:965`  isMatchRecord && activeMatchId !== null           -> splash
        let splash: Vec<_> = all.iter().filter(|p| matches!(p, Phase::InBattle { .. })).collect();
        assert_eq!(splash.len(), 1);

        // `:988`  activeMatchId !== null && ocrGraceUntil === 0     -> final screen
        // Two shapes on purpose: the final screen can arrive with or without the
        // splash having been seen first (`:990` is a disjunction), but never
        // while already holding for numbers.
        let final_screen: Vec<_> = all.iter().filter(|p| p.accepts_final_screen()).collect();
        assert_eq!(final_screen.len(), 2);
        assert!(!awaiting_numbers(now).accepts_final_screen(), "the hold must not restart itself");

        // `:1096` activeMatchId !== null && ocrGraceUntil > 0       -> resolve hold
        let holding: Vec<_> = all
            .iter()
            .filter(|p| matches!(p, Phase::Resolving { awaiting: Awaiting::Numbers { .. }, .. }))
            .collect();
        assert_eq!(holding.len(), 1);
    }

    /// The 21 `activeMatchId !== null` guards become one question with one
    /// answer per phase, and a suppressed replay must never look open - that is
    /// what stops a replay's frames writing into the match it interrupted.
    #[test]
    fn only_the_open_phases_carry_a_match() {
        let now = t0();
        assert_eq!(Phase::default().match_id(), None);
        assert_eq!(in_battle().match_id(), Some(MatchRef(1)));
        assert_eq!(awaiting_final(now).match_id(), Some(MatchRef(1)));
        assert_eq!(awaiting_numbers(now).match_id(), Some(MatchRef(1)));
        assert_eq!(Phase::ReplaySuppressed { until: now }.match_id(), None);
    }

    /// "A match is open" and "the result screen is up" are different questions.
    ///
    /// They were the same one while the blind wait lasted fifteen seconds. It
    /// now lasts as long as the player leaves a reward screen up, and every
    /// result-screen probe would spend that time firing at reward art.
    #[test]
    fn the_blind_wait_is_not_the_result_screen() {
        let now = t0();
        assert!(!awaiting_final(now).on_result_screen(), "the reward panels are not it");
        assert!(awaiting_numbers(now).on_result_screen());
        assert!(!in_battle().on_result_screen());

        // The wait is unbounded; the believing is not. A custom room raises its
        // own panel immediately and is read inside the window; a reward screen
        // left up for minutes is not read at all.
        assert!(awaiting_final(now).trusts_probes_at(now));
        assert!(awaiting_final(now).trusts_probes_at(now + Duration::from_secs(14)));
        assert!(!awaiting_final(now).trusts_probes_at(now + Duration::from_secs(15)));
        assert!(in_battle().trusts_probes_at(now + Duration::from_secs(600)), "always in battle");

        // ...and there are no digits to read until it does arrive.
        assert!(!awaiting_final(now).wants_numbers());
        assert!(awaiting_numbers(now).wants_numbers());
        assert!(in_battle().wants_numbers());
        assert!(!Phase::default().wants_numbers(), "nothing to attach a number to");
    }

    /// A hint that outlived its window must not be applied to whatever match
    /// starts next: the CPU label is read during deck selection, and the player
    /// may well pick a different mode afterwards.
    #[test]
    fn a_stale_hint_is_not_valid() {
        let now = t0();
        let hint = ModeHint { mode: GameMode::Cpu, expires: now + Duration::from_secs(30) };
        assert!(hint.is_valid_at(now));
        assert!(hint.is_valid_at(now + Duration::from_secs(29)));
        assert!(!hint.is_valid_at(now + Duration::from_secs(30)), "expiry is exclusive");
        assert!(!hint.is_valid_at(now + Duration::from_secs(31)));
    }

    /// Deadlines are compared with `>=`, matching `now >= ocrGraceUntil` and
    /// `now >= resultModeDeadline` in the source. A replay stepping at exactly
    /// the deadline must expire, not hang for one more frame.
    #[test]
    fn a_deadline_expires_on_the_instant_it_names() {
        let now = t0();
        let awaiting = Awaiting::Numbers {
            deadline: now + Duration::from_secs(5),
            floor: now + Duration::from_secs(5),
        };
        assert!(!awaiting.is_expired_at(now + Duration::from_secs(4)));
        assert!(awaiting.is_expired_at(now + Duration::from_secs(5)));
        assert!(awaiting.is_expired_at(now + Duration::from_secs(6)));
    }
}

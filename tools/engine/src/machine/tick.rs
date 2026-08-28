//! One frame's worth of decision making.
//!
//! Split from the type definitions in the parent module only for length; it is
//! the same `Machine`, and being a child module is what lets it reach the
//! private fields without widening them to the crate.
//!
//! Ordering follows `analyzeOnce`: suppression first because it can discard
//! everything, then mode, then the match lifecycle in the order the player sees
//! it. Nothing here performs I/O, which is the whole point - a test supplies a
//! [`Reading`] and an `Instant`.

use std::time::Instant;

use super::{
    Change, Located, Machine, MatchPatch, ModeSignal, NumberBlock, Reading,
};
use crate::calibration::{ScoreSystem, timing};
use crate::phase::{Awaiting, ModeHint, Phase};
use crate::protocol::{Confidence, GameMode, MatchRef};

/// Stand-in position for signals whose debounce does not check position.
const UNPOSITIONED: Located = Located { x: 0, y: 0 };

impl Machine {
    /// Advance by one frame and report what changed.
    pub fn tick(&mut self, reading: &Reading, now: Instant) -> Vec<Change> {
        let mut changes = Vec::new();

        if self.update_replay_suppression(reading, now, &mut changes) {
            return changes;
        }
        self.collect_numbers(reading, &mut changes);
        self.resolve_mode(reading, now, &mut changes);
        self.start_match(reading, now, &mut changes);
        self.observe_battle_end(reading, now, &mut changes);
        self.observe_final_screen(reading, now, &mut changes);
        self.resolve_hold(reading, now, &mut changes);
        self.close_on_missing_final_screen(now, &mut changes);

        changes
    }

    /// `true` when a replay is on screen and the rest of the tick must be skipped.
    ///
    /// Entering suppression DISCARDS an open match rather than finishing it: a
    /// replay shows the same versus screen, play-order overlay and battlefield as
    /// a real match, so whatever was open cannot be trusted.
    fn update_replay_suppression(
        &mut self,
        reading: &Reading,
        now: Instant,
        changes: &mut Vec<Change>,
    ) -> bool {
        // The banner sets a floor long enough to reach the chrome; the chrome
        // holds the latch from there. Neither works alone - see
        // `Reading::shows_replay`.
        let extend_to = if reading.replay_banner {
            Some(now + timing::REPLAY_BANNER_FLOOR)
        } else if reading.replay_chrome {
            Some(now + timing::REPLAY_CHROME_GRACE)
        } else {
            None
        };

        if let Some(until) = extend_to {
            let current = match self.phase {
                Phase::ReplaySuppressed { until } => Some(until),
                _ => None,
            };
            // The latch only ever moves forward, so a chrome hit two seconds into
            // a fifteen-second banner floor cannot shorten it.
            let until = current.map_or(until, |held| held.max(until));

            if current.is_none() {
                if let Some(r#ref) = self.phase.match_id() {
                    changes.push(Change::MatchAbandoned { r#ref });
                }
                self.clear_match_state();
                changes.push(Change::ReplaySuppression { active: true });
            }
            self.phase = Phase::ReplaySuppressed { until };
            return true;
        }

        if let Phase::ReplaySuppressed { until } = self.phase {
            if now < until {
                return true;
            }
            self.phase = Phase::Idle { hint: None };
            changes.push(Change::ReplaySuppression { active: false });
        }
        false
    }

    /// Feed this frame's readings into the per-field consensus.
    ///
    /// Every field is offered regardless of which block is owed. A field absent
    /// from this layout simply never reads, while gating on `owed` would discard
    /// readings taken before the score-system label faded in - precisely the
    /// window the hold exists to cover.
    fn collect_numbers(&mut self, reading: &Reading, changes: &mut Vec<Change>) {
        let Some(r#ref) = self.phase.match_id() else {
            return;
        };
        let mut patch = MatchPatch::default();
        let n = &reading.numbers;

        if let Some(v) = n.bp.and_then(|v| self.bp.observe(v, false)) {
            patch.bp = Some(v);
        }
        if let Some(v) = n.delta_mp.and_then(|v| self.delta_mp.observe(v, false)) {
            patch.delta_mp = Some(v);
        }
        if let Some(v) = n.total_mp.and_then(|v| self.total_mp.observe(v, false)) {
            patch.mp = Some(v);
        }
        if let Some(v) = n.delta_cr.and_then(|v| self.delta_cr.observe(v, false)) {
            patch.delta_cr = Some(v);
        }
        if let Some(v) = n.total_cr.and_then(|v| self.total_cr.observe(v, false)) {
            patch.current_cr = Some(v);
        }

        if !patch.is_empty() {
            self.merge(&patch);
            changes.push(Change::MatchUpdated { r#ref, patch });
        }
    }

    /// Decide the mode from whatever this frame offers.
    ///
    /// The plaza label is gated on [`Phase::Resolving`] rather than on where the
    /// probe call happens to sit. It is a result-screen element, mutually
    /// exclusive with BP/MP/CR, so it CANNOT legitimately be on screen
    /// mid-battle - every mid-battle hit was a false positive by definition, and
    /// one of them recorded a ranked match as `weekendPlaza`.
    fn resolve_mode(&mut self, reading: &Reading, now: Instant, changes: &mut Vec<Change>) {
        // Before a match exists there is nothing to attach a decision to, so the
        // pre-battle label parks a hint instead.
        if let Phase::Idle { .. } = self.phase {
            if self.cpu.observe(reading.cpu_pre_battle.then_some(UNPOSITIONED)) {
                self.phase = Phase::Idle {
                    hint: Some(ModeHint {
                        mode: GameMode::Cpu,
                        expires: now + timing::PRE_BATTLE_HINT_TTL,
                    }),
                };
            }
            return;
        }

        let Some(r#ref) = self.phase.match_id() else {
            return;
        };
        let on_result_screen = matches!(self.phase, Phase::Resolving { .. });

        // Fed every tick rather than inside the chain below, so a run of frames
        // is not broken by whichever branch happened to short-circuit first.
        let versus_says_2pick =
            self.two_pick_versus.observe(reading.two_pick_versus.then_some(UNPOSITIONED));

        let offered = if reading.two_pick || versus_says_2pick {
            // 2Pick brings its own deck, so the pre-filled default must go.
            if self.collected.clear_my_deck.is_none() {
                let patch = MatchPatch { clear_my_deck: Some(true), ..Default::default() };
                self.merge(&patch);
                changes.push(Change::MatchUpdated { r#ref, patch });
            }
            Some(ModeSignal { mode: GameMode::TwoPick, confidence: Confidence::Authoritative })
        } else if self.ranked.observe(reading.score_system.as_ref().map(|_| UNPOSITIONED)) {
            // The BP/MP label is on the same screen as the numbers and says which
            // system is in play. It may correct an earlier weaker guess.
            //
            // Strong, NOT authoritative, and measured that way. The 2Pick result
            // screen shows its own 「BP 100」, which scores 0.757-0.787 against the
            // 「BP :」 template - over the 0.7 threshold, and on 9 consecutive
            // frames of `2pick-1920-fullscreen-win`. This probe cannot tell a
            // ranked result screen from a 2Pick one, so it must not be able to
            // overrule something that can. `TWO_PICK_VERSUS_OWN` is that
            // something, and it is authoritative.
            //
            // Debounced as well - see `Machine::ranked`. The number windows still
            // key off the per-frame hit; only the MODE decision waits.
            Some(ModeSignal { mode: GameMode::Ranked, confidence: Confidence::Strong })
        } else if on_result_screen && self.plaza.observe(reading.plaza.map(|(at, _)| at)) {
            if let Some((at, score)) = reading.plaza {
                // No verified positive sample exists for this probe, so keep what
                // convinced it - the only way to tell a real plaza result from
                // yet another false positive.
                changes.push(Change::Noted {
                    kind: "weak-mode-accepted",
                    label: "weekendPlaza".into(),
                    detail: Some(serde_json::json!({ "score": score, "at": [at.x, at.y] })),
                });
            }
            Some(ModeSignal { mode: GameMode::WeekendPlaza, confidence: Confidence::Authoritative })
        } else if on_result_screen && reading.cpu_anywhere && self.mode.is_none() {
            // A direct hit on the final screen needs no second frame: this window
            // shows the CPU deck label only in practice matches.
            Some(ModeSignal { mode: GameMode::Cpu, confidence: Confidence::Strong })
        } else if self.cpu.observe(reading.cpu_anywhere.then_some(UNPOSITIONED)) {
            Some(ModeSignal { mode: GameMode::Cpu, confidence: Confidence::Strong })
        } else if self.custom.observe(reading.custom_room.then_some(UNPOSITIONED)) {
            Some(ModeSignal { mode: GameMode::Custom, confidence: Confidence::Weak })
        } else {
            None
        };

        let Some(signal) = offered else { return };
        let previous = self.mode;
        if !self.offer_mode(signal) {
            return;
        }
        if let Some(was) = previous {
            changes.push(Change::Noted {
                kind: "mode-corrected",
                label: format!("{:?}->{:?}", was.mode, signal.mode),
                detail: None,
            });
        }
        let patch = MatchPatch { mode: Some(signal.mode), ..Default::default() };
        self.merge(&patch);
        changes.push(Change::MatchUpdated { r#ref, patch });
    }

    fn start_match(&mut self, reading: &Reading, now: Instant, changes: &mut Vec<Change>) {
        if !self.phase.accepts_new_match() {
            return;
        }
        let Some(versus) = reading.versus else {
            return;
        };

        let hint = match self.phase {
            Phase::Idle { hint: Some(hint) } if hint.is_valid_at(now) => Some(hint.mode),
            _ => None,
        };

        let r#ref = self.allocate_ref();
        self.clear_match_state();
        // A pre-battle label is a calibrated probe that already needed two
        // frames, so it counts as strong - but the result screen may correct it.
        self.mode = hint.map(|mode| ModeSignal { mode, confidence: Confidence::Strong });
        self.collected.mode = hint;
        self.phase = Phase::InBattle { match_id: r#ref };
        changes.push(Change::MatchStarted { r#ref, versus, mode: hint });
    }

    /// The centred splash the moment the battle ends.
    ///
    /// The outcome is recorded here so it survives a crash, but the mode stays
    /// open: the CPU deck label appears on the final screen, which has not
    /// arrived yet.
    fn observe_battle_end(&mut self, reading: &Reading, now: Instant, changes: &mut Vec<Change>) {
        let Phase::InBattle { match_id } = self.phase else {
            return;
        };
        let Some(result) = reading.battle_end_splash else {
            return;
        };

        let patch = MatchPatch { result: Some(result), ..Default::default() };
        self.merge(&patch);
        changes.push(Change::MatchUpdated { r#ref: match_id, patch });
        self.phase = Phase::Resolving {
            match_id,
            result,
            awaiting: Awaiting::FinalScreen { deadline: now + timing::FINAL_SCREEN_GRACE },
        };
    }

    /// The final result screen. May arrive with or without the splash first.
    fn observe_final_screen(&mut self, reading: &Reading, now: Instant, changes: &mut Vec<Change>) {
        if !self.phase.accepts_final_screen() {
            return;
        }
        let (Some(result), Some(match_id)) = (reading.final_result, self.phase.match_id()) else {
            return;
        };

        if self.collected.result != Some(result) {
            let patch = MatchPatch { result: Some(result), ..Default::default() };
            self.merge(&patch);
            changes.push(Change::MatchUpdated { r#ref: match_id, patch });
        }

        self.owed = self.owed_block(reading);

        // Do NOT close on the first result tick. The WIN/LOSE banner crosses its
        // threshold while the rest of the screen is still fading in - measured,
        // the banner scored 0.87 on a frame where the BP block had not been drawn
        // at all, so the score-system label scored 0.41 and the match closed as
        // `unknown` on its very first result tick.
        if self.numbers_complete() && self.mode.is_some() {
            self.finish(match_id, changes);
        } else {
            self.phase = Phase::Resolving {
                match_id,
                result,
                awaiting: Awaiting::Numbers {
                    deadline: now + timing::NUMBERS_GRACE,
                    floor: now + timing::MODE_SETTLE,
                },
            };
        }
    }

    /// Close the hold once the numbers are in, or when it expires.
    fn resolve_hold(&mut self, reading: &Reading, now: Instant, changes: &mut Vec<Change>) {
        let Phase::Resolving {
            match_id,
            result,
            awaiting: Awaiting::Numbers { deadline, floor },
        } = self.phase
        else {
            return;
        };

        // The score-system label can fade in AFTER the hold started - that is the
        // whole reason the hold exists. Take on what it owes and restart the
        // clock, so the numbers get a full window rather than whatever is left of
        // one that began before they were on screen.
        //
        // Without this the match closes on the first tick of the hold: it owes
        // nothing, so it is trivially complete, and the numbers that arrive a
        // beat later are never read. `observe_final_screen` cannot cover this -
        // it is gated on `accepts_final_screen`, which a hold deliberately is not.
        let mut deadline = deadline;
        if self.owed.is_none() {
            if let Some(owed) = self.owed_block(reading) {
                self.owed = Some(owed);
                deadline = now + timing::NUMBERS_GRACE;
                self.phase = Phase::Resolving {
                    match_id,
                    result,
                    awaiting: Awaiting::Numbers { deadline, floor },
                };
            }
        }

        // Whichever reason to stay open outlives the other. A ranked result with
        // its numbers in still closes on the tick they settle, below - the floor
        // only governs the path where something is missing, which is exactly the
        // path a 2Pick match takes, since it has no numbers to complete.
        let expired = now >= deadline.max(floor);
        if expired && !self.numbers_complete() {
            // Take the last unconfirmed cumulative read rather than losing it
            // outright - no worse than the first-frame latch this replaced.
            let mut patch = MatchPatch::default();
            if self.collected.mp.is_none() {
                patch.mp = self.total_mp.last_read();
            }
            if self.collected.current_cr.is_none() {
                patch.current_cr = self.total_cr.last_read();
            }
            if !patch.is_empty() {
                self.merge(&patch);
                changes.push(Change::Noted {
                    kind: "cumulative-never-settled",
                    label: "best-effort".into(),
                    detail: Some(
                        serde_json::json!({ "mp": patch.mp, "currentCr": patch.current_cr }),
                    ),
                });
                changes.push(Change::MatchUpdated { r#ref: match_id, patch });
            }
        }

        if (self.numbers_complete() && self.mode.is_some()) || expired {
            self.finish(match_id, changes);
        }
    }

    /// Do not leave a match open forever if the game never shows the final
    /// screen - an interrupted capture, or the player leaving early.
    fn close_on_missing_final_screen(&mut self, now: Instant, changes: &mut Vec<Change>) {
        let Phase::Resolving { match_id, awaiting: Awaiting::FinalScreen { deadline }, .. } =
            self.phase
        else {
            return;
        };
        if now >= deadline {
            changes.push(Change::Noted {
                kind: "final-screen-never-seen",
                label: "closed-by-timeout".into(),
                detail: None,
            });
            self.finish(match_id, changes);
        }
    }

    /// Which numbers this result screen owes, from its score-system label.
    fn owed_block(&self, reading: &Reading) -> Option<NumberBlock> {
        if self.mode.map(|m| m.mode) == Some(GameMode::TwoPick) {
            return Some(NumberBlock::Bp);
        }
        match reading.score_system.map(|hit| hit.system) {
            Some(ScoreSystem::Bp) => Some(NumberBlock::Bp),
            Some(ScoreSystem::Mp) => Some(NumberBlock::Mp),
            // The label can fade in a beat after the banner, so its absence must
            // not clear what a previous tick already established.
            None => self.owed,
        }
    }

    fn numbers_complete(&self) -> bool {
        match self.owed {
            // Owes nothing, which is different from owing something unread.
            None => true,
            Some(NumberBlock::Bp) => self.collected.bp.is_some(),
            Some(NumberBlock::Mp) => {
                self.collected.delta_mp.is_some()
                    && self.collected.mp.is_some()
                    && self.collected.delta_cr.is_some()
                    && self.collected.current_cr.is_some()
            }
        }
    }

    /// Close the match, defaulting anything still unresolved.
    fn finish(&mut self, r#ref: MatchRef, changes: &mut Vec<Change>) {
        if self.mode.is_none() {
            // `Unknown`, never `Unranked`. Taking the latter quietly polluted the
            // free-play statistics with every recognition failure and gave the
            // user no way to tell the two apart.
            self.collected.mode = Some(GameMode::Unknown);
            changes.push(Change::Noted {
                kind: "mode-guessed",
                label: "unknown".into(),
                detail: None,
            });
        }

        // A ranked match should always carry at least one number. None at all
        // means the read never ran or never succeeded, which the user has no way
        // to notice. Keyed on the label having been SEEN, not on `mode == ranked`:
        // a plaza false positive once relabelled a ranked match and thereby
        // silenced this very diagnostic too.
        if self.owed.is_some()
            && self.collected.bp.is_none()
            && self.collected.mp.is_none()
            && self.collected.current_cr.is_none()
        {
            changes.push(Change::Noted {
                kind: "ranked-no-numbers",
                label: format!("{:?}", self.owed),
                detail: Some(serde_json::json!({ "mode": self.collected.mode })),
            });
        }

        changes.push(Change::MatchFinished { r#ref, patch: self.collected.clone() });
        self.clear_match_state();
        self.phase = Phase::Idle { hint: None };
    }

    /// Fold a patch into what the machine holds for the open match.
    /// `None` means "not resolved by this patch", never "cleared".
    fn merge(&mut self, patch: &MatchPatch) {
        let into = &mut self.collected;
        into.mode = patch.mode.or(into.mode);
        into.result = patch.result.or(into.result);
        into.bp = patch.bp.or(into.bp);
        into.mp = patch.mp.or(into.mp);
        into.delta_mp = patch.delta_mp.or(into.delta_mp);
        into.current_cr = patch.current_cr.or(into.current_cr);
        into.delta_cr = patch.delta_cr.or(into.delta_cr);
        into.clear_my_deck = patch.clear_my_deck.or(into.clear_my_deck);
    }
}

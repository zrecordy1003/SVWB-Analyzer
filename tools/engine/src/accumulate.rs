//! Turning repeated observations into a decision: debouncing and consensus.
//!
//! Both patterns exist three and two times over in
//! `src/main/recognition/forkedImageAnalyzer.ts`, hand-written each time with
//! slightly different rules. Collecting them here is not tidiness - the
//! divergence between the copies is where the behaviour got interesting, and one
//! implementation means one place to state the rule and one place to test it.

use crate::machine::Located;

/// How many consecutive frames a weak signal needs, and how far it may move.
///
/// Ported from the three separate hit counters (`cpuDetectionHits`,
/// `plazaDetectionHits`, `customDetectionHits`). Only the plaza copy carried the
/// position check, but the reasoning behind it - a UI label is pixel-stable on
/// the normalised canvas while drifting card text is not - applies to every weak
/// signal, so it is the default here rather than a special case.
///
/// `tolerance_px` of `None` means position is not checked at all, for signals
/// whose probe window is tight enough that a false positive cannot hold still.
#[derive(Debug, Clone, Copy)]
pub struct Debounce {
    required_hits: u32,
    tolerance_px: Option<u32>,
    hits: u32,
    last: Option<Located>,
}

impl Debounce {
    /// Requires `required_hits` consecutive frames, ignoring position.
    pub const fn consecutive(required_hits: u32) -> Self {
        Self { required_hits, tolerance_px: None, hits: 0, last: None }
    }

    /// Requires `required_hits` consecutive frames whose positions agree within
    /// `tolerance_px`.
    pub const fn stable(required_hits: u32, tolerance_px: u32) -> Self {
        Self { required_hits, tolerance_px: Some(tolerance_px), hits: 0, last: None }
    }

    /// Feed one frame's observation. `true` once the signal may be trusted.
    ///
    /// A miss resets the count. That is deliberate and matches the source: these
    /// guard against a single-frame false positive, so "two out of the last
    /// five" would defeat the purpose.
    pub fn observe(&mut self, seen: Option<Located>) -> bool {
        let Some(at) = seen else {
            self.hits = 0;
            self.last = None;
            return false;
        };

        self.hits = match (self.tolerance_px, self.last) {
            // Moved further than a stable UI element ever does: treat it as the
            // first sighting of something new rather than continuing the run.
            (Some(tolerance), Some(previous)) if !within(at, previous, tolerance) => 1,
            _ => self.hits + 1,
        };
        self.last = Some(at);
        self.hits >= self.required_hits
    }

    /// Forget the run. Used when the phase changes under it.
    pub fn reset(&mut self) {
        self.hits = 0;
        self.last = None;
    }
}

fn within(a: Located, b: Located, tolerance: u32) -> bool {
    a.x.abs_diff(b.x) <= tolerance && a.y.abs_diff(b.y) <= tolerance
}

/// How many readings must agree before a number is believed.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Agreement {
    /// Two readings in a row must be identical.
    ///
    /// For values that ANIMATE. The cumulative totals count up frame by frame -
    /// measured 88638 -> 88754 -> 88762 across ticks - and the database stores
    /// `read - delta` as the pre-match value, so latching the animation's first
    /// frame would double-subtract. Consecutive is what proves the count-up has
    /// settled; a plain tally would happily accept two equal frames either side
    /// of a different one.
    Consecutive,

    /// Any `n` readings agree, not necessarily in a row.
    ///
    /// For values that are STATIC once drawn - BP, gained MP, delta CR. The
    /// shipped analyzer accepted the FIRST successful read of these, which is
    /// backwards: the animated values were given a consensus rule and the still
    /// ones, where consensus is free, were not. The result screen is up for
    /// 2.5s+ and the hold adds 5s, so there are five to ten readings available
    /// and only one was used.
    Tally(usize),
}

/// Collects readings of one number until enough of them agree.
#[derive(Debug, Clone)]
pub struct Consensus {
    rule: Agreement,
    /// Distinct values seen, with how many times each was read. Small by
    /// construction - a handful of readings of one on-screen number.
    seen: Vec<(i32, usize)>,
    previous: Option<i32>,
    settled: Option<i32>,
}

impl Consensus {
    pub fn new(rule: Agreement) -> Self {
        Self { rule, seen: Vec::new(), previous: None, settled: None }
    }

    /// The value, once enough readings agreed.
    pub fn settled(&self) -> Option<i32> {
        self.settled
    }

    /// The most recent reading, agreed or not.
    ///
    /// When the hold expires without consensus this is taken as a best effort -
    /// no worse than the old first-frame latch, and better than losing the value
    /// outright.
    pub fn last_read(&self) -> Option<i32> {
        self.previous
    }

    /// Feed one reading. Returns the value if this reading settled it.
    ///
    /// `corroborated` lets an outside check lower the bar for THIS reading only
    /// - see P6-d. It may only ever make acceptance easier: the check is
    /// asymmetric, a match is evidence and a mismatch is not, so `false` is
    /// simply the normal path rather than a veto.
    pub fn observe(&mut self, value: i32, corroborated: bool) -> Option<i32> {
        if self.settled.is_some() {
            return None;
        }

        let agreed = match self.rule {
            Agreement::Consecutive => self.previous == Some(value),
            Agreement::Tally(required) => {
                match self.seen.iter_mut().find(|(v, _)| *v == value) {
                    Some((_, count)) => {
                        *count += 1;
                        *count >= required
                    }
                    None => {
                        self.seen.push((value, 1));
                        1 >= required
                    }
                }
            }
        };

        self.previous = Some(value);

        if agreed || corroborated {
            self.settled = Some(value);
            return self.settled;
        }
        None
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn at(x: u32, y: u32) -> Option<Located> {
        Some(Located { x, y })
    }

    /// A single frame must never be enough for a weak signal. This is the plaza
    /// incident: a five-glyph template over a battlefield full of ornate card
    /// text, accepted on one frame, recorded a ranked match as `weekendPlaza`.
    #[test]
    fn one_frame_never_convinces_a_debounce() {
        let mut d = Debounce::consecutive(2);
        assert!(!d.observe(at(100, 100)));
        assert!(d.observe(at(100, 100)));
    }

    /// A miss in the middle restarts the run - these guard against single-frame
    /// false positives, so "two of the last five" would defeat the purpose.
    #[test]
    fn a_miss_restarts_the_run() {
        let mut d = Debounce::consecutive(2);
        assert!(!d.observe(at(100, 100)));
        assert!(!d.observe(None));
        assert!(!d.observe(at(100, 100)), "the run restarted, so one hit is not two");
        assert!(d.observe(at(100, 100)));
    }

    /// Card text drifts; a UI label does not. A hit that jumped further than the
    /// measured normalisation drift is a different thing being matched, not the
    /// same thing seen twice.
    #[test]
    fn a_moving_hit_does_not_accumulate() {
        let mut d = Debounce::stable(2, 8);
        assert!(!d.observe(at(880, 285)));
        assert!(!d.observe(at(940, 300)), "jumped 60px - not the same element");
        assert!(d.observe(at(941, 301)), "but it may start a new run from there");
    }

    /// Within tolerance is the same element: the normalised canvas still drifts
    /// a few pixels between recordings.
    #[test]
    fn drift_inside_tolerance_still_accumulates() {
        let mut d = Debounce::stable(2, 8);
        assert!(!d.observe(at(887, 285)));
        assert!(d.observe(at(889, 285)), "2px is inside the measured 6px drift");
    }

    /// The count-up animation hands out a different value every tick. Only
    /// consecutive equality proves it has stopped - a tally would accept two
    /// equal frames sitting either side of a different one.
    #[test]
    fn an_animated_value_needs_consecutive_agreement() {
        let mut c = Consensus::new(Agreement::Consecutive);
        assert_eq!(c.observe(88638, false), None);
        assert_eq!(c.observe(88754, false), None);
        assert_eq!(c.observe(88762, false), None);
        assert_eq!(c.observe(88762, false), Some(88762));
    }

    #[test]
    fn a_tally_tolerates_one_bad_read_in_the_middle() {
        let mut c = Consensus::new(Agreement::Tally(2));
        assert_eq!(c.observe(124, false), None);
        assert_eq!(c.observe(724, false), None, "one misread must not settle it");
        assert_eq!(c.observe(124, false), Some(124));
    }

    /// Once settled, later readings are ignored. The shipped analyzer spelled
    /// this as an `isModifyX` flag checked before every read.
    #[test]
    fn a_settled_value_stops_listening() {
        let mut c = Consensus::new(Agreement::Tally(1));
        assert_eq!(c.observe(8, false), Some(8));
        assert_eq!(c.observe(9, false), None);
        assert_eq!(c.settled(), Some(8));
    }

    /// P6-d: corroboration may only ever make acceptance EASIER. A reading that
    /// matches `previous total + delta` is backed by an independent source, so
    /// one frame is enough.
    #[test]
    fn corroboration_shortens_the_requirement() {
        let mut c = Consensus::new(Agreement::Tally(3));
        assert_eq!(c.observe(41938, true), Some(41938), "corroborated on the first read");
    }

    /// ...and the absence of corroboration must be inert, NOT a veto. The check
    /// is asymmetric: the app is not always running while the user plays, so a
    /// mismatch cannot distinguish a misread from an unrecorded match.
    #[test]
    fn missing_corroboration_is_not_a_veto() {
        let mut c = Consensus::new(Agreement::Tally(2));
        assert_eq!(c.observe(41938, false), None);
        assert_eq!(c.observe(41938, false), Some(41938), "plain agreement still settles it");
    }

    /// When the hold expires with no agreement, the last reading is still worth
    /// more than nothing - it is exactly what the old first-frame latch would
    /// have stored.
    #[test]
    fn the_last_read_survives_a_failed_consensus() {
        let mut c = Consensus::new(Agreement::Consecutive);
        c.observe(88638, false);
        c.observe(88754, false);
        assert_eq!(c.settled(), None);
        assert_eq!(c.last_read(), Some(88754));
    }
}

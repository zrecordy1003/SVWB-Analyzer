//! Where a card actually is inside its mulligan slot.
//!
//! # Why this exists at all
//!
//! [`crate::mulligan`] answers "is there a card here", and a fixed rectangle is
//! enough for that: a card lights up its slot from wherever it happens to be.
//! Reading WHICH card is a different question - the art has to line up with the
//! art it is being compared against - and there the panel's animations are fatal.
//! Measured on the practice recording, the cards are pixel-identical for the
//! whole of both stages (frame-to-frame correlation 0.999-1.000) and then slide
//! out towards the hand when the panel dismisses, drifting 5px per frame for two
//! seconds. A fixed window over one of those frames reads a smear of two cards.
//!
//! So this module finds the card rather than assuming it, and REFUSES rather than
//! guessing. `None` here means "not on a frame you can read cards from", which
//! costs one tick - there are four to sixteen of them (see
//! `docs/opening-hand-plan.md`, stage 0).
//!
//! # What it locks onto
//!
//! The cost badge: a bright disc at the card's top-left corner, the most
//! findable thing on a card that is otherwise all texture. It is located by the
//! contrast between its own disc and the ring just outside it, which is what
//! distinguishes it from bright art - art is bright in patches, the badge is
//! bright in a circle with a dark rim around it.
//!
//! One badge is not trusted on its own. Bright card art can win the search on a
//! single slot - measured twice across the fixtures, both times disagreeing with
//! the neighbouring slots by 8px or more - so a row is located only if every card
//! in it agrees, and agrees with where the badge is supposed to be. A row is a
//! rigid object; its cards cannot each be somewhere else.

use svwb_vision_native::Rect;

use crate::calibration as cal;
use crate::frame::Frame;
use crate::mulligan::Mulligan;

/// A point on the normalised canvas.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Point {
    pub x: u32,
    pub y: u32,
}

/// One card, found rather than assumed.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct CardBox {
    /// The cost badge's centre, in canvas coordinates.
    pub badge: Point,
    /// The illustration window, positioned from the badge.
    ///
    /// This is the window the art comparison uses. It deliberately excludes the
    /// frame, the name band and the attack/life badges: the frame and badges are
    /// shared by every card of the same rarity, so including them would raise
    /// every score at once and shrink the gap that decides the match.
    pub art: Rect,
}

/// Which row of the panel a slot belongs to. The badge sits at a different
/// height in each: the CHANGE row's cards are drawn higher in their slot.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Row {
    Keep,
    Change,
}

impl Row {
    fn badge_offset(self) -> (u32, u32) {
        match self {
            Row::Keep => cal::MULLIGAN_BADGE_IN_KEEP,
            Row::Change => cal::MULLIGAN_BADGE_IN_CHANGE,
        }
    }

    fn card_top(self) -> u32 {
        match self {
            Row::Keep => cal::MULLIGAN_KEEP_TOP,
            Row::Change => cal::MULLIGAN_CHANGE_TOP,
        }
    }
}

/// Locate every card of one row, or refuse the frame.
///
/// `occupied` says which slots hold a card - ask [`crate::mulligan`], which can
/// answer it on frames this function refuses.
///
/// `None` means the row is not readable: a card was not found where a card must
/// be, or the cards disagree about where the row is. Both are the same fact -
/// the panel is not standing still - and neither is worth reporting per slot,
/// because a row is either settled or it is not.
pub fn locate_row(frame: &Frame, row: Row, occupied: [bool; 4]) -> Option<[Option<CardBox>; 4]> {
    let top = row.card_top();
    let (want_dx, want_dy) = row.badge_offset();

    let mut found: [Option<CardBox>; 4] = [None; 4];
    let mut offsets: Vec<(i64, i64)> = Vec::new();
    for (i, left) in cal::MULLIGAN_CARD_X.iter().enumerate() {
        if !occupied[i] {
            continue;
        }
        let badge = find_badge(frame, *left + want_dx, top + want_dy)?;
        offsets.push((
            i64::from(badge.x) - i64::from(*left),
            i64::from(badge.y) - i64::from(top),
        ));
        found[i] = Some(CardBox { badge, art: art_window(badge) });
    }

    // A row with nothing in it is not a located row. The caller asked where the
    // cards are; the answer "there are none" belongs to the occupancy check.
    if offsets.is_empty() {
        return None;
    }
    // Every card of a row is drawn by the same layout, so their badges share one
    // offset. Any spread beyond a couple of pixels means at least one of them is
    // not a badge - or the row is mid-flight.
    let (min_x, max_x) = span(offsets.iter().map(|o| o.0));
    let (min_y, max_y) = span(offsets.iter().map(|o| o.1));
    if max_x - min_x > cal::MULLIGAN_BADGE_AGREEMENT_PX as i64
        || max_y - min_y > cal::MULLIGAN_BADGE_AGREEMENT_PX as i64
    {
        return None;
    }

    Some(found)
}

/// Locate both rows of a settled panel.
///
/// The CHANGE row is only asked about while the player is still choosing; in the
/// other stage it does not exist. See [`crate::mulligan::Stage`].
pub fn locate(frame: &Frame, reading: &Mulligan) -> Option<PanelCards> {
    use crate::mulligan::Stage;
    let keep = locate_row(frame, Row::Keep, reading.keep)?;
    let change = match reading.stage {
        Stage::Waiting => [None; 4],
        Stage::Choosing => {
            if reading.change.iter().any(|c| *c) {
                locate_row(frame, Row::Change, reading.change)?
            } else {
                [None; 4]
            }
        }
    };
    Some(PanelCards { keep, change })
}

/// Every card the panel is showing, with its own geometry.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct PanelCards {
    pub keep: [Option<CardBox>; 4],
    pub change: [Option<CardBox>; 4],
}

fn span(values: impl Iterator<Item = i64>) -> (i64, i64) {
    values.fold((i64::MAX, i64::MIN), |(lo, hi), v| (lo.min(v), hi.max(v)))
}

/// The illustration window for a card whose badge is at `badge`.
///
/// The offsets are measured: with the badge at its nominal place the window is
/// the one the art comparison was calibrated on (see `docs/opening-hand-plan.md`,
/// stage 2's measurements), and anchoring it here is what carries that
/// calibration across the few pixels the panel drifts.
fn art_window(badge: Point) -> Rect {
    Rect::new(
        badge.x + cal::MULLIGAN_ART_FROM_BADGE.0,
        badge.y + cal::MULLIGAN_ART_FROM_BADGE.1,
        cal::MULLIGAN_ART_SIZE.0,
        cal::MULLIGAN_ART_SIZE.1,
    )
}

/// The badge's centre, searched for near where it should be.
///
/// Scored by "how much brighter is this disc than the ring just outside it",
/// which is the badge's defining property rather than brightness alone. The
/// search is bounded to [`cal::MULLIGAN_BADGE_SEARCH_PX`] around the nominal
/// position: a badge further away than that is a card in flight, and widening
/// the search would find it and report a card that is no longer where it says.
fn find_badge(frame: &Frame, centre_x: u32, centre_y: u32) -> Option<Point> {
    let r = cal::MULLIGAN_BADGE_RADIUS;
    let reach = cal::MULLIGAN_BADGE_SEARCH_PX;

    let source = &frame.levels[0];
    let mut best: Option<(f64, Point)> = None;
    for cy in centre_y.saturating_sub(reach)..=centre_y + reach {
        for cx in centre_x.saturating_sub(reach)..=centre_x + reach {
            if cx < r + 5 || cy < r + 5 || cx + r + 5 >= frame.width() || cy + r + 5 >= frame.height()
            {
                continue;
            }
            let mut inside = 0u64;
            let mut inside_n = 0u64;
            let mut outside = 0u64;
            let mut outside_n = 0u64;
            for dy in -(r as i64 + 5)..=(r as i64 + 5) {
                for dx in -(r as i64 + 5)..=(r as i64 + 5) {
                    let d2 = (dx * dx + dy * dy) as u64;
                    let value = u64::from(
                        source.get_pixel((cx as i64 + dx) as u32, (cy as i64 + dy) as u32)[0],
                    );
                    if d2 <= u64::from(r * r) {
                        inside += value;
                        inside_n += 1;
                    } else if d2 > u64::from((r + 2) * (r + 2)) {
                        outside += value;
                        outside_n += 1;
                    }
                }
            }
            if inside_n == 0 || outside_n == 0 {
                continue;
            }
            let score = inside as f64 / inside_n as f64 - outside as f64 / outside_n as f64;
            if best.is_none_or(|(b, _)| score > b) {
                best = Some((score, Point { x: cx, y: cy }));
            }
        }
    }

    best.filter(|(score, _)| *score >= cal::MULLIGAN_BADGE_CONTRAST).map(|(_, p)| p)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_art_window_travels_with_the_badge() {
        let a = art_window(Point { x: 202, y: 429 });
        let b = art_window(Point { x: 205, y: 431 });
        assert_eq!(b.x - a.x, 3);
        assert_eq!(b.y - a.y, 2);
        assert_eq!((a.w, a.h), cal::MULLIGAN_ART_SIZE);
    }

    /// With the badge where it nominally sits, the art window must be the one the
    /// portal-art comparison was measured against: slot + (12, 40), 128x145.
    #[test]
    fn the_nominal_badge_reproduces_the_calibrated_art_window() {
        let left = cal::MULLIGAN_CARD_X[0];
        let top = cal::MULLIGAN_KEEP_TOP;
        let (dx, dy) = Row::Keep.badge_offset();
        let art = art_window(Point { x: left + dx, y: top + dy });
        assert_eq!(art.x, left + 12, "the calibrated art window starts 12px in");
        assert_eq!(art.y, top + 40, "and 40px down");
        assert_eq!((art.w, art.h), (128, 145));
    }
}

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

/// How far past the disc's radius the ring reaches, and the gap between them.
///
/// The ring is the pixels further than `radius + RING_GAP` from the centre but
/// within `radius + RING_REACH` of it: a two-pixel guard band so the disc's own
/// anti-aliased edge counts for neither side, then three pixels of rim.
const RING_GAP: u32 = 2;
const RING_REACH: u32 = 5;

/// The badge's centre, searched for near where it should be.
///
/// Scored by "how much brighter is this disc than the ring just outside it",
/// which is the badge's defining property rather than brightness alone. The
/// search is bounded to [`cal::MULLIGAN_BADGE_SEARCH_PX`] around the nominal
/// position: a badge further away than that is a card in flight, and widening
/// the search would find it and report a card that is no longer where it says.
///
/// # How it is computed
///
/// The disc and the ring are both unions of horizontal runs, one per row, and
/// every candidate centre reads the same rows shifted by a pixel. So the patch
/// under the search is summed once per row (a prefix sum), and each candidate
/// costs one subtraction per run instead of one read per pixel. Measured on the
/// four settled fixtures this took locating a row from 3.8-4.0ms to well under a
/// millisecond, and it is arithmetically the same score: the same integer sums
/// over the same pixel sets, so the threshold measured for the pixel walk keeps
/// its meaning. The test below holds the two forms to identical output.
///
/// Not the frame's box integrals, although they are already built: a box is not
/// a disc, and a badge's rim is what separates it from bright art. Scoring a
/// square would change what [`cal::MULLIGAN_BADGE_CONTRAST`] measures.
fn find_badge(frame: &Frame, centre_x: u32, centre_y: u32) -> Option<Point> {
    let r = i64::from(cal::MULLIGAN_BADGE_RADIUS);
    let reach = i64::from(cal::MULLIGAN_BADGE_SEARCH_PX);
    let pad = r + i64::from(RING_REACH);
    let (width, height) = (i64::from(frame.width()), i64::from(frame.height()));

    // Candidate centres whose whole ring lies on the canvas. The nominal
    // positions are hundreds of pixels in, so this never actually clips; it is
    // here so the function cannot read outside the image.
    let cx_lo = (i64::from(centre_x) - reach).max(pad);
    let cx_hi = (i64::from(centre_x) + reach).min(width - pad - 1);
    let cy_lo = (i64::from(centre_y) - reach).max(pad);
    let cy_hi = (i64::from(centre_y) + reach).min(height - pad - 1);
    if cx_lo > cx_hi || cy_lo > cy_hi {
        return None;
    }

    // Per row offset from a centre: how far the disc and the guard band extend.
    // `None` where the row misses the shape entirely.
    let half_width = |dy: i64, radius: i64| -> Option<i64> {
        let rest = radius * radius - dy * dy;
        (rest >= 0).then(|| (rest as f64).sqrt().floor() as i64)
    };
    let guard = r + i64::from(RING_GAP);
    let rows: Vec<(i64, Option<i64>, Option<i64>)> =
        (-pad..=pad).map(|dy| (dy, half_width(dy, r), half_width(dy, guard))).collect();
    let inside_n: i64 = rows.iter().filter_map(|(_, disc, _)| disc.map(|h| 2 * h + 1)).sum();
    let outside_n: i64 = rows
        .iter()
        .map(|(_, _, band)| (2 * pad + 1) - band.map_or(0, |h| 2 * h + 1))
        .sum();
    if inside_n == 0 || outside_n == 0 {
        return None;
    }

    // Prefix sums of the patch every candidate reads from: `prefix[row][k]` is
    // the sum of the first `k` pixels of that row, starting at `x_lo`.
    let source = &frame.levels[0];
    let x_lo = cx_lo - pad;
    let patch_w = (cx_hi + pad - x_lo + 1) as usize;
    let y_lo = cy_lo - pad;
    let patch_h = (cy_hi + pad - y_lo + 1) as usize;
    let stride = patch_w + 1;
    let mut prefix = vec![0u64; stride * patch_h];
    for (py, row) in prefix.chunks_exact_mut(stride).enumerate() {
        let y = (y_lo + py as i64) as u32;
        let mut acc = 0u64;
        for (px, cell) in row.iter_mut().enumerate().skip(1) {
            acc += u64::from(source.get_pixel((x_lo + px as i64 - 1) as u32, y)[0]);
            *cell = acc;
        }
    }
    // Sum of the row's pixels from `a` to `b` inclusive, in canvas coordinates.
    let run = |py: usize, a: i64, b: i64| -> u64 {
        let row = &prefix[py * stride..(py + 1) * stride];
        row[(b - x_lo + 1) as usize] - row[(a - x_lo) as usize]
    };

    let mut best: Option<(f64, Point)> = None;
    for cy in cy_lo..=cy_hi {
        for cx in cx_lo..=cx_hi {
            let mut inside = 0u64;
            let mut outside = 0u64;
            for (dy, disc, band) in &rows {
                let py = (cy + dy - y_lo) as usize;
                if let Some(h) = disc {
                    inside += run(py, cx - h, cx + h);
                }
                let whole = run(py, cx - pad, cx + pad);
                outside += whole - band.map_or(0, |h| run(py, cx - h, cx + h));
            }
            let score = inside as f64 / inside_n as f64 - outside as f64 / outside_n as f64;
            if best.is_none_or(|(b, _)| score > b) {
                best = Some((score, Point { x: cx as u32, y: cy as u32 }));
            }
        }
    }

    best.filter(|(score, _)| *score >= cal::MULLIGAN_BADGE_CONTRAST).map(|(_, p)| p)
}

#[cfg(test)]
mod tests {
    use super::*;
    use image::Luma;
    use svwb_vision_native::GrayImage;

    /// The badge search as it was first written: every pixel of the square
    /// around every candidate centre, classified by its distance. Kept as the
    /// oracle for [`find_badge`], which must produce the same answer from the
    /// same pixels.
    fn find_badge_by_pixels(frame: &Frame, centre_x: u32, centre_y: u32) -> Option<(f64, Point)> {
        let r = cal::MULLIGAN_BADGE_RADIUS;
        let reach = cal::MULLIGAN_BADGE_SEARCH_PX;
        let source = &frame.levels[0];
        let mut best: Option<(f64, Point)> = None;
        for cy in centre_y.saturating_sub(reach)..=centre_y + reach {
            for cx in centre_x.saturating_sub(reach)..=centre_x + reach {
                if cx < r + 5 || cy < r + 5 || cx + r + 5 >= frame.width() || cy + r + 5 >= frame.height() {
                    continue;
                }
                let (mut inside, mut inside_n, mut outside, mut outside_n) = (0u64, 0u64, 0u64, 0u64);
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
                let score = inside as f64 / inside_n as f64 - outside as f64 / outside_n as f64;
                if best.is_none_or(|(b, _)| score > b) {
                    best = Some((score, Point { x: cx, y: cy }));
                }
            }
        }
        best
    }

    /// A canvas of deterministic texture with a bright disc painted on it, the
    /// texture so that every candidate position scores differently and a slip
    /// in either form shows up as a different argmax, not a rounding wobble.
    fn textured_canvas_with_disc(disc: Point, radius: u32) -> Frame {
        let mut gray = GrayImage::new(1280, 720);
        let mut seed = 0x2545_F491u32;
        for y in 0..720 {
            for x in 0..1280 {
                seed ^= seed << 13;
                seed ^= seed >> 17;
                seed ^= seed << 5;
                let noise = (seed % 60) as i64;
                let d2 = (i64::from(x) - i64::from(disc.x)).pow(2) + (i64::from(y) - i64::from(disc.y)).pow(2);
                let value = if d2 <= i64::from(radius * radius) { 170 + noise } else { 40 + noise };
                gray.put_pixel(x, y, Luma([value as u8]));
            }
        }
        Frame::from_image(&image::DynamicImage::ImageLuma8(gray))
    }

    /// The run-sum search and the pixel walk are the same function.
    ///
    /// Checked with the disc where the layout puts it, a few pixels off (the
    /// drift the search exists to absorb), and beyond the reach (where both must
    /// pick the same best-of-nothing), on the textured canvas above.
    #[test]
    fn the_run_sum_search_matches_the_pixel_walk() {
        let nominal = Point {
            x: cal::MULLIGAN_CARD_X[1] + cal::MULLIGAN_BADGE_IN_KEEP.0,
            y: cal::MULLIGAN_KEEP_TOP + cal::MULLIGAN_BADGE_IN_KEEP.1,
        };
        for (dx, dy) in [(0i64, 0i64), (3, -2), (-7, 6), (10, 10), (-25, 0)] {
            let disc = Point { x: (nominal.x as i64 + dx) as u32, y: (nominal.y as i64 + dy) as u32 };
            let frame = textured_canvas_with_disc(disc, cal::MULLIGAN_BADGE_RADIUS);
            let oracle = find_badge_by_pixels(&frame, nominal.x, nominal.y).expect("some best");
            let fast = find_badge(&frame, nominal.x, nominal.y);
            let accepted = oracle.0 >= cal::MULLIGAN_BADGE_CONTRAST;
            assert_eq!(fast, accepted.then_some(oracle.1), "disc at {disc:?}: oracle scored {:.3}", oracle.0);
            if dx.abs() <= 10 && dy.abs() <= 10 {
                assert_eq!(fast, Some(disc), "a disc within reach is found exactly");
            }
        }
    }

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

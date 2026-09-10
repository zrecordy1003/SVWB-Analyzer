//! A card's illustration, reduced to something small enough to compare against
//! a whole deck on every frame that matters.
//!
//! # Why the illustration and not the numbers
//!
//! Because the numbers cannot be read. The cost badge is a ~28px digit on a
//! translucent disc over art, and every way of reading it was measured against
//! 20 known badges: Tesseract at the engine's own binarisation threshold got
//! 1/20, at its best threshold 9/20, glyph matching 12/20. The illustration is
//! 128x145 pixels of signal instead of 28x28, and it separates cleanly.
//! See `docs/opening-hand-plan.md`, "階段 2 的可行性量測".
//!
//! # Why 32x36
//!
//! Measured against a 63-card candidate set, every size from 128x145 down to
//! 16x18 identifies all eight test cards. 32x36 has the widest margin of any of
//! them (+0.435 between the winner and the runner-up) and costs 1152 bytes per
//! card, so a whole class pool is a quarter of a megabyte. Below it the wrong
//! matches start climbing - 8x9 puts them at 0.622 - and above it nothing
//! improves.
//!
//! # Why both sides are reduced the same way
//!
//! A fingerprint from the screen and a fingerprint from the portal's card image
//! start at different resolutions, so they can only be compared if they pass
//! through the same reduction. Both are brought to the calibrated art window's
//! size first and box-averaged down from there by the same factor - box
//! averaging rather than sampling, because a 4x sample of illustration is noise.

use image::DynamicImage;
use svwb_vision_native::{GrayImage, Rect, downscale, resize_bilinear_opencv, to_gray_opencv};

use crate::calibration as cal;
use crate::frame::Frame;

/// The reduced patch's size, and the factor it is reduced by.
///
/// `MULLIGAN_ART_SIZE` divided by [`REDUCTION`], which is why the three are
/// stated together: changing one without the others silently produces
/// fingerprints that cannot be compared with the stored ones.
pub const REDUCTION: u32 = 4;
pub const FINGERPRINT_W: u32 = cal::MULLIGAN_ART_SIZE.0 / REDUCTION;
pub const FINGERPRINT_H: u32 = cal::MULLIGAN_ART_SIZE.1 / REDUCTION;
pub const FINGERPRINT_BYTES: usize = (FINGERPRINT_W * FINGERPRINT_H) as usize;

/// Bumped whenever anything above changes.
///
/// Stored beside every fingerprint so a change invalidates the lot rather than
/// silently comparing old vectors with new ones. There is no migration path for
/// a fingerprint and there should not be: they are derived data, and recomputing
/// them from the card images already on disk is cheap.
pub const ALGO_VERSION: u32 = 1;

/// Which part of a portal card image is the illustration.
///
/// The portal ships the whole card - frame, name band, cost badge, the lot - at
/// 530x687, while the screen shows it cropped tighter. Fitted against a real
/// frame: aligning the whole card scores 0.346, aligning these fractions scores
/// 0.695 on the same pair. The fractions rather than pixels because the portal
/// has shipped more than one image size.
pub const PORTAL_ART_FRACTION: (f64, f64, f64, f64) = (0.140, 0.198, 0.853, 0.837);

/// One card's illustration, reduced.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Fingerprint {
    bytes: Vec<u8>,
}

impl Fingerprint {
    /// Wrap stored bytes, or refuse them.
    ///
    /// Refusing is the point: a fingerprint of the wrong length is a stored
    /// vector from another algorithm version, and comparing it would produce a
    /// number rather than an error.
    pub fn from_bytes(bytes: Vec<u8>) -> Option<Self> {
        (bytes.len() == FINGERPRINT_BYTES).then_some(Self { bytes })
    }

    pub fn as_bytes(&self) -> &[u8] {
        &self.bytes
    }

    /// Mean-normalised correlation, the same measure every template score in
    /// this engine uses. 1.0 is identical; anything a card shares with every
    /// other card - overall brightness, overall contrast - is normalised away.
    pub fn similarity(&self, other: &Self) -> f64 {
        let mean = |v: &[u8]| v.iter().map(|b| f64::from(*b)).sum::<f64>() / v.len() as f64;
        let (ma, mb) = (mean(&self.bytes), mean(&other.bytes));
        let mut dot = 0.0;
        let mut sa = 0.0;
        let mut sb = 0.0;
        for (a, b) in self.bytes.iter().zip(&other.bytes) {
            let (a, b) = (f64::from(*a) - ma, f64::from(*b) - mb);
            dot += a * b;
            sa += a * a;
            sb += b * b;
        }
        let denom = (sa * sb).sqrt();
        if denom < 1e-9 { -1.0 } else { dot / denom }
    }
}

/// The fingerprint of a located card on screen.
///
/// `art` comes from [`crate::card`], which is the whole reason this can use a
/// fixed window: it has already checked that the card is where the layout says.
pub fn of_screen_art(frame: &Frame, art: Rect) -> Option<Fingerprint> {
    if art.x + art.w > frame.width() || art.y + art.h > frame.height() {
        return None;
    }
    let source = &frame.levels[0];
    let mut patch = GrayImage::new(art.w, art.h);
    for y in 0..art.h {
        for x in 0..art.w {
            patch.put_pixel(x, y, *source.get_pixel(art.x + x, art.y + y));
        }
    }
    Some(reduce(&patch))
}

/// The fingerprint of a portal card image.
///
/// The image is cropped to [`PORTAL_ART_FRACTION`], brought to the art window's
/// size, and reduced by the same step the screen side uses.
pub fn of_reference_card(image: &DynamicImage) -> Option<Fingerprint> {
    let gray = to_gray_opencv(image);
    let (w, h) = (f64::from(gray.width()), f64::from(gray.height()));
    let (x0, y0, x1, y1) = PORTAL_ART_FRACTION;
    let left = (w * x0).round() as u32;
    let top = (h * y0).round() as u32;
    let right = (w * x1).round() as u32;
    let bottom = (h * y1).round() as u32;
    if right <= left || bottom <= top || right > gray.width() || bottom > gray.height() {
        return None;
    }

    let mut art = GrayImage::new(right - left, bottom - top);
    for y in 0..art.height() {
        for x in 0..art.width() {
            art.put_pixel(x, y, *gray.get_pixel(left + x, top + y));
        }
    }
    let sized = resize_bilinear_opencv(&art, cal::MULLIGAN_ART_SIZE.0, cal::MULLIGAN_ART_SIZE.1);
    Some(reduce(&sized))
}

fn reduce(patch: &GrayImage) -> Fingerprint {
    let small = downscale(patch, REDUCTION);
    let mut bytes = Vec::with_capacity(FINGERPRINT_BYTES);
    for y in 0..FINGERPRINT_H {
        for x in 0..FINGERPRINT_W {
            // `downscale` floors the size, so a patch that is not an exact
            // multiple loses its last row or column rather than reading past it.
            let sx = x.min(small.width().saturating_sub(1));
            let sy = y.min(small.height().saturating_sub(1));
            bytes.push(small.get_pixel(sx, sy)[0]);
        }
    }
    Fingerprint { bytes }
}

/// The candidate cards a match could be holding, and the answer to "which one
/// is this".
///
/// A seam for the same reason [`crate::numbers::NumberReader`] is one: the
/// observation layer must not know where fingerprints are stored. A replay with
/// no database still reads panels, a state-machine test has no frame at all, and
/// the live engine looks the candidates up per match from the deck it thinks is
/// being played.
pub trait CardReader {
    /// `None` when nothing in the candidate set is clearly the best answer -
    /// which is also what an empty candidate set means.
    fn identify(&self, art: &Fingerprint) -> Option<Identified>;
}

/// Recognises nothing, always.
///
/// Not a stub to be removed: identifying cards needs a candidate set, and a
/// replay checking classes and outcomes has no deck to build one from.
pub struct NoCards;

impl CardReader for NoCards {
    fn identify(&self, _art: &Fingerprint) -> Option<Identified> {
        None
    }
}

/// A candidate set held in memory: the deck's cards, or a class pool.
pub struct CardIndex {
    candidates: Vec<(i64, Fingerprint)>,
}

impl CardIndex {
    pub fn new(candidates: Vec<(i64, Fingerprint)>) -> Self {
        Self { candidates }
    }

    pub fn len(&self) -> usize {
        self.candidates.len()
    }

    pub fn is_empty(&self) -> bool {
        self.candidates.is_empty()
    }
}

impl CardReader for CardIndex {
    fn identify(&self, art: &Fingerprint) -> Option<Identified> {
        identify(art, &self.candidates)
    }
}

/// Which card an illustration is, and how safely.
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct Identified {
    pub card_id: i64,
    /// How well the winner matched.
    pub score: f64,
    /// How far ahead of the runner-up it was. This is the number that decides,
    /// not `score` - see [`identify`].
    pub margin: f64,
}

/// Pick the candidate an illustration belongs to, or refuse.
///
/// **The margin decides, not the score.** A dim card in a dark scene scores
/// lower against everything, including itself, so an absolute threshold either
/// rejects it or admits false matches on brighter frames; the distance to the
/// runner-up is what stays stable. Measured over a 63-card candidate set: right
/// answers led by 0.389 or more, and the best wrong answer anywhere scored
/// 0.478.
///
/// A single candidate has no runner-up, so its margin is measured from the floor
/// instead - the alternative is to accept whatever is in the list.
pub fn identify(art: &Fingerprint, candidates: &[(i64, Fingerprint)]) -> Option<Identified> {
    let mut best: Option<(f64, i64)> = None;
    let mut second = f64::NEG_INFINITY;
    for (card_id, candidate) in candidates {
        let score = art.similarity(candidate);
        match best {
            Some((b, _)) if score <= b => second = second.max(score),
            Some((b, id)) => {
                second = second.max(b);
                let _ = id;
                best = Some((score, *card_id));
            }
            None => best = Some((score, *card_id)),
        }
    }

    let (score, card_id) = best?;
    if score < cal::CARD_ART_MIN_SCORE {
        return None;
    }
    let margin = if second.is_finite() { score - second } else { score };
    (margin >= cal::CARD_ART_MIN_MARGIN).then_some(Identified { card_id, score, margin })
}

#[cfg(test)]
mod tests {
    use super::*;

    fn fp(fill: impl Fn(u32, u32) -> u8) -> Fingerprint {
        let mut bytes = Vec::with_capacity(FINGERPRINT_BYTES);
        for y in 0..FINGERPRINT_H {
            for x in 0..FINGERPRINT_W {
                bytes.push(fill(x, y));
            }
        }
        Fingerprint { bytes }
    }

    #[test]
    fn the_size_is_the_art_window_reduced() {
        assert_eq!(FINGERPRINT_W * REDUCTION, cal::MULLIGAN_ART_SIZE.0);
        assert_eq!(FINGERPRINT_BYTES, 32 * 36);
    }

    #[test]
    fn a_stored_vector_of_the_wrong_length_is_refused() {
        assert!(Fingerprint::from_bytes(vec![0; FINGERPRINT_BYTES]).is_some());
        assert!(Fingerprint::from_bytes(vec![0; FINGERPRINT_BYTES - 1]).is_none());
    }

    #[test]
    fn a_fingerprint_matches_itself_and_not_a_different_one() {
        let a = fp(|x, y| ((x * 7 + y * 3) % 256) as u8);
        let b = fp(|x, y| ((x * 3 + y * 11) % 256) as u8);
        assert!((a.similarity(&a) - 1.0).abs() < 1e-9);
        assert!(a.similarity(&b) < 0.5, "got {}", a.similarity(&b));
    }

    /// Brightness and contrast are normalised away, which is what lets one
    /// reference image serve a bright scene and a dark one.
    #[test]
    fn overall_brightness_does_not_change_the_score() {
        let a = fp(|x, y| ((x * 7 + y * 3) % 200) as u8);
        let dimmer = fp(|x, y| (((x * 7 + y * 3) % 200) / 2 + 20) as u8);
        assert!(a.similarity(&dimmer) > 0.99, "got {}", a.similarity(&dimmer));
    }

    #[test]
    fn a_clear_winner_is_identified() {
        let art = fp(|x, y| ((x * 7 + y * 3) % 256) as u8);
        let other = fp(|x, y| ((x * 3 + y * 11) % 256) as u8);
        let found = identify(&art, &[(1, other), (2, art.clone())]).expect("a winner");
        assert_eq!(found.card_id, 2);
        assert!(found.margin > cal::CARD_ART_MIN_MARGIN);
    }

    /// Two candidates that are equally good are not an answer. This is the case
    /// a card printed in two versions produces, and guessing between them would
    /// be worse than recording "not recognised".
    #[test]
    fn a_tie_is_refused() {
        let art = fp(|x, y| ((x * 7 + y * 3) % 256) as u8);
        assert!(identify(&art, &[(1, art.clone()), (2, art.clone())]).is_none());
    }

    #[test]
    fn a_card_that_is_in_no_candidate_list_is_refused() {
        let art = fp(|x, y| ((x * 7 + y * 3) % 256) as u8);
        let unrelated = fp(|x, y| ((x % 3) * 90 + (y % 2) * 40) as u8);
        assert!(identify(&art, &[(1, unrelated)]).is_none());
    }

    #[test]
    fn no_candidates_is_no_answer() {
        assert!(identify(&fp(|_, _| 100), &[]).is_none());
    }
}

//! A picture of the opponent's name, cut from the versus screen.
//!
//! # Why a picture
//!
//! Because OCR was tried first and cannot read these names. Measured against
//! this exact row, with the same binarisation the number path uses:
//!
//! | sample            | truth          | best read over every variant tried |
//! |-------------------|----------------|------------------------------------|
//! | Latin             | `Bobybob`      | `Bobybob`, confidence 87-91        |
//! | Japanese          | `オベベインコ` | `オベべベベインコ` / `オペペインコ` |
//! | Traditional Chinese | `四月驟雨`   | `中月叔示`                          |
//!
//! The variants were: threshold 128/160/190, nearest-neighbour and bilinear
//! upscaling at 2x and 3x, ink-bounding-box trimming, `jpn` / `chi_tra` /
//! combined language packs, LSTM and legacy engines, and three page-segmentation
//! modes - plus reading the raw 1920x1080 frame instead of the normalised canvas,
//! to rule out the downscale. The Latin name was exact in every one of them; no
//! variant ever read either CJK name correctly.
//!
//! Multi-frame consensus does not rescue this. The errors are systematic
//! per-glyph confusions - a dakuten read as a handakuten, a kana doubled or
//! dropped - so ten frames agree on the same wrong string. And a name that is
//! wrong by one character is worse than no name: it looks usable, and it splits
//! one opponent into two or merges two into one.
//!
//! So the engine stores what it saw. The crop measures 379 bytes to 1.5 KB
//! across the fixtures, it is never wrong, and it needs no language pack in the
//! installer.
//!
//! # Why binarising is what makes this work at all
//!
//! The nameplate is drawn over character art. At [`OCR_BINARY_THRESHOLD`] the
//! art disappears almost entirely and the glyphs survive intact - the same
//! property the number windows rely on, for the same reason: this text is white
//! on a darkened panel.
//!
//! "Almost" is why [`cut`] does more than crop. Bright art at the left end of
//! the window binarises to solid white blobs, and the trim below is what keeps
//! them out of the stored picture.

use image::ImageEncoder;
use svwb_vision_native::GrayImage;

use crate::calibration::{NAMEPLATE_GAP, NAMEPLATE_RIGHT_EDGE, NAME_ENEMY};
use crate::frame::Frame;
use crate::numbers::OCR_BINARY_THRESHOLD;

/// Narrower than this is not a name.
///
/// The shortest real nameplate in the fixtures is 「はむ」 at 42px. This only has
/// to reject a lone speck of art that happens to land against the right edge,
/// so it sits far below that rather than close to it.
const MIN_WIDTH: u32 = 16;

/// Ink covering more of the plate than this is not text.
///
/// Glyphs are thin strokes with air around them: the six fixtures measure
/// 10.3% to 26.2% once trimmed, across Latin, kana and a 298px 稱號. Bright
/// character art binarises to a filled blob instead - the home screen's is
/// 82.3%, and it reaches the window's right edge, so it passes every other
/// check here.
///
/// That home screen cannot reach [`cut`] in the live engine, which only asks on
/// the frame a match was recognised from. This is the belt to that braces: the
/// window is not matched against a template, so nothing else would ever notice
/// it landing on art.
const MAX_DENSITY: f64 = 0.5;

/// Cut the opponent's nameplate out of a versus frame, or return `None`.
///
/// `None` is a real answer, not a failure: a CPU opponent has no name, and the
/// versus panel slides in, so a frame caught mid-slide has no nameplate at its
/// aligned position yet. Both are told apart from a real name by one measured
/// fact - see [`NAMEPLATE_RIGHT_EDGE`].
///
/// The caller gets PNG bytes, ready for the `Match.oppo_name_crop` column.
pub fn cut(frame: &Frame) -> Option<Vec<u8>> {
    let window = NAME_ENEMY;
    if window.x + window.w > frame.width() || window.y + window.h > frame.height() {
        return None;
    }

    let source = &frame.levels[0];
    let mut plate = GrayImage::new(window.w, window.h);
    for y in 0..window.h {
        for x in 0..window.w {
            let value = source.get_pixel(window.x + x, window.y + y)[0];
            plate.put_pixel(x, y, image::Luma([if value > OCR_BINARY_THRESHOLD { 255 } else { 0 }]));
        }
    }

    let (left, right) = ink_span(&plate)?;

    // Full height, trimmed width. The height is deliberately NOT trimmed to the
    // ink: every stored plate then shares one baseline, so a list of them lines
    // up instead of each name floating at its own offset. It costs nothing - the
    // rows above and below the glyphs are blank and compress to nothing.
    //
    // Written as white-on-TRANSPARENT rather than the white-on-black the
    // threshold produces. The panel's black is not part of the name, and a
    // rectangle of it dropped into a light-themed list is a black box with a
    // name in it. Transparent instead, the UI can use the plate as a mask and
    // paint the glyphs in whatever colour the row's text already uses, so it
    // reads the same in both themes. It costs nothing on disk either - the
    // alpha channel holds the same two values the grey one does, and PNG
    // compresses it away.
    let width = right - left + 1;
    let mut pixels = Vec::with_capacity((width * window.h * 2) as usize);
    for y in 0..window.h {
        for x in 0..width {
            let lit = plate.get_pixel(left + x, y)[0] > 0;
            pixels.extend_from_slice(&[255, if lit { 255 } else { 0 }]);
        }
    }

    let mut encoded = Vec::new();
    image::codecs::png::PngEncoder::new(&mut encoded)
        .write_image(&pixels, width, window.h, image::ExtendedColorType::La8)
        .ok()?;
    Some(encoded)
}

/// The columns the nameplate occupies, walking in from the right.
///
/// Right-to-left because the name is right-aligned and the art is not: the
/// right edge is a measured constant, and everything to the left of the first
/// wide gap belongs to the name. Scanning from the left would have to guess
/// where the art ends instead.
fn ink_span(plate: &GrayImage) -> Option<(u32, u32)> {
    let inked = |x: u32| (0..plate.height()).any(|y| plate.get_pixel(x, y)[0] > 0);

    let right = (0..plate.width()).rev().find(|&x| inked(x))?;
    if !NAMEPLATE_RIGHT_EDGE.contains(&(NAME_ENEMY.x + right)) {
        return None;
    }

    let mut left = right;
    let mut blank = 0;
    for x in (0..=right).rev() {
        if inked(x) {
            left = x;
            blank = 0;
        } else {
            blank += 1;
            if blank >= NAMEPLATE_GAP {
                break;
            }
        }
    }

    let width = right - left + 1;
    if width < MIN_WIDTH {
        return None;
    }

    let ink: u32 = (left..=right)
        .map(|x| (0..plate.height()).filter(|&y| plate.get_pixel(x, y)[0] > 0).count() as u32)
        .sum();
    let density = f64::from(ink) / f64::from(width * plate.height());
    (density <= MAX_DENSITY).then_some((left, right))
}

#[cfg(test)]
mod tests {
    use super::*;

    /// A plate with ink in the given window-relative columns, one pixel tall.
    fn plate(columns: &[u32]) -> GrayImage {
        let mut plate = GrayImage::new(NAME_ENEMY.w, NAME_ENEMY.h);
        for &x in columns {
            plate.put_pixel(x, 0, image::Luma([255]));
        }
        plate
    }

    /// Window-relative column of an absolute canvas x.
    fn at(absolute: u32) -> u32 {
        absolute - NAME_ENEMY.x
    }

    #[test]
    fn ink_short_of_the_right_edge_is_not_a_name() {
        // The CPU fixture's rightmost ink is at x=921 - character art in the
        // same row, and the reason this check exists rather than an ink-density
        // one: that crop is denser than two of the real nameplates.
        assert!(ink_span(&plate(&[at(880), at(900), at(921)])).is_none());
    }

    /// The MP result screen's panel arc ends at x=1136 and is both narrower and
    /// sparser than a nameplate, so position is the only thing that rejects it.
    #[test]
    fn ink_past_the_right_edge_is_not_a_name() {
        let columns: Vec<u32> = (at(1080)..=at(1136)).collect();
        assert!(ink_span(&plate(&columns)).is_none());
    }

    #[test]
    fn a_wide_gap_ends_the_plate_and_the_art_stays_out() {
        // Art at the left end, then a gap far wider than a space, then a name
        // ending at the measured right edge.
        let columns: Vec<u32> = (at(840)..at(870)).chain(at(1080)..=at(1127)).collect();
        let (left, right) = ink_span(&plate(&columns)).expect("the name is at the right edge");
        assert_eq!(NAME_ENEMY.x + left, 1080, "the art was kept");
        assert_eq!(NAME_ENEMY.x + right, 1127);
    }

    /// 「至高的宿命者 莉希婭菲爾」 - the space between a title and a name is
    /// 10px, and cutting there would throw the title away on every custom-room
    /// match.
    #[test]
    fn the_space_inside_a_title_does_not_end_the_plate() {
        let columns: Vec<u32> =
            (at(1000)..at(1060)).chain(at(1070)..=at(1127)).collect();
        let (left, _) = ink_span(&plate(&columns)).expect("a name is present");
        assert_eq!(NAME_ENEMY.x + left, 1000, "the title was cut off at its space");
    }

    /// The home screen's bright art fills 82.3% of the plate and reaches the
    /// right edge, so the alignment check alone lets it through.
    #[test]
    fn a_solid_blob_is_not_a_name() {
        let mut plate = GrayImage::new(NAME_ENEMY.w, NAME_ENEMY.h);
        for y in 0..NAME_ENEMY.h {
            for x in at(1060)..=at(1127) {
                plate.put_pixel(x, y, image::Luma([255]));
            }
        }
        assert!(ink_span(&plate).is_none());
    }

    #[test]
    fn a_lone_speck_at_the_right_edge_is_not_a_name() {
        assert!(ink_span(&plate(&[at(1127)])).is_none());
    }

    #[test]
    fn a_blank_row_has_no_nameplate() {
        assert!(ink_span(&plate(&[])).is_none());
    }
}

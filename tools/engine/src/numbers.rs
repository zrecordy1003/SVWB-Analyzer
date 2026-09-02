//! Reading the integers off a result screen.
//!
//! A seam, in the same shape as [`crate::frame_source::FrameSource`], and for
//! the same reason: there is more than one legitimate source, and which one is
//! in use must not be visible to anything downstream.
//!
//!   [`NoNumbers`]    reads nothing. Replay and tests that do not care.
//!   `HostReader`     asks the JS host's Tesseract (plan P6-a, in progress)
//!   `TemplateReader` digit templates (plan P6-c, conditional)
//!
//! This is deliberately NOT framed as a temporary bridge to be torn out. Nothing
//! about the design says the digits must be recognised in this process, and
//! Tesseract is not currently known to be reading them wrong - the case against
//! it turned out to rest on two claims that did not survive checking (see
//! 修訂紀錄 R-5). What matters is that the state machine cannot tell.
//!
//! Which WINDOWS to read is decided here rather than by the implementations,
//! because it depends on the result-screen layout and on the cursor - facts
//! about the frame, not about the recogniser.

use svwb_vision_native::Rect;

use crate::calibration::{self as cal, ScoreSystem, ScoreSystemHit, threshold};
use crate::frame::Frame;
use crate::machine::NumberReads;
use crate::templates::TemplateStore;

/// Threshold applied to a crop before it is handed to any recogniser.
///
/// One value for every reader, deliberately: it is part of what "the pixels the
/// recogniser sees" means, so two readers comparing results must binarise the
/// same way or the comparison is about preprocessing, not recognition.
pub const OCR_BINARY_THRESHOLD: u8 = 128;

/// Reads one integer out of one window of one frame.
///
/// `None` means "not readable from this frame" - the cursor is over the digits,
/// the text did not parse, the animation has not settled - never "absent for
/// good". The caller retries on the next frame and lets consensus decide.
pub trait NumberReader {
    fn read(&mut self, frame: &Frame, window: Rect) -> Option<i32>;
}

/// Reads nothing, always.
///
/// Not a stub to be removed: a replay that only checks classes, play order,
/// mode and outcome has no reason to pay for digit recognition, and a state
/// machine test has no frame to read from in the first place.
pub struct NoNumbers;

impl NumberReader for NoNumbers {
    fn read(&mut self, _frame: &Frame, _window: Rect) -> Option<i32> {
        None
    }
}

/// Parse a signed integer out of recognised text.
///
/// Named for what it does. The original was `parseBPGain`, which named one of
/// its six call sites: BP, gained MP, total MP, delta CR and total CR all went
/// through it, so the name suggested a BP-specific path that never existed.
///
/// Normalisation is Tesseract's tax - full-width signs and letter O for zero -
/// and is applied regardless of the reader, because a template recogniser that
/// confuses O and 0 would want exactly the same treatment.
pub fn parse_signed_int(raw: &str) -> Option<i32> {
    let cleaned: String = raw
        .chars()
        .filter(|c| !c.is_whitespace())
        .map(|c| match c {
            '＋' | '﹢' => '+',
            '－' | '﹣' => '-',
            'O' | 'o' => '0',
            other => other,
        })
        .collect();

    let (sign, digits) = match cleaned.strip_prefix('-') {
        Some(rest) => (-1, rest),
        None => (1, cleaned.strip_prefix('+').unwrap_or(&cleaned)),
    };
    if digits.is_empty() || !digits.chars().all(|c| c.is_ascii_digit()) {
        return None;
    }
    digits.parse::<i32>().ok().map(|n| sign * n)
}

/// Whether the mouse cursor is sitting on top of the digits.
///
/// Several overlapping windows rather than one: the cursor can straddle the
/// edge of a single window, and taking the best score across all of them guards
/// that boundary case. A blocked read is skipped, not guessed - the screen stays
/// up long enough to try again.
fn cursor_blocks(frame: &Frame, store: &TemplateStore, windows: &[Rect], dy: i32) -> bool {
    windows.iter().any(|window| {
        let shifted = cal::shift_roi(*window, dy);
        store
            .best_in(frame, cal::templates::CURSOR, shifted)
            .is_some_and(|hit| hit.score > threshold::CURSOR_BLOCK)
    })
}

/// How far the MP block has slid on this frame, or `None` if its label is not
/// on screen.
///
/// The label lives in the same bordered box as the value on the 「獲得MP」 row,
/// so "the value is readable but the label is not" is not a state the screen
/// has - which is what makes refusing to read safe rather than lossy.
fn mp_block_offset(frame: &Frame, store: &TemplateStore) -> Option<i32> {
    store
        .best_in(frame, cal::templates::MP_GAIN, cal::MP_GAIN_ANCHOR)
        .filter(|hit| hit.score >= threshold::MP_GAIN)
        .map(|hit| cal::mp_block_offset(hit.y))
}

/// Read whichever numbers this result screen is showing.
///
/// Returns everything empty when the screen carries no score-system label:
/// that is not a ranked result, so it owes nothing. The exception is 2Pick,
/// which shows its BP gain on a layout of its own.
///
/// 2Pick is checked FIRST, and not only for tidiness: the 2Pick result screen
/// also carries a 「BP N」 that the ranked score-system template matches, so
/// falling through to the ranked branch would read the ranked windows against a
/// 2Pick layout. The mode is settled on the versus screen long before this runs.
pub fn read_all(
    frame: &Frame,
    store: &TemplateStore,
    reader: &mut dyn NumberReader,
    score_system: Option<ScoreSystemHit>,
    two_pick: bool,
) -> NumberReads {
    let mut out = NumberReads::default();

    if two_pick {
        let layout = &cal::BP_LAYOUT_2PICK;
        if !cursor_blocks(frame, store, layout.cursor, 0) {
            out.bp = reader.read(frame, layout.value);
        }
        return out;
    }

    let Some(hit) = score_system else {
        return out;
    };
    // A property of THIS frame: the reward list's row count slides everything
    // below it, so the offset must be recomputed every tick rather than latched.
    let dy = cal::result_layout_offset(&hit);

    match hit.system {
        ScoreSystem::Bp => {
            let layout = &cal::BP_LAYOUT_RANKED;
            if !cursor_blocks(frame, store, layout.cursor, dy) {
                out.bp = reader.read(frame, cal::shift_roi(layout.value, dy));
            }
        }
        ScoreSystem::Mp => {
            // One cursor test for the whole block: the four values sit inside
            // the same panel, so a cursor over one is over the group.
            if cursor_blocks(frame, store, cal::MP_CURSOR_WINDOWS, dy) {
                return out;
            }
            // The MP half of the panel is anchored to its own label, because
            // rows drawn under the MP bar move it without moving the CR half -
            // see `cal::MP_GAIN_ANCHOR`. No label, no MP read: a window placed
            // by guesswork lands on a neighbouring row as readily as on empty
            // space, and digits from the wrong row parse.
            if let Some(dy_mp) = mp_block_offset(frame, store) {
                out.delta_mp = reader.read(frame, cal::shift_roi(cal::GAINED_MP, dy_mp));
                out.total_mp = reader.read(frame, cal::shift_roi(cal::TOTAL_MP, dy_mp));
            }
            out.delta_cr = reader.read(frame, cal::shift_roi(cal::DELTA_CR_MP_LAYOUT, dy));
            out.total_cr = reader.read(frame, cal::shift_roi(cal::TOTAL_CR_MP_LAYOUT, dy));
        }
    }

    out
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn signs_and_digits_round_trip() {
        assert_eq!(parse_signed_int("+124"), Some(124));
        assert_eq!(parse_signed_int("-16"), Some(-16));
        assert_eq!(parse_signed_int("41743"), Some(41743));
        assert_eq!(parse_signed_int("8"), Some(8));
    }

    /// Tesseract returns full-width signs and letter O for zero. A template
    /// recogniser that confused the same glyphs would want the same treatment,
    /// which is why this lives here and not behind one implementation.
    #[test]
    fn tesseract_quirks_are_normalised() {
        assert_eq!(parse_signed_int("＋15"), Some(15));
        assert_eq!(parse_signed_int("－16"), Some(-16));
        assert_eq!(parse_signed_int("15O2"), Some(1502));
        assert_eq!(parse_signed_int(" +14 "), Some(14));
    }

    /// Anything that is not an integer must be refused rather than coerced. A
    /// misplaced window still reads SOMETHING - the bug this guards is a window
    /// that drifted onto a neighbouring row, not one that reads nothing.
    #[test]
    fn noise_is_refused_not_coerced() {
        assert_eq!(parse_signed_int(""), None);
        assert_eq!(parse_signed_int("+"), None);
        assert_eq!(parse_signed_int("-"), None);
        assert_eq!(parse_signed_int("P：88794"), None);
        assert_eq!(parse_signed_int("12.5"), None);
        assert_eq!(parse_signed_int("1 557"), Some(1557), "internal spaces are stripped");
    }

    /// A reader that reads nothing must be indistinguishable from a frame with
    /// nothing on it, so the machine's retry path is exercised either way.
    #[test]
    fn no_numbers_reads_nothing() {
        let mut reader = NoNumbers;
        let dummy = Frame::from_image(&image::DynamicImage::new_luma8(4, 4));
        assert_eq!(reader.read(&dummy, Rect::new(0, 0, 1, 1)), None);
    }
}

//! The mulligan panel: which stage it is showing, and which slots hold a card.
//!
//! # What the screen does
//!
//! The panel is two rows of four slots. The opening hand is dealt into the
//! bottom row (KEEP); choosing to throw a card away MOVES it into the top row
//! (CHANGE), into the slot of the SAME index. Confirming makes the top row
//! disappear and leaves the FINAL four cards in the bottom row, in the same four
//! positions, while the game waits for the opponent.
//!
//! Two things follow from that, and both are why this module is small:
//!
//! 1. **"Which cards were swapped" is a question about geometry, not content.**
//!    A card in CHANGE slot 2 means the second card of the opening hand is being
//!    thrown away. Nothing has to be recognised to know that.
//! 2. **Before and after share one set of windows.** The hand before the swap and
//!    the hand after it are drawn in the same four rectangles; only the stage
//!    differs. See [`cal::MULLIGAN_KEEP_SLOTS`].
//!
//! # Why contrast decides whether a slot holds a card
//!
//! An empty slot is flat: the KEEP row's is bare dark panel, the CHANGE row's is
//! the same plus a faint recycle glyph. A card is a bright name band, art, and
//! two badges. Measured over the fixtures, the fraction of pixels more than
//! [`INK_ABOVE_MEDIAN`] brighter than the slot's own median is 0.000-0.009 for an
//! empty slot and 0.085-0.334 for an occupied one - a tenfold gap, with
//! [`OCCUPIED_FRACTION`] in the middle of it.
//!
//! The median is taken per slot rather than fixed, because the panel darkens and
//! brightens with the battlefield behind it; what stays constant is that a card
//! is much brighter than its own background and an empty slot is not.

use svwb_vision_native::Rect;

use crate::calibration::{self as cal, templates as tpl, threshold};
use crate::frame::Frame;
use crate::templates::TemplateStore;

/// How much brighter than the slot's median a pixel must be to count as ink.
const INK_ABOVE_MEDIAN: u32 = 50;

/// The fraction of ink above which a slot is holding a card.
const OCCUPIED_FRACTION: f64 = 0.04;

/// Which half of the mulligan is on screen.
#[derive(Debug, Clone, Copy, PartialEq, Eq, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub enum Stage {
    /// The player is still choosing. Both rows are drawn, and the KEEP row is
    /// the hand as it was DEALT minus whatever has been moved up so far.
    Choosing,
    /// The choice is in and the game is waiting for the opponent. The CHANGE row
    /// is gone and the KEEP row is the FINAL hand.
    Waiting,
}

/// One frame of the mulligan panel.
#[derive(Debug, Clone, Copy, PartialEq, Eq, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Mulligan {
    pub stage: Stage,
    /// Which KEEP slots hold a card, left to right.
    pub keep: [bool; 4],
    /// Which CHANGE slots hold a card - i.e. which cards are being thrown away.
    ///
    /// Always all-false in [`Stage::Waiting`], where the row does not exist. That
    /// is not "nothing was swapped": ask this in `Choosing`, on the last frame
    /// before the panel changes stage.
    pub change: [bool; 4],
}

impl Mulligan {
    /// How many cards are being thrown away. Meaningless in [`Stage::Waiting`].
    pub fn change_count(&self) -> usize {
        self.change.iter().filter(|c| **c).count()
    }

    /// Every slot of the dealt hand accounted for, exactly once.
    ///
    /// The dealt hand is four cards, so during `Choosing` each column holds its
    /// card in one row or the other. A column with a card in both rows, or in
    /// neither, is a frame caught mid-animation - the card is in the air between
    /// the two - and must not be read as a hand. This is the check that keeps
    /// those frames out; see [`Stage::Choosing`].
    pub fn is_settled(&self) -> bool {
        match self.stage {
            Stage::Choosing => (0..4).all(|i| self.keep[i] != self.change[i]),
            Stage::Waiting => self.keep.iter().all(|k| *k),
        }
    }
}

/// Read the mulligan panel, or `None` when this frame is not showing one.
///
/// `None` is the answer for every other screen in the game, which is what the
/// labels are for: see [`cal::MULLIGAN_KEEP`] for the measured separation.
pub fn read(frame: &Frame, templates: &TemplateStore) -> Option<Mulligan> {
    let keep_label = label_hit(frame, templates, cal::MULLIGAN_KEEP, "keep");
    let change_label = label_hit(frame, templates, cal::MULLIGAN_CHANGE, "change");
    let stage = classify(change_label, keep_label)?;

    let keep = occupancy(frame, &cal::MULLIGAN_KEEP_SLOTS);
    let change = match stage {
        // The row is not on screen; the battlefield showing through where it used
        // to be would read as four occupied slots.
        Stage::Waiting => [false; 4],
        Stage::Choosing => occupancy(frame, &cal::MULLIGAN_CHANGE_SLOTS),
    };

    Some(Mulligan { stage, keep, change })
}

/// The stage the two labels imply.
///
/// Kept separate from [`read`] so the rule is testable without a frame: it is one
/// line, and it is the whole state machine of this screen.
fn classify(change_label: bool, keep_label: bool) -> Option<Stage> {
    match (keep_label, change_label) {
        (true, true) => Some(Stage::Choosing),
        (true, false) => Some(Stage::Waiting),
        // CHANGE without KEEP is not a stage. The KEEP label is drawn in both,
        // so its absence means whatever matched up top was not this panel.
        (false, _) => None,
    }
}

/// Whether the named template of the `mulligan` set is the best hit in `window`.
///
/// The name is checked, not just the score: both labels are in one set, so a
/// window that happens to like the other one must not count as its own. This is
/// the same guard the score-system windows use.
fn label_hit(frame: &Frame, templates: &TemplateStore, window: Rect, name: &str) -> bool {
    templates
        .best_in(frame, tpl::MULLIGAN, window)
        .is_some_and(|hit| hit.name == name && hit.score > threshold::MULLIGAN)
}

fn occupancy(frame: &Frame, slots: &[Rect; 4]) -> [bool; 4] {
    [
        occupied(frame, slots[0]),
        occupied(frame, slots[1]),
        occupied(frame, slots[2]),
        occupied(frame, slots[3]),
    ]
}

/// Whether `slot` holds a card.
///
/// A slot outside the frame is not a card, for the same reason an unreadable
/// number is not a zero.
fn occupied(frame: &Frame, slot: Rect) -> bool {
    if slot.x + slot.w > frame.width() || slot.y + slot.h > frame.height() {
        return false;
    }

    let source = &frame.levels[0];
    let mut histogram = [0u32; 256];
    for y in slot.y..slot.y + slot.h {
        for x in slot.x..slot.x + slot.w {
            histogram[source.get_pixel(x, y)[0] as usize] += 1;
        }
    }

    let total = slot.w * slot.h;
    let median = {
        let mut seen = 0;
        let mut value = 0u32;
        for (level, count) in histogram.iter().enumerate() {
            seen += count;
            if seen * 2 >= total {
                value = level as u32;
                break;
            }
        }
        value
    };

    let floor = (median + INK_ABOVE_MEDIAN).min(255) as usize;
    let ink: u32 = histogram[floor..].iter().sum();
    f64::from(ink) / f64::from(total) > OCCUPIED_FRACTION
}

#[cfg(test)]
mod tests {
    use super::*;
    use image::Luma;
    use svwb_vision_native::GrayImage;

    /// A canvas-sized frame of flat `background`, with `bright` painted over the
    /// first `rows` rows of each named slot.
    fn frame_with(background: u8, slots: &[(Rect, u32)]) -> Frame {
        let mut gray = GrayImage::from_pixel(1280, 720, Luma([background]));
        for (slot, rows) in slots {
            for y in slot.y..slot.y + rows {
                for x in slot.x..slot.x + slot.w {
                    gray.put_pixel(x, y, Luma([background.saturating_add(120)]));
                }
            }
        }
        Frame::from_image(&image::DynamicImage::ImageLuma8(gray))
    }

    #[test]
    fn a_flat_slot_holds_nothing() {
        let frame = frame_with(40, &[]);
        assert!(!occupied(&frame, cal::MULLIGAN_KEEP_SLOTS[0]));
    }

    /// The recycle glyph in an empty CHANGE slot is a few percent of the slot at
    /// most; the measured fixtures put an empty slot at 0.9% ink and a card at
    /// 8.5% or more.
    #[test]
    fn a_faint_glyph_is_not_a_card() {
        let slot = cal::MULLIGAN_CHANGE_SLOTS[1];
        let frame = frame_with(40, &[(slot, slot.h / 50)]); // 2% of the slot
        assert!(!occupied(&frame, slot));
    }

    #[test]
    fn a_bright_slot_holds_a_card() {
        let slot = cal::MULLIGAN_KEEP_SLOTS[2];
        let frame = frame_with(40, &[(slot, slot.h / 4)]); // 25%
        assert!(occupied(&frame, slot));
    }

    /// A card is brighter than ITS OWN slot, not brighter than some fixed value:
    /// the panel dims and brightens with the battlefield behind it.
    #[test]
    fn a_bright_background_does_not_fill_every_slot() {
        let frame = frame_with(190, &[]);
        assert!(!occupied(&frame, cal::MULLIGAN_KEEP_SLOTS[0]));
    }

    #[test]
    fn both_labels_mean_the_player_is_still_choosing() {
        assert_eq!(classify(true, true), Some(Stage::Choosing));
    }

    #[test]
    fn keep_alone_means_the_hand_is_final() {
        assert_eq!(classify(false, true), Some(Stage::Waiting));
    }

    #[test]
    fn change_without_keep_is_not_the_panel() {
        assert_eq!(classify(true, false), None);
        assert_eq!(classify(false, false), None);
    }

    #[test]
    fn a_card_in_the_air_is_not_a_settled_hand() {
        let mid_flight = Mulligan {
            stage: Stage::Choosing,
            keep: [false, true, true, true],
            change: [false, false, false, false],
        };
        assert!(!mid_flight.is_settled());

        let landed = Mulligan {
            stage: Stage::Choosing,
            keep: [false, true, true, true],
            change: [true, false, false, false],
        };
        assert!(landed.is_settled());
        assert_eq!(landed.change_count(), 1);
    }
}

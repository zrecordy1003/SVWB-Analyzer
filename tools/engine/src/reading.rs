//! Turning probe scores into a [`Reading`].
//!
//! This is the only place a threshold is compared against a score. Everything
//! downstream deals in "the versus screen is up" rather than in "classesOwn
//! scored 0.83", which is what lets the state machine be tested without images.
//!
//! It is deliberately dumb: no history, no accumulation, no phase awareness. A
//! probe that fires here has been SEEN, not believed - whether it may be acted
//! on is the machine's decision. See the module docs on `machine`.

use crate::calibration::{self as cal, ScoreSystem, ScoreSystemHit, threshold};
use crate::frame::Frame;
use crate::machine::{Located, NumberReads, Reading, VersusScreen, WatchedScore};
use crate::numbers::{self, NumberReader};
use crate::protocol::{ClassName, PlayOrder};
use crate::templates::{Hit, TemplateStore};

impl ClassName {
    /// Template file stems under `resources/templates/classes` and `/emblems`.
    fn from_template(name: &str) -> Option<Self> {
        Some(match name {
            "elf" => ClassName::Elf,
            "royal" => ClassName::Royal,
            "witch" => ClassName::Witch,
            "dragon" => ClassName::Dragon,
            "bishop" => ClassName::Bishop,
            "nightmare" => ClassName::Nightmare,
            "nemesis" => ClassName::Nemesis,
            _ => return None,
        })
    }
}

impl PlayOrder {
    fn from_template(name: &str) -> Option<Self> {
        Some(match name {
            "first" => PlayOrder::First,
            "second" => PlayOrder::Second,
            _ => return None,
        })
    }
}

/// The best of several probes, if any cleared `threshold`.
///
/// Ported from `pickBestResult`. Named for the question it answers rather than
/// for what it does to a list.
fn best_above<'a>(candidates: &[&'a Hit], threshold: f64) -> Option<&'a Hit> {
    candidates
        .iter()
        .copied()
        .filter(|hit| hit.score > threshold)
        .max_by(|a, b| a.score.total_cmp(&b.score))
}

/// Read the play order from either side of the versus screen.
///
/// The overlay appears on both sides, and the SIDE it was read from decides
/// whether the label means what it says: "first" seen on the opponent's half
/// means the player went second. Getting this backwards would invert the play
/// order of every match, silently and systematically.
fn read_play_order(own: &Hit, enemy: &Hit) -> Option<PlayOrder> {
    let own_wins = own.score >= enemy.score;
    let best = if own_wins { own } else { enemy };
    if best.score <= threshold::PLAY_ORDER {
        return None;
    }
    let literal = PlayOrder::from_template(&best.name)?;
    Some(if own_wins {
        literal
    } else {
        match literal {
            PlayOrder::First => PlayOrder::Second,
            PlayOrder::Second => PlayOrder::First,
        }
    })
}

/// Identify the point system on a ranked result screen.
///
/// Above Grand Master the game stops showing BP and shows MP + CR instead, and
/// the two layouts put their numbers in completely different places - so reading
/// values without establishing the layout first would write the wrong number
/// into the wrong column. Both templates compete inside one window and the
/// winner must clear the threshold, so an unrecognised screen yields `None`
/// rather than defaulting to a guess.
fn read_score_system(hit: Option<Hit>) -> Option<ScoreSystemHit> {
    let hit = hit?;
    if hit.score < threshold::SCORE_SYSTEM {
        return None;
    }
    let system = match hit.name.as_str() {
        "bp" => ScoreSystem::Bp,
        "cr" => ScoreSystem::Mp,
        _ => return None,
    };
    Some(ScoreSystemHit { system, x: hit.x, y: hit.y, score: hit.score })
}

/// Score every probe against one frame and interpret the results.
///
/// Digits go through a [`NumberReader`], so a replay with no number source and a
/// live run with one produce the same shape of `Reading`.
///
/// `wants_numbers` exists because reading digits is the one EXPENSIVE probe. The
/// template windows are calibrated and cost microseconds, so they run
/// unconditionally; a number read crosses a process boundary to Tesseract. The
/// shipped analyzer guarded every one of its six number reads on
/// `activeMatchId !== null`, and the caller passes the same fact here - there is
/// nothing to attach a number to when no match is open, so asking would be pure
/// cost.
pub fn read(
    frame: &Frame,
    store: &TemplateStore,
    reader: &mut dyn NumberReader,
    wants_numbers: bool,
) -> Reading {
    let probe = |set: &str, window| store.best_in(frame, set, window);
    let no_hit = Hit { name: String::new(), score: -1.0, x: 0, y: 0 };
    let scored = |hit: Option<Hit>| hit.unwrap_or_else(|| no_hit.clone());

    let own_class = scored(probe(cal::templates::CLASSES, cal::CLASSES_OWN));
    let enemy_class = scored(probe(cal::templates::CLASSES, cal::CLASSES_ENEMY));
    let own_emblem = scored(probe(cal::templates::EMBLEMS, cal::EMBLEMS_OWN));
    let enemy_emblem = scored(probe(cal::templates::EMBLEMS, cal::EMBLEMS_ENEMY));
    let own_order = scored(probe(cal::templates::PLAY_ORDER, cal::PLAY_ORDER_OWN));
    let enemy_order = scored(probe(cal::templates::PLAY_ORDER, cal::PLAY_ORDER_ENEMY));

    // Class and emblem are two views of the same fact, so either may carry it.
    let my_class = best_above(&[&own_class, &own_emblem], threshold::CLASS)
        .and_then(|hit| ClassName::from_template(&hit.name));
    let oppo_class = best_above(&[&enemy_class, &enemy_emblem], threshold::CLASS)
        .and_then(|hit| ClassName::from_template(&hit.name));
    let play_order = read_play_order(&own_order, &enemy_order);

    // All three or nothing: a match may only start when the whole screen was
    // read, and a partial versus screen is a frame caught mid-transition.
    let versus = match (my_class, oppo_class, play_order) {
        (Some(my_class), Some(oppo_class), Some(play_order)) => {
            Some(VersusScreen { my_class, oppo_class, play_order })
        }
        _ => None,
    };

    let splash = scored(probe(cal::templates::RESULT_MID, cal::RESULT_MID));
    let final_banner = scored(probe(cal::templates::RESULT, cal::RESULT));
    let cpu_pre = scored(probe(cal::templates::MODES_CPU, cal::MODES_CPU_PRE_BATTLE));
    let cpu_result = scored(probe(cal::templates::MODES_CPU, cal::MODES_CPU_RESULT));
    let two_pick = scored(probe(cal::templates::MODES_2PICK, cal::MODES_2PICK));
    let two_pick_own =
        scored(probe(cal::templates::MODES_2PICK_VERSUS, cal::TWO_PICK_VERSUS_OWN));
    let two_pick_enemy =
        scored(probe(cal::templates::MODES_2PICK_VERSUS, cal::TWO_PICK_VERSUS_ENEMY));
    let custom_own = scored(probe(cal::templates::CUSTOM, cal::CUSTOM_OWN));
    let custom_other = scored(probe(cal::templates::CUSTOM, cal::CUSTOM_OTHER));
    let plaza = scored(probe(cal::templates::MODES_PLAZA, cal::MODES_PLAZA));
    let banner = scored(probe(cal::templates::HISTORY, cal::HISTORY));
    let chrome = scored(probe(cal::templates::REPLAY_CHROME, cal::REPLAY_CHROME));

    // Both decide WHICH number windows are on this layout, so they are needed
    // before the digits can be read at all.
    let score_system =
        read_score_system(probe(cal::templates::SCORE_SYSTEM, cal::SCORE_SYSTEM_ANCHOR));
    let two_pick_seen = two_pick.score > threshold::RANKED;

    // The three the shipped analyzer watched: the two result banners and the CPU
    // label. All three gate a recording, so a drift in any of them loses matches
    // silently.
    let watched = [
        WatchedScore { label: "result", score: final_banner.score, threshold: threshold::RESULT },
        WatchedScore {
            label: "resultMid",
            score: splash.score,
            threshold: threshold::RESULT_MID,
        },
        WatchedScore {
            label: "modesCPU",
            score: cpu_pre.score.max(cpu_result.score),
            threshold: threshold::CPU,
        },
    ];

    Reading {
        watched,
        replay_banner: banner.score > threshold::REPLAY_BANNER,
        replay_chrome: chrome.score > threshold::REPLAY_CHROME,
        versus,
        // The set holds `win` and `gameset`: a win shows its own banner, a loss
        // shows the neutral end-of-game one.
        battle_end_splash: (splash.score > threshold::RESULT_MID)
            .then(|| splash.name == "win"),
        final_result: (final_banner.score > threshold::RESULT)
            .then(|| final_banner.name == "win"),
        score_system,
        cpu_pre_battle: cpu_pre.score >= threshold::CPU,
        cpu_anywhere: cpu_pre.score.max(cpu_result.score) >= threshold::CPU,
        two_pick: two_pick_seen,
        // Either player's row will do - see `TWO_PICK_VERSUS_OWN`.
        two_pick_versus: best_above(&[&two_pick_own, &two_pick_enemy], threshold::RANKED)
            .is_some(),
        // The window matches the WHOLE set, not one label: which side shows 室長
        // depends on whether the user hosted, so both compete on both sides.
        custom_room: best_above(&[&custom_own, &custom_other], threshold::CUSTOM).is_some(),
        plaza: (plaza.score > threshold::PLAZA)
            .then(|| (Located { x: plaza.x, y: plaza.y }, plaza.score)),
        numbers: if wants_numbers {
            numbers::read_all(frame, store, reader, score_system, two_pick_seen)
        } else {
            NumberReads::default()
        },
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn hit(name: &str, score: f64) -> Hit {
        Hit { name: name.into(), score, x: 0, y: 0 }
    }

    /// "first" read on the OPPONENT's half means the player went second.
    /// Getting this backwards inverts the play order of every match, silently.
    #[test]
    fn a_label_on_the_enemy_side_is_inverted() {
        let quiet = hit("", -1.0);
        assert_eq!(
            read_play_order(&quiet, &hit("first", 0.9)),
            Some(PlayOrder::Second),
            "the enemy going first means we went second"
        );
        assert_eq!(
            read_play_order(&hit("first", 0.9), &quiet),
            Some(PlayOrder::First),
            "our own side reads literally"
        );
    }

    /// Both sides carry the overlay; the stronger reading wins, and only then is
    /// the side used to decide whether to invert.
    #[test]
    fn the_stronger_side_decides() {
        assert_eq!(
            read_play_order(&hit("first", 0.65), &hit("second", 0.95)),
            Some(PlayOrder::First),
            "enemy 'second' is our 'first'"
        );
    }

    #[test]
    fn a_weak_play_order_is_no_play_order() {
        // Below threshold on both sides: the overlay is not on screen yet.
        assert_eq!(read_play_order(&hit("first", 0.5), &hit("second", 0.4)), None);
    }

    /// `cr` on screen means the MP system is in play - the CR label is what
    /// accompanies MP above Grand Master. Mapping it to `Bp` would send every
    /// number to the wrong column.
    #[test]
    fn the_cr_label_means_the_mp_system() {
        let read = read_score_system(Some(hit("cr", 1.0))).expect("should identify");
        assert_eq!(read.system, ScoreSystem::Mp);
        assert_eq!(read_score_system(Some(hit("bp", 1.0))).unwrap().system, ScoreSystem::Bp);
    }

    /// An unrecognised result screen yields nothing rather than defaulting.
    #[test]
    fn an_unreadable_label_is_not_a_guess() {
        assert!(read_score_system(None).is_none());
        assert!(read_score_system(Some(hit("bp", 0.41))).is_none(), "below threshold");
        assert!(read_score_system(Some(hit("something", 1.0))).is_none(), "unknown label");
    }

    /// Class and emblem are two views of the same fact, so the better one wins.
    #[test]
    fn either_class_view_can_carry_the_reading() {
        let class = hit("witch", 0.72);
        let emblem = hit("bishop", 0.95);
        let best = best_above(&[&class, &emblem], threshold::CLASS).unwrap();
        assert_eq!(best.name, "bishop");

        let weak = hit("witch", 0.5);
        assert!(best_above(&[&weak], threshold::CLASS).is_none());
    }
}

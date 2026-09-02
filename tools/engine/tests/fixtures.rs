//! What the engine concludes from real frames.
//!
//! `check-engine-parity.cjs` proves the engine SCORES windows exactly as the
//! addon does. This proves it draws the right conclusions from those scores -
//! a different failure entirely, since a correct score fed through the wrong
//! threshold, or read off the wrong side of the versus screen, produces
//! identical numbers and an inverted match.
//!
//! These are the shipped fixtures, so a template or threshold change that breaks
//! a real screen fails here rather than in a user's match history.

use std::path::{Path, PathBuf};
use std::sync::OnceLock;

use svwb_engine::calibration::{self, ScoreSystem};
use svwb_engine::frame::Frame;
use svwb_engine::machine::Reading;
use svwb_engine::numbers::NoNumbers;
use svwb_engine::protocol::PlayOrder;
use svwb_engine::reading;
use svwb_engine::templates::TemplateStore;

fn repo_root() -> PathBuf {
    Path::new(env!("CARGO_MANIFEST_DIR")).join("../..")
}

fn store() -> &'static TemplateStore {
    static STORE: OnceLock<TemplateStore> = OnceLock::new();
    STORE.get_or_init(|| {
        TemplateStore::load(&repo_root().join("resources/templates"))
            .expect("resources/templates must be loadable")
    })
}

fn frame_of(relative: &str) -> Frame {
    let path = repo_root().join("tests/fixtures/captures").join(relative);
    let decoded = image::open(&path).unwrap_or_else(|e| panic!("{}: {e}", path.display()));
    Frame::from_image(&decoded)
}

fn read_fixture(relative: &str) -> Reading {
    reading::read(&frame_of(relative), store(), &mut NoNumbers, false)
}

/// Nothing on a home screen, a matchmaking battlefield or a mid-battle frame may
/// look like a result, a mode or a replay. Every probe in the table is a
/// potential false positive, and mid-battle is where the two worst ones fired:
/// the plaza label against ornate card text, and the custom-room label against
/// card art.
#[test]
fn quiet_screens_stay_quiet() {
    for fixture in [
        "cpu-practice-1920-fullscreen/01-home.png",
        "cpu-practice-1920-fullscreen/04-battle.png",
        "custom-1280-windowed-lose/04-battle-card-art.png",
        "ranked-bp-1280-windowed-lose/03-battle.png",
        // 1920x1032 windowed, with the app's own HUD on screen: the only fixture
        // at a client area that is wider than 16:9 once its title bar is off.
        "ranked-bp-1920-windowed-no-colon/03-battle.png",
        "2pick-1920-fullscreen-lose/03-battle.png",
        "non-2pick-versus/01-ranked-fullscreen.png",
        "non-2pick-versus/02-ranked-windowed.png",
        "non-2pick-versus/03-cpu.png",
        "non-2pick-versus/04-custom.png",
        "history-1280-windowed/03-before-banner.png",
        "history-1280-windowed/08-after-early-exit.png",
    ] {
        let r = read_fixture(fixture);
        assert!(r.plaza.is_none(), "{fixture}: plaza fired");
        assert!(!r.custom_room, "{fixture}: custom room fired");
        assert!(!r.two_pick, "{fixture}: 2Pick fired");
        assert!(!r.two_pick_versus, "{fixture}: the versus 2Pick label fired");
        assert!(r.final_result.is_none(), "{fixture}: a result banner fired");
        assert!(r.score_system.is_none(), "{fixture}: a score system fired");
        assert!(!r.shows_replay(), "{fixture}: replay suppression fired");
    }
}

/// The BP and MP result screens must be told apart, and each must carry its own
/// score system - reading the numbers without establishing the layout first
/// writes the wrong value into the wrong column.
#[test]
fn ranked_result_screens_report_their_score_system() {
    let win = read_fixture("ranked-bp-1920-fullscreen/01-result-win-bp.png");
    assert_eq!(win.final_result, Some(true));
    assert_eq!(win.score_system.map(|s| s.system), Some(ScoreSystem::Bp));

    let lose = read_fixture("ranked-bp-1280-windowed-lose/01-result-lose-bp.png");
    assert_eq!(lose.final_result, Some(false));
    assert_eq!(lose.score_system.map(|s| s.system), Some(ScoreSystem::Bp));

    // Grand Master and above: MP replaces BP and CR appears alongside.
    let mp_lose = read_fixture("ranked-gm-mp-windowed/01-result-lose-mp-cr.png");
    assert_eq!(mp_lose.final_result, Some(false));
    assert_eq!(mp_lose.score_system.map(|s| s.system), Some(ScoreSystem::Mp));

    let mp_win = read_fixture("ranked-gm-mp-windowed/02-result-win-mp-cr.png");
    assert_eq!(mp_win.final_result, Some(true));
    assert_eq!(mp_win.score_system.map(|s| s.system), Some(ScoreSystem::Mp));

    // A client that dropped the 「：」 after 「BP」. Asserted on the SCORE, not just
    // on the system: the colon-era template still technically cleared 0.7 here
    // (0.7057), so a presence-only assertion passed while three real matches lost
    // both their mode and their BP. See this fixture's README.
    let no_colon = read_fixture("ranked-bp-1920-windowed-no-colon/01-result-lose-bp.png");
    assert_eq!(no_colon.final_result, Some(false));
    let hit = no_colon.score_system.expect("the no-colon BP label must be found");
    assert_eq!(hit.system, ScoreSystem::Bp);
    assert!(
        hit.score >= 0.90,
        "the BP label scored {:.4}; a margin this thin is a coin flip per frame, \
         and the label is only up for ~1.6s",
        hit.score
    );
    // The offset every number window is measured from. A template whose top edge
    // moved would still match here and silently shift every OCR window with it.
    assert_eq!(hit.y, 387, "the anchor y feeds result_layout_offset directly");

    // 0.4s later, as the label fades. The colon-era template found nothing at all
    // on this frame - this one is a pass/fail regression, not a margin.
    let fading =
        read_fixture("ranked-bp-1920-windowed-no-colon/02-result-label-thinnest.png");
    assert_eq!(
        fading.score_system.map(|s| s.system),
        Some(ScoreSystem::Bp),
        "the fading label must still be readable"
    );

    // 2560x1440, and a client that draws 「指定系列」 under the MP bar. Both are
    // new here: the frame is scaled 2:1 onto the canvas rather than 1.5:1, and
    // the extra row moves the MP block without moving this label.
    let wqhd = read_fixture("ranked-gm-mp-2560-fullscreen/01-result-win-mp-cr.png");
    assert_eq!(wqhd.final_result, Some(true));
    let wqhd_hit = wqhd.score_system.expect("the CR label must be found at 2560x1440");
    assert_eq!(wqhd_hit.system, ScoreSystem::Mp);
    assert!(
        (wqhd_hit.y as i32 - ScoreSystem::Mp.anchor_y()).abs() <= 4,
        "the CR half of the panel does not move with the MP half; it sat at {} \
         against the reference {}",
        wqhd_hit.y,
        ScoreSystem::Mp.anchor_y()
    );
}

/// The MP block is anchored to its OWN label, because it moves on its own.
///
/// `ranked-gm-mp-2560-fullscreen` draws a 「指定系列」 row under the MP bar,
/// which lifts 「獲得MP」 and the `MP nnnnn` row by 19px while the CR block below
/// stays within 2px of the reference. Reading the MP windows at the
/// score-system offset there crops the gap above the label and the tail of the
/// row above the total - digits that parse, from the wrong row.
#[test]
fn the_mp_block_is_located_by_its_own_label() {
    let expected = [
        ("ranked-gm-mp-windowed/01-result-lose-mp-cr.png", 174, 0),
        ("ranked-gm-mp-windowed/02-result-win-mp-cr.png", 174, 0),
        ("ranked-gm-mp-2560-fullscreen/01-result-win-mp-cr.png", 155, -19),
    ];

    for (fixture, y, offset) in expected {
        let hit = store()
            .best_in(
                &frame_of(fixture),
                calibration::templates::MP_GAIN,
                calibration::MP_GAIN_ANCHOR,
            )
            .unwrap_or_else(|| panic!("{fixture}: the 獲得MP label must be found"));
        assert!(
            hit.score >= 0.85,
            "{fixture}: the label scored {:.4}, too thin against the 0.7 threshold",
            hit.score
        );
        assert_eq!(hit.y, y, "{fixture}: the label's top edge feeds mp_block_offset directly");
        assert_eq!(calibration::mp_block_offset(hit.y), offset, "{fixture}");
    }
}

/// The anchor must not fire on screens that have no MP block at all - a false
/// hit there would shift the MP windows onto whatever else is on the panel.
#[test]
fn the_mp_label_is_absent_from_every_other_screen() {
    for fixture in [
        "cpu-practice-1920-fullscreen/01-home.png",
        "cpu-practice-1920-fullscreen/04-battle.png",
        "cpu-practice-1920-fullscreen/06-result-cpu-label.png",
        "ranked-bp-1920-fullscreen/01-result-win-bp.png",
        "ranked-bp-1280-windowed-lose/01-result-lose-bp.png",
        "2pick-1920-fullscreen-lose/01-result-2pick-label.png",
        "custom-1280-windowed-lose/01-room-guest.png",
    ] {
        let hit = store().best_in(
            &frame_of(fixture),
            calibration::templates::MP_GAIN,
            calibration::MP_GAIN_ANCHOR,
        );
        let score = hit.map(|h| h.score).unwrap_or(0.0);
        assert!(
            score < calibration::threshold::MP_GAIN,
            "{fixture}: the 獲得MP label scored {score:.4} on a screen that has none"
        );
    }
}

/// The frame that motivated the hold: the WIN banner is already readable while
/// the score-system label is not. A machine that closed the match here would
/// file it as `unknown` with no numbers - which is exactly what used to happen.
#[test]
fn a_fading_in_result_screen_has_a_banner_but_no_label_yet() {
    let r = read_fixture("ranked-bp-1920-fullscreen/03-result-win-fade-in.png");
    assert_eq!(r.final_result, Some(true), "the banner is readable");
    assert!(r.score_system.is_none(), "the label is not, yet");
}

/// The splash distinguishes a win from a loss on its own, before the final
/// screen exists.
#[test]
fn the_battle_end_splash_carries_the_outcome() {
    assert_eq!(
        read_fixture("ranked-bp-1920-fullscreen/02-game-set-mid.png").battle_end_splash,
        Some(true)
    );
    assert_eq!(
        read_fixture("ranked-bp-1280-windowed-lose/02-game-set-mid.png").battle_end_splash,
        Some(false)
    );
    assert_eq!(
        read_fixture("cpu-practice-1920-fullscreen/05-game-set.png").battle_end_splash,
        Some(false)
    );
}

/// The CPU deck label appears before the battle and again on the result screen,
/// and both must be seen - the pre-battle sighting decides the mode of a match
/// that does not exist yet, the result sighting corrects one that does.
#[test]
fn the_cpu_label_is_found_on_both_screens_that_show_it() {
    for fixture in [
        "cpu-practice-1920-fullscreen/02-cpu-deck-label.png",
        "cpu-practice-1920-fullscreen/07-cpu-label-late.png",
        "cpu-practice-1920-fullscreen/08-cpu-label-fading.png",
        "cpu-practice-1920-fullscreen/09-cpu-label-second-appearance.png",
    ] {
        assert!(read_fixture(fixture).cpu_pre_battle, "{fixture}: pre-battle label missed");
    }

    let on_result = read_fixture("cpu-practice-1920-fullscreen/06-result-cpu-label.png");
    assert!(on_result.cpu_anywhere, "the result-screen label was missed");
    assert_eq!(on_result.final_result, Some(false));
}

/// Both replay signals, at both resolutions. The banner says a replay BEGAN and
/// the chrome says one is STILL RUNNING; a missed banner records the replay as a
/// real match, and a missed chrome ends suppression while it is still playing.
#[test]
fn replay_signals_are_found_at_both_resolutions() {
    for fixture in [
        "history-1280-windowed/01-replay-banner.png",
        "history-1280-windowed/02-replay-banner-fading.png",
        "history-1280-windowed/05-replay-banner-second.png",
        "history-1920-fullscreen/01-replay-banner.png",
        "history-1920-fullscreen/02-replay-banner-weak.png",
    ] {
        assert!(read_fixture(fixture).replay_banner, "{fixture}: banner missed");
    }

    for fixture in [
        "history-1280-windowed/04-replay-playback.png",
        "history-1280-windowed/06-chrome-weakest.png",
        "history-1280-windowed/07-chrome-shortest-bar.png",
        "history-1920-fullscreen/04-chrome-playback.png",
    ] {
        assert!(read_fixture(fixture).replay_chrome, "{fixture}: chrome missed");
    }
}

/// The custom-room label, on the frames where the panel is actually up.
#[test]
fn the_custom_room_is_recognised_while_the_panel_is_up() {
    assert!(read_fixture("custom-1280-windowed-lose/01-room-guest.png").custom_room);
    assert!(read_fixture("custom-1280-windowed-lose/02-room-slide-in.png").custom_room);
}

/// NOT COVERED HERE, and worth stating: no still fixture shows the versus
/// screen with the play-order overlay, so `Reading::versus` - the class pair,
/// the emblem fallback and the enemy-side inversion - is exercised only by the
/// recordings. `read_play_order`'s unit tests cover the inversion logic, but
/// nothing here proves it fires on a real frame. That gap closes when the engine
/// can replay a recording end to end.
#[test]
fn no_still_fixture_shows_a_versus_screen() {
    for fixture in [
        "cpu-practice-1920-fullscreen/03-matchmaking.png",
        "cpu-practice-1920-fullscreen/04-battle.png",
        "ranked-bp-1280-windowed-lose/03-battle.png",
    ] {
        assert!(
            read_fixture(fixture).versus.is_none(),
            "{fixture} DOES show a versus screen - promote it into a real assertion \
             and delete this test"
        );
    }
}

/// A 2Pick result screen must be recognised as 2Pick, and NOT be mistaken for
/// ranked.
///
/// The regression this pins: `MODES_2PICK` was carried over from the old
/// pipeline untested, and its window sat entirely below the label. `two_pick`
/// therefore never fired, `resolve_mode` fell through to the score-system
/// branch, and a full 2Pick recording replayed as `mode: ranked` - a loss filed
/// into the user's ranked record. The label scores 0.052 against the old window
/// on this very frame and 0.840 against the corrected one.
#[test]
fn a_2pick_result_screen_is_2pick_and_not_ranked() {
    let r = read_fixture("2pick-1920-fullscreen-lose/01-result-2pick-label.png");
    assert!(r.two_pick, "the 2Pick階級 label is plainly on screen");
    assert_eq!(r.final_result, Some(false));
    assert!(
        r.score_system.is_none(),
        "the 2Pick layout shows 「BP 0」, which the colon-bearing `bp` template \
         must not match - matching it is what filed this match as ranked"
    );
}

/// The reward strip on the 2Pick result screen is a carousel, and 2Pick階級 is
/// the LAST panel to rotate in - roughly 5.5s after the result banner.
///
/// So the absence of the label is not evidence of a non-2Pick match, and the
/// mode must not be decided from an early frame. This fixture is one of those
/// early frames: the banner is already readable, the label is not there yet, and
/// nothing else may step in and claim the match.
#[test]
fn the_2pick_label_is_absent_while_the_reward_carousel_turns() {
    let r = read_fixture("2pick-1920-fullscreen-lose/02-result-carousel-other-reward.png");
    assert_eq!(r.final_result, Some(false), "the banner is readable");
    assert!(!r.two_pick, "the 2Pick panel has not rotated in yet");
    assert!(r.score_system.is_none(), "and nothing may claim it as ranked");
    assert!(r.plaza.is_none());
    assert!(!r.custom_room);
}

/// The versus screen says 2Pick, on the frame the match starts, at both capture
/// scales.
///
/// This is the probe the mode actually rests on. `MODES_2PICK` reads a result
/// screen, which on a win arrives after a RANK UP animation and a reward
/// carousel - 15s late on the fullscreen recording, past every grace the machine
/// has. This one is on screen as the battle opens.
///
/// The windowed frame is 1282x752 - a real window, with border and title bar -
/// so it exercises the chrome crop as well as the scale. Without it the probe's
/// only positive evidence would have been 1920x1080 fullscreen.
#[test]
fn the_versus_screen_identifies_a_2pick_match_at_both_scales() {
    let windowed = read_fixture("2pick-1280-windowed-win/01-versus-2pick-label.png");
    assert!(windowed.two_pick_versus, "windowed: the label is there too");
    assert!(windowed.versus.is_some(), "windowed: and the match is starting");
    assert!(windowed.score_system.is_none());

    let r = read_fixture("2pick-1920-fullscreen-win/01-versus-2pick-label.png");
    assert!(r.two_pick_versus, "「2Pick階級」 is on both players' rows");
    assert_eq!(
        r.versus.map(|v| v.play_order),
        Some(PlayOrder::Second),
        "and it is a frame that starts a match - the label is up for the whole          versus sequence, including every frame the play-order overlay is on"
    );
    assert!(r.score_system.is_none(), "nothing on the versus screen says ranked");
}

/// Why the result screen is not enough, stated as a test.
///
/// This frame is 5s into a 2Pick WIN result screen. The 2Pick label has not
/// arrived - the carousel is still on the rank-up - and the screen's own
/// 「BP 100」 matches the ranked 「BP :」 template at 0.770. Every signal here
/// says ranked. A machine that decides the mode from this screen decides wrong,
/// and no debounce saves it, because the reading is stable and repeats.
#[test]
fn a_2pick_result_screen_looks_exactly_like_a_ranked_one() {
    let r = read_fixture("2pick-1920-fullscreen-win/02-result-rank-up-bp-only.png");
    assert!(!r.two_pick, "the 2Pick label has not rotated in yet");
    assert!(
        r.score_system.is_some(),
        "and the 2Pick screen's own BP label reads as the ranked one - this is \
         the false signal the versus probe exists to outrank"
    );
}

/// The result-screen label does eventually arrive on this recording too, 15s in.
/// It is a corroboration, not the evidence the mode rests on.
#[test]
fn the_2pick_result_label_still_lands_eventually() {
    let r = read_fixture("2pick-1920-fullscreen-win/03-result-2pick-label-late.png");
    assert!(r.two_pick);
    assert_eq!(r.final_result, Some(true));
}

/// The negative the versus probe most needs: every OTHER mode's versus screen.
///
/// The 2Pick label lives in a slot the game fills with the mode's own name - on
/// a ranked versus screen the same slot reads 「階級 分組 BP」. That is what makes
/// the probe strong, and it is also the one place a false positive would cost
/// something real: a ranked match filed as 2Pick.
///
/// Until these existed the probe had never been tested against a non-2Pick
/// versus screen at all. Every other fixture in the set is a home screen, a
/// battlefield or a result screen, none of which has a versus row for the window
/// to land on - so "zero false positives across 37 fixtures" was true and did not
/// cover the case that mattered.
///
/// All four modes that produce a versus screen, at both capture scales.
/// Measured: own 0.165-0.316, enemy -0.054-0.388, against a 0.7 threshold.
#[test]
fn no_other_modes_versus_screen_is_read_as_2pick() {
    for fixture in [
        "non-2pick-versus/01-ranked-fullscreen.png",
        "non-2pick-versus/02-ranked-windowed.png",
        "non-2pick-versus/03-cpu.png",
        "non-2pick-versus/04-custom.png",
    ] {
        let r = read_fixture(fixture);
        assert!(r.versus.is_some(), "{fixture}: this is a versus screen");
        assert!(!r.two_pick_versus, "{fixture}: read as 2Pick");
    }
}

/// The windowed recording repeats the fullscreen one's central lesson, so it is
/// not a quirk of one capture: on the result screen the score-system anchor says
/// `bp` while the 2Pick label is still absent.
///
/// Here the gap is 9s rather than 15s and would have fit inside
/// `timing::MODE_SETTLE` - which is exactly the trap. Two recordings, two
/// different delays, both inside a window that was only ever guessed at. The
/// mode is settled on the versus screen so the delay stops mattering.
#[test]
fn the_windowed_2pick_result_screen_also_reads_as_ranked_at_first() {
    let early = read_fixture("2pick-1280-windowed-win/02-result-anchor-says-ranked.png");
    assert_eq!(early.final_result, Some(true), "the banner is up");
    assert!(!early.two_pick, "the 2Pick label is not");
    assert!(early.score_system.is_some(), "but the ranked anchor is");

    let late = read_fixture("2pick-1280-windowed-win/03-result-2pick-label-late.png");
    assert!(late.two_pick, "9s later the carousel has turned");
    assert_eq!(late.final_result, Some(true));
}

/// Whatever sits above the picture has to be measured away, whether it is a
/// window's title bar or the letterbox a display taller than 16:9 gets.
///
/// It is not scanned, it stays in frame, and since the aspect crop then trims
/// the BOTTOM, every calibrated window ends up shifted down by the height of
/// the band - with no error, just scores that quietly stop clearing their
/// thresholds. Both shapes below were unreachable before: a 4:3 letterbox is
/// `rows / 8` exactly, which is where the scan used to stop, and a Win11 title
/// bar at 200% display scaling is 64px against a limit of 63.
///
/// The frames are the 2560x1440 fixture with bands added, so "correct" is
/// exactly the position the untouched frame produces - no tolerance to argue
/// about.
#[test]
fn a_band_above_the_picture_does_not_move_the_calibrated_windows() {
    use image::{DynamicImage, Rgba, RgbaImage};

    let source = image::open(
        repo_root()
            .join("tests/fixtures/captures/ranked-gm-mp-2560-fullscreen/01-result-win-mp-cr.png"),
    )
    .expect("the 2560 fixture must be readable");

    let banded = |top: u32, bottom: u32, fill: Rgba<u8>| {
        let src = source.to_rgba8();
        let (w, h) = (src.width(), src.height());
        let mut out = RgbaImage::from_pixel(w, h + top + bottom, fill);
        image::imageops::replace(&mut out, &src, 0, i64::from(top));
        DynamicImage::ImageRgba8(out)
    };

    let probe = |frame: &Frame| {
        let hit = |set, window| {
            store()
                .best_in(frame, set, window)
                .map(|h| (h.name, (h.x, h.y), h.score))
        };
        (
            hit(calibration::templates::RESULT, calibration::RESULT),
            hit(calibration::templates::MP_GAIN, calibration::MP_GAIN_ANCHOR),
        )
    };

    let (result, mp_gain) = probe(&Frame::from_image(&source));
    assert!(result.is_some() && mp_gain.is_some(), "the untouched frame must read");

    let black = Rgba([0, 0, 0, 255]);
    for (label, frame) in [
        // A Win11 title bar at 200% scaling: 32px * 2, opaque and flat.
        ("a 64px title bar", banded(64, 0, Rgba([255, 255, 255, 255]))),
        // 2560x1920 is 4:3, so the client letterboxes by 240px top and bottom.
        ("a 4:3 letterbox", banded(240, 240, black)),
        // 2560x1600 is 16:10 - the shape a 1920x1200 display has.
        ("a 16:10 letterbox", banded(80, 80, black)),
        // Both at once: windowed on a display taller than 16:9.
        ("a title bar over a letterbox", {
            let letterboxed = banded(80, 80, black);
            let src = letterboxed.to_rgba8();
            let mut out =
                RgbaImage::from_pixel(src.width(), src.height() + 64, Rgba([255, 255, 255, 255]));
            image::imageops::replace(&mut out, &src, 0, 64);
            DynamicImage::ImageRgba8(out)
        }),
    ] {
        let (banded_result, banded_mp_gain) = probe(&Frame::from_image(&frame));
        assert_eq!(
            banded_result.as_ref().map(|h| (&h.0, h.1)),
            result.as_ref().map(|h| (&h.0, h.1)),
            "{label}: the result banner moved"
        );
        assert_eq!(
            banded_mp_gain.as_ref().map(|h| (&h.0, h.1)),
            mp_gain.as_ref().map(|h| (&h.0, h.1)),
            "{label}: the 獲得MP label moved"
        );
    }
}

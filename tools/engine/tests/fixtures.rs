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
use svwb_engine::machine::{Located, Reading};
use svwb_engine::fingerprint::NoCards;
use svwb_engine::mulligan;
use svwb_engine::nameplate;
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
    reading::read(&frame_of(relative), store(), &mut NoNumbers, false, &NoCards)
}

/// Nothing on a home screen, a mulligan panel or a mid-battle frame may look
/// like a result, a mode or a replay. Every probe in the table is a potential
/// false positive, and mid-battle is where the two worst ones fired: the plaza
/// label against ornate card text, and the custom-room label against card art.
///
/// Two of these were called `04-battle*.png` until 2026-09-09, when the mulligan
/// probes were added and read a panel off both of them. They are mulligan
/// screens, not battlefields - which is fine for what this test asks of them,
/// and worth knowing before quoting either as battlefield evidence. The ornate
/// card art that the custom-room label used to score 0.69 against is on one of
/// them, so that false positive was never a battlefield either.
#[test]
fn quiet_screens_stay_quiet() {
    for fixture in [
        "cpu-practice-1920-fullscreen/01-home.png",
        "cpu-practice-1920-fullscreen/04-mulligan-waiting.png",
        "custom-1280-windowed-lose/04-mulligan-card-art.png",
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

/// Master is an MP-ranked layout without the CR block Grand Master uses.
#[test]
fn a_master_mp_only_result_is_still_ranked_evidence() {
    let r = read_fixture("ranked-master-mp-only/01-result-lose-mp-only.png");
    assert_eq!(r.final_result, Some(false));
    assert!(r.score_system.is_none(), "Master has neither a BP nor a CR label");
    assert_eq!(r.mp_gain, Some(Located { x: 1028, y: 154 }));
    assert_eq!(r.mode_probes.ranked_mp_gain.candidate, "gained_mp");
    assert!(
        r.mode_probes.ranked_mp_gain.score >= 0.85,
        "the MP label scored {:.4}, too thin against the 0.7 threshold",
        r.mode_probes.ranked_mp_gain.score
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
        ("ranked-master-mp-only/01-result-lose-mp-only.png", 154, -20),
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
        "cpu-practice-1920-fullscreen/04-mulligan-waiting.png",
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
        "cpu-practice-1920-fullscreen/04-mulligan-waiting.png",
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

/// Every versus screen with a player on the other side yields a nameplate, and
/// the one with a CPU on it does not.
///
/// This is the whole guard on `NAME_ENEMY`. The window is not matched against a
/// template, so nothing else can notice it drifting: a window that slid off the
/// text would keep returning a perfectly valid PNG of the wrong pixels, and the
/// first report would be a user asking why their match history is full of
/// pictures of a character's elbow.
///
/// The CPU frame is the half of this that catches a window sliding the OTHER
/// way. Its row is not empty - character art bleeds into it and binarises to
/// 14.8% ink, denser than two of the real nameplates here - so a check that
/// merely asked "is there anything there" would pass on it.
///
/// It also settles the timing question, which nothing else here could. The
/// engine cuts the plate on the frame a match is recognised from, and that
/// frame needs the play-order overlay - which arrives about a second into the
/// versus screen, while the panel carrying the name slides in. Every fixture
/// below is an overlay frame, so each one is the kind of frame `MatchStarted`
/// actually fires on, and the panel is settled on all of them.
#[test]
fn a_nameplate_is_cut_from_every_versus_screen_that_has_one() {
    for fixture in [
        "non-2pick-versus/01-ranked-fullscreen.png",
        "non-2pick-versus/02-ranked-windowed.png",
        "non-2pick-versus/04-custom.png",
        "2pick-1280-windowed-win/01-versus-2pick-label.png",
        "2pick-1920-fullscreen-win/01-versus-2pick-label.png",
    ] {
        let png = nameplate::cut(&frame_of(fixture));
        assert!(png.is_some(), "{fixture}: no nameplate was cut");
        // Small enough to keep in the row rather than on disk, which is what
        // makes a picture affordable in the first place. The fixtures measure
        // 379 bytes to 1.5 KB; the largest is the custom-room 稱號 plus name at
        // 298px wide, and the window caps the width at 318px, so nothing much
        // larger can exist.
        let size = png.unwrap().len();
        assert!(size < 3072, "{fixture}: the nameplate grew to {size} bytes");
    }

    assert!(
        nameplate::cut(&frame_of("non-2pick-versus/03-cpu.png")).is_none(),
        "a CPU opponent has no name, so its row must not be stored as one"
    );
}

/// Nothing that is not a versus screen may yield a nameplate.
///
/// The engine only asks on the frame a match starts from, so this is not about
/// the live path - it is about the window itself. If a battlefield or a result
/// screen can produce one, the window is loose enough that a versus screen can
/// produce the wrong one.
#[test]
fn other_screens_have_no_nameplate() {
    for fixture in [
        "cpu-practice-1920-fullscreen/01-home.png",
        "cpu-practice-1920-fullscreen/04-mulligan-waiting.png",
        "ranked-bp-1280-windowed-lose/03-battle.png",
        "ranked-bp-1920-fullscreen/01-result-win-bp.png",
        "ranked-gm-mp-windowed/01-result-lose-mp-cr.png",
        "2pick-1920-fullscreen-lose/03-battle.png",
    ] {
        assert!(
            nameplate::cut(&frame_of(fixture)).is_none(),
            "{fixture}: cut a nameplate off a screen that has no name on it"
        );
    }
}

/// The mulligan panel, read off four real frames.
///
/// Each one is here for a property nothing else covers:
///
/// - `01-mulligan-two-changed` is the whole argument for reading the swap off
///   geometry. Two cards have been moved into the CHANGE row and their KEEP
///   slots are empty, so the two rows are complements of each other. Nothing was
///   recognised to know which two.
/// - `cpu-practice/04-mulligan-waiting` is the other stage: the CHANGE row is gone and the
///   KEEP row holds the FINAL hand in the same four windows. This is the frame
///   the post-mulligan hand comes from, and the reason the plan does not have to
///   read the fanned-out hand on the battlefield. It was already in the tree,
///   misfiled as `04-battle.png` and used by four tests as a mid-battle frame -
///   it never was one, and this is what noticed.
/// - `02-mulligan-three-changed` is 2560x1440 fullscreen on a dark stage, three
///   cards up, one kept. Its dim art is what stops the occupancy test from being
///   tuned to a bright panel.
/// - `ranked-bp-1280/04-mulligan-waiting` is the dimmest KEEP row measured (two of its four
///   cards sit at a quarter of the contrast of the brightest fixture's), at
///   1280x720 - the one that would fail first if the threshold crept up.
#[test]
fn the_mulligan_panel_reads_the_same_at_every_resolution() {
    use svwb_engine::mulligan::{self, Stage};

    let read = |fixture: &str| {
        mulligan::read(&frame_of(fixture), store())
            .unwrap_or_else(|| panic!("{fixture}: no mulligan panel was found"))
    };

    let two_up = read("ranked-1920-windowed-2560-desktop/01-mulligan-two-changed.png");
    assert_eq!(two_up.stage, Stage::Choosing);
    assert_eq!(two_up.change, [true, false, false, true]);
    assert_eq!(two_up.keep, [false, true, true, false]);
    assert!(two_up.is_settled(), "every column holds its card in exactly one row");
    assert_eq!(two_up.change_count(), 2);

    let waiting = read("cpu-practice-1920-fullscreen/04-mulligan-waiting.png");
    assert_eq!(waiting.stage, Stage::Waiting);
    assert_eq!(waiting.keep, [true; 4], "the final hand is four cards");
    assert_eq!(waiting.change, [false; 4], "the CHANGE row is not on screen to read");
    assert!(waiting.is_settled());

    let three_up = read("ranked-gm-mp-2560-fullscreen/02-mulligan-three-changed.png");
    assert_eq!(three_up.stage, Stage::Choosing);
    assert_eq!(three_up.change, [false, true, true, true]);
    assert_eq!(three_up.keep, [true, false, false, false]);
    assert_eq!(three_up.change_count(), 3);

    let dim = read("ranked-bp-1280-windowed-lose/04-mulligan-waiting.png");
    assert_eq!(dim.stage, Stage::Waiting);
    assert_eq!(dim.keep, [true; 4], "dim art is still a card");
}

/// No other screen may look like a mulligan panel.
///
/// The two labels are what stands between "read the eight slots" and "read eight
/// rectangles of battlefield", and the KEEP row's windows sit exactly where a
/// battlefield's own cards are drawn - so a loose label match would not fail
/// quietly, it would invent a hand.
#[test]
fn other_screens_are_not_a_mulligan() {
    for fixture in [
        "cpu-practice-1920-fullscreen/01-home.png",
        "ranked-bp-1280-windowed-lose/03-battle.png",
        "ranked-bp-1920-fullscreen/01-result-win-bp.png",
        "ranked-gm-mp-2560-fullscreen/01-result-win-mp-cr.png",
        "non-2pick-versus/01-ranked-fullscreen.png",
        "2pick-1920-fullscreen-lose/03-battle.png",
    ] {
        assert!(
            svwb_engine::mulligan::read(&frame_of(fixture), store()).is_none(),
            "{fixture}: found a mulligan panel on a screen that has none"
        );
    }
}

/// A settled panel gives up a card box for every card, and they agree.
///
/// This is the gate everything in stage 2 stands on: the art comparison is only
/// meaningful if the window it cuts is the window the reference art was
/// calibrated against. The assertions are about geometry rather than scores -
/// the badges must land where the layout puts them, and the columns must be one
/// pitch apart, on every resolution and in both stages.
#[test]
fn a_settled_panel_locates_every_card() {
    use svwb_engine::card::{self, Row};
    use svwb_engine::calibration as cal;

    for (fixture, stage_note) in [
        ("ranked-1920-windowed-2560-desktop/01-mulligan-two-changed.png", "choosing"),
        ("ranked-gm-mp-2560-fullscreen/02-mulligan-three-changed.png", "choosing"),
        ("ranked-bp-1280-windowed-lose/04-mulligan-waiting.png", "waiting"),
        ("custom-1280-windowed-lose/04-mulligan-card-art.png", "waiting"),
    ] {
        let frame = frame_of(fixture);
        let reading = mulligan::read(&frame, store()).expect(fixture);
        let cards = card::locate(&frame, &reading)
            .unwrap_or_else(|| panic!("{fixture} ({stage_note}): a settled panel was refused"));

        for (row, boxes, occupied) in [
            (Row::Keep, cards.keep, reading.keep),
            (Row::Change, cards.change, reading.change),
        ] {
            for (i, occupied) in occupied.iter().enumerate() {
                let found = boxes[i];
                assert_eq!(
                    found.is_some(),
                    *occupied,
                    "{fixture}: {row:?} slot {} - a located card and an occupied slot must be the same thing",
                    i + 1
                );
                let Some(found) = found else { continue };

                let (dx, dy) = match row {
                    Row::Keep => cal::MULLIGAN_BADGE_IN_KEEP,
                    Row::Change => cal::MULLIGAN_BADGE_IN_CHANGE,
                };
                let top = match row {
                    Row::Keep => cal::MULLIGAN_KEEP_TOP,
                    Row::Change => cal::MULLIGAN_CHANGE_TOP,
                };
                let want_x = cal::MULLIGAN_CARD_X[i] + dx;
                let want_y = top + dy;
                let drift_x = found.badge.x.abs_diff(want_x);
                let drift_y = found.badge.y.abs_diff(want_y);
                assert!(
                    drift_x <= 4 && drift_y <= 4,
                    "{fixture}: {row:?} slot {} badge at ({},{}) is {drift_x},{drift_y} from ({want_x},{want_y})",
                    i + 1, found.badge.x, found.badge.y
                );
                assert_eq!(
                    (found.art.w, found.art.h),
                    cal::MULLIGAN_ART_SIZE,
                    "{fixture}: the art window is the size the comparison was calibrated for"
                );
            }
        }
    }
}

/// A panel that is still moving is refused, even though its slots read as full.
///
/// `cpu-practice/04-mulligan-waiting.png` is the frame the panel dismisses on:
/// the four cards have begun sliding out towards the hand, and over the two
/// seconds that follow they drift 5px per frame. Occupancy is right about it -
/// there ARE four cards - and a fixed art window over it would cut a smear of
/// two. This is the whole reason `card` exists as a separate step from
/// `mulligan`, so the two answers being different here is the point, not a
/// contradiction.
#[test]
fn a_panel_in_motion_is_refused() {
    let fixture = "cpu-practice-1920-fullscreen/04-mulligan-waiting.png";
    let frame = frame_of(fixture);
    let reading = mulligan::read(&frame, store()).expect("the labels are still up");

    assert_eq!(reading.keep, [true; 4], "occupancy still sees four cards");
    assert!(
        svwb_engine::card::locate(&frame, &reading).is_none(),
        "a dismissing panel must not hand out card windows"
    );
}

/// Which cards are on the panel, against reference art.
///
/// The references are the committed fingerprints in `tests/fixtures/card-art/`,
/// which include decoys - without those this would only prove that the single
/// candidate wins. Both frames also hold cards whose reference is NOT in the
/// set, and those must come back unrecognised: refusing is the behaviour that
/// keeps a wrong card out of a match's history, and it is worth pinning.
#[test]
fn the_cards_on_a_settled_panel_are_named() {
    use svwb_engine::card;
    use svwb_engine::fingerprint;

    let candidates = card_art_fingerprints();
    assert!(candidates.len() >= 10, "the decoys are the point; found {}", candidates.len());

    let read_hand = |fixture: &str| -> Vec<Option<i64>> {
        let frame = frame_of(fixture);
        let reading = mulligan::read(&frame, store()).expect(fixture);
        let cards = card::locate(&frame, &reading).expect(fixture);
        cards
            .keep
            .iter()
            .flatten()
            .map(|found| {
                let art = fingerprint::of_screen_art(&frame, found.art)?;
                fingerprint::name(&art, &candidates).card.map(|hit| hit.card_id)
            })
            .collect()
    };

    // Three copies of 狂焰毀滅者 and one card the reference set does not have.
    assert_eq!(
        read_hand("ranked-bp-1280-windowed-lose/04-mulligan-waiting.png"),
        vec![Some(10032120), Some(10032120), Some(10032120), None]
    );

    // 入神的實驗體, 人性之愛, one absent card, 智慧耀光.
    assert_eq!(
        read_hand("custom-1280-windowed-lose/04-mulligan-card-art.png"),
        vec![Some(10931110), Some(10932310), None, Some(10031310)]
    );
}

/// A card is only named when the winner is clearly ahead.
///
/// The margin is what decides, so the guard worth pinning is that a real
/// screen's illustration beats every decoy by more than the threshold - not
/// just that it wins.
#[test]
fn the_winning_card_is_clearly_ahead_of_the_rest() {
    use svwb_engine::calibration as cal;
    use svwb_engine::card;
    use svwb_engine::fingerprint;

    let candidates = card_art_fingerprints();
    let fixture = "custom-1280-windowed-lose/04-mulligan-card-art.png";
    let frame = frame_of(fixture);
    let reading = mulligan::read(&frame, store()).expect(fixture);
    let cards = card::locate(&frame, &reading).expect(fixture);

    let found = cards.keep[3].expect("slot 4 holds a card");
    let art = fingerprint::of_screen_art(&frame, found.art).expect("the art window is on canvas");
    let hit = fingerprint::name(&art, &candidates).card.expect("slot 4 is 智慧耀光");

    assert_eq!(hit.card_id, 10031310);
    assert!(
        hit.score > 0.8 && hit.margin > 0.3,
        "score {:.3} margin {:.3} - the fixtures measured 0.669-0.961 and 0.389+, so anything \
         near the thresholds ({} / {}) means the reduction changed",
        hit.score,
        hit.margin,
        cal::CARD_ART_MIN_SCORE,
        cal::CARD_ART_MIN_MARGIN
    );
}

/// The committed reference fingerprints, keyed by card id.
fn card_art_fingerprints() -> Vec<(i64, svwb_engine::fingerprint::Fingerprint)> {
    let dir = repo_root().join("tests/fixtures/card-art");
    let mut out = Vec::new();
    for entry in std::fs::read_dir(&dir).expect("the fingerprint fixtures").flatten() {
        let path = entry.path();
        if path.extension().and_then(|e| e.to_str()) != Some("fp") {
            continue;
        }
        let card_id: i64 = path
            .file_stem()
            .and_then(|s| s.to_str())
            .and_then(|s| s.parse().ok())
            .unwrap_or_else(|| panic!("{}: a fingerprint is named for its card", path.display()));
        let bytes = std::fs::read(&path).expect("readable");
        let fp = svwb_engine::fingerprint::Fingerprint::from_bytes(bytes).unwrap_or_else(|| {
            panic!("{}: wrong length - regenerate after an ALGO_VERSION bump", path.display())
        });
        out.push((card_id, fp));
    }
    out
}

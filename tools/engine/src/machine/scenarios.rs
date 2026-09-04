//! The incident history, as executable scenarios.
//!
//! Every test here corresponds to a defect recorded in the comments of
//! `src/main/recognition/forkedImageAnalyzer.ts`. Those comments were the only
//! record because the logic could not be reached without Electron, Prisma and a
//! screen recording; a `Reading` is three lines.
//!
//! Scenarios drive whole ticks, not helper functions. A defect that only appears
//! when two rules interact - a banner crossing its threshold before the label
//! it depends on, a latch discarding a match mid-flight - is invisible to a unit
//! test of either rule alone.

use std::time::{Duration, Instant};

use super::{
    Change, Located, Machine, ModeProbeScore, ModeProbeScores, NumberReads, Reading, VersusScreen,
};
use crate::calibration::{ScoreSystem, ScoreSystemHit, timing};
use crate::phase::Phase;
use crate::protocol::{ClassName, GameMode, PlayOrder};

fn versus() -> VersusScreen {
    VersusScreen {
        my_class: ClassName::Witch,
        oppo_class: ClassName::Bishop,
        play_order: PlayOrder::Second,
    }
}

fn on_versus_screen() -> Reading {
    Reading { versus: Some(versus()), ..Default::default() }
}

fn score_system(system: ScoreSystem) -> ScoreSystemHit {
    ScoreSystemHit { system, x: 1068, y: system.anchor_y() as u32, score: 1.0 }
}

/// The BP result screen, fully drawn.
fn bp_result(bp: i32) -> Reading {
    Reading {
        final_result: Some(false),
        score_system: Some(score_system(ScoreSystem::Bp)),
        numbers: NumberReads { bp: Some(bp), ..Default::default() },
        ..Default::default()
    }
}

fn master_mp_result(delta_mp: i32, total_mp: i32) -> Reading {
    Reading {
        final_result: Some(false),
        mp_gain: Some(Located { x: 1028, y: 154 }),
        numbers: NumberReads {
            delta_mp: Some(delta_mp),
            total_mp: Some(total_mp),
            ..Default::default()
        },
        ..Default::default()
    }
}

fn started(changes: &[Change]) -> bool {
    changes.iter().any(|c| matches!(c, Change::MatchStarted { .. }))
}

fn finished(changes: &[Change]) -> Option<&Change> {
    changes.iter().find(|c| matches!(c, Change::MatchFinished { .. }))
}

fn flagged(patch: &crate::protocol::MatchPatch, flag: &str) -> bool {
    patch.recog_flags.iter().flatten().any(|held| held == flag)
}

fn noted(changes: &[Change], kind: &str) -> bool {
    changes.iter().any(|c| matches!(c, Change::Noted { kind: k, .. } if *k == kind))
}

/// A whole ranked match, from versus screen to a closed row.
#[test]
fn a_ranked_match_runs_end_to_end() {
    let mut m = Machine::new();
    let t = Instant::now();

    assert!(started(&m.tick(&on_versus_screen(), t)));
    assert!(matches!(m.phase(), Phase::InBattle { .. }));

    // The splash records the outcome but leaves the mode open - the CPU deck
    // label lives on the final screen, which has not arrived.
    let splash = Reading { battle_end_splash: Some(false), ..Default::default() };
    let changes = m.tick(&splash, t + timing::TICK);
    assert!(finished(&changes).is_none(), "the splash must not close the match");

    // BP is static, so it needs several agreeing reads.
    let mut now = t + timing::TICK * 2;
    let mut closed = None;
    for _ in 0..5 {
        let changes = m.tick(&bp_result(8), now);
        if let Some(Change::MatchFinished { patch, .. }) = finished(&changes) {
            closed = Some(patch.clone());
            break;
        }
        now += timing::TICK;
    }

    let patch = closed.expect("the match should close once BP settles");
    assert_eq!(patch.bp, Some(8));
    assert_eq!(patch.result, Some(false));
    assert_eq!(patch.mode, Some(GameMode::Ranked));
    assert!(matches!(m.phase(), Phase::Idle { .. }));
}

/// Master uses MP but does not draw the CR block that previously served as the
/// only way to identify an MP-ranked result.
#[test]
fn a_master_mp_only_match_runs_end_to_end() {
    let mut m = Machine::new();
    let t = Instant::now();
    assert!(started(&m.tick(&on_versus_screen(), t)));

    let mut now = t + timing::TICK;
    let mut closed = None;
    for _ in 0..5 {
        let changes = m.tick(&master_mp_result(14, 16867), now);
        if let Some(Change::MatchFinished { patch, .. }) = finished(&changes) {
            closed = Some(patch.clone());
            break;
        }
        now += timing::TICK;
    }

    let patch = closed.expect("MP-only Master should close without waiting for CR");
    assert_eq!(patch.mode, Some(GameMode::Ranked));
    assert_eq!(patch.delta_mp, Some(14));
    assert_eq!(patch.mp, Some(16867));
    assert_eq!(patch.delta_cr, None);
    assert_eq!(patch.current_cr, None);
    assert!(!flagged(&patch, "mode-guessed"));
}

/// The banner crosses its threshold while the rest of the screen is still
/// fading in. Measured on the 1920 fullscreen ranked result: the banner scored
/// 0.87 on a frame where the BP block had not been drawn at all, so the
/// score-system label scored 0.41 and the match was closed as `unknown` on its
/// very first result tick.
#[test]
fn a_half_drawn_result_screen_does_not_close_the_match() {
    let mut m = Machine::new();
    let t = Instant::now();
    m.tick(&on_versus_screen(), t);

    // Banner only: no label, no numbers.
    let fading_in = Reading { final_result: Some(true), ..Default::default() };
    let changes = m.tick(&fading_in, t + timing::TICK);

    assert!(finished(&changes).is_none(), "closed on a half-drawn screen");
    assert!(!noted(&changes, "mode-guessed"), "guessed the mode before the label appeared");
    assert!(matches!(m.phase(), Phase::Resolving { .. }));
}

/// ...and the label arriving a beat later still decides the mode.
#[test]
fn a_label_that_arrives_during_the_hold_still_counts() {
    let mut m = Machine::new();
    let t = Instant::now();
    m.tick(&on_versus_screen(), t);
    m.tick(&Reading { final_result: Some(true), ..Default::default() }, t + timing::TICK);

    let mut now = t + timing::TICK * 2;
    let mut closed = None;
    for _ in 0..5 {
        if let Some(Change::MatchFinished { patch, .. }) = finished(&m.tick(&bp_result(124), now)) {
            closed = Some(patch.clone());
            break;
        }
        now += timing::TICK;
    }
    let patch = closed.expect("should close once the settled screen is read");
    assert_eq!(patch.mode, Some(GameMode::Ranked));
    assert_eq!(patch.bp, Some(124));
}

/// A real final screen that survives the settling window without a mode must
/// retain every raw mode-probe score for the exported diagnostic.
#[test]
fn an_unattributable_result_keeps_its_mode_probe_scores() {
    let mut m = Machine::new();
    let t = Instant::now();
    m.tick(&on_versus_screen(), t);
    m.tick(
        &Reading { battle_end_splash: Some(false), ..Default::default() },
        t + timing::TICK,
    );

    let result = Reading {
        final_result: Some(false),
        mode_probes: ModeProbeScores {
            ranked_score_system: ModeProbeScore {
                candidate: "bp",
                score: 0.64,
                threshold: 0.7,
                x: 1042,
                y: 321,
            },
            ..Default::default()
        },
        ..Default::default()
    };
    let hold_started = t + timing::TICK * 2;
    m.tick(&result, hold_started);
    let changes = m.tick(&result, hold_started + timing::MODE_SETTLE);

    let detail = changes.iter().find_map(|change| match change {
        Change::Noted { kind: "mode-unattributable", detail: Some(detail), .. } => Some(detail),
        _ => None,
    });
    let detail = detail.expect("the unknown result screen needs actionable evidence");
    assert_eq!(detail["probes"]["rankedScoreSystem"]["candidate"], "bp");
    assert_eq!(detail["probes"]["rankedScoreSystem"]["score"], 0.64);
    assert_eq!(detail["probes"]["rankedScoreSystem"]["threshold"], 0.7);
    assert!(noted(&changes, "mode-guessed"));
    assert!(finished(&changes).is_some());
}

/// A replay shows the same versus screen and battlefield as a real match, so an
/// open match must be DISCARDED, not finished.
#[test]
fn a_replay_discards_the_open_match() {
    let mut m = Machine::new();
    let t = Instant::now();
    m.tick(&on_versus_screen(), t);

    let replay = Reading { replay_banner: true, ..Default::default() };
    let changes = m.tick(&replay, t + timing::TICK);

    assert!(
        changes.iter().any(|c| matches!(c, Change::MatchAbandoned { .. })),
        "an open match must be abandoned"
    );
    assert!(finished(&changes).is_none(), "abandoning must not write a result");
    assert!(matches!(m.phase(), Phase::ReplaySuppressed { .. }));
}

/// The banner sets a floor long enough to reach the playback chrome. A chrome
/// hit inside that floor must not shorten it to its own two-second grace -
/// which would leave the rest of the replay unprotected.
#[test]
fn the_chrome_never_shortens_the_banner_floor() {
    let mut m = Machine::new();
    let t = Instant::now();
    m.tick(&Reading { replay_banner: true, ..Default::default() }, t);

    let chrome = Reading { replay_chrome: true, ..Default::default() };
    m.tick(&chrome, t + timing::TICK);

    // Well past the chrome's own grace, well inside the banner floor.
    let still_suppressed = m.tick(&on_versus_screen(), t + Duration::from_secs(10));
    assert!(!started(&still_suppressed), "a match started inside the replay");
    assert!(matches!(m.phase(), Phase::ReplaySuppressed { .. }));
}

/// Once the replay ends, a real match must be recordable again. An early exit
/// used to leave a blind timer running that swallowed the next match.
#[test]
fn suppression_lifts_and_the_next_match_records() {
    let mut m = Machine::new();
    let t = Instant::now();
    m.tick(&Reading { replay_chrome: true, ..Default::default() }, t);

    let after = t + timing::REPLAY_CHROME_GRACE + timing::TICK;
    let changes = m.tick(&on_versus_screen(), after);
    assert!(
        changes.iter().any(|c| matches!(c, Change::ReplaySuppression { active: false })),
        "suppression should lift"
    );
    assert!(started(&changes));
}

/// The plaza template is five ornate glyphs and the battlefield is full of
/// ornate card text. The label is a RESULT-SCREEN element, mutually exclusive
/// with BP/MP/CR, so a mid-battle hit is a false positive by definition. One
/// such hit recorded a ranked match as `weekendPlaza` and, worse, silenced the
/// diagnostic that would have reported the missing numbers.
#[test]
fn a_plaza_hit_mid_battle_is_ignored() {
    let mut m = Machine::new();
    let t = Instant::now();
    m.tick(&on_versus_screen(), t);

    let card_text = Reading { plaza: Some((Located { x: 888, y: 285 }, 0.78)), ..Default::default() };
    let mut now = t + timing::TICK;
    for _ in 0..6 {
        let changes = m.tick(&card_text, now);
        assert!(
            !changes.iter().any(|c| matches!(
                c,
                Change::MatchUpdated { patch, .. } if patch.mode == Some(GameMode::WeekendPlaza)
            )),
            "a mid-battle plaza hit must never set the mode"
        );
        now += timing::TICK;
    }
}

/// A match whose mode was never detected is stored as `unknown`, NOT
/// `unranked`. The latter quietly polluted the free-play statistics with every
/// recognition failure and gave the user no way to tell the two apart.
#[test]
fn an_undetected_mode_closes_as_unknown_not_unranked() {
    let mut m = Machine::new();
    let t = Instant::now();
    m.tick(&on_versus_screen(), t);
    m.tick(&Reading { battle_end_splash: Some(true), ..Default::default() }, t + timing::TICK);

    // The final screen never appears and nothing else ever ends the wait - the
    // player quit to the title screen, or the capture died. Only the backstop is
    // left, and it must still close the row.
    let after = t + timing::FINAL_SCREEN_BACKSTOP + timing::TICK * 2;
    let changes = m.tick(&Reading::default(), after);

    let Some(Change::MatchFinished { patch, .. }) = finished(&changes) else {
        panic!("the match must not stay open forever");
    };
    assert_eq!(patch.mode, Some(GameMode::Unknown));
    assert_ne!(patch.mode, Some(GameMode::Unranked));
    assert!(noted(&changes, "mode-guessed"), "the guess is worth counting");
    assert!(noted(&changes, "final-screen-never-seen"));
}

/// The reward screens hold until the player clicks, and the match must survive
/// however long that takes.
///
/// Between the end-of-battle splash and the final result screen the game shows
/// FULL-SCREEN reward panels. They cover the result banner, so no probe reads
/// anything at all, and they wait for a click - a player who goes to make coffee
/// leaves them up for as long as they like. A fifteen-second grace closed the
/// match somewhere in the middle of that, with no mode, no numbers and a
/// `final-screen-never-seen` flag, for a match that was still perfectly on its
/// way.
///
/// Five minutes here is not a measurement of anything. It is well past any
/// deadline that could honestly be written down, which is the point.
#[test]
fn a_reward_screen_left_up_for_minutes_does_not_lose_the_match() {
    let mut m = Machine::new();
    let t = Instant::now();
    m.tick(&on_versus_screen(), t);
    m.tick(&Reading { battle_end_splash: Some(false), ..Default::default() }, t + timing::TICK);

    // Nothing readable, for a very long time.
    let mut now = t + timing::TICK * 2;
    let clicks_at = now + Duration::from_secs(300);
    while now < clicks_at {
        let changes = m.tick(&Reading::default(), now);
        assert!(finished(&changes).is_none(), "closed while the player was reading rewards");
        now += timing::TICK * 20;
    }

    // ...and then they click, and the result screen comes up as normal.
    let mut closed = None;
    for _ in 0..10 {
        if let Some(Change::MatchFinished { patch, .. }) = finished(&m.tick(&bp_result(31), now)) {
            closed = Some(patch.clone());
            break;
        }
        now += timing::TICK;
    }

    let patch = closed.expect("the result screen must still be read five minutes later");
    assert_eq!(patch.mode, Some(GameMode::Ranked));
    assert_eq!(patch.bp, Some(31));
    assert_eq!(patch.result, Some(false));
    assert!(
        !flagged(&patch, "final-screen-never-seen"),
        "nothing went wrong here - the player just read their rewards"
    );
}

/// Waiting longer must not mean deciding more.
///
/// The wait is unbounded now, and the probes it runs past are windows at fixed
/// positions with reward art underneath them. The plaza probe has no verified
/// positive sample and the score-system anchor already false-positives on the
/// app's own HUD, so a wait that kept believing them would trade "sometimes
/// loses the mode" for "sometimes invents one" - the worse of the two, because a
/// wrong mode does not look like a failure to the user.
///
/// `POST_BATTLE_TRUST` is where the believing stops. Before it, the screen is
/// one the game raised by itself and is read normally - that is what
/// `a_custom_room_is_still_identified_after_the_battle` covers.
#[test]
fn nothing_is_decided_once_the_wait_outlives_its_trusted_window() {
    let mut m = Machine::new();
    let t = Instant::now();
    m.tick(&on_versus_screen(), t);
    m.tick(&Reading { battle_end_splash: Some(true), ..Default::default() }, t + timing::TICK);

    // Reward art under every calibrated window, for two hundred frames, all of
    // them past the window in which a post-battle screen is believed.
    let noise = Reading {
        plaza: Some((Located { x: 888, y: 285 }, 0.78)),
        score_system: Some(score_system(ScoreSystem::Bp)),
        cpu_anywhere: true,
        custom_room: true,
        ..Default::default()
    };
    let mut now = t + timing::TICK + timing::POST_BATTLE_TRUST;
    for _ in 0..200 {
        let changes = m.tick(&noise, now);
        assert!(
            !changes.iter().any(|c| matches!(c, Change::MatchUpdated { patch, .. } if patch.mode.is_some())),
            "a probe fired against a reward screen and branded the match"
        );
        assert!(finished(&changes).is_none());
        now += timing::TICK;
    }
}

/// A custom room raises its own panel the moment the battle ends, and 室長 on it
/// is the only evidence that match was ever a custom room.
///
/// This is `custom-1280-windowed-lose`, which has no result screen at all - the
/// recording runs four more minutes without one. The mode is read here or not at
/// all, which is why the blind wait cannot simply refuse to believe everything:
/// a first draft of that guard turned this recording's mode into `unknown`.
#[test]
fn a_custom_room_is_still_identified_after_the_battle() {
    let mut m = Machine::new();
    let t = Instant::now();
    m.tick(&on_versus_screen(), t);
    m.tick(&Reading { battle_end_splash: Some(false), ..Default::default() }, t + timing::TICK);

    let room = Reading { custom_room: true, ..Default::default() };
    let mut now = t + timing::TICK * 2;
    let mut decided = false;
    for _ in 0..4 {
        let changes = m.tick(&room, now);
        decided |= changes.iter().any(|c| matches!(
            c,
            Change::MatchUpdated { patch, .. } if patch.mode == Some(GameMode::Custom)
        ));
        now += timing::TICK;
    }
    assert!(decided, "the room panel right after the battle must still be read");

    // ...and the match still closes with it, even though no result screen ever
    // arrives to end the wait.
    let closed = m.close_open_match();
    let Some(Change::MatchFinished { patch, .. }) = finished(&closed) else {
        panic!("the recording ending must close the row");
    };
    assert_eq!(patch.mode, Some(GameMode::Custom));
    assert_eq!(patch.result, Some(false));
}

/// A half-finished mid-battle hit must not be completed by the result screen.
///
/// A debounce is reset by seeing its signal ABSENT, and the blind wait observes
/// nothing at all - so one stray plaza hit during the battle would otherwise sit
/// at `hits: 1` through however long the reward screens take, and the first hit
/// on the result screen would carry it over the line. Two frames, minutes apart,
/// either side of a screen change: exactly what the debounce exists to reject.
#[test]
fn a_stray_hit_from_the_battle_does_not_survive_into_the_result_screen() {
    let mut m = Machine::new();
    let t = Instant::now();
    m.tick(&on_versus_screen(), t);

    let at = Located { x: 888, y: 285 };
    // One hit mid-battle, then the battle ends.
    m.tick(&Reading { plaza: Some((at, 0.78)), ..Default::default() }, t + timing::TICK);
    m.tick(
        &Reading { battle_end_splash: Some(false), ..Default::default() },
        t + timing::TICK * 2,
    );

    // The reward screen holds, then the result screen arrives with one more hit.
    let mut now = t + timing::TICK * 3 + Duration::from_secs(120);
    let changes = m.tick(
        &Reading { final_result: Some(false), plaza: Some((at, 0.78)), ..Default::default() },
        now,
    );
    assert!(
        !changes.iter().any(|c| matches!(
            c,
            Change::MatchUpdated { patch, .. } if patch.mode == Some(GameMode::WeekendPlaza)
        )),
        "a hit from before the battle ended was counted towards a decision after it"
    );

    // Hits on the result screen itself are a different matter - two frames of
    // the same screen is what the debounce asks for, and it still gets them.
    //
    // Three ticks, not two: the first frame of the result screen is the one that
    // ENDS the blind wait, and `resolve_mode` runs before `observe_final_screen`
    // in a tick, so the probes only start counting on the tick after it. The
    // same off-by-one as `the_versus_2pick_label_clears_the_default_deck`, and
    // affordable for the same reason - the hold is twelve seconds of frames.
    let mut decided = false;
    for _ in 0..2 {
        now += timing::TICK;
        let changes = m.tick(
            &Reading { final_result: Some(false), plaza: Some((at, 0.78)), ..Default::default() },
            now,
        );
        decided |= changes.iter().any(|c| matches!(
            c,
            Change::MatchUpdated { patch, .. } if patch.mode == Some(GameMode::WeekendPlaza)
        ));
    }
    assert!(decided, "two frames of the actual result screen must still decide");
}

/// An unbounded wait must not eat the next match.
///
/// `start_match` only fires from `Idle`, so anything still resolving swallows
/// the versus screen that follows it - and with it the entire game. A
/// fifteen-second cap hid this: nothing was still open by the time the player
/// found another opponent. Removing the cap makes the next match the thing that
/// ends the last one's wait.
#[test]
fn the_next_match_closes_the_one_still_waiting() {
    let mut m = Machine::new();
    let t = Instant::now();
    m.tick(&on_versus_screen(), t);
    m.tick(&Reading { battle_end_splash: Some(true), ..Default::default() }, t + timing::TICK);

    // The player skips the result screen entirely and queues up again.
    let mut now = t + timing::TICK * 2;
    for _ in 0..4 {
        m.tick(&Reading::default(), now);
        now += timing::TICK;
    }

    let first = m.tick(&on_versus_screen(), now);
    assert!(finished(&first).is_none(), "one frame is not a new match");
    assert!(!started(&first));

    let second = m.tick(&on_versus_screen(), now + timing::TICK);
    let Some(Change::MatchFinished { patch, .. }) = finished(&second) else {
        panic!("the waiting match must close rather than swallow the next one");
    };
    assert_eq!(patch.result, Some(true), "the outcome the splash gave is still kept");
    assert!(started(&second), "and the new match must open on the same tick");
    assert!(matches!(m.phase(), Phase::InBattle { .. }));
}

/// Going to watch a replay after a match must not throw that match away.
///
/// Suppression discards an open match, and it is right to: a replay shows the
/// same versus screen and battlefield, so anything open when one starts cannot
/// be trusted. A match that is RESOLVING is the exception - its outcome came
/// off the end-of-battle splash before any replay existed. This only became
/// reachable when the wait stopped being capped at fifteen seconds; now
/// "finish a game, go and look at the replay" happens inside it.
#[test]
fn a_replay_after_the_battle_finishes_the_match_rather_than_discarding_it() {
    let mut m = Machine::new();
    let t = Instant::now();
    m.tick(&on_versus_screen(), t);
    m.tick(&Reading { battle_end_splash: Some(true), ..Default::default() }, t + timing::TICK);

    let replay = Reading { replay_banner: true, ..Default::default() };
    let changes = m.tick(&replay, t + timing::TICK * 2);

    let Some(Change::MatchFinished { patch, .. }) = finished(&changes) else {
        panic!("a resolved match must be kept, not abandoned");
    };
    assert_eq!(patch.result, Some(true));
    assert!(!changes.iter().any(|c| matches!(c, Change::MatchAbandoned { .. })));
    assert!(matches!(m.phase(), Phase::ReplaySuppressed { .. }));
}

/// The capture stopping is the fourth way the wait can end.
///
/// The player finishes their last game, reads the rewards and closes the
/// tracker. No final screen, no next match, no replay - and no frames coming
/// either, so the backstop will never fire because nothing is ticking.
#[test]
fn stopping_the_capture_closes_a_match_that_is_still_waiting() {
    let mut m = Machine::new();
    let t = Instant::now();
    m.tick(&on_versus_screen(), t);
    m.tick(&Reading { battle_end_splash: Some(false), ..Default::default() }, t + timing::TICK);

    let changes = m.close_open_match();
    let Some(Change::MatchFinished { patch, .. }) = finished(&changes) else {
        panic!("the row must be closed rather than left open");
    };
    assert_eq!(patch.result, Some(false), "the outcome is still worth keeping");
    assert!(
        flagged(patch, "closed-by-capture-stop"),
        "and the row must say why it is missing the rest"
    );
    assert!(matches!(m.phase(), Phase::Idle { .. }));
}

/// A match still IN BATTLE is left alone. It has no outcome, and inventing a
/// closed row because the capture stopped is worse than the open one the host
/// already has.
#[test]
fn stopping_the_capture_mid_battle_closes_nothing() {
    let mut m = Machine::new();
    let t = Instant::now();
    m.tick(&on_versus_screen(), t);

    assert!(m.close_open_match().is_empty());
    assert!(matches!(m.phase(), Phase::InBattle { .. }));
}

/// The CPU deck label is visible during deck selection, before the row exists.
#[test]
fn a_pre_battle_cpu_label_decides_the_mode_of_the_match_that_follows() {
    let mut m = Machine::new();
    let t = Instant::now();

    let deck_select = Reading { cpu_pre_battle: true, ..Default::default() };
    m.tick(&deck_select, t);
    m.tick(&deck_select, t + timing::TICK);

    let changes = m.tick(&on_versus_screen(), t + timing::TICK * 2);
    assert!(
        changes.iter().any(|c| matches!(
            c,
            Change::MatchStarted { mode: Some(GameMode::Cpu), .. }
        )),
        "the hint should be applied at start"
    );
}

/// ...but a hint that outlived its window must not be applied to whatever the
/// player started instead.
#[test]
fn a_stale_pre_battle_hint_is_dropped() {
    let mut m = Machine::new();
    let t = Instant::now();
    let deck_select = Reading { cpu_pre_battle: true, ..Default::default() };
    m.tick(&deck_select, t);
    m.tick(&deck_select, t + timing::TICK);

    let much_later = t + timing::PRE_BATTLE_HINT_TTL + timing::TICK;
    let changes = m.tick(&on_versus_screen(), much_later);
    assert!(
        changes.iter().any(|c| matches!(c, Change::MatchStarted { mode: None, .. })),
        "a stale hint must not decide the mode"
    );
}

/// A single frame must never convince a weak signal. The custom-room probe has
/// no verified positive sample and used to false-positive on card art.
#[test]
fn one_frame_of_a_weak_signal_decides_nothing() {
    let mut m = Machine::new();
    let t = Instant::now();
    m.tick(&on_versus_screen(), t);

    let once = Reading { custom_room: true, ..Default::default() };
    let changes = m.tick(&once, t + timing::TICK);
    assert!(
        !changes.iter().any(|c| matches!(
            c,
            Change::MatchUpdated { patch, .. } if patch.mode == Some(GameMode::Custom)
        )),
        "one frame set a weak mode"
    );
}

/// The score-system label is authoritative and may correct a weaker guess made
/// earlier in the same match.
#[test]
fn an_authoritative_label_corrects_a_weaker_guess() {
    let mut m = Machine::new();
    let t = Instant::now();
    m.tick(&on_versus_screen(), t);

    let custom = Reading { custom_room: true, ..Default::default() };
    m.tick(&custom, t + timing::TICK);
    m.tick(&custom, t + timing::TICK * 2);

    let mut now = t + timing::TICK * 3;
    let mut corrected = false;
    for _ in 0..5 {
        let changes = m.tick(&bp_result(8), now);
        corrected |= noted(&changes, "mode-corrected");
        if finished(&changes).is_some() {
            break;
        }
        now += timing::TICK;
    }
    assert!(corrected, "ranked must correct the earlier weak guess, and say so");
}

/// The cumulative totals count up frame by frame. If they never settle before
/// the hold expires, the last reading is still better than nothing - it is
/// exactly what the old first-frame latch would have stored.
#[test]
fn a_never_settling_total_is_stored_as_best_effort() {
    let mut m = Machine::new();
    let t = Instant::now();
    m.tick(&on_versus_screen(), t);

    let counting_up = |mp: i32, cr: i32| Reading {
        final_result: Some(true),
        score_system: Some(score_system(ScoreSystem::Mp)),
        numbers: NumberReads {
            delta_mp: Some(15),
            total_mp: Some(mp),
            delta_cr: Some(-16),
            total_cr: Some(cr),
            ..Default::default()
        },
        ..Default::default()
    };

    // Never the same value twice, so consensus can never settle.
    let mut now = t + timing::TICK;
    let mut mp = 88638;
    let mut closed = None;
    // Bounded by the constants rather than a tick count, so raising either one
    // cannot quietly turn this into a test that gives up before the hold does.
    let give_up = now + timing::MODE_SETTLE.max(timing::NUMBERS_GRACE) + timing::TICK * 4;
    while now <= give_up {
        let changes = m.tick(&counting_up(mp, 1557 + (mp - 88638)), now);
        if let Some(Change::MatchFinished { patch, .. }) = finished(&changes) {
            closed = Some(patch.clone());
            break;
        }
        mp += 8;
        now += timing::TICK;
    }

    let patch = closed.expect("the hold must expire rather than hang");
    assert!(patch.mp.is_some(), "the last reading should be kept, not lost");
    assert_eq!(patch.delta_mp, Some(15), "the static delta settles normally");
}

/// A 2Pick match must survive the reward carousel.
///
/// The measured shape of `2pick-1920-fullscreen-lose`: the LOSE banner is
/// readable immediately, and for the next 5.5s the reward strip shows other
/// panels while 2Pick階級 waits its turn. Nothing else on that screen identifies
/// the mode, so a machine that closes inside those 5.5s files a 2Pick loss as
/// `unknown` - or, if the score-system anchor false-positives on the way past,
/// as `ranked`, into the user's ranked record.
///
/// Both are represented here: the anchor fires on two frames before the label
/// arrives, exactly as it did on the real recording, where it matched the app's
/// own HUD rather than anything the game drew.
#[test]
fn a_2pick_label_arriving_after_the_carousel_still_decides_the_match() {
    let mut m = Machine::new();
    let t = Instant::now();
    m.tick(&on_versus_screen(), t);

    let banner_only =
        || Reading { final_result: Some(false), ..Default::default() };
    let stray_anchor = || Reading {
        final_result: Some(false),
        score_system: Some(score_system(ScoreSystem::Bp)),
        ..Default::default()
    };
    let label_up =
        || Reading { final_result: Some(false), two_pick: true, ..Default::default() };

    let mut now = t + timing::TICK;
    let mut closed = None;
    let label_at = now + Duration::from_millis(5500);
    let give_up = now + timing::MODE_SETTLE + timing::TICK * 8;

    while now <= give_up {
        // Two consecutive stray hits, then back to nothing - the sporadic shape
        // the anchor showed on the recording, and enough to defeat a debounce
        // that only asked for two frames without asking what fired them.
        let reading = if now >= label_at {
            label_up()
        } else if now >= label_at - timing::TICK * 3 && now < label_at - timing::TICK {
            stray_anchor()
        } else {
            banner_only()
        };
        let changes = m.tick(&reading, now);
        if let Some(Change::MatchFinished { patch, .. }) = finished(&changes) {
            closed = Some(patch.clone());
            break;
        }
        now += timing::TICK;
    }

    let patch = closed.expect("the hold must still close, not hang");
    assert_eq!(
        patch.mode,
        Some(GameMode::TwoPick),
        "the label arrives late but it is the only real evidence of the mode"
    );
    assert_eq!(patch.result, Some(false));
    assert_eq!(patch.bp, None, "this reading carries no number for it to store");
}

/// The versus screen decides the mode, and the result screen cannot take it
/// back.
///
/// This is the shape of `2pick-1920-fullscreen-win`, which is why it exists.
/// The player wins, so the result screen runs a RANK UP animation first and the
/// reward carousel does not reach 2Pick階級 until 15s after the banner - past
/// every grace this machine has. In the meantime the 2Pick screen shows its own
/// 「BP 100」, which the `bp` template matches at 0.757-0.787 on nine consecutive
/// frames. Every result-screen signal therefore says `ranked`, confidently and
/// for a long time.
///
/// The only honest evidence was on the versus screen ten minutes earlier. So it
/// has to be taken there, and it has to outrank what comes later.
#[test]
fn a_2pick_match_identified_on_the_versus_screen_is_not_relabelled_as_ranked() {
    let mut m = Machine::new();
    let t = Instant::now();

    let versus_2pick = Reading { two_pick_versus: true, ..on_versus_screen() };
    m.tick(&versus_2pick, t);
    // The label is on screen for about ten seconds; two ticks satisfy the
    // debounce and the match is already open by the second one.
    m.tick(&versus_2pick, t + timing::TICK);
    m.tick(&versus_2pick, t + timing::TICK * 2);

    // Now the result screen, insisting on ranked for as long as it likes.
    let mut now = t + timing::TICK * 3;
    let mut closed = None;
    let give_up = now + timing::MODE_SETTLE + timing::TICK * 8;
    while now <= give_up {
        let changes = m.tick(&bp_result(0), now);
        if let Some(Change::MatchFinished { patch, .. }) = finished(&changes) {
            closed = Some(patch.clone());
            break;
        }
        now += timing::TICK;
    }

    let patch = closed.expect("the hold must close");
    assert_eq!(
        patch.mode,
        Some(GameMode::TwoPick),
        "the result screen's BP label must not overrule the versus screen"
    );
}

/// The versus label also clears the pre-filled default deck, the same as the
/// result-screen label does - a 2Pick run brings its own deck.
#[test]
fn the_versus_2pick_label_clears_the_default_deck() {
    let mut m = Machine::new();
    let t = Instant::now();

    let versus_2pick = Reading { two_pick_versus: true, ..on_versus_screen() };
    // Three ticks, not two. The first is spent opening the match, and
    // `start_match` clears the debounce along with everything else - so the two
    // frames the debounce wants can only start counting on the tick after that.
    m.tick(&versus_2pick, t);
    m.tick(&versus_2pick, t + timing::TICK);
    let changes = m.tick(&versus_2pick, t + timing::TICK * 2);
    let cleared = changes.iter().any(|c| matches!(
        c,
        Change::MatchUpdated { patch, .. } if patch.clear_my_deck == Some(true)
    ));
    assert!(cleared, "2Pick brings its own deck, so the default must go");
}

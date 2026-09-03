//! Everything measured off real frames: search windows, template sets, the
//! scale each set is matched at, hit thresholds, and the result-screen layout
//! arithmetic. The single source of truth for all of it.
//!
//! Named for what it is rather than for one of its parts - an earlier draft
//! called this `roi` and then accumulated thresholds and layout offsets it could
//! not account for. `tools/vision-native/CALIBRATION.md` is its prose companion.
//!
//! Every frame is normalised to a fixed 1280x720 canvas, so each UI element
//! sits at a stable position and can be given a measured window instead of a
//! broad search. That is not tidiness: searching half a frame for a small icon
//! costs ~300ms, the same search over its calibrated window ~14ms. It is also a
//! correctness property - every broad window this table ever had turned out to
//! be a false-positive source as well as a dominant cost. Measure the element
//! and add a window; do not reintroduce one.
//!
//! Windows are derived, not guessed: `size = largest template in the set +
//! 2 * MARGIN`, centred on the measured position. MARGIN is 20px against
//! observed drift of at most 6px. Cost is dominated by candidate positions, so
//! the margin is the main performance dial - widening it by 20px roughly
//! doubles the work. See `tools/vision-native/CALIBRATION.md`.
//!
//! Ported from `src/main/recognition/visionNative.ts` and the `THRESHOLD` block
//! in `src/main/recognition/forkedImageAnalyzer.ts`. Both have since been
//! DELETED - this module is the only copy. The `matches_the_typescript_table`
//! guard test that policed the overlap went with them, exactly as its own
//! comment said it should.

use svwb_vision_native::Rect;

pub const BASE_HEIGHT: u32 = svwb_vision_native::BASE_HEIGHT;

// ------------------------------------------------------------------- windows

/// Versus screen. Element centres: own (147,496), enemy (1133,496).
pub const CLASSES_OWN: Rect = Rect::new(58, 456, 178, 80);
pub const CLASSES_ENEMY: Rect = Rect::new(1044, 456, 178, 80);

/// Element centres: own (74,496), enemy (1204,498).
pub const EMBLEMS_OWN: Rect = Rect::new(7, 420, 134, 152);
pub const EMBLEMS_ENEMY: Rect = Rect::new(1137, 422, 134, 152);

/// Centred battle-start overlay, on screen for roughly one second - about two
/// ticks, so this pair must be probed on EVERY tick.
/// Element centres: own (454,496), enemy (827,496).
pub const PLAY_ORDER_OWN: Rect = Rect::new(367, 439, 173, 113);
pub const PLAY_ORDER_ENEMY: Rect = Rect::new(740, 439, 173, 113);

/// The CPU deck label sits in a different place before the battle than on the
/// result screen, so both are probed and the better score wins.
/// Element centres: pre-battle (1194,121), result (746,265).
pub const MODES_CPU_PRE_BATTLE: Rect = Rect::new(1122, 81, 144, 80);
pub const MODES_CPU_RESULT: Rect = Rect::new(674, 225, 144, 80);

/// The two WIN/LOSE banners, in the order the player sees them.
///
/// `RESULT_MID` is the large centred splash thrown up the moment the battle
/// ends, over the battlefield - hence the low [`threshold::RESULT_MID`], it
/// fades in over a busy background. `RESULT` is the banner at the top of the
/// final result/reward screen that follows it, and is the one whose layout the
/// number windows are measured against.
///
/// The gap between them is load-bearing: the outcome is persisted on the splash
/// so it survives a crash, while mode and numbers stay open until the final
/// screen has settled.
///
/// Both are horizontally centred: centres (640,361), (639,66).
///
/// NAMING: `_MID` is inherited from the `result_mid` template directory and its
/// meaning is inferred from the windows and call sites, not documented anywhere.
/// The constants keep the directory's vocabulary deliberately - renaming one
/// without the other would be worse than an unclear name.
pub const RESULT_MID: Rect = Rect::new(268, 252, 744, 218);
pub const RESULT: Rect = Rect::new(470, 0, 338, 123);

/// The weekend-plaza label on the result screen. Mutually exclusive with the
/// score-system labels - a plaza result shows neither BP nor MP/CR.
///
/// Measured across 11 result frames from four plaza matches: the label lands at
/// (887-889, 285), pixel-stable but for 2px. Window = template (107x40) + 20px.
///
/// This replaces a `topRight` half-frame search, which is how a ranked match
/// came to be recorded as `weekendPlaza`: the template is five ornate glyphs and
/// that window is full of ornate Chinese card text mid-battle (measured 0.5846
/// against a card's effect text, threshold 0.7). Narrowing drops the worst score
/// across the fixtures from 0.5532 to 0.3854, true hits untouched at 0.7702.
pub const MODES_PLAZA: Rect = Rect::new(867, 265, 149, 80);

/// The 室長 / 訪客 labels on the custom-room screen, one per side.
///
/// Measured across a 4m16s 1280x720 windowed recording (39 frames, three
/// visits): host settles at (75,97), guest at (1158,97), both pixel-stable. The
/// panel slides outward as it fades in, so the first frame of an appearance sits
/// further out - extremes (45,97) / (1187,97) horizontally, y=84 vertically.
///
/// This replaces `leftHalf` / `rightHalf` searches, which were both the single
/// most expensive matching in the tick (3.19G multiply-accumulates, 78% of the
/// whole tick) and a live false positive: a 50x40 label over 640x720 of
/// battlefield scored 0.7002 on card art at (857,144), threshold 0.7. Narrowing
/// drops the worst over 598 negative frames from 0.7002 to 0.5066, true hits
/// stay 0.89-0.96, probe 136.7ms -> 2.5ms.
///
/// The window matches the WHOLE set, not one label: which side shows 室長
/// depends on whether the user hosted, so both templates compete on both sides.
pub const CUSTOM_OWN: Rect = Rect::new(25, 64, 119, 93);
pub const CUSTOM_OTHER: Rect = Rect::new(1138, 64, 119, 93);

/// Which point system the ranked result screen shows, and where its label sits -
/// the anchor every number window on that screen is measured from.
///
/// ONE window for both labels, deliberately tall. The BP result screen's reward
/// list has a VARIABLE row count (a win shows 對戰勝利 plus three sub-rows plus
/// TOTAL; a loss shows only 對戰表現獎勵, 時間獎勵 and TOTAL), and everything
/// below it slides up by 33px per missing row. Measured: the BP label is at
/// y=420 on the win fixture and y=321 on a loss, a 99px shift. The previous pair
/// of windows was calibrated on the win layout only, so on a loss `bp` fell
/// outside `scoreSystemBp` and landed inside `scoreSystemCr`, where it was
/// discarded for having the wrong name - both probes missed, and the match was
/// never recognised as ranked at all.
///
/// Width covers the label's horizontal drift during the count-up animation
/// (measured 1053 -> 1105; the 階級/BP group slides while the reward list above
/// it stays put).
///
/// The `bp` template holds the 「BP」 glyphs ONLY, and stops there on purpose.
/// It used to be 64px wide and include the 「：」 that followed them, cut from a
/// client that drew one. A later client dropped the colon and tightened the
/// spacing, so that third of the template came to sit over the first digit of
/// the cumulative BP - a digit that changes every match. True labels fell from
/// 0.955-1.000 to 0.706-0.727 against a 0.7 threshold, i.e. a coin flip per
/// frame, which cost three matches their mode AND their BP (`mode-guessed` plus
/// `ranked-no-numbers`) before anyone noticed. Cut to the glyphs, the same
/// frames score 0.976-1.000 and the old colon-era fixtures still score 0.955
/// (win 0.976), so one template covers both clients.
///
/// Trimming raised the known 2Pick false positive from 0.771 to 0.963 - see
/// `Machine::ranked`, which is why that signal is only `Strong`. Everything
/// that is neither a BP nor a 2Pick result screen stays at or below 0.595
/// across every fixture.
pub const SCORE_SYSTEM_ANCHOR: Rect = Rect::new(990, 230, 250, 250);

/// The 「獲得MP」 label, which anchors the MP block the way `cr` anchors the CR
/// block below it.
///
/// The two blocks do NOT move together, which is why one anchor cannot serve
/// both. On `ranked-gm-2560-fullscreen` the client draws an extra 「指定系列」
/// row under the MP bar; the CR block and the divider above it stay put
/// (`cr` 306 -> 304) while the whole MP block is pushed 19px UP
/// (label 174 -> 155, the `MP nnnnn` row 210 -> 190). Reading [`GAINED_MP`] and
/// [`TOTAL_MP`] at [`result_layout_offset`] there crops the gap above the label
/// and the tail of the row above the total - the same class of silent
/// mis-read the reward list once caused for BP, and the reason that one is
/// anchored too.
///
/// The template holds the 「獲得MP」 glyphs only: no box border, and above all
/// none of the value that follows them on the same row. It scores 1.000 on the
/// fixture it was cut from, 0.913 on the 2560 fixture's client, and at most
/// 0.508 on every other screen in `tests/fixtures/captures` - so the 0.7
/// threshold sits in clean air on both sides.
///
/// Window size is the usual `template + 2 * MARGIN`, except vertically, where it
/// must also span the 19px between the two observed layouts. The label does not
/// drift horizontally during the count-up (1027 vs 1028 across every settled
/// frame), unlike the BP one, so the width carries no extra slack for it.
pub const MP_GAIN_ANCHOR: Rect = Rect::new(1007, 135, 128, 85);

/// Where the 「獲得MP」 label sits on the layout [`GAINED_MP`] and [`TOTAL_MP`]
/// were measured from.
pub const MP_GAIN_ANCHOR_Y: i32 = 174;

/// OCR windows for the MP result screen (Grand Master and above), measured from
/// `tests/fixtures/captures/ranked-gm-mp-windowed`.
///
/// These are the REFERENCE layout. The two CR windows are placed against the
/// score-system label and shifted by [`result_layout_offset`]; the two MP
/// windows are placed against the 「獲得MP」 label and shifted by
/// [`mp_block_offset`], because the two halves of the panel move independently -
/// see [`MP_GAIN_ANCHOR`].
///
/// The two signed windows are deliberately wider than the digits need. The
/// originals (`gainedMp` 52px, `deltaCrMpLayout` 46px) fit a sign plus two
/// digits, so "+173" came back as "173" - the leading sign fell outside. For a
/// gain that parses to the same number and hides the problem; for a three-digit
/// LOSS it would drop the minus and store the value with the sign inverted.
pub const GAINED_MP: Rect = Rect::new(1116, 175, 64, 28);
pub const TOTAL_MP: Rect = Rect::new(1142, 212, 90, 32);
pub const DELTA_CR_MP_LAYOUT: Rect = Rect::new(1158, 302, 66, 34);
pub const TOTAL_CR_MP_LAYOUT: Rect = Rect::new(1162, 340, 68, 30);

/// The 2Pick階級 label on the 2Pick result screen.
///
/// Measured from `2pick-1920-fullscreen-lose`: over the final screen sampled at
/// 4fps the label settles at (783,268) and holds 0.840 there for the remaining
/// 5.5s, against a 118x40 template.
///
/// The reward strip is a CAROUSEL - 對戰通行證 and the other rewards rotate
/// through first, and 2Pick階級 only arrives last, roughly 5.5s after the
/// score-system label. It slides horizontally on the way in (first frame 738,
/// then 781, then 783 for good), so the window carries left slack for the
/// slide rather than fitting only the settled position.
///
/// The previous values (780,295,180,50) sat entirely BELOW the label and scored
/// 0.052 on frames where it is plainly on screen, so `two_pick` never fired and
/// every 2Pick match fell through to the `ranked` branch - see the regression in
/// `tests/fixtures.rs`. They were carried over untested from the old pipeline
/// and marked UNVERIFIED; this is the first 2Pick fixture able to check them.
pub const MODES_2PICK: Rect = Rect::new(728, 248, 220, 80);

/// Where the BP result screen shows the points gained, per layout.
///
/// `ranked.value` is the TOTAL row - the BP actually gained for the match, which
/// is what the `bp` column stores. Measured from
/// `ranked-bp-1920-fullscreen/01-result-win-bp.png`, where it reads exactly
/// "+124" on every frame the screen is up.
///
/// The previous window was `(1115, 200, 65, 30)`, aimed at the 對戰表現獎勵 row.
/// It sat in the empty gap between that label and its number and returned an
/// empty string on every frame - BP was never captured at all. The defect stayed
/// invisible because the ranked branch was gated on the broken `modes_ranked`
/// probe, so this code had never once run.
///
/// `ranked` is measured on the WIN layout and is shifted per frame by
/// [`result_layout_offset`]: a loss shows three fewer reward rows, lifting the
/// block by 99px. Left unshifted, this window reads the 階級 row below it - on
/// the loss frame it crops "P：88794", the CUMULATIVE BP, which would have been
/// stored as the points gained for the match.
///
/// `cursor` MUST overlap `value`: it is what detects the mouse sitting on top of
/// the number, and a window that does not cover the digits cannot do that.
pub struct BpLayout {
    pub value: Rect,
    pub cursor: &'static [Rect],
}

pub const BP_LAYOUT_RANKED: BpLayout = BpLayout {
    value: Rect::new(1150, 334, 90, 32),
    cursor: &[Rect::new(1080, 296, 200, 108)],
};

/// The 2Pick階級 labels on the VERSUS screen, one per player.
///
/// This is the probe that actually identifies a 2Pick match, and
/// [`MODES_2PICK`] is the fallback rather than the other way round. The versus
/// screen carries the label on the same frame that starts the match, so the mode
/// is known from the first tick of the battle instead of being inferred from a
/// result screen ten minutes later - which was where every 2Pick match was being
/// lost. Measured on `2pick-1920-fullscreen-win`, where the result-screen label
/// never landed at all and the match still replayed as `ranked` after
/// `MODES_2PICK` had already been corrected.
///
/// Two windows, one template. Both players' rows show the same 「2Pick階級」, so
/// either one answers the question, and an overlay or a HUD sitting over one
/// corner cannot take the signal away. Measured at (389,617) and (813,617),
/// both 78x17.
pub const TWO_PICK_VERSUS_OWN: Rect = Rect::new(377, 607, 102, 38);
pub const TWO_PICK_VERSUS_ENEMY: Rect = Rect::new(801, 607, 102, 38);

/// Where the 2Pick result screen shows the points gained.
///
/// Measured from `2pick-1920-fullscreen-win`, the recording that could finally
/// see it: 「獲得BP +100」 with the value at x1117-1163, y274-290.
///
/// TWO BP figures are on that screen and they are not interchangeable. This is
/// 「獲得BP +N」, the per-match gain, which is what the `bp` column stores. Below
/// right sits 「BP N」, the career cumulative - reading that one into `bp` would
/// file a lifetime total as a single match's gain. The lose recording could not
/// settle this because the user's own HUD sat over the gain row, which is a live
/// condition rather than an artefact; the win recording has the HUD elsewhere.
///
/// The line is left-aligned at a fixed position, not centred - 「獲得」, 「得」 and
/// "B" land on identical columns in both recordings despite one showing +0 and
/// the other +100. So a longer value grows rightward, and the window carries its
/// slack on that side, stopping short of the ⓘ badge at x1182. Left margin is
/// for the sign, per the lesson recorded on [`GAINED_MP`].
///
/// The whole panel slides in horizontally before it settles, so an early frame
/// has the value further left. That is what the multi-frame consensus is for.
pub const BP_LAYOUT_2PICK: BpLayout = BpLayout {
    value: Rect::new(1112, 270, 66, 26),
    cursor: &[Rect::new(1050, 250, 200, 70)],
};

/// Cursor probes covering the MP/CR block on the ranked result screen.
///
/// Several overlapping windows rather than one: the cursor can straddle the edge
/// of a single window, and taking the best score across all of them guards that
/// boundary case.
pub const MP_CURSOR_WINDOWS: &[Rect] =
    &[Rect::new(1055, 315, 210, 135), Rect::new(1060, 280, 210, 135)];

/// The "開始播放對戰紀錄" banner shown when a replay starts.
///
/// Measured across a 1280x720 windowed recording of two replays (one watched to
/// the end, one exited early): the banner lands at (498,409) on both and scores
/// 0.822-0.891 at full resolution. Window = template (290x40) + 30px margin,
/// wider than the usual 20 because this is a single recording.
///
/// Narrowing it was not primarily a performance fix, though it is one (490M
/// multiply-accumulates at half resolution down to 45M at full): the cost is
/// what forced the probe to run on one tick in four, and the banner is on screen
/// for about a second. Sampling a 1s event every 2s aliases - measured over four
/// tick phases, the probe MISSED the banner in three, and a missed banner means
/// the replay is recorded as a real match. See CALIBRATION.md 8.3.
pub const HISTORY: Rect = Rect::new(468, 378, 350, 102);

/// The "X 播放‧停止" hotkey chip on the replay playback bar.
///
/// [`HISTORY`] says a replay STARTED; this says one is still playing, and the
/// two answer different questions. The banner is gone a second later, so on its
/// own it can only arm a blind timer - too short and the rest of the replay is
/// unprotected, too long and a real match started right after an early exit is
/// swallowed. This chip is on screen for the whole of playback and vanishes the
/// moment the user leaves, so it can hold a latch instead.
///
/// Replay-only, and that is the property that matters: a real battle's bottom
/// bar reads 戰場紀錄 / 額外PP / 回合結束 and has no play/stop control. 選單
/// would have been wrong - menus outside a replay show it too, and a latch that
/// fired in a menu would suppress a REAL match.
///
/// The bar is left-aligned and grows as entries appear, so the chip slides
/// between three measured positions: x = 141, 200, 336, all at y = 699-700.
/// Measured across a 1280 windowed recording (87 hits, 0.797-1.000) and a 1920
/// fullscreen one (14 hits, 0.889-0.980, landing at x=199 against 200 - so it
/// survives normalisation from another resolution). Across 667 negative frames
/// of real ranked, CPU and custom play it never cleared 0.7; worst 0.407.
pub const REPLAY_CHROME: Rect = Rect::new(121, 679, 353, 41);

// NOT PORTED: `modesRanked` { x: 780, y: 205, w: 150, h: 60 }.
//
// Dead code in the shipped analyzer. The window does not contain the rank crest
// - the crest was measured at (74,283) on the pre-battle home screen - so the
// probe never matched and the whole ranked branch never ran, which is why no
// ranked match ever recorded its mode, CR or BP. It was superseded by
// `detectScoreSystem`, which reads the BP/MP label on the same screen as the
// numbers it decides the position of.
//
// Verified 2026-08-28: `forkedImageAnalyzer.ts` contained no call against this
// window, and that file has since been deleted outright - the JS analyzer it
// belonged to is gone, so there is no longer anywhere for the probe to be
// resurrected by accident. The guard test that watched for that is gone with it. The only remaining references are comments plus the calibration tools
// (`vision-native/src/bin/calibrate.rs`, `scan.cjs`, `bench-tick.cjs`), which
// scan template sets directly and do not need an entry here. The
// `resources/templates/modes_ranked/` directory is left alone; removing it is a
// separate decision from this port.

// --------------------------------------------------------------- number windows

/// Look up a number-reading window by its stable name.
///
/// This is how anything OUTSIDE the engine (the OCR fixture check, a future
/// calibration tool) refers to these windows without carrying its own copy of
/// the coordinates - the habit that produced `check-rois.cjs` and the replay
/// mirror. Names match the vocabulary used in `numbers::read_all`.
pub fn number_window(name: &str) -> Option<Rect> {
    Some(match name {
        "bpRanked" => BP_LAYOUT_RANKED.value,
        "bp2Pick" => BP_LAYOUT_2PICK.value,
        "gainedMp" => GAINED_MP,
        "totalMp" => TOTAL_MP,
        "deltaCr" => DELTA_CR_MP_LAYOUT,
        "totalCr" => TOTAL_CR_MP_LAYOUT,
        _ => return None,
    })
}

// --------------------------------------------------------------- probe registry

/// One template probe: a named window matched against one template set.
pub struct Probe {
    /// Stable identifier, matching the key used in `visionNative.ts`'s `ROI`.
    pub name: &'static str,
    pub set: &'static str,
    pub window: Rect,
}

/// Every template probe the analyzer performs, in a stable order.
///
/// The OCR number windows are deliberately absent - they are read, not matched.
/// The `cursor` entries are here because they ARE template matches, against the
/// same windows those numbers are read from.
///
/// This exists so "what does a tick actually probe" has one answer that can be
/// enumerated, rather than being implicit in the order of `if` statements in
/// `analyzeOnce`. `probe-dump` walks it; the state machine will too.
pub const PROBES: &[Probe] = &[
    Probe { name: "classesOwn", set: templates::CLASSES, window: CLASSES_OWN },
    Probe { name: "classesEnemy", set: templates::CLASSES, window: CLASSES_ENEMY },
    Probe { name: "emblemsOwn", set: templates::EMBLEMS, window: EMBLEMS_OWN },
    Probe { name: "emblemsEnemy", set: templates::EMBLEMS, window: EMBLEMS_ENEMY },
    Probe { name: "playOrderOwn", set: templates::PLAY_ORDER, window: PLAY_ORDER_OWN },
    Probe { name: "playOrderEnemy", set: templates::PLAY_ORDER, window: PLAY_ORDER_ENEMY },
    Probe { name: "modesCpuPreBattle", set: templates::MODES_CPU, window: MODES_CPU_PRE_BATTLE },
    Probe { name: "modesCpuResult", set: templates::MODES_CPU, window: MODES_CPU_RESULT },
    Probe { name: "resultMid", set: templates::RESULT_MID, window: RESULT_MID },
    Probe { name: "result", set: templates::RESULT, window: RESULT },
    Probe { name: "modesPlaza", set: templates::MODES_PLAZA, window: MODES_PLAZA },
    Probe { name: "customOwn", set: templates::CUSTOM, window: CUSTOM_OWN },
    Probe { name: "customOther", set: templates::CUSTOM, window: CUSTOM_OTHER },
    Probe { name: "scoreSystemAnchor", set: templates::SCORE_SYSTEM, window: SCORE_SYSTEM_ANCHOR },
    Probe { name: "mpGainAnchor", set: templates::MP_GAIN, window: MP_GAIN_ANCHOR },
    Probe { name: "modes2Pick", set: templates::MODES_2PICK, window: MODES_2PICK },
    Probe {
        name: "twoPickVersusOwn",
        set: templates::MODES_2PICK_VERSUS,
        window: TWO_PICK_VERSUS_OWN,
    },
    Probe {
        name: "twoPickVersusEnemy",
        set: templates::MODES_2PICK_VERSUS,
        window: TWO_PICK_VERSUS_ENEMY,
    },
    Probe { name: "history", set: templates::HISTORY, window: HISTORY },
    Probe { name: "replayChrome", set: templates::REPLAY_CHROME, window: REPLAY_CHROME },
    Probe { name: "cursorMp0", set: templates::CURSOR, window: MP_CURSOR_WINDOWS[0] },
    Probe { name: "cursorMp1", set: templates::CURSOR, window: MP_CURSOR_WINDOWS[1] },
    Probe { name: "cursorBpRanked", set: templates::CURSOR, window: BP_LAYOUT_RANKED.cursor[0] },
    Probe { name: "cursorBp2Pick", set: templates::CURSOR, window: BP_LAYOUT_2PICK.cursor[0] },
];

// ---------------------------------------------------------------- template sets

/// Directory names under `resources/templates`.
pub mod templates {
    pub const CLASSES: &str = "classes";
    pub const EMBLEMS: &str = "emblems";
    pub const PLAY_ORDER: &str = "play_order";
    pub const RESULT: &str = "result";
    pub const RESULT_MID: &str = "result_mid";
    pub const MODES_CPU: &str = "modes_cpu";
    pub const MODES_2PICK: &str = "modes_2pick";
    pub const MODES_2PICK_VERSUS: &str = "modes_2pick_versus";
    pub const MODES_PLAZA: &str = "modes_plaza";
    pub const CURSOR: &str = "cursor";
    pub const CUSTOM: &str = "custom";
    pub const HISTORY: &str = "history";
    pub const REPLAY_CHROME: &str = "replay_chrome";
    pub const SCORE_SYSTEM: &str = "score_system";
    pub const MP_GAIN: &str = "mp_gain";
}

/// Downscale factor a set is matched at. Absent means full resolution.
///
/// Only 2 is used, and only where `check-scales.cjs` verified it does not move
/// the score across the threshold. Nothing is coarsened without a reason:
/// `history` used to be here purely because it was a whole-frame search, and
/// went back to full resolution once it got a calibrated window.
pub fn downscale_factor_for(template_set: &str) -> u32 {
    match template_set {
        // 704x97 and 566x178 banners.
        templates::RESULT_MID | templates::RESULT => 2,
        _ => 1,
    }
}

// ------------------------------------------------------------------ thresholds

/// Score above which a probe counts as a hit.
///
/// Collected here rather than left inline. Four of these were bare literals in
/// the middle of `analyzeOnce` (`resultMid > 0.3`, `replayBanner > 0.6`,
/// `replayChrome > 0.7`, custom `0.7`), which is how a value ends up tuned in
/// one branch and stale in another.
pub mod threshold {
    pub const CLASS: f64 = 0.7;
    pub const EMBLEM: f64 = 0.7;
    /// Lower than the rest: the overlay is on screen for ~0.9s and a partially
    /// faded frame still has to count.
    pub const PLAY_ORDER: f64 = 0.6;
    pub const RANKED: f64 = 0.7;
    /// Raised from 0.58 once `modes_cpu` got a template for what the pre-battle
    /// screen actually shows. That 0.58 was not a considered choice - it was the
    /// only number that let a "CPU牌組" template scrape past a label reading
    /// "CPU" plus a class emblem, i.e. a PARTIAL match against different text.
    /// Measured across the practice recording that partial match scored
    /// 0.5236-0.6195, so the threshold cut through the middle of it and roughly
    /// half the frames failed. With `cpu_prebattle` in the set the same frames
    /// score 0.930-1.000.
    pub const CPU: f64 = 0.7;
    pub const RESULT: f64 = 0.7;
    /// Deliberately low: this is the mid-battle result overlay, which fades in
    /// over the battlefield rather than onto a clean screen.
    pub const RESULT_MID: f64 = 0.3;
    pub const CUSTOM: f64 = 0.7;
    pub const PLAZA: f64 = 0.7;
    pub const SCORE_SYSTEM: f64 = 0.7;
    /// The 「獲得MP」 label. Same value as the score-system label it sits above,
    /// and with the same margin behind it: 0.913-1.000 on the MP result screens,
    /// at most 0.508 anywhere else.
    pub const MP_GAIN: f64 = 0.7;
    pub const REPLAY_BANNER: f64 = 0.6;
    pub const REPLAY_CHROME: f64 = 0.7;
    /// The mouse cursor sitting on top of a number being read.
    pub const CURSOR_BLOCK: f64 = 0.6;
}

/// How far a repeated weak hit may move and still count as the same element.
///
/// A UI label is pixel-stable once the frame is normalised; drifting card text
/// is not. Generous enough to absorb the normalisation drift measured across
/// recordings (at most 6px - see CALIBRATION.md).
pub const POSITION_TOLERANCE_PX: u32 = 8;

// ------------------------------------------------------------------- timings

/// Durations measured off recordings, not chosen. Each one has a failure it was
/// sized against.
pub mod timing {
    use std::time::Duration;

    /// One tick. Everything below is expressed against it.
    pub const TICK: Duration = Duration::from_millis(500);

    /// How long the start-of-playback banner holds the replay latch alone.
    ///
    /// It has to bridge the gap between the banner disappearing and the playback
    /// chrome appearing - the replay's versus screen, exactly the frames that
    /// would otherwise be recorded as a match. Measured at 10.5s (1280 windowed)
    /// and 10.0s (1920 fullscreen); 15s keeps the margin the old timer had.
    pub const REPLAY_BANNER_FLOOR: Duration = Duration::from_secs(15);

    /// How long the playback chrome holds the latch after it was last seen.
    ///
    /// Short on purpose: this is what the user feels when they leave a replay
    /// early. The chrome runs continuously while playback is up (no internal gaps
    /// over 87 consecutive hits), so four ticks is slack, not coverage.
    pub const REPLAY_CHROME_GRACE: Duration = Duration::from_secs(2);

    /// How long a screen that follows the battle is still believed.
    ///
    /// The wait for the final screen has no end (see `FINAL_SCREEN_BACKSTOP`),
    /// but our willingness to DECIDE things during it must, and these are not
    /// the same duration. Two different screens live in that wait:
    ///
    /// - A custom room goes straight back to its own panel, and 室長 is on it.
    ///   Measured on `custom-1280-windowed-lose`, whose mode is read here and
    ///   nowhere else - the recording runs for four more minutes and never shows
    ///   a result screen at all. A practice match's CPU deck label behaves the
    ///   same way.
    /// - A ranked or 2Pick match shows FULL-SCREEN reward panels instead, which
    ///   hold until they are clicked and put unrelated art under every
    ///   calibrated window.
    ///
    /// Nothing distinguishes the two while they are up, so time does it. Fifteen
    /// seconds is the original grace, kept at its measured value because the
    /// evidence it was measured against - a post-battle label appearing within
    /// it - has not changed. What changed is what happens AFTER it: the match
    /// used to close, and now it only stops believing what it sees.
    pub const POST_BATTLE_TRUST: Duration = Duration::from_secs(15);

    /// The last resort for a match whose final result screen never arrived.
    ///
    /// This is NOT a grace period, and it is the one duration here that was not
    /// measured - it cannot be. Between the end-of-battle splash and the final
    /// screen the game shows FULL-SCREEN reward panels which wait for a click,
    /// so how long that gap runs is the player's choice and no recording can
    /// bound it. Nothing calibrated is on screen through it either: the reward
    /// panels cover the result banner, so there is not even a probe to say the
    /// player is still sitting there.
    ///
    /// The wait therefore ends on EVIDENCE, not on a clock - the final screen
    /// arriving, the next match's versus screen, or a replay starting (see
    /// `Machine::close_on_missing_final_screen` for the full list). Fifteen
    /// seconds used to end it instead, and closed a match that was still on its
    /// way with `mode: unknown`, no numbers, and a `final-screen-never-seen`
    /// flag - the player only had to read their rewards.
    ///
    /// What is left for this constant is the case where the evidence never
    /// comes: the player quit to the title screen, or the capture died. Ten
    /// minutes, so that no one reaches it by reading a reward screen, and the
    /// row still closes rather than staying open for the rest of the session.
    pub const FINAL_SCREEN_BACKSTOP: Duration = Duration::from_secs(600);

    /// How long a finished match stays open for number reads to retry.
    ///
    /// The result screen itself persists for 2.5s+; five seconds covers a cursor
    /// moving off the digits and the count-up animation settling. Without it the
    /// score-system label and the result banner cross their thresholds on the
    /// same tick, so there was exactly one attempt at each number.
    pub const NUMBERS_GRACE: Duration = Duration::from_secs(5);

    /// How long a result screen stays open when something is still missing.
    ///
    /// Measured, not chosen: on `2pick-1920-fullscreen-lose` the reward carousel
    /// rotates 2Pick階級 into place 5.5s after the result banner and holds it
    /// there. `NUMBERS_GRACE` alone gave 5s, so the match closed before the only
    /// probe that could tell 2Pick from ranked ever fired. Twelve seconds leaves
    /// room for a slower carousel without approaching the 15s the game keeps the
    /// screen up for. It costs nothing on a ranked match, which closes as soon as
    /// its numbers settle regardless of this floor.
    pub const MODE_SETTLE: Duration = Duration::from_secs(12);

    /// How long a pre-battle mode hint stays applicable.
    ///
    /// The CPU deck label is read during deck selection, before there is a match
    /// to attach it to. Long enough to cover matchmaking, short enough that the
    /// player cannot back out and start something else under it.
    pub const PRE_BATTLE_HINT_TTL: Duration = Duration::from_secs(30);
}

// --------------------------------------------------------------- result layout

/// Which point system a ranked result screen is showing.
#[derive(Debug, Clone, Copy, PartialEq, Eq, serde::Serialize)]
#[serde(rename_all = "lowercase")]
pub enum ScoreSystem {
    /// Below Grand Master. BP only, no CR shown at all.
    Bp,
    /// Grand Master and above. MP replaces BP, and CR is shown alongside.
    Mp,
}

impl ScoreSystem {
    /// Where this label sits on the layout the number windows were measured
    /// from. `Bp` is the WIN result screen (label at 1068,420); `Mp` is
    /// `ranked-gm-mp-windowed` (label at 1027,306, identical win and lose).
    pub const fn anchor_y(self) -> i32 {
        match self {
            ScoreSystem::Bp => 420,
            ScoreSystem::Mp => 306,
        }
    }
}

/// A located score-system label.
#[derive(Debug, Clone, Copy, PartialEq, serde::Serialize)]
pub struct ScoreSystemHit {
    pub system: ScoreSystem,
    /// Top-left of the matched label, in normalised canvas coordinates.
    pub x: u32,
    pub y: u32,
    pub score: f64,
}

/// How far this frame's result layout has slid relative to the reference.
/// Positive means further down the screen.
///
/// Only the reward list's row count moves the block, which is a vertical effect
/// only - so the horizontal drift of the label during the count-up animation
/// (measured at 52px) is deliberately NOT propagated: the reward rows are
/// right-aligned to a fixed column and do not move with it.
pub fn result_layout_offset(hit: &ScoreSystemHit) -> i32 {
    hit.y as i32 - hit.system.anchor_y()
}

/// How far the MP block has slid relative to the reference layout, from the
/// 「獲得MP」 label's own position.
///
/// Separate from [`result_layout_offset`] because the MP and CR halves of the
/// panel are anchored to different things: rows added under the MP bar (the
/// 「指定系列」 line) push the MP block up while leaving the CR block where it
/// is. Horizontal drift is ignored for the same reason as there - the values are
/// right-aligned to a fixed column.
pub fn mp_block_offset(label_y: u32) -> i32 {
    label_y as i32 - MP_GAIN_ANCHOR_Y
}

/// Move a window vertically, keeping it inside the canvas.
///
/// The clamp matters: a label matched near the top or bottom edge of the anchor
/// window would otherwise push an OCR window off-canvas, and an out-of-bounds
/// window is rejected rather than returning an empty read.
pub fn shift_roi(roi: Rect, dy: i32) -> Rect {
    if dy == 0 {
        return roi;
    }
    let max_y = BASE_HEIGHT.saturating_sub(roi.h) as i32;
    let y = (roi.y as i32 + dy).clamp(0, max_y) as u32;
    Rect { y, ..roi }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn shift_clamps_to_the_canvas() {
        // A window pushed past the bottom edge stops at it rather than going
        // out of bounds, which would be rejected outright.
        let shifted = shift_roi(TOTAL_CR_MP_LAYOUT, 10_000);
        assert_eq!(shifted.y, BASE_HEIGHT - TOTAL_CR_MP_LAYOUT.h);
        assert_eq!(shift_roi(TOTAL_CR_MP_LAYOUT, -10_000).y, 0);
        // Identity, not a clamped copy.
        assert_eq!(shift_roi(GAINED_MP, 0).y, GAINED_MP.y);
    }

    /// The 99px shift that motivated the tall anchor window: a loss layout puts
    /// the BP label at y=321 against the reference 420.
    #[test]
    fn loss_layout_offset_is_the_measured_shift() {
        let hit = ScoreSystemHit { system: ScoreSystem::Bp, x: 1068, y: 321, score: 1.0 };
        assert_eq!(result_layout_offset(&hit), -99);

        // The MP screen carries no reward list, so the CR half of it does not
        // shift: its fixtures must report exactly zero.
        let mp = ScoreSystemHit { system: ScoreSystem::Mp, x: 1027, y: 306, score: 1.0 };
        assert_eq!(result_layout_offset(&mp), 0);
    }

    /// The MP block moves on its own. A client that draws 「指定系列」 under the
    /// MP bar lifts the label 19px while the score-system label below it stays
    /// within 2px, which is exactly the case one shared offset cannot express.
    #[test]
    fn the_mp_block_carries_its_own_offset() {
        assert_eq!(mp_block_offset(MP_GAIN_ANCHOR_Y as u32), 0);
        assert_eq!(mp_block_offset(155), -19);
    }

    /// Both observed layouts have to sit inside the anchor window with room to
    /// spare, or the next row the client adds pushes the label out of it.
    #[test]
    fn the_anchor_window_spans_both_observed_layouts() {
        let template_h = 26;
        for y in [155, MP_GAIN_ANCHOR_Y as u32] {
            assert!(y >= MP_GAIN_ANCHOR.y + 12, "{y} is too close to the top edge");
            assert!(
                y + template_h + 12 <= MP_GAIN_ANCHOR.y + MP_GAIN_ANCHOR.h,
                "{y} is too close to the bottom edge"
            );
        }
    }


}

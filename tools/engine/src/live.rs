//! The live tick loop: watch a frame source, drive the machine, report.
//!
//! This is what replaces `src/main/recognition/forkedImageAnalyzer.ts`. The
//! logic is the same [`Machine`] the replay fixtures exercise, so for the first
//! time the thing under test and the thing that ships are the same thing.
//!
//! What lives here and nowhere else: the tick clock, the "frame not ready yet"
//! retry, and the translation from [`Change`] to [`Event`]. Everything else is a
//! call into a layer that can be tested without a game running.

use std::time::{Duration, Instant};

use crate::calibration::timing;
use crate::diagnostics::FrameRecorder;
use crate::frame_source::{FrameError, FrameSource, SourceControl};
use crate::host::{HostChannel, Inbox};
use std::collections::HashMap;

use crate::machine::{Change, Machine};
use crate::protocol::MatchRef;
use crate::store::MatchStore;
use crate::protocol::{BattleStatus, Command, Event};
use crate::reading;
use crate::templates::TemplateStore;

/// How long to wait before re-reading a frame source that had nothing new.
///
/// Short relative to the tick: the capture tool replaces the file on its own
/// schedule, and a poll that slept a whole tick would alias against it - the
/// same failure that made the replay banner probe miss three tick phases in four.
const NOT_READY_BACKOFF: Duration = Duration::from_millis(50);

/// How far below a threshold still counts as a near miss.
///
/// Wide enough to give warning before a template stops matching, narrow enough
/// that ordinary negatives do not fill the log. Mirrors `NEAR_MISS_BAND` in
/// `diagnosticsRecorder.ts`, which is where the aggregation lives.
const NEAR_MISS_BAND: f64 = 0.12;

pub struct LiveOptions {
    /// Emitted on every change so the HUD can follow along.
    pub emit_status: bool,
    /// Where to save the frame behind an anomaly. `None` turns frame capture
    /// off; the host still records the event itself.
    pub diagnostics: Option<FrameRecorder>,
    /// Where matches land. `None` keeps the run events-only, which is what
    /// tests and `--image` experiments want; the shipped path always persists.
    pub store: Option<MatchStore>,
}

impl Default for LiveOptions {
    fn default() -> Self {
        Self { emit_status: true, diagnostics: None, store: None }
    }
}

/// Run until the host says stop or the frame source is exhausted.
pub fn run<S, W>(
    source: &mut S,
    store: &TemplateStore,
    channel: &mut HostChannel<W>,
    options: &mut LiveOptions,
) -> std::io::Result<()>
where
    S: FrameSource,
    W: std::io::Write,
{
    channel.emit(&Event::Ready {
        version: env!("CARGO_PKG_VERSION").to_string(),
        templates_loaded: store.len() as u32,
    })?;

    let mut machine = Machine::new();
    let mut status = BattleStatus::default();
    // MatchRef -> row id. This mapping used to live in the HOST, which meant
    // every patch crossed a process boundary to be written; now the decision
    // and the write share a process, and the host only hears about it. The
    // machine itself still never sees a row id - that is what keeps it
    // testable without a database.
    let mut rows: HashMap<MatchRef, i64> = HashMap::new();
    // Consumed since the last attach. Proof that pixels actually flowed, for
    // the CaptureChanged report - see the event's docs.
    let mut frames_this_session: u64 = 0;
    // The host re-sends `attach` on every poll - that is by design, it is what
    // re-establishes capture after an engine restart - so the state change has
    // to be deduplicated HERE, or every poll broadcasts a fresh
    // `captureChanged` and the log reads like capture is flapping.
    let mut attached_to: Option<u64> = None;

    loop {
        match channel.poll_command() {
            Inbox::Command(Command::Stop) => {
                flush_open_match(&mut machine, channel, &mut status, options, &mut rows)?;
                return Ok(());
            }
            // stdin closed: there is no one left to answer a number read or
            // receive an event, so continuing would only spin against a dead
            // pipe. Exiting also lets the host restart us cleanly.
            //
            // The flush still goes out: the pipe is one-way dead, and a match
            // waiting on a final screen has an outcome worth writing to the
            // store even if nobody reads the event.
            Inbox::HostGone => {
                flush_open_match(&mut machine, channel, &mut status, options, &mut rows)?;
                return Ok(());
            }
            // Retargeting is the source's business; a source with a fixed
            // target refuses, and the refusal goes back as a non-fatal failure
            // rather than being swallowed - the host optimistically reports
            // "capturing" on attach and needs to know when that was wrong.
            Inbox::Command(Command::Attach { hwnd }) => {
                match source.control(SourceControl::Attach { hwnd }) {
                    Ok(()) if attached_to == Some(hwnd) => {} // idempotent re-send
                    Ok(()) => {
                        attached_to = Some(hwnd);
                        frames_this_session = 0;
                        channel.emit(&Event::CaptureChanged {
                            attached: true,
                            frames_seen: 0,
                        })?;
                    }
                    Err(why) => {
                        attached_to = None;
                        channel.emit(&Event::Failed { message: why, fatal: false })?;
                    }
                }
            }
            Inbox::Command(Command::Detach) => {
                // No more frames are coming, so a match still waiting for its
                // final screen will never see one. Close it here rather than
                // leaving the row open for the rest of the session.
                flush_open_match(&mut machine, channel, &mut status, options, &mut rows)?;
                let _ = source.control(SourceControl::Detach);
                if attached_to.take().is_some() {
                    channel.emit(&Event::CaptureChanged {
                        attached: false,
                        frames_seen: frames_this_session,
                    })?;
                }
                frames_this_session = 0;
            }
            Inbox::Command(Command::Start) | Inbox::Command(Command::Configure { .. })
            | Inbox::Empty => {}
        }

        let started = Instant::now();
        let timed = match source.next_frame() {
            Ok(frame) => frame,
            Err(FrameError::NotReady) => {
                std::thread::sleep(NOT_READY_BACKOFF);
                continue;
            }
            Err(FrameError::Exhausted) => {
                flush_open_match(&mut machine, channel, &mut status, options, &mut rows)?;
                return Ok(());
            }
            Err(FrameError::Decode(why)) => {
                // A frame that will not decode is almost always the capture tool
                // caught mid-write. Report it and carry on rather than exiting -
                // the next frame is 500ms away.
                channel.emit(&Event::Failed { message: why, fatal: false })?;
                std::thread::sleep(NOT_READY_BACKOFF);
                continue;
            }
        };

        // Only ask for digits when there could be digits; see `reading::read`
        // and `Phase::wants_numbers`.
        let wants_numbers = machine.phase().wants_numbers();
        frames_this_session += 1;
        let reading = reading::read(&timed.frame, store, channel, wants_numbers);
        // Emitted before the tick so a score that is about to stop clearing its
        // threshold is on record even if the decision it feeds goes the other way.
        for watched in reading.watched {
            if watched.score < watched.threshold
                && watched.score >= watched.threshold - NEAR_MISS_BAND
            {
                channel.emit(&Event::NearMiss {
                    label: watched.label.to_string(),
                    score: watched.score,
                    threshold: watched.threshold,
                })?;
            }
        }
        for change in machine.tick(&reading, timed.at) {
            apply(change, channel, &mut status, options, &mut rows, Some(&timed.frame), timed.at)?;
        }
        // ~20 MB of buffers. Dropped before the sleep, not after, so the idle
        // gap is not spent holding them.
        drop(timed);

        // The budget is what the analyzer's tick was, and a tick that misses it
        // falls behind the capture stream rather than catching up.
        let elapsed = started.elapsed();
        if elapsed > timing::TICK {
            channel.emit(&Event::SlowTick {
                elapsed_ms: elapsed.as_millis() as u64,
                budget_ms: timing::TICK.as_millis() as u64,
            })?;
        } else {
            std::thread::sleep(timing::TICK - elapsed);
        }
    }
}

/// Write one patch to the row it belongs to, reporting rather than dying on
/// failure - the match in progress is worth more than the write that missed.
fn persist<W: std::io::Write>(
    store: &Option<MatchStore>,
    row: Option<&i64>,
    patch: &crate::protocol::MatchPatch,
    channel: &mut HostChannel<W>,
) -> std::io::Result<()> {
    if let (Some(store), Some(id)) = (store, row) {
        if let Err(why) = store.update_match(*id, patch) {
            channel.emit(&Event::Failed { message: why.to_string(), fatal: false })?;
        }
    }
    Ok(())
}

/// Close an open match because the capture is going away rather than because
/// the game said anything. See [`Machine::close_open_match`].
fn flush_open_match<W: std::io::Write>(
    machine: &mut Machine,
    channel: &mut HostChannel<W>,
    status: &mut BattleStatus,
    options: &mut LiveOptions,
    rows: &mut HashMap<MatchRef, i64>,
) -> std::io::Result<()> {
    let now = Instant::now();
    for change in machine.close_open_match() {
        // No frame: there is no tick under way, and the diagnostic that reports
        // this is about the capture stopping, not about anything on screen.
        apply(change, channel, status, options, rows, None, now)?;
    }
    Ok(())
}

/// Translate one decision into the events the host acts on.
///
/// Kept as a total match rather than a catch-all: a new [`Change`] must not be
/// able to reach the host as silence.
///
/// `frame` is optional because not every change comes from a frame - a flush at
/// shutdown has no tick behind it, and only the diagnostics branch wants pixels.
fn apply<W: std::io::Write>(
    change: Change,
    channel: &mut HostChannel<W>,
    status: &mut BattleStatus,
    options: &mut LiveOptions,
    rows: &mut HashMap<MatchRef, i64>,
    frame: Option<&crate::frame::Frame>,
    now: Instant,
) -> std::io::Result<()> {
    match change {
        Change::MatchStarted { r#ref, versus, mode } => {
            if let Some(store) = &options.store {
                match store.insert_match(&versus, mode) {
                    Ok(id) => {
                        rows.insert(r#ref, id);
                    }
                    Err(why) => channel
                        .emit(&Event::Failed { message: why.to_string(), fatal: false })?,
                }
            }
            channel.emit(&Event::MatchStarted {
                r#ref,
                my_class: versus.my_class,
                oppo_class: versus.oppo_class,
                play_order: versus.play_order,
                mode,
            })?;
            *status = BattleStatus {
                in_battle: true,
                own_class: Some(versus.my_class),
                enemy_class: Some(versus.oppo_class),
                play_order: Some(versus.play_order),
                // Whatever the pre-battle hint knew. For 2Pick that is the
                // versus screen's own label, so the mode is on the wire before
                // the first turn.
                mode,
            };
            if options.emit_status {
                channel.emit(&Event::StatusChanged(status.clone()))?;
            }
        }

        Change::MatchUpdated { r#ref, patch } => {
            // Written as they resolve, not batched to finalize. The batching
            // argument (判斷題 D-1) was about Prisma's per-call engine overhead;
            // an in-process sqlite UPDATE is microseconds, and immediate writes
            // keep the crash-safety property the early result write existed for.
            persist(&options.store, rows.get(&r#ref), &patch, channel)?;
            // A mode resolved mid-battle has to reach the status too, not only
            // the database row. Without this the host learns 2Pick only when the
            // match closes, which is the whole thing this field exists to avoid.
            let learned_mode = patch.mode.filter(|resolved| status.mode != Some(*resolved));
            channel.emit(&Event::MatchUpdated { r#ref, patch })?;
            if let Some(mode) = learned_mode {
                status.mode = Some(mode);
                if options.emit_status {
                    channel.emit(&Event::StatusChanged(status.clone()))?;
                }
            }
        }

        Change::MatchFinished { r#ref, patch } => {
            persist(&options.store, rows.get(&r#ref), &patch, channel)?;
            rows.remove(&r#ref);
            channel.emit(&Event::MatchFinished { r#ref, patch })?;
            *status = BattleStatus::default();
            if options.emit_status {
                channel.emit(&Event::StatusChanged(status.clone()))?;
            }
        }

        // Abandoning is NOT finishing, and must not be collapsed into it. A row
        // written with an empty patch is a RECORDED match with missing fields;
        // the host has to delete it instead. `machine::tests::
        // abandoning_is_not_finishing` guards the same distinction one layer up.
        Change::MatchAbandoned { r#ref } => {
            if let (Some(store), Some(id)) = (&options.store, rows.remove(&r#ref)) {
                if let Err(why) = store.delete_match(id) {
                    channel.emit(&Event::Failed { message: why.to_string(), fatal: false })?;
                }
            }
            channel.emit(&Event::MatchAbandoned { r#ref })?;
            *status = BattleStatus::default();
            if options.emit_status {
                channel.emit(&Event::StatusChanged(status.clone()))?;
            }
        }

        Change::ReplaySuppression { active } => {
            channel.emit(&Event::ReplaySuppressionChanged { suppressed: active })?
        }

        Change::Noted { kind, label, detail } => {
            // Save the pixels here, where they are; the host writes the sidecar
            // and the event log beside them. See `diagnostics`.
            let saved = options
                .diagnostics
                .as_mut()
                .zip(frame)
                .and_then(|(recorder, frame)| recorder.capture(kind, frame, now));
            let detail = match (detail, saved) {
                (Some(serde_json::Value::Object(mut map)), Some(file)) => {
                    map.insert("frame".into(), serde_json::Value::String(file));
                    Some(serde_json::Value::Object(map))
                }
                (None, Some(file)) => Some(serde_json::json!({ "frame": file })),
                (detail, _) => detail,
            };
            channel.emit(&Event::Diagnostic { kind: kind.to_string(), label, detail })?
        }
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::machine::VersusScreen;
    use crate::protocol::{ClassName, GameMode, MatchPatch, PlayOrder};
    use std::sync::mpsc::channel;

    fn versus() -> VersusScreen {
        VersusScreen {
            my_class: ClassName::Bishop,
            oppo_class: ClassName::Royal,
            play_order: PlayOrder::First,
        }
    }

    /// A frame is only touched by the diagnostics branch, which these tests do
    /// not exercise - but `apply` takes one, so it needs something real.
    fn blank_frame() -> crate::frame::Frame {
        crate::frame::Frame::from_image(&image::DynamicImage::new_rgba8(1280, 720))
    }

    /// Run changes through `apply` and return the emitted event lines.
    fn emitted(changes: Vec<Change>) -> Vec<serde_json::Value> {
        let (_ctx, commands) = channel();
        let (_rtx, replies) = channel();
        let mut channel_out = HostChannel::new(Vec::new(), commands, replies);
        let mut status = BattleStatus::default();
        let mut options = LiveOptions::default();
        let mut rows = HashMap::new();
        let frame = blank_frame();
        let now = Instant::now();
        for change in changes {
            apply(change, &mut channel_out, &mut status, &mut options, &mut rows, Some(&frame), now)
                .expect("writing to a Vec cannot fail");
        }
        String::from_utf8(channel_out.into_inner())
            .expect("events are utf-8")
            .lines()
            .map(|line| serde_json::from_str(line).expect("each line is one event"))
            .collect()
    }

    fn status_modes(events: &[serde_json::Value]) -> Vec<Option<String>> {
        events
            .iter()
            .filter(|e| e["event"] == "statusChanged")
            .map(|e| e["mode"].as_str().map(str::to_owned))
            .collect()
    }

    /// A mode known at the versus screen is on the wire before the first turn.
    ///
    /// This is what lets the HUD retarget as the battle opens rather than when
    /// it closes. 2Pick and CPU are both labelled pre-battle; ranked is not, and
    /// the next test covers that.
    #[test]
    fn a_mode_known_at_match_start_reaches_the_status() {
        let events = emitted(vec![Change::MatchStarted {
            r#ref: MatchRef(1),
            versus: versus(),
            mode: Some(GameMode::TwoPick),
        }]);
        assert_eq!(status_modes(&events), vec![Some("twoPick".into())]);
    }

    /// A mode resolved mid-battle re-emits the status.
    ///
    /// Without this the host would see the mode only in `matchUpdated`, which it
    /// treats as "refetch the list" - the live battle status would still say
    /// nothing, and the HUD would keep whatever filter it had until the match
    /// closed.
    #[test]
    fn a_mode_resolved_mid_battle_re_emits_the_status() {
        let events = emitted(vec![
            Change::MatchStarted { r#ref: MatchRef(1), versus: versus(), mode: None },
            Change::MatchUpdated {
                r#ref: MatchRef(1),
                patch: MatchPatch { mode: Some(GameMode::TwoPick), ..Default::default() },
            },
        ]);
        assert_eq!(
            status_modes(&events),
            vec![None, Some("twoPick".into())],
            "the start says nothing, the update says 2Pick"
        );
    }

    /// The same mode arriving again must not re-emit.
    ///
    /// `matchUpdated` fires for every field that resolves, and several carry the
    /// mode along unchanged. Emitting a status per patch would put a burst of
    /// identical events on the wire for the HUD to re-render against.
    #[test]
    fn an_unchanged_mode_does_not_re_emit_the_status() {
        let events = emitted(vec![
            Change::MatchStarted { r#ref: MatchRef(1), versus: versus(), mode: Some(GameMode::TwoPick) },
            Change::MatchUpdated {
                r#ref: MatchRef(1),
                patch: MatchPatch { mode: Some(GameMode::TwoPick), ..Default::default() },
            },
        ]);
        assert_eq!(status_modes(&events), vec![Some("twoPick".into())]);
    }

    /// Finishing clears it, which is how the HUD is told to fall back to the
    /// last recorded match rather than hold the mode of a battle that is over.
    #[test]
    fn finishing_a_match_clears_the_status_mode() {
        let events = emitted(vec![
            Change::MatchStarted { r#ref: MatchRef(1), versus: versus(), mode: Some(GameMode::TwoPick) },
            Change::MatchFinished { r#ref: MatchRef(1), patch: MatchPatch::default() },
        ]);
        assert_eq!(status_modes(&events), vec![Some("twoPick".into()), None]);
    }
}

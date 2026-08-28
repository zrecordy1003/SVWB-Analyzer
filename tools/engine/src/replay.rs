//! Running a recording through the whole pipeline.
//!
//! This is why the engine is a standalone binary. It drives the SHIPPED
//! [`Machine`], so the regression fixtures stop testing a hand-copied mirror of
//! the state machine and start testing the state machine.
//!
//! Frames come from ffmpeg, one segment at a time - a thirteen-minute recording
//! at 2fps is 1560 PNGs, which is worth not materialising at once. Each segment
//! is deleted after it is processed.
//!
//! Time is synthetic: frame `n` is treated as observed at `start + n/fps`,
//! whatever the wall clock says. That is what lets a five-minute recording verify
//! in seconds, and it is precisely what the JS harness could not do without
//! re-implementing the state machine around its own timestamps.

use std::path::{Path, PathBuf};
use std::process::Command;
use std::time::{Duration, Instant};

use crate::frame::Frame;
use crate::machine::{Change, Machine};
use crate::numbers::NumberReader;
use crate::protocol::MatchPatch;
use crate::reading;
use crate::templates::TemplateStore;

/// One match the run produced, in the order it closed.
#[derive(Debug, Clone)]
pub struct RecordedMatch {
    pub my_class: String,
    pub oppo_class: String,
    pub play_order: String,
    pub patch: MatchPatch,
}

pub struct ReplayReport {
    pub frames: usize,
    pub matches: Vec<RecordedMatch>,
    /// Diagnostics raised along the way, as `kind` counts. A run that produces
    /// the right match for the wrong reason shows up here.
    pub notes: Vec<(String, String)>,
}

pub struct ReplayOptions {
    pub fps: f64,
    /// Seconds of video per ffmpeg pass.
    pub segment: f64,
}

impl Default for ReplayOptions {
    fn default() -> Self {
        // 2fps matches the 500ms analyzer tick, so the run sees what the
        // analyzer would have seen rather than a denser or sparser stream.
        Self { fps: 2.0, segment: 60.0 }
    }
}

#[derive(Debug)]
pub enum ReplayError {
    NoFfmpeg,
    Ffmpeg(String),
    Io(String),
    Decode(String),
}

impl std::fmt::Display for ReplayError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            // Fail specifically rather than surfacing a spawn error from the
            // middle of a run.
            ReplayError::NoFfmpeg => write!(f, "ffmpeg and ffprobe must be on PATH"),
            ReplayError::Ffmpeg(m) => write!(f, "ffmpeg: {m}"),
            ReplayError::Io(m) => write!(f, "{m}"),
            ReplayError::Decode(m) => write!(f, "{m}"),
        }
    }
}

pub fn has_ffmpeg() -> bool {
    ["ffmpeg", "ffprobe"]
        .iter()
        .all(|bin| Command::new(bin).arg("-version").output().is_ok_and(|o| o.status.success()))
}

fn duration_seconds(video: &Path) -> Result<f64, ReplayError> {
    let out = Command::new("ffprobe")
        .args(["-v", "error", "-show_entries", "format=duration", "-of", "csv=p=0"])
        .arg(video)
        .output()
        .map_err(|e| ReplayError::Ffmpeg(e.to_string()))?;
    if !out.status.success() {
        return Err(ReplayError::Ffmpeg(String::from_utf8_lossy(&out.stderr).into_owned()));
    }
    String::from_utf8_lossy(&out.stdout)
        .trim()
        .parse()
        .map_err(|_| ReplayError::Ffmpeg("could not read duration".into()))
}

fn extract_segment(
    video: &Path,
    start: f64,
    length: f64,
    fps: f64,
    out_dir: &Path,
) -> Result<Vec<PathBuf>, ReplayError> {
    let _ = std::fs::remove_dir_all(out_dir);
    std::fs::create_dir_all(out_dir).map_err(|e| ReplayError::Io(e.to_string()))?;

    let status = Command::new("ffmpeg")
        .args(["-v", "error", "-ss", &start.to_string(), "-t", &length.to_string(), "-i"])
        .arg(video)
        // The fps filter already decides which frames survive.
        .args(["-vf", &format!("fps={fps}")])
        .arg(out_dir.join("f%06d.png"))
        .output()
        .map_err(|e| ReplayError::Ffmpeg(e.to_string()))?;
    if !status.status.success() {
        return Err(ReplayError::Ffmpeg(String::from_utf8_lossy(&status.stderr).into_owned()));
    }

    let mut frames: Vec<PathBuf> = std::fs::read_dir(out_dir)
        .map_err(|e| ReplayError::Io(e.to_string()))?
        .flatten()
        .map(|e| e.path())
        .filter(|p| p.extension().is_some_and(|e| e == "png"))
        .collect();
    frames.sort();
    Ok(frames)
}

/// Run a recording through the pipeline and report what the analyzer would have
/// written to the database.
///
/// `reader` is whatever answers number reads. `NoNumbers` exercises everything
/// that does not depend on a digit - classes, play order, mode, outcome - and a
/// host-backed reader adds the numbers, which is what lets a fixture assert
/// `bp: 8` against the SHIPPED state machine rather than against a copy of it.
pub fn run(
    video: &Path,
    store: &TemplateStore,
    reader: &mut dyn NumberReader,
    options: &ReplayOptions,
) -> Result<ReplayReport, ReplayError> {
    if !has_ffmpeg() {
        return Err(ReplayError::NoFfmpeg);
    }

    let duration = duration_seconds(video)?;
    let work = std::env::temp_dir().join(format!("svwb-replay-{}", std::process::id()));

    let mut machine = Machine::new();
    let mut report = ReplayReport { frames: 0, matches: Vec::new(), notes: Vec::new() };
    // Any fixed origin will do; every deadline is relative to it.
    let origin = Instant::now();
    // Carried across segments so a match that spans a segment boundary keeps a
    // continuous clock - the whole point of the synthetic timestamps.
    let mut frame_index: u64 = 0;
    let mut open: Option<(String, String, String)> = None;

    let mut segment_start = 0.0;
    while segment_start < duration {
        let length = options.segment.min(duration - segment_start);
        let frames = extract_segment(video, segment_start, length, options.fps, &work)?;

        for path in frames {
            let decoded = image::open(&path)
                .map_err(|e| ReplayError::Decode(format!("{}: {e}", path.display())))?;
            let frame = Frame::from_image(&decoded);
            // Unlike live, a replay has no cost pressure to skip number reads
            // - but the gate is kept identical so a replay exercises the same
            // code path the shipped analyzer takes.
            let wants_numbers = machine.phase().is_open();
            let reading = reading::read(&frame, store, reader, wants_numbers);
            let now = origin + Duration::from_secs_f64(frame_index as f64 / options.fps);
            frame_index += 1;
            report.frames += 1;

            for change in machine.tick(&reading, now) {
                match change {
                    Change::MatchStarted { versus, .. } => {
                        open = Some((
                            format!("{:?}", versus.my_class).to_lowercase(),
                            format!("{:?}", versus.oppo_class).to_lowercase(),
                            format!("{:?}", versus.play_order).to_lowercase(),
                        ));
                    }
                    Change::MatchFinished { patch, .. } => {
                        // A finish without a start would mean the machine
                        // invented a match; it cannot, but reporting it as such
                        // is better than silently dropping the row.
                        let (my_class, oppo_class, play_order) =
                            open.take().unwrap_or_default();
                        report.matches.push(RecordedMatch {
                            my_class,
                            oppo_class,
                            play_order,
                            patch,
                        });
                    }
                    // Abandoned matches are exactly what a replay recording must
                    // produce none of, so they are deliberately NOT reported as
                    // matches.
                    Change::MatchAbandoned { .. } => {
                        open = None;
                    }
                    Change::Noted { kind, label, .. } => {
                        report.notes.push((kind.to_string(), label));
                    }
                    _ => {}
                }
            }
        }

        segment_start += options.segment;
    }

    let _ = std::fs::remove_dir_all(&work);
    Ok(report)
}

//! Where frames come from.
//!
//! This trait is the reason the refactor is ordered the way it is. Probes and
//! the state machine move into the engine first (plan P1, P2) while frames are
//! still read from `svwb.png`; only then does live capture move in (plan P3),
//! and at that point it is a second implementation of this trait rather than a
//! new cross-process channel for pixels. Doing capture first would have meant
//! writing shared memory or piping raw bitmaps back to the JS analyzer, all of
//! which would be deleted again one phase later. See 修訂紀錄 R-1.
//!
//! `FileSource` is not scaffolding to be removed later either: replay fixtures
//! keep using it forever, which is what lets `svwb-engine replay` run the real
//! state machine with no game and no capture backend.

use std::path::PathBuf;
use std::time::{Duration, Instant};

use crate::frame::Frame;

/// A frame plus the moment it is to be treated as having been observed.
///
/// The timestamp is carried rather than read from the clock inside the state
/// machine on purpose. Four of the state machine's deadlines are wall-clock
/// based, so a replay that cannot supply its own notion of "now" can only run in
/// real time - a five minute recording would take five minutes to verify. It is
/// also precisely why the existing `replay-recording.cjs` had to re-implement
/// the state machine instead of calling it. See 判斷題 D-2.
pub struct TimedFrame {
    pub frame: Frame,
    pub at: Instant,
}

/// Errors a source can report without the run being over.
#[derive(Debug)]
pub enum FrameError {
    /// Nothing new to read yet. The caller should wait and retry, not fail.
    NotReady,
    /// The source is permanently finished (replay reached the end of input).
    Exhausted,
    /// A frame was there but could not be turned into a `Frame`.
    Decode(String),
}

/// Yields frames until exhausted.
///
/// Deliberately pull-based: the state machine's tick budget is what governs
/// pace, and a push-based source would need buffering and a dropped-frame
/// policy that nothing in this application actually wants.
pub trait FrameSource {
    /// Next frame, or why there isn't one.
    ///
    /// Returning [`FrameError::NotReady`] must be cheap - live capture polls it
    /// between ticks.
    fn next_frame(&mut self) -> Result<TimedFrame, FrameError>;

    /// Human-readable, for diagnostics and log headers only.
    fn describe(&self) -> String;

    /// Point the source somewhere else at runtime.
    ///
    /// Most sources have a fixed target - a file, a recording - and refuse.
    /// Live capture accepts: the game window comes and goes, and restarting the
    /// whole engine on every minimise would drop the state machine's open match
    /// with it.
    fn control(&mut self, _request: SourceControl) -> Result<(), String> {
        Err("this source has a fixed target".into())
    }
}

/// A runtime retargeting request, forwarded from the host's `attach`/`detach`
/// commands by the live loop.
#[derive(Debug, Clone, Copy)]
pub enum SourceControl {
    Attach { hwnd: u64 },
    Detach,
}

/// Reads frames from disk: the capture tool's `svwb.png` in live mode today,
/// and an extracted PNG sequence when replaying a recording.
///
/// The two cases differ only in how `at` is derived, which is why they are one
/// type: watching a single path re-read in place, versus walking a list of
/// files at a fixed sampling rate.
pub struct FileSource {
    mode: FileSourceMode,
}

enum FileSourceMode {
    /// One path, rewritten in place by the capture tool. `at` is the real clock.
    Watch { path: PathBuf },
    /// A finite ordered list. `at` is derived from `start + index / fps`, so a
    /// replay can run as fast as the CPU allows.
    Sequence {
        paths: Vec<PathBuf>,
        next: usize,
        fps: f64,
        start: Instant,
    },
}

impl FileSource {
    /// Live mode: re-read one path as the capture tool replaces it.
    pub fn watching(path: PathBuf) -> Self {
        Self { mode: FileSourceMode::Watch { path } }
    }

    /// Replay mode: walk an ordered list at a synthetic `fps`.
    pub fn sequence(paths: Vec<PathBuf>, fps: f64, start: Instant) -> Self {
        Self { mode: FileSourceMode::Sequence { paths, next: 0, fps, start } }
    }
}

impl FrameSource for FileSource {
    fn next_frame(&mut self) -> Result<TimedFrame, FrameError> {
        match &mut self.mode {
            FileSourceMode::Watch { path } => {
                // A zero-byte read is the capture tool mid-write, not a failure:
                // it writes to `<path>.tmp.png` and renames, but the rename is
                // not atomic against every reader on every filesystem.
                match std::fs::metadata(path.as_path()) {
                    Ok(meta) if meta.len() > 0 => {}
                    _ => return Err(FrameError::NotReady),
                }
                let decoded = image::open(path.as_path())
                    .map_err(|e| FrameError::Decode(format!("{}: {e}", path.display())))?;
                Ok(TimedFrame { frame: Frame::from_image(&decoded), at: Instant::now() })
            }

            FileSourceMode::Sequence { paths, next, fps, start } => {
                let Some(path) = paths.get(*next) else {
                    return Err(FrameError::Exhausted);
                };
                let decoded = image::open(path)
                    .map_err(|e| FrameError::Decode(format!("{}: {e}", path.display())))?;
                // Synthetic clock: frame N is treated as observed at
                // `start + N/fps`, whatever the wall clock says. This is what
                // lets a five minute recording verify in seconds, and what the
                // JS replay harness had to fake by re-implementing the state
                // machine around its own timestamps.
                let at = *start + Duration::from_secs_f64(*next as f64 / *fps);
                *next += 1;
                Ok(TimedFrame { frame: Frame::from_image(&decoded), at })
            }
        }
    }

    fn describe(&self) -> String {
        match &self.mode {
            FileSourceMode::Watch { path } => format!("file:watch {}", path.display()),
            FileSourceMode::Sequence { paths, fps, .. } => {
                format!("file:sequence {} frames @ {fps}fps", paths.len())
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Compile-time proof that the seam is usable as designed: anything
    /// satisfying [`FrameSource`] can drive the engine, with no reference to
    /// Electron, to a database, or to the capture backend.
    #[test]
    fn the_seam_is_object_safe() {
        let source: Box<dyn FrameSource> =
            Box::new(FileSource::watching(std::path::PathBuf::from("svwb.png")));
        assert!(source.describe().starts_with("file:watch"));
    }
}

//! Saving the frame behind an anomaly.
//!
//! Recognition failures are mostly invisible to the user: a template score that
//! drifted to just under its threshold, a number read that came back as
//! nonsense, a result screen no mode probe could account for. The user only ever
//! sees "my match wasn't recorded", which diagnoses nothing. So the app keeps
//! the pixels that produced its own doubts. Everything stays local.
//!
//! # Why only the pixels
//!
//! `src/main/recognition/diagnosticsRecorder.ts` keeps the rest: `events.jsonl`,
//! throttling, aggregation, rotation, and the JSON sidecar. That module is 305
//! lines of pure bookkeeping with nothing perception-specific in it, it is
//! already exercised standalone by `check-diagnostics.cjs`, and re-implementing
//! it here to satisfy a tidiness argument would throw away working, tested code.
//!
//! So the split is by what each side already holds: the engine has the frame and
//! writes it; the host has the bookkeeping and keeps it. Each also throttles
//! what it writes - a host-side throttle applied after the engine had already
//! written a PNG would leave orphans on disk.

use std::path::{Path, PathBuf};
use std::time::{SystemTime, UNIX_EPOCH};

use crate::frame::Frame;

/// Anomalies worth spending a saved frame on: the ones that need pixels to
/// diagnose. Mirrors `KINDS_WITH_FRAME`, and a kind absent here still produces
/// an event on the host side - it just does not cost an image.
const KINDS_WITH_FRAME: &[&str] = &[
    "ocr-reject",
    "mode-unattributable",
    "class-unrecognised",
    "ranked-no-numbers",
    "weak-mode-accepted",
];

/// One frame per kind per window. These fire on screens that persist for
/// seconds, so without this a single bad result screen would fill the cap.
const FRAME_THROTTLE: std::time::Duration = std::time::Duration::from_secs(30);

/// Frames kept on disk, oldest dropped first.
const MAX_FRAMES: usize = 20;

const FRAMES_DIR: &str = "frames";

pub struct FrameRecorder {
    dir: PathBuf,
    /// Last write per kind, as monotonic instants - wall-clock jumps must not
    /// open the throttle early or wedge it shut.
    last: Vec<(String, std::time::Instant)>,
}

impl FrameRecorder {
    /// `None` when diagnostics are off or the directory cannot be created.
    /// Losing diagnostics must never stop the engine doing its real job.
    pub fn new(root: &Path) -> Option<Self> {
        let dir = root.join(FRAMES_DIR);
        if let Err(e) = std::fs::create_dir_all(&dir) {
            eprintln!("[diag] cannot create {}: {e}", dir.display());
            return None;
        }
        Some(Self { dir, last: Vec::new() })
    }

    /// Save the frame if this kind warrants one and is not throttled.
    ///
    /// Returns the file name to put in the event, so the host can write its
    /// sidecar beside it. `None` means no frame was written, which the host
    /// treats as an ordinary event.
    pub fn capture(&mut self, kind: &str, frame: &Frame, now: std::time::Instant) -> Option<String> {
        if !KINDS_WITH_FRAME.contains(&kind) {
            return None;
        }
        match self.last.iter_mut().find(|(k, _)| k == kind) {
            Some((_, at)) => {
                if now.duration_since(*at) < FRAME_THROTTLE {
                    return None;
                }
                *at = now;
            }
            None => self.last.push((kind.to_string(), now)),
        }

        // The saved image is the normalised 1280x720 grayscale canvas - exactly
        // what the matcher sees, and less revealing than the raw colour
        // screenshot.
        let png = frame.normalised_to_png()?;

        // Epoch milliseconds, fixed width for the next few centuries, so lexical
        // order is chronological and pruning needs no metadata. The human-
        // readable timestamp lives in the host's sidecar.
        let stamp = SystemTime::now().duration_since(UNIX_EPOCH).ok()?.as_millis();
        let name = format!("{stamp:015}_{kind}.png");

        if let Err(e) = std::fs::write(self.dir.join(&name), png) {
            eprintln!("[diag] cannot write frame: {e}");
            return None;
        }
        self.prune();
        Some(name)
    }

    /// Drop the oldest frames, and the host's sidecars for them, beyond the cap.
    fn prune(&self) {
        let Ok(entries) = std::fs::read_dir(&self.dir) else {
            return;
        };
        let mut pngs: Vec<PathBuf> = entries
            .flatten()
            .map(|e| e.path())
            .filter(|p| p.extension().is_some_and(|e| e == "png"))
            .collect();
        pngs.sort();

        for stale in pngs.iter().take(pngs.len().saturating_sub(MAX_FRAMES)) {
            let _ = std::fs::remove_file(stale);
            // The sidecar is the host's, but it is meaningless without its
            // image, so it goes with it rather than accumulating forever.
            let _ = std::fs::remove_file(stale.with_extension("json"));
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::time::{Duration, Instant};

    fn frame() -> Frame {
        Frame::from_image(&image::DynamicImage::new_luma8(1280, 720))
    }

    fn recorder() -> (FrameRecorder, tempdir::Dir) {
        let dir = tempdir::Dir::new();
        let rec = FrameRecorder::new(dir.path()).expect("should create");
        (rec, dir)
    }

    /// A kind that does not need pixels must not cost an image. `mode-guessed`
    /// fires on every unattributable match and would fill the cap on its own.
    #[test]
    fn only_frame_worthy_kinds_cost_an_image() {
        let (mut rec, _dir) = recorder();
        let now = Instant::now();
        assert!(rec.capture("mode-guessed", &frame(), now).is_none());
        assert!(rec.capture("near-miss", &frame(), now).is_none());
        assert!(rec.capture("weak-mode-accepted", &frame(), now).is_some());
    }

    /// These fire on screens that persist for seconds. Without a throttle one
    /// bad result screen would evict every other kind from the cap.
    #[test]
    fn a_kind_is_throttled_but_others_are_not() {
        let (mut rec, _dir) = recorder();
        let now = Instant::now();
        assert!(rec.capture("ocr-reject", &frame(), now).is_some());
        assert!(rec.capture("ocr-reject", &frame(), now + Duration::from_secs(5)).is_none());
        // A different kind has its own window.
        assert!(rec.capture("ranked-no-numbers", &frame(), now + Duration::from_secs(5)).is_some());
        // ...and the first opens again once its window passes.
        assert!(rec.capture("ocr-reject", &frame(), now + FRAME_THROTTLE).is_some());
    }

    /// The cap is what stops this growing without bound on a user's disk.
    #[test]
    fn the_oldest_frames_are_pruned() {
        let (mut rec, dir) = recorder();
        let mut now = Instant::now();
        for _ in 0..MAX_FRAMES + 5 {
            rec.capture("ocr-reject", &frame(), now).expect("should write");
            now += FRAME_THROTTLE;
        }
        let count = std::fs::read_dir(dir.path().join(FRAMES_DIR))
            .unwrap()
            .flatten()
            .filter(|e| e.path().extension().is_some_and(|x| x == "png"))
            .count();
        assert_eq!(count, MAX_FRAMES);
    }

    /// Minimal scratch directory; the crate has no dev-dependencies and this is
    /// the only place that needs one.
    mod tempdir {
        use std::path::{Path, PathBuf};
        use std::sync::atomic::{AtomicU32, Ordering};

        static COUNTER: AtomicU32 = AtomicU32::new(0);

        pub struct Dir(PathBuf);

        impl Dir {
            pub fn new() -> Self {
                let n = COUNTER.fetch_add(1, Ordering::Relaxed);
                let path = std::env::temp_dir()
                    .join(format!("svwb-diag-test-{}-{n}", std::process::id()));
                let _ = std::fs::remove_dir_all(&path);
                std::fs::create_dir_all(&path).expect("scratch dir");
                Self(path)
            }

            pub fn path(&self) -> &Path {
                &self.0
            }
        }

        impl Drop for Dir {
            fn drop(&mut self) {
                let _ = std::fs::remove_dir_all(&self.0);
            }
        }
    }
}

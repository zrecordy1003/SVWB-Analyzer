//! `svwb-engine` - the perception engine.
//!
//! Plan P1: the wire contract, the frame-source seam, the calibration table and
//! the probe registry are in place. The state machine arrives in P2 and live
//! capture in P3. See docs/engine-refactor-plan.md.
//!
//! Subcommands, all sharing everything downstream of [`FrameSource`]:
//!
//!   svwb-engine probe-dump --templates <dir> <png>...
//!       Score every entry in `calibration::PROBES` against each image and emit
//!       one JSON line per probe. Exists to be diffed against the Node addon's
//!       output (`tools/vision-node-addon/dump-probes.cjs`), which is how P1 is
//!       accepted: identical scores prove the engine reproduces the addon before
//!       anything is allowed to depend on it.
//!
//!   svwb-engine live | replay        (P2/P3)
//!
//! `replay` is not a debugging convenience. It is the reason this is a binary
//! and not a Node addon: it runs the shipped state machine, so the fixtures stop
//! testing a hand-copied mirror of it.


use std::path::{Path, PathBuf};
use std::process::ExitCode;

use svwb_engine::frame::Frame;
use svwb_vision_native::Rect;
use svwb_engine::frame_source::FileSource;

use svwb_engine::templates::TemplateStore;
use svwb_engine::numbers::{self, NoNumbers};
use svwb_engine::{calibration, diagnostics, host, live, reading, replay, store};

fn main() -> ExitCode {
    let args: Vec<String> = std::env::args().skip(1).collect();
    match args.first().map(String::as_str) {
        Some("probe-dump") => match probe_dump(&args[1..]) {
            Ok(()) => ExitCode::SUCCESS,
            Err(message) => {
                eprintln!("svwb-engine: {message}");
                ExitCode::FAILURE
            }
        },
        Some("probes") => {
            print_probe_registry();
            ExitCode::SUCCESS
        }
        Some("canvas") => match canvas(&args[1..]) {
            Ok(()) => ExitCode::SUCCESS,
            Err(message) => {
                eprintln!("svwb-engine: {message}");
                ExitCode::FAILURE
            }
        },
        Some("crop") => match crop(&args[1..]) {
            Ok(()) => ExitCode::SUCCESS,
            Err(message) => {
                eprintln!("svwb-engine: {message}");
                ExitCode::FAILURE
            }
        },
        Some("read-dump") => match read_dump(&args[1..]) {
            Ok(()) => ExitCode::SUCCESS,
            Err(message) => {
                eprintln!("svwb-engine: {message}");
                ExitCode::FAILURE
            }
        },
        Some("migrate") => match migrate(&args[1..]) {
            Ok(()) => ExitCode::SUCCESS,
            Err(message) => {
                eprintln!("svwb-engine: {message}");
                ExitCode::FAILURE
            }
        },
        Some("live") => match live_run(&args[1..]) {
            Ok(()) => ExitCode::SUCCESS,
            Err(message) => {
                eprintln!("svwb-engine: {message}");
                ExitCode::FAILURE
            }
        },
        Some("replay") => match replay_recording(&args[1..]) {
            Ok(true) => ExitCode::SUCCESS,
            Ok(false) => ExitCode::FAILURE,
            Err(message) => {
                eprintln!("svwb-engine: {message}");
                ExitCode::FAILURE
            }
        },
        Some(other) => {
            eprintln!("svwb-engine: unknown subcommand `{other}`");
            ExitCode::FAILURE
        }
        None => {
            eprintln!(
                "svwb-engine {}\n\nusage:\n  svwb-engine probes\n  svwb-engine probe-dump --templates <dir> <png>...\n  svwb-engine canvas --image <png> [--rect x,y,w,h]",
                env!("CARGO_PKG_VERSION")
            );
            ExitCode::FAILURE
        }
    }
}

/// Emit the probe registry as JSON lines.
///
/// This exists so the Node comparison harness does not need its own copy of the
/// table. Handing it over rather than letting it be typed twice is the whole
/// point: a parity check whose two sides disagree about WHICH windows to probe
/// proves nothing, and a hand-copied table is exactly how this codebase ended up
/// with `check-rois.cjs` and a 953-line replay mirror in the first place.
fn print_probe_registry() {
    for probe in calibration::PROBES {
        println!(
            "{{\"probe\":{:?},\"set\":{:?},\"x\":{},\"y\":{},\"w\":{},\"h\":{},\"scale\":{}}}",
            probe.name,
            probe.set,
            probe.window.x,
            probe.window.y,
            probe.window.w,
            probe.window.h,
            calibration::downscale_factor_for(probe.set)
        );
    }
}

/// Emit one JSON line per probe, in [`calibration::PROBES`] order so two runs
/// diff line by line.
///
/// A probe that finds nothing prints `"name":null` rather than being skipped: a
/// missing line and a miss must not look alike, or a template set that failed to
/// load on one side would read as agreement.
fn probe_dump(args: &[String]) -> Result<(), String> {
    let mut templates_dir: Option<PathBuf> = None;
    let mut images: Vec<PathBuf> = Vec::new();

    let mut rest = args.iter();
    while let Some(arg) = rest.next() {
        match arg.as_str() {
            "--templates" => {
                templates_dir =
                    Some(PathBuf::from(rest.next().ok_or("--templates needs a directory")?));
            }
            other => images.push(PathBuf::from(other)),
        }
    }

    let templates_dir = templates_dir.ok_or("--templates <dir> is required")?;
    let store = TemplateStore::load(&templates_dir).map_err(|e| e.to_string())?;
    if store.is_empty() {
        return Err(format!("no template sets under {}", templates_dir.display()));
    }
    if images.is_empty() {
        return Err("at least one image is required".into());
    }

    for image_path in &images {
        let decoded = image::open(image_path)
            .map_err(|e| format!("cannot decode {}: {e}", image_path.display()))?;
        let frame = Frame::from_image(&decoded);
        let label = stable_label(image_path);

        for probe in calibration::PROBES {
            if !frame.contains(probe.window) {
                return Err(format!(
                    "probe {} window {},{},{},{} is outside the {}x{} canvas",
                    probe.name,
                    probe.window.x,
                    probe.window.y,
                    probe.window.w,
                    probe.window.h,
                    frame.width(),
                    frame.height()
                ));
            }
            let hit = store.best_in(&frame, probe.set, probe.window);
            let (name, score, x, y) = match &hit {
                Some(h) => (
                    format!("{:?}", h.name),
                    // Fixed precision, not Rust's shortest-round-trip default:
                    // the Node side formats the same f64 differently, and this
                    // comparison is about the value, not about how each language
                    // chooses to print it.
                    format!("{:.6}", h.score),
                    h.x.to_string(),
                    h.y.to_string(),
                ),
                None => ("null".into(), "null".into(), "null".into(), "null".into()),
            };
            println!(
                "{{\"image\":{:?},\"probe\":{:?},\"set\":{:?},\"name\":{name},\"score\":{score},\"x\":{x},\"y\":{y}}}",
                label, probe.name, probe.set
            );
        }
    }

    Ok(())
}

/// Bring the database up to the shipped schema, then exit.
///
///   svwb-engine migrate --db <path> --migrations <dir>
///
/// The one owner of migrations (判斷題 D-5). The host runs this synchronously at
/// startup before anything reads; `live --db` applies the same set again, which
/// is a no-op by then. `initDb.ts` - the previous owner - is deleted.
fn migrate(args: &[String]) -> Result<(), String> {
    let mut db: Option<PathBuf> = None;
    let mut migrations: Option<PathBuf> = None;

    let mut rest = args.iter();
    while let Some(arg) = rest.next() {
        let mut next = || rest.next().ok_or_else(|| format!("{arg} needs a value"));
        match arg.as_str() {
            "--db" => db = Some(PathBuf::from(next()?)),
            "--migrations" => migrations = Some(PathBuf::from(next()?)),
            other => return Err(format!("unexpected argument `{other}`")),
        }
    }
    let db = db.ok_or("--db <path> is required")?;
    let migrations = migrations.ok_or("--migrations <dir> is required")?;

    let mut store = store::MatchStore::open(&db).map_err(|e| e.to_string())?;
    let applied = store.apply_migrations(&migrations).map_err(|e| e.to_string())?;
    println!("{{\"applied\":{applied}}}");
    Ok(())
}

/// Watch the capture tool's output and report matches to the host.
///
///   svwb-engine live --image <path> --templates <dir>
///
/// This is the shipped analyzer. Events go to stdout as JSON Lines; commands and
/// number replies come back on stdin. stderr is for humans only - anything the
/// host needs to act on is an event.
fn live_run(args: &[String]) -> Result<(), String> {
    let mut templates_dir: Option<PathBuf> = None;
    let mut image: Option<PathBuf> = None;
    let mut use_capture = false;
    let mut db: Option<PathBuf> = None;
    let mut migrations_dir: Option<PathBuf> = None;
    let mut diagnostics_dir: Option<PathBuf> = None;

    let mut rest = args.iter();
    while let Some(arg) = rest.next() {
        let mut next = || rest.next().ok_or_else(|| format!("{arg} needs a value"));
        match arg.as_str() {
            "--templates" => templates_dir = Some(PathBuf::from(next()?)),
            "--image" => image = Some(PathBuf::from(next()?)),
            // Frames from Windows Graphics Capture, in memory, awaiting an
            // `attach` command with the HWND. This is the shipped mode; --image
            // remains for tests and for driving the engine from saved frames.
            "--capture" => use_capture = true,
            // Absent turns frame capture off. The host still records the event
            // itself, so diagnostics degrade rather than disappear.
            "--diagnostics-dir" => diagnostics_dir = Some(PathBuf::from(next()?)),
            // Where matches land. Optional so tests can run events-only; the
            // shipped invocation always passes both.
            "--db" => db = Some(PathBuf::from(next()?)),
            "--migrations" => migrations_dir = Some(PathBuf::from(next()?)),
            other => return Err(format!("unexpected argument `{other}`")),
        }
    }

    if image.is_none() && !use_capture {
        return Err("either --image <path> or --capture is required".into());
    }
    let templates_dir = templates_dir.ok_or("--templates <dir> is required")?;
    let store = TemplateStore::load(&templates_dir).map_err(|e| e.to_string())?;
    if store.is_empty() {
        // Without templates nothing can ever be detected, and failing loudly
        // beats never recording another match.
        return Err(format!("no template sets under {}", templates_dir.display()));
    }

    let match_store = match db {
        Some(path) => {
            let mut opened = store::MatchStore::open(&path).map_err(|e| e.to_string())?;
            // Idempotent by now - the host ran `migrate` at startup - but a
            // direct `live --db` invocation must not depend on that.
            if let Some(dir) = &migrations_dir {
                opened.apply_migrations(dir).map_err(|e| e.to_string())?;
            }
            Some(opened)
        }
        None => None,
    };
    let mut options = live::LiveOptions {
        diagnostics: diagnostics_dir.as_deref().and_then(diagnostics::FrameRecorder::new),
        store: match_store,
        ..Default::default()
    };
    let mut channel = host::over_stdio();
    if use_capture {
        #[cfg(windows)]
        {
            let mut source = svwb_engine::capture_source::CaptureSource::new();
            return live::run(&mut source, &store, &mut channel, &mut options)
                .map_err(|e| e.to_string());
        }
        #[cfg(not(windows))]
        return Err("--capture requires Windows".into());
    }
    let mut source = FileSource::watching(image.expect("checked above"));
    live::run(&mut source, &store, &mut channel, &mut options).map_err(|e| e.to_string())
}

/// Replay a recording through the shipped state machine and check the outcome.
///
///   svwb-engine replay <video> --templates <dir> [--fps n]
///                     [--expect '{"my_class":"witch",...}'] [--expect-matches n]
///
/// Returns `Ok(false)` when an expectation failed, so the caller exits non-zero
/// without a Rust panic in the output.
fn replay_recording(args: &[String]) -> Result<bool, String> {
    let mut templates_dir: Option<PathBuf> = None;
    let mut video: Option<PathBuf> = None;
    let mut expect: Option<serde_json::Value> = None;
    let mut expect_matches: Option<usize> = None;
    let mut options = replay::ReplayOptions::default();
    let mut numbers_source = String::from("none");

    let mut rest = args.iter();
    while let Some(arg) = rest.next() {
        let mut next = || rest.next().ok_or_else(|| format!("{arg} needs a value"));
        match arg.as_str() {
            "--templates" => templates_dir = Some(PathBuf::from(next()?)),
            "--fps" => options.fps = next()?.parse().map_err(|_| "--fps must be a number")?,
            "--segment" => {
                options.segment = next()?.parse().map_err(|_| "--segment must be a number")?
            }
            "--expect" => {
                expect = Some(serde_json::from_str(next()?).map_err(|e| format!("--expect: {e}"))?)
            }
            "--expect-matches" => {
                expect_matches =
                    Some(next()?.parse().map_err(|_| "--expect-matches must be a number")?)
            }
            // `host` routes number reads back to whoever spawned this process,
            // over the same protocol `live` uses. That is what lets a fixture
            // assert a BP value against the shipped state machine.
            "--numbers" => numbers_source = next()?.clone(),
            other => video = Some(PathBuf::from(other)),
        }
    }

    let video = video.ok_or("a recording is required")?;
    let templates_dir = templates_dir.ok_or("--templates <dir> is required")?;
    let store = TemplateStore::load(&templates_dir).map_err(|e| e.to_string())?;

    let report = match numbers_source.as_str() {
        "none" => replay::run(&video, &store, &mut NoNumbers, &options),
        "host" => replay::run(&video, &store, &mut host::over_stdio(), &options),
        other => return Err(format!("--numbers must be `none` or `host`, not `{other}`")),
    }
    .map_err(|e| e.to_string())?;

    println!("{} frames at {}fps", report.frames, options.fps);
    for (i, m) in report.matches.iter().enumerate() {
        // Every number the patch can carry, including the ones that are None on
        // most runs. A missing value is the failure mode these fixtures exist to
        // catch - the MP windows once read nothing at all on a client that moved
        // them, and a line that printed only `bp` showed the same thing then as
        // it did when they worked.
        println!(
            "  match {}: {} vs {} ({}) mode={:?} result={:?} \
             bp={:?} mp={:?} delta_mp={:?} cr={:?} delta_cr={:?}",
            i + 1,
            m.my_class,
            m.oppo_class,
            m.play_order,
            m.patch.mode,
            m.patch.result,
            m.patch.bp,
            m.patch.mp,
            m.patch.delta_mp,
            m.patch.current_cr,
            m.patch.delta_cr
        );
    }
    // Diagnostics are printed even on success: a run that reaches the right
    // answer for the wrong reason is worth seeing.
    for (kind, label) in &report.notes {
        println!("  note: {kind} {label}");
    }

    let mut ok = true;

    if let Some(want) = expect_matches {
        if report.matches.len() != want {
            eprintln!("FAIL: expected {want} matches, produced {}", report.matches.len());
            ok = false;
        }
    }

    if let Some(want) = expect {
        let Some(m) = report.matches.first() else {
            eprintln!("FAIL: --expect given but the run produced no match");
            return Ok(false);
        };
        let got = serde_json::json!({
            "my_class": m.my_class,
            "oppo_class": m.oppo_class,
            "play_order": m.play_order,
            "mode": m.patch.mode,
            "result": m.patch.result,
            "bp": m.patch.bp,
            // The MP layout's four values. Without them a recording whose whole
            // point is the MP result screen could only be asserted down to
            // "ranked, won" - which is exactly what stayed true while the MP
            // windows were reading nothing at all.
            "mp": m.patch.mp,
            "delta_mp": m.patch.delta_mp,
            "cr": m.patch.current_cr,
            "delta_cr": m.patch.delta_cr,
        });
        for (key, wanted) in want.as_object().ok_or("--expect must be a JSON object")? {
            let actual = &got[key.as_str()];
            if actual != wanted {
                eprintln!("FAIL: {key}: expected {wanted}, got {actual}");
                ok = false;
            }
        }
    }

    if ok {
        println!("OK");
    }
    Ok(ok)
}

/// Write one binarised number crop to stdout, exactly as a recogniser gets it.
///
///   svwb-engine crop --image <png> --window <name> [--dy <n>]
///
/// This is what the OCR fixture check pipes into Tesseract. It goes through the
/// same `number_window` -> `shift_roi` -> `binarize_to_png` path the live engine
/// uses, so the check validates the crops that actually ship - with no copy of
/// the window coordinates on the checking side.
/// Write the normalised canvas, or a window of it, to stdout as a PNG.
///
/// This is where templates come from. A template cut from a raw 1920x1080
/// screenshot is at the wrong scale and will never match: every window and
/// every template is measured against the 1280x720 grey canvas the probes
/// actually see, and this is the only way to get at it. `--rect` takes that
/// canvas's own coordinates, so a position read off `probe-dump` output can be
/// cut out directly.
///
/// Unlike `crop`, no binary threshold is applied - templates are grey.
fn canvas(args: &[String]) -> Result<(), String> {
    let mut image_path: Option<PathBuf> = None;
    let mut rect: Option<Rect> = None;

    let mut rest = args.iter();
    while let Some(arg) = rest.next() {
        let mut next = || rest.next().ok_or_else(|| format!("{arg} needs a value"));
        match arg.as_str() {
            "--image" => image_path = Some(PathBuf::from(next()?)),
            "--rect" => {
                let raw = next()?;
                let parts: Vec<u32> = raw
                    .split(',')
                    .map(|n| n.trim().parse::<u32>())
                    .collect::<Result<_, _>>()
                    .map_err(|_| "--rect must be four numbers: x,y,w,h")?;
                let [x, y, w, h] = parts[..] else {
                    return Err("--rect must be four numbers: x,y,w,h".into());
                };
                rect = Some(Rect::new(x, y, w, h));
            }
            other => return Err(format!("unexpected argument `{other}`")),
        }
    }

    let image_path = image_path.ok_or("--image <png> is required")?;
    let decoded = image::open(&image_path)
        .map_err(|e| format!("cannot decode {}: {e}", image_path.display()))?;
    let frame = Frame::from_image(&decoded);

    let png = match rect {
        Some(window) => frame.crop_to_png(window).ok_or("rect is outside the canvas")?,
        None => frame.normalised_to_png().ok_or("cannot encode the canvas")?,
    };

    use std::io::Write;
    std::io::stdout().write_all(&png).map_err(|e| e.to_string())
}

fn crop(args: &[String]) -> Result<(), String> {
    let mut image_path: Option<PathBuf> = None;
    let mut window_name: Option<String> = None;
    let mut dy: i32 = 0;

    let mut rest = args.iter();
    while let Some(arg) = rest.next() {
        let mut next = || rest.next().ok_or_else(|| format!("{arg} needs a value"));
        match arg.as_str() {
            "--image" => image_path = Some(PathBuf::from(next()?)),
            "--window" => window_name = Some(next()?.clone()),
            "--dy" => dy = next()?.parse().map_err(|_| "--dy must be an integer")?,
            other => return Err(format!("unexpected argument `{other}`")),
        }
    }

    let image_path = image_path.ok_or("--image <png> is required")?;
    let name = window_name.ok_or("--window <name> is required")?;
    let window = calibration::number_window(&name)
        .ok_or_else(|| format!("unknown window `{name}`"))?;

    let decoded = image::open(&image_path)
        .map_err(|e| format!("cannot decode {}: {e}", image_path.display()))?;
    let frame = Frame::from_image(&decoded);
    let png = frame
        .binarize_to_png(calibration::shift_roi(window, dy), numbers::OCR_BINARY_THRESHOLD)
        .ok_or("window is outside the canvas")?;

    use std::io::Write;
    std::io::stdout().write_all(&png).map_err(|e| e.to_string())
}

/// Emit the interpreted [`Reading`] for each image, one JSON line each.
///
/// `probe-dump` answers "did the engine score this window the same as the
/// addon"; this answers "and did it draw the same conclusion". The two are
/// different failures - a correct score fed through the wrong threshold, or the
/// wrong side of the versus screen, produces identical numbers and an inverted
/// match.
///
/// Numbers are left empty: reading digits needs a `NumberReader`, which is a
/// separate seam (plan P6-a).
fn read_dump(args: &[String]) -> Result<(), String> {
    let mut templates_dir: Option<PathBuf> = None;
    let mut images: Vec<PathBuf> = Vec::new();

    let mut rest = args.iter();
    while let Some(arg) = rest.next() {
        match arg.as_str() {
            "--templates" => {
                templates_dir =
                    Some(PathBuf::from(rest.next().ok_or("--templates needs a directory")?));
            }
            other => images.push(PathBuf::from(other)),
        }
    }

    let templates_dir = templates_dir.ok_or("--templates <dir> is required")?;
    let store = TemplateStore::load(&templates_dir).map_err(|e| e.to_string())?;
    if images.is_empty() {
        return Err("at least one image is required".into());
    }

    for image_path in &images {
        let decoded = image::open(image_path)
            .map_err(|e| format!("cannot decode {}: {e}", image_path.display()))?;
        let frame = Frame::from_image(&decoded);
        let reading = reading::read(&frame, &store, &mut NoNumbers, false);
        let body = serde_json::to_string(&reading).map_err(|e| e.to_string())?;
        println!("{{\"image\":{:?},\"reading\":{body}}}", stable_label(image_path));
    }
    Ok(())
}

/// `<parent>/<file>`, so the two sides agree regardless of how each was invoked
/// or which path separator the platform uses.
fn stable_label(path: &Path) -> String {
    let file = path.file_name().unwrap_or_default().to_string_lossy();
    match path.parent().and_then(Path::file_name) {
        Some(parent) => format!("{}/{}", parent.to_string_lossy(), file),
        None => file.into_owned(),
    }
}


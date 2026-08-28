//! Offline calibration / validation harness.
//!
//! Runs the ported matcher over the regression fixtures using the SAME broad
//! search windows that `forkedImageAnalyzer.ts` uses today, and reports the
//! best score plus the position where each match landed.
//!
//! Two things come out of this:
//!   1. validation - do the scores clear the thresholds the TS code already
//!      uses, on frames whose expected outcome is documented in the fixture
//!      README?
//!   2. calibration - `maxLoc` (which the TS code computes and throws away)
//!      tells us where each element actually sits on the normalized canvas, so
//!      the broad searches can be narrowed to tight fixed ROIs.
//!
//! Usage: cargo run --release --bin calibrate -- <fixtures-dir> <templates-dir>

use std::path::{Path, PathBuf};
use std::time::Instant;

use svwb_vision_native::{
    Integral, MatchResult, Rect, Template, match_best, normalize_gray, to_gray_opencv,
};

/// Thresholds copied from `THRESHOLD` in forkedImageAnalyzer.ts, so the report
/// shows pass/fail against the values already in production.
fn threshold_for(category: &str) -> Option<f64> {
    match category {
        "classes" => Some(0.7),
        "emblems" => Some(0.7),
        "play_order" => Some(0.6),
        "modes_ranked" | "modes_2pick" => Some(0.7),
        "modes_cpu" => Some(0.58),
        "result" | "result_mid" => Some(0.7),
        "history" => Some(0.6),
        _ => None,
    }
}

struct Search {
    label: &'static str,
    category: &'static str,
    rect: Rect,
}

/// Mirrors every matchTemplate() call site in analyzeOnce().
fn searches() -> Vec<Search> {
    let full = Rect::full_frame();
    let left = Rect::new(0, 0, 640, 720);
    let right = Rect::new(640, 0, 640, 720);
    let top_right = Rect::new(640, 0, 640, 360);
    let top_right_banner = Rect::new(640, 0, 640, 180);

    vec![
        Search {
            label: "history/full",
            category: "history",
            rect: full,
        },
        Search {
            label: "modesRanked/roi",
            category: "modes_ranked",
            rect: Rect::new(780, 205, 150, 60),
        },
        Search {
            label: "modes2Pick/roi",
            category: "modes_2pick",
            rect: Rect::new(780, 295, 180, 50),
        },
        Search {
            label: "modesCPU/topRight",
            category: "modes_cpu",
            rect: top_right,
        },
        Search {
            label: "modesCPU/full",
            category: "modes_cpu",
            rect: full,
        },
        Search {
            label: "modesCPU/topRightBanner",
            category: "modes_cpu",
            rect: top_right_banner,
        },
        Search {
            label: "modesPlaza/topRight",
            category: "modes_plaza",
            rect: top_right,
        },
        Search {
            label: "custom/left",
            category: "custom",
            rect: left,
        },
        Search {
            label: "custom/right",
            category: "custom",
            rect: right,
        },
        Search {
            label: "classes/left",
            category: "classes",
            rect: left,
        },
        Search {
            label: "classes/right",
            category: "classes",
            rect: right,
        },
        Search {
            label: "emblems/left",
            category: "emblems",
            rect: left,
        },
        Search {
            label: "emblems/right",
            category: "emblems",
            rect: right,
        },
        Search {
            label: "playOrder/left",
            category: "play_order",
            rect: left,
        },
        Search {
            label: "playOrder/right",
            category: "play_order",
            rect: right,
        },
        Search {
            label: "resultMid/full",
            category: "result_mid",
            rect: full,
        },
        Search {
            label: "result/full",
            category: "result",
            rect: full,
        },
    ]
}

fn load_templates(dir: &Path) -> std::io::Result<Vec<Template>> {
    let mut out = Vec::new();
    let mut entries: Vec<PathBuf> = std::fs::read_dir(dir)?
        .filter_map(|e| e.ok().map(|e| e.path()))
        .filter(|p| p.extension().and_then(|e| e.to_str()) == Some("png"))
        .collect();
    entries.sort();

    for path in entries {
        let name = path
            .file_stem()
            .and_then(|s| s.to_str())
            .unwrap_or("?")
            .to_string();
        let img = image::open(&path).expect("template decode");
        out.push(Template::new(name, &to_gray_opencv(&img)));
    }
    Ok(out)
}

fn main() {
    let mut args = std::env::args().skip(1);
    let fixtures_dir = PathBuf::from(
        args.next()
            .unwrap_or_else(|| "tests/fixtures/captures/cpu-practice-1920-fullscreen".into()),
    );
    let templates_dir = PathBuf::from(args.next().unwrap_or_else(|| "resources/templates".into()));
    // Optional third arg: only run searches whose label contains this substring.
    let filter = args.next();

    let searches: Vec<Search> = match &filter {
        Some(f) => searches()
            .into_iter()
            .filter(|s| s.label.contains(f.as_str()))
            .collect(),
        None => searches(),
    };

    // Load every template category the searches reference, once.
    let mut categories: Vec<&str> = searches.iter().map(|s| s.category).collect();
    categories.sort();
    categories.dedup();

    let mut loaded: Vec<(&str, Vec<Template>)> = Vec::new();
    for category in categories {
        let dir = templates_dir.join(category);
        match load_templates(&dir) {
            Ok(t) if !t.is_empty() => {
                println!("loaded {:>14}: {} template(s)", category, t.len());
                loaded.push((category, t));
            }
            Ok(_) => eprintln!("warn: no templates in {}", dir.display()),
            Err(e) => eprintln!("warn: cannot read {}: {e}", dir.display()),
        }
    }

    let mut frames: Vec<PathBuf> = std::fs::read_dir(&fixtures_dir)
        .expect("fixtures dir")
        .filter_map(|e| e.ok().map(|e| e.path()))
        .filter(|p| p.extension().and_then(|e| e.to_str()) == Some("png"))
        .collect();
    frames.sort();

    for frame_path in frames {
        let decoded = image::open(&frame_path).expect("frame decode");
        let raw_gray = to_gray_opencv(&decoded);
        let started = Instant::now();
        let frame = normalize_gray(&raw_gray);
        let normalize_ms = started.elapsed().as_secs_f64() * 1000.0;

        let integral = Integral::new(&frame);

        println!(
            "\n=== {} ({}x{} -> {}x{}, normalize {:.1}ms) ===",
            frame_path.file_name().unwrap().to_string_lossy(),
            raw_gray.width(),
            raw_gray.height(),
            frame.width(),
            frame.height(),
            normalize_ms
        );
        println!(
            "{:<26} {:>7} {:>6} {:>16} {:>18} {:>9}",
            "search", "score", "vs thr", "best template", "found at (x,y,w,h)", "ms"
        );

        let mut frame_total_ms = 0.0;
        for search in &searches {
            let templates = match loaded.iter().find(|(c, _)| *c == search.category) {
                Some((_, t)) => t,
                None => continue,
            };

            let t0 = Instant::now();
            let hit: Option<MatchResult> = match_best(&frame, &integral, search.rect, templates);
            let ms = t0.elapsed().as_secs_f64() * 1000.0;
            frame_total_ms += ms;

            match hit {
                Some(m) => {
                    let verdict = match threshold_for(search.category) {
                        Some(thr) if m.score >= thr => format!("PASS>{thr}"),
                        Some(thr) => format!("  no<{thr}"),
                        None => "   -".into(),
                    };
                    // Report the matched box so a tight ROI can be derived from it.
                    let tpl = templates.iter().find(|t| t.name == m.name);
                    let (tw, th) = tpl.map_or((0, 0), |t| (t.width, t.height));
                    println!(
                        "{:<26} {:>7.4} {:>6} {:>16} {:>18} {:>9.1}",
                        search.label,
                        m.score,
                        verdict,
                        m.name,
                        format!("{},{},{},{}", m.x, m.y, tw, th),
                        ms
                    );
                }
                None => println!(
                    "{:<26} {:>7} (template larger than search window)",
                    search.label, "-"
                ),
            }
        }
        println!(
            "{:<26} {:>7} {:>40} {:>9.1}",
            "TOTAL", "", "", frame_total_ms
        );
    }
}

//! Core image-recognition primitives for the SVWB analyzer.
//!
//! This is a deliberate, faithful port of the OpenCV operations that
//! `src/main/forkedImageAnalyzer.ts` relies on, so that existing detection
//! thresholds keep their meaning:
//!
//! * grayscale uses OpenCV's BGR2GRAY fixed-point weights,
//! * downscaling uses OpenCV's `INTER_LINEAR` sample mapping,
//! * scoring reproduces `TM_CCOEFF_NORMED`.
//!
//! Template matching is computed directly (no FFT). Every frame is normalized
//! to a fixed 1280x720 canvas, so callers search small fixed regions instead of
//! whole frames, which keeps the direct form far cheaper than a transform.

use image::DynamicImage;
use rayon::prelude::*;

// Re-exported so dependent crates (the Node addon) share the exact same type
// rather than relying on their own `image` version resolving identically.
pub use image::GrayImage;

pub const BASE_WIDTH: u32 = 1280;
pub const BASE_HEIGHT: u32 = 720;
pub const GAME_ASPECT_RATIO: f64 = BASE_WIDTH as f64 / BASE_HEIGHT as f64;

/// An axis-aligned search window in normalized (1280x720) canvas coordinates.
#[derive(Debug, Clone, Copy)]
pub struct Rect {
    pub x: u32,
    pub y: u32,
    pub w: u32,
    pub h: u32,
}

impl Rect {
    pub const fn new(x: u32, y: u32, w: u32, h: u32) -> Self {
        Self { x, y, w, h }
    }

    pub const fn full_frame() -> Self {
        Self::new(0, 0, BASE_WIDTH, BASE_HEIGHT)
    }
}

/// OpenCV's `cvtColor(..., COLOR_BGR2GRAY)` for 8-bit input, which uses
/// fixed-point BT.601 weights rather than the BT.709 weights that the `image`
/// crate's own `to_luma8` would apply. Matching OpenCV here keeps template
/// scores comparable to the existing implementation.
pub fn to_gray_opencv(img: &DynamicImage) -> GrayImage {
    let rgb = img.to_rgb8();
    let (w, h) = (rgb.width(), rgb.height());
    let mut out = GrayImage::new(w, h);
    for (src, dst) in rgb.pixels().zip(out.pixels_mut()) {
        let r = src[0] as u32;
        let g = src[1] as u32;
        let b = src[2] as u32;
        dst[0] = ((r * 4899 + g * 9617 + b * 1868 + 8192) >> 14) as u8;
    }
    out
}

/// A row with at least this much variation across the sampled columns counts as
/// picture rather than window chrome.
const TEXTURED_ROW_SD: f64 = 8.0;
/// How many consecutive textured rows mark the true start of the picture.
///
/// One row is not enough: the very top row of a window capture can pick up the
/// desktop behind an anti-aliased border and read as textured on its own, which
/// would stop the scan at row 0 and crop nothing. Game content stays textured
/// for hundreds of rows, so requiring a short run rejects that noise.
const TEXTURED_RUN: u32 = 4;

/// How far down the frame the scan for the start of the picture may go.
///
/// This is not a tidiness limit, it is the supported range of everything above
/// the game: the window's title bar, and the letterbox the client paints when
/// the display is taller than 16:9. Whatever is not scanned stays in frame, and
/// the aspect crop then trims the BOTTOM - so an unrecognised top band shifts
/// every calibrated window down by its own height, silently.
///
/// The previous value was `64.min(rows / 8)`, and both halves of that were too
/// small to state the range honestly:
///
/// * The 64 put the boundary at 63px of chrome (measured: 62 and 63 normalise
///   identically to a clean capture, 64 and above do not). A Win11 title bar is
///   32px at 100% scaling, so a 4K or 2K display at **200% scaling** produces
///   exactly 64 - a reachable setup that failed silently. 150% (45px) was fine.
/// * `rows / 8` is EXACTLY the letterbox a 4:3 display gets (bar height is
///   `rows * 0.125` at 4:3), so the scan stopped one row short of the very case
///   it needed to cover. 1600x1200 lost the `result` banner completely.
///
/// 320 covers every common shape: 16:10 needs `0.05 * rows` (120px at
/// 3840x2400), 5:4 needs `0.148 * rows` (178px at 1920x1200 5:4), 4:3 needs
/// `0.125 * rows` (270px at 2880x2160). The `rows / 4` guard keeps the scan out
/// of the picture on a small capture. Cost is nil in the normal case: the scan
/// stops at the first textured run, and fullscreen 16:9 returns before it.
const MAX_CHROME_ROWS: u32 = 320;

/// Height of whatever sits above the picture - window chrome in a windowed
/// capture, the client's own letterbox on a display taller than 16:9, or both -
/// and 0 when the capture starts straight into the game.
///
/// The name is historical: it was written for title bars, and the letterbox
/// turned out to be the same measurement taken for the same reason. See
/// [`MAX_CHROME_ROWS`] for how far down it looks and why.
///
/// The discriminator is **texture, never brightness**. Window chrome is painted
/// in flat bands, so every such row has near-zero variance across the sampled
/// columns; the game's artwork is textured. Measured on a real 1276x754
/// windowed capture, the rows above the game were:
///
/// ```text
/// row  0      mean 112  sd 0.00   border
/// rows 1-2    mean 219  sd 0.00   border
/// row  3      mean  64  sd 0.00   border
/// rows 4-30   mean 255  sd 0.00   title bar
/// row  31+    mean  55  sd 11.5   game content
/// ```
///
/// Note how the flat bands span 64..255 in brightness. That is why an earlier
/// version, which returned the first row with `mean >= 80`, stopped at row 0 and
/// cropped nothing: the whole title bar stayed in frame, shifting every
/// calibrated region down by ~30px. A light system theme was enough to break it,
/// and it failed silently - detections simply stopped matching.
///
/// Only the centre columns are sampled, so the app icon and window controls
/// cannot influence the decision.
pub fn detect_title_bar_height(gray: &GrayImage) -> u32 {
    let cols = gray.width();
    let rows = gray.height();
    if (cols as f64 / rows as f64 - GAME_ASPECT_RATIO).abs() < 0.01 {
        return 0;
    }

    let max_rows = MAX_CHROME_ROWS.min(rows / 4);
    if max_rows == 0 {
        return 0;
    }
    let start_x = (cols as f64 * 0.25).floor() as u32;
    let end_x = ((cols as f64 * 0.75).ceil() as u32).min(cols);
    let step = 1.max((end_x.saturating_sub(start_x)) / 160);

    let row_is_textured = |y: u32| -> bool {
        let mut sum = 0f64;
        let mut sum_squares = 0f64;
        let mut count = 0f64;
        let mut x = start_x;
        while x < end_x {
            let value = gray.get_pixel(x, y)[0] as f64;
            sum += value;
            sum_squares += value * value;
            count += 1.0;
            x += step;
        }
        if count == 0.0 {
            return false;
        }
        let mean = sum / count;
        (sum_squares / count - mean * mean).max(0.0).sqrt() >= TEXTURED_ROW_SD
    };

    // The picture starts at the first row where texture persists.
    let limit = max_rows.min(rows.saturating_sub(TEXTURED_RUN));
    for y in 0..limit {
        if (0..TEXTURED_RUN).all(|d| row_is_textured(y + d)) {
            return y;
        }
    }

    0
}

/// Bilinear resize using OpenCV's `INTER_LINEAR` source mapping
/// (`src = (dst + 0.5) * scale - 0.5`), which differs from the `image` crate's
/// triangle filter and would otherwise shift scores.
pub fn resize_bilinear_opencv(src: &GrayImage, dst_w: u32, dst_h: u32) -> GrayImage {
    let src_w = src.width();
    let src_h = src.height();
    if src_w == dst_w && src_h == dst_h {
        return src.clone();
    }

    let scale_x = src_w as f64 / dst_w as f64;
    let scale_y = src_h as f64 / dst_h as f64;
    let mut out = GrayImage::new(dst_w, dst_h);

    for dy in 0..dst_h {
        let fy = ((dy as f64 + 0.5) * scale_y - 0.5).max(0.0);
        let y0 = fy.floor() as u32;
        let y1 = (y0 + 1).min(src_h - 1);
        let wy = fy - y0 as f64;

        for dx in 0..dst_w {
            let fx = ((dx as f64 + 0.5) * scale_x - 0.5).max(0.0);
            let x0 = fx.floor() as u32;
            let x1 = (x0 + 1).min(src_w - 1);
            let wx = fx - x0 as f64;

            let p00 = src.get_pixel(x0, y0)[0] as f64;
            let p01 = src.get_pixel(x1, y0)[0] as f64;
            let p10 = src.get_pixel(x0, y1)[0] as f64;
            let p11 = src.get_pixel(x1, y1)[0] as f64;

            let top = p00 + (p01 - p00) * wx;
            let bottom = p10 + (p11 - p10) * wx;
            let value = top + (bottom - top) * wy;
            out.put_pixel(dx, dy, image::Luma([value.round().clamp(0.0, 255.0) as u8]));
        }
    }

    out
}

/// Extract the game viewport before scaling, then normalize to 1280x720.
///
/// Port of `normalizeGray` in `forkedImageAnalyzer.ts`.
pub fn normalize_gray(gray: &GrayImage) -> GrayImage {
    let title_bar_height = detect_title_bar_height(gray);
    let content = if title_bar_height > 0 {
        image::imageops::crop_imm(
            gray,
            0,
            title_bar_height,
            gray.width(),
            gray.height() - title_bar_height,
        )
        .to_image()
    } else {
        gray.clone()
    };

    let content_aspect = content.width() as f64 / content.height() as f64;
    let viewport = if content_aspect > GAME_ASPECT_RATIO {
        let width = (content.height() as f64 * GAME_ASPECT_RATIO).floor() as u32;
        let x = (content.width() - width) / 2;
        image::imageops::crop_imm(&content, x, 0, width, content.height()).to_image()
    } else if content_aspect < GAME_ASPECT_RATIO {
        let height = (content.width() as f64 / GAME_ASPECT_RATIO).floor() as u32;
        image::imageops::crop_imm(&content, 0, 0, content.width(), height).to_image()
    } else {
        content
    };

    resize_bilinear_opencv(&viewport, BASE_WIDTH, BASE_HEIGHT)
}

/// Box-average downscale by an integer factor.
///
/// Matching cost grows with both the candidate count and the template area, so
/// halving the resolution cuts the work roughly sixteenfold. For large, smooth
/// banners the normalized correlation score is barely affected, which makes
/// this the right lever for the few searches that use big templates.
/// Averaging (rather than sampling) keeps the score stable by not introducing
/// aliasing that the full-resolution template would not have.
pub fn downscale(gray: &GrayImage, factor: u32) -> GrayImage {
    assert!(factor >= 1, "downscale factor must be >= 1");
    if factor == 1 {
        return gray.clone();
    }
    let w = (gray.width() / factor).max(1);
    let h = (gray.height() / factor).max(1);
    let mut out = GrayImage::new(w, h);
    let n = factor * factor;
    for y in 0..h {
        for x in 0..w {
            let mut sum = 0u32;
            for dy in 0..factor {
                for dx in 0..factor {
                    sum += gray.get_pixel(x * factor + dx, y * factor + dy)[0] as u32;
                }
            }
            out.put_pixel(x, y, image::Luma([(sum / n) as u8]));
        }
    }
    out
}

/// A template with its scoring constants precomputed once at load time.
pub struct Template {
    pub name: String,
    pub width: u32,
    pub height: u32,
    /// Zero-mean pixel values, so matching only needs a dot product.
    centered: Vec<f64>,
    /// `sum((T - mean(T))^2)`, the template half of the normalizing term.
    sum_sq_dev: f64,
}

impl Template {
    pub fn new(name: impl Into<String>, gray: &GrayImage) -> Self {
        let n = (gray.width() * gray.height()) as f64;
        let sum: f64 = gray.pixels().map(|p| p[0] as f64).sum();
        let mean = sum / n;
        let centered: Vec<f64> = gray.pixels().map(|p| p[0] as f64 - mean).collect();
        let sum_sq_dev = centered.iter().map(|v| v * v).sum();
        Self {
            name: name.into(),
            width: gray.width(),
            height: gray.height(),
            centered,
            sum_sq_dev,
        }
    }
}

/// Integral images of a frame, built once and reused for every window so the
/// per-position normalizing term is O(1) instead of O(template area).
pub struct Integral {
    stride: usize,
    sum: Vec<f64>,
    sum_sq: Vec<f64>,
}

impl Integral {
    pub fn new(gray: &GrayImage) -> Self {
        let w = gray.width() as usize;
        let h = gray.height() as usize;
        let stride = w + 1;
        let mut sum = vec![0f64; stride * (h + 1)];
        let mut sum_sq = vec![0f64; stride * (h + 1)];

        for y in 0..h {
            let mut row_sum = 0f64;
            let mut row_sum_sq = 0f64;
            for x in 0..w {
                let v = gray.get_pixel(x as u32, y as u32)[0] as f64;
                row_sum += v;
                row_sum_sq += v * v;
                sum[(y + 1) * stride + x + 1] = sum[y * stride + x + 1] + row_sum;
                sum_sq[(y + 1) * stride + x + 1] = sum_sq[y * stride + x + 1] + row_sum_sq;
            }
        }

        Self {
            stride,
            sum,
            sum_sq,
        }
    }

    /// `(sum, sum of squares)` over the `w x h` window whose top-left is (x, y).
    #[inline]
    fn window(&self, x: u32, y: u32, w: u32, h: u32) -> (f64, f64) {
        let (x0, y0) = (x as usize, y as usize);
        let (x1, y1) = (x0 + w as usize, y0 + h as usize);
        let a = y0 * self.stride + x0;
        let b = y0 * self.stride + x1;
        let c = y1 * self.stride + x0;
        let d = y1 * self.stride + x1;
        (
            self.sum[d] - self.sum[b] - self.sum[c] + self.sum[a],
            self.sum_sq[d] - self.sum_sq[b] - self.sum_sq[c] + self.sum_sq[a],
        )
    }
}

/// Best position and score for one template within one search window.
#[derive(Debug, Clone)]
pub struct MatchResult {
    pub name: String,
    pub score: f64,
    /// Best match position, in normalized canvas coordinates.
    pub x: u32,
    pub y: u32,
}

/// Score one template across `search`, returning its best position.
///
/// Reproduces `TM_CCOEFF_NORMED`:
/// `score = (sum(T*I) - mean(T) * sum(I)) / sqrt(sum_sq_dev(T) * (sum(I^2) - sum(I)^2 / N))`
pub fn match_template(
    frame: &GrayImage,
    integral: &Integral,
    search: Rect,
    template: &Template,
) -> Option<MatchResult> {
    let (tw, th) = (template.width, template.height);
    if tw > search.w || th > search.h || tw == 0 || th == 0 {
        return None;
    }

    let frame_w = frame.width() as usize;
    let pixels = frame.as_raw();
    let n = (tw * th) as f64;
    let last_x = search.x + search.w - tw;
    let last_y = search.y + search.h - th;

    // The template mean is already folded into `centered`, so the numerator is a
    // plain dot product of centered template against raw window pixels.
    let best = (search.y..=last_y)
        .into_par_iter()
        .map(|y| {
            let mut row_best: Option<(f64, u32, u32)> = None;
            for x in search.x..=last_x {
                let mut dot = 0f64;
                for ty in 0..th as usize {
                    let frame_row = (y as usize + ty) * frame_w + x as usize;
                    let tpl_row = ty * tw as usize;
                    for tx in 0..tw as usize {
                        dot += template.centered[tpl_row + tx] * pixels[frame_row + tx] as f64;
                    }
                }

                let (s1, s2) = integral.window(x, y, tw, th);
                let window_var = s2 - s1 * s1 / n;
                let denom = (template.sum_sq_dev * window_var).max(0.0).sqrt();
                // A flat window or flat template has no correlation to speak of.
                let score = if denom > f64::EPSILON {
                    dot / denom
                } else {
                    0.0
                };

                if row_best.is_none_or(|(best, _, _)| score > best) {
                    row_best = Some((score, x, y));
                }
            }
            row_best
        })
        .reduce(
            || None,
            |a, b| match (a, b) {
                (Some(a), Some(b)) => Some(if b.0 > a.0 { b } else { a }),
                (Some(a), None) => Some(a),
                (None, b) => b,
            },
        );

    best.map(|(score, x, y)| MatchResult {
        name: template.name.clone(),
        score,
        x,
        y,
    })
}

/// Highest-scoring template in a set, mirroring the TS `matchTemplate` helper.
pub fn match_best(
    frame: &GrayImage,
    integral: &Integral,
    search: Rect,
    templates: &[Template],
) -> Option<MatchResult> {
    templates
        .iter()
        .filter_map(|t| match_template(frame, integral, search, t))
        .fold(None::<MatchResult>, |acc, m| match acc {
            Some(best) if best.score >= m.score => Some(best),
            _ => Some(m),
        })
}

#[cfg(test)]
mod tests {
    use super::*;

    fn gray_from(w: u32, h: u32, vals: &[u8]) -> GrayImage {
        GrayImage::from_raw(w, h, vals.to_vec()).unwrap()
    }

    #[test]
    fn identical_patch_scores_one_at_its_own_location() {
        // Deliberately non-linear pixel values: a linear gradient would make every
        // window identical once the score normalizes brightness and contrast away,
        // so the reported location would be arbitrary rather than wrong.
        let frame = gray_from(
            4,
            4,
            &[
                5, 90, 12, 200, //
                77, 3, 160, 45, //
                120, 33, 8, 175, //
                60, 210, 95, 20,
            ],
        );
        let patch = gray_from(2, 2, &[160, 45, 8, 175]);
        let tpl = Template::new("patch", &patch);
        let integral = Integral::new(&frame);

        let m = match_template(&frame, &integral, Rect::new(0, 0, 4, 4), &tpl).unwrap();
        assert!((m.score - 1.0).abs() < 1e-9, "score was {}", m.score);

        // Assert on the matched content rather than on fixed coordinates, so the
        // test stays valid even if some other window happens to tie.
        let matched: Vec<u8> = (0..2)
            .flat_map(|dy| (0..2).map(move |dx| (dx, dy)))
            .map(|(dx, dy)| frame.get_pixel(m.x + dx, m.y + dy)[0])
            .collect();
        assert_eq!(matched, vec![160, 45, 8, 175]);
    }

    #[test]
    fn contrast_and_brightness_are_normalized_away() {
        // TM_CCOEFF_NORMED is invariant to affine changes in intensity, so a
        // brightened/scaled copy of the pattern must still score ~1.0.
        let frame = gray_from(2, 2, &[10, 20, 30, 40]);
        let patch = gray_from(2, 2, &[110, 120, 130, 140]);
        let tpl = Template::new("shifted", &patch);
        let integral = Integral::new(&frame);

        let m = match_template(&frame, &integral, Rect::new(0, 0, 2, 2), &tpl).unwrap();
        assert!((m.score - 1.0).abs() < 1e-9, "score was {}", m.score);
    }

    #[test]
    fn flat_window_yields_zero_instead_of_nan() {
        let frame = gray_from(2, 2, &[128, 128, 128, 128]);
        let patch = gray_from(2, 2, &[0, 255, 255, 0]);
        let tpl = Template::new("flat", &patch);
        let integral = Integral::new(&frame);

        let m = match_template(&frame, &integral, Rect::new(0, 0, 2, 2), &tpl).unwrap();
        assert_eq!(m.score, 0.0);
    }

    #[test]
    fn fullscreen_16_9_needs_no_title_bar_crop() {
        let gray = GrayImage::new(1920, 1080);
        assert_eq!(detect_title_bar_height(&gray), 0);
    }

    /// Builds a non-16:9 canvas with a flat title bar of `bar` brightness over
    /// textured content, to check the band is measured by flatness rather than
    /// by being dark.
    fn windowed_with_title_bar(bar: u8, height: u32) -> GrayImage {
        let (w, h) = (1276u32, 754u32);
        let mut img = GrayImage::new(w, h);
        for y in 0..h {
            for x in 0..w {
                let v = if y < height {
                    bar
                } else {
                    // Alternating content so rows are clearly textured.
                    if (x / 4 + y / 4) % 2 == 0 { 30 } else { 190 }
                };
                img.put_pixel(x, y, image::Luma([v]));
            }
        }
        img
    }

    #[test]
    fn detects_a_dark_title_bar() {
        assert_eq!(detect_title_bar_height(&windowed_with_title_bar(20, 31)), 31);
    }

    #[test]
    fn detects_a_light_title_bar() {
        // The case that used to fail: a light theme made the old brightness
        // test fire on row 0, so nothing was cropped.
        assert_eq!(
            detect_title_bar_height(&windowed_with_title_bar(240, 31)),
            31
        );
    }

    /// A Win11 title bar is 32px at 100% scaling, so a 2K or 4K display at 200%
    /// hands over 64 - the exact height the old `64.min(rows / 8)` limit could
    /// not reach, and a setup a user can arrive at through the display settings
    /// alone. 150% (45px) always worked; this is the pair that did not.
    #[test]
    fn a_title_bar_at_200_percent_scaling_is_still_found() {
        for bar in [45, 64, 96] {
            assert_eq!(
                detect_title_bar_height(&windowed_with_title_bar(240, bar)),
                bar,
                "a {bar}px title bar"
            );
        }
    }

    /// The letterbox a 4:3 display gets is `rows / 8` exactly, which is where
    /// the old limit stopped - so the one shape that most needed the scan was
    /// the one it could not reach. 1600x1200 lost the result banner outright.
    #[test]
    fn a_letterbox_taller_than_a_title_bar_is_found() {
        // 4:3, 16:10 and 5:4 at their common sizes, as (width, height).
        for (w, h) in [(1600u32, 1200u32), (1920, 1440), (1920, 1200), (1280, 1024)] {
            let bar = (h - (w as f64 / GAME_ASPECT_RATIO) as u32) / 2;
            let mut img = GrayImage::new(w, h);
            for y in bar..(h - bar) {
                for x in 0..w {
                    let v = if (x / 4 + y / 4) % 2 == 0 { 30 } else { 190 };
                    img.put_pixel(x, y, image::Luma([v]));
                }
            }
            assert_eq!(
                detect_title_bar_height(&img),
                bar,
                "{w}x{h} letterboxes the picture by {bar}px"
            );
        }
    }

    #[test]
    fn a_single_noisy_top_row_does_not_end_the_scan() {
        // Seen for real: one capture's row 0 picked up the desktop behind an
        // anti-aliased window edge (sd 9.9) while rows 1..30 were flat chrome.
        // Keying off a single textured row cropped nothing at all.
        let (w, h) = (1276u32, 754u32);
        let mut img = GrayImage::new(w, h);
        for x in 0..w {
            img.put_pixel(x, 0, image::Luma([if x % 2 == 0 { 20 } else { 70 }]));
        }
        for y in 1..31 {
            for x in 0..w {
                img.put_pixel(x, y, image::Luma([255]));
            }
        }
        for y in 31..h {
            for x in 0..w {
                let v = if (x / 4 + y / 4) % 2 == 0 { 30 } else { 190 };
                img.put_pixel(x, y, image::Luma([v]));
            }
        }
        assert_eq!(detect_title_bar_height(&img), 31);
    }

    #[test]
    fn detects_chrome_made_of_bands_of_differing_brightness() {
        // Reproduces the real capture: border rows at 112/219/64 above a white
        // title bar. Anything keyed off brightness - absolute or relative to the
        // first row - stops early here and leaves the chrome in frame.
        let (w, h) = (1276u32, 754u32);
        let mut img = GrayImage::new(w, h);
        let bands: [(u32, u8); 4] = [(1, 112), (2, 219), (1, 64), (27, 255)];
        let mut y = 0u32;
        for (count, value) in bands {
            for _ in 0..count {
                for x in 0..w {
                    img.put_pixel(x, y, image::Luma([value]));
                }
                y += 1;
            }
        }
        let chrome_height = y;
        for cy in y..h {
            for x in 0..w {
                let v = if (x / 4 + cy / 4) % 2 == 0 { 30 } else { 190 };
                img.put_pixel(x, cy, image::Luma([v]));
            }
        }

        assert_eq!(detect_title_bar_height(&img), chrome_height);
        assert_eq!(chrome_height, 31);
    }

    #[test]
    fn no_title_bar_when_content_starts_immediately() {
        let img = windowed_with_title_bar(0, 0);
        assert_eq!(detect_title_bar_height(&img), 0);
    }

    /// A canvas whose every row is textured, so `normalize_gray` performs no
    /// title-bar crop and the aspect-ratio branch is what is under test.
    ///
    /// Values stay below 255 so `mark` can plant a unique maximum.
    fn textured(w: u32, h: u32) -> GrayImage {
        let mut img = GrayImage::new(w, h);
        for y in 0..h {
            for x in 0..w {
                img.put_pixel(x, y, image::Luma([((x * 7 + y * 13) % 251) as u8]));
            }
        }
        img
    }

    /// Plant a small bright square centred on (cx, cy).
    ///
    /// Tracking a marker is the only honest way to test this: the resize is
    /// bilinear, so no output pixel ever equals a single source pixel, and
    /// comparing pixel values would only measure the interpolation. Where a
    /// known element *lands* is also exactly what the calibrated ROI table
    /// depends on.
    fn mark(img: &mut GrayImage, cx: u32, cy: u32) {
        const HALF: u32 = 10;
        for y in cy.saturating_sub(HALF)..(cy + HALF).min(img.height()) {
            for x in cx.saturating_sub(HALF)..(cx + HALF).min(img.width()) {
                img.put_pixel(x, y, image::Luma([255]));
            }
        }
    }

    /// Brightest pixel of the normalized canvas, i.e. where `mark` ended up.
    fn brightest(img: &GrayImage) -> (u32, u32) {
        let mut best = (0u32, 0u32, 0u8);
        for y in 0..img.height() {
            for x in 0..img.width() {
                let v = img.get_pixel(x, y)[0];
                if v > best.2 {
                    best = (x, y, v);
                }
            }
        }
        (best.0, best.1)
    }

    fn assert_near(actual: (u32, u32), expected: (u32, u32), tolerance: u32) {
        let dx = actual.0.abs_diff(expected.0);
        let dy = actual.1.abs_diff(expected.1);
        assert!(
            dx <= tolerance && dy <= tolerance,
            "marker landed at {actual:?}, expected about {expected:?}"
        );
    }

    #[test]
    fn exactly_16_9_is_scaled_without_cropping() {
        let mut img = textured(1920, 1080);
        mark(&mut img, 960, 540);
        let out = normalize_gray(&img);
        assert_eq!((out.width(), out.height()), (BASE_WIDTH, BASE_HEIGHT));
        assert_near(brightest(&out), (640, 360), 12);
    }

    #[test]
    fn a_too_wide_capture_is_cropped_from_both_sides() {
        // Ultrawide: the game renders 16:9 in the middle with pillarboxes, so the
        // excess width has to come off symmetrically or every ROI shifts.
        let (w, h) = (2560u32, 1080u32);
        let mut img = textured(w, h);
        // Centre of the source is also the centre of the intended viewport.
        mark(&mut img, w / 2, h / 2);
        let out = normalize_gray(&img);

        assert_eq!((out.width(), out.height()), (BASE_WIDTH, BASE_HEIGHT));
        // Left-anchored cropping would put this at x=853 instead of x=640.
        assert_near(brightest(&out), (BASE_WIDTH / 2, BASE_HEIGHT / 2), 12);
    }

    #[test]
    fn a_too_tall_capture_is_cropped_from_the_bottom_only() {
        // Deliberately NOT centred, unlike the width case. `detect_title_bar_height`
        // already consumes any flat band above the game (window chrome and the
        // upper letterbox alike), so by the time this runs the content starts at
        // the game's own top edge and all remaining excess is below it.
        let (w, h) = (1276u32, 900u32);
        assert!(
            (w as f64 / h as f64) < GAME_ASPECT_RATIO,
            "fixture must actually be too tall"
        );

        let mut img = textured(w, h);
        mark(&mut img, w / 2, 100);
        let out = normalize_gray(&img);

        let kept = (w as f64 / GAME_ASPECT_RATIO).floor() as u32;
        let expected_y = 100 * BASE_HEIGHT / kept;
        // Vertically centring the crop would instead put this near y=9.
        assert_near(brightest(&out), (BASE_WIDTH / 2, expected_y), 12);
    }

    #[test]
    fn title_bar_is_removed_before_the_aspect_crop() {
        // The real windowed fixture: 1276x754 is 1.69, but once a ~37px title bar
        // goes it is essentially 16:9. Cropping for aspect first would throw away
        // a slice of the game instead.
        let bar_height = 37;
        let img = windowed_with_title_bar(200, bar_height);
        assert_eq!(detect_title_bar_height(&img), bar_height);

        let out = normalize_gray(&img);
        assert_eq!((out.width(), out.height()), (BASE_WIDTH, BASE_HEIGHT));
        // The flat title-bar brightness must not survive as a whole first row.
        let first_row: Vec<u8> = (0..BASE_WIDTH).map(|x| out.get_pixel(x, 0)[0]).collect();
        assert!(
            first_row.iter().any(|&v| v != 200),
            "title bar leaked into the normalized canvas"
        );
    }
}

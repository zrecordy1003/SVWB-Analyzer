//! Node addon exposing the SVWB template matcher.
//!
//! Built with N-API (via napi-rs) rather than node-gyp/nan, so the compiled
//! `.node` stays ABI-compatible across Node and Electron upgrades and never
//! needs rebuilding on a user's machine.
//!
//! Shape of the API mirrors how the analyzer actually works: one frame is
//! loaded per tick, then matched against many small fixed regions. The frame
//! (and its integral images) therefore lives in Rust for the duration of the
//! tick, so pixel buffers never cross the FFI boundary repeatedly.

use std::collections::HashMap;
use std::sync::{LazyLock, RwLock};

use image::{ImageEncoder, codecs::png::PngEncoder};
use napi::bindgen_prelude::*;
use napi_derive::napi;
use svwb_vision_native::{
    GrayImage, Integral, Rect, Template, downscale, match_best, normalize_gray, to_gray_opencv,
};

/// Scales every template set is prepared at. Callers pick one per search: 1 for
/// small icons, a coarser factor for the few sets with large templates, where
/// the cost saving is large and the score impact negligible.
const SCALES: [u32; 3] = [1, 2, 4];

fn scale_index(scale: u32) -> Option<usize> {
    SCALES.iter().position(|s| *s == scale)
}

/// Templates are loaded once at startup and only ever read afterwards.
/// Keyed by category, holding one prepared set per entry in `SCALES`.
static TEMPLATES: LazyLock<RwLock<HashMap<String, Vec<Vec<Template>>>>> =
    LazyLock::new(|| RwLock::new(HashMap::new()));

/// A search window on the normalized 1280x720 canvas.
#[napi(object)]
pub struct Roi {
    pub x: u32,
    pub y: u32,
    pub w: u32,
    pub h: u32,
}

/// Best-scoring template within a search window.
#[napi(object)]
pub struct Hit {
    pub name: String,
    pub score: f64,
    /// Where the match landed, in normalized canvas coordinates. Useful for
    /// re-calibrating regions; the analyzer itself only needs `score`.
    pub x: u32,
    pub y: u32,
}

/// Load every `<root>/<category>/*.png` directory into memory, keyed by the
/// directory name. Replaces any previously loaded set. Returns the number of
/// templates loaded across all categories.
#[napi]
pub fn init_templates(root_dir: String) -> Result<u32> {
    let root = std::path::Path::new(&root_dir);
    let entries = std::fs::read_dir(root)
        .map_err(|e| Error::from_reason(format!("cannot read {root_dir}: {e}")))?;

    let mut loaded: HashMap<String, Vec<Vec<Template>>> = HashMap::new();
    let mut total = 0u32;

    for entry in entries.flatten() {
        let path = entry.path();
        if !path.is_dir() {
            continue;
        }
        let Some(category) = path.file_name().and_then(|s| s.to_str()) else {
            continue;
        };

        let files = std::fs::read_dir(&path)
            .map_err(|e| Error::from_reason(format!("cannot read {}: {e}", path.display())))?;
        let mut paths: Vec<std::path::PathBuf> = files
            .flatten()
            .map(|f| f.path())
            .filter(|p| p.extension().and_then(|e| e.to_str()) == Some("png"))
            .collect();
        // Stable order keeps tie-breaking between equal scores deterministic.
        paths.sort();

        let mut grays = Vec::new();
        for file in paths {
            let name = file
                .file_stem()
                .and_then(|s| s.to_str())
                .unwrap_or_default()
                .to_string();
            let decoded = image::open(&file).map_err(|e| {
                Error::from_reason(format!("cannot decode {}: {e}", file.display()))
            })?;
            grays.push((name, to_gray_opencv(&decoded)));
        }

        if !grays.is_empty() {
            total += grays.len() as u32;
            // One prepared set per scale, so a coarse search costs nothing extra
            // at match time.
            let per_scale = SCALES
                .iter()
                .map(|&s| {
                    grays
                        .iter()
                        .map(|(name, gray)| Template::new(name.clone(), &downscale(gray, s)))
                        .collect()
                })
                .collect();
            loaded.insert(category.to_string(), per_scale);
        }
    }

    let mut guard = TEMPLATES
        .write()
        .map_err(|_| Error::from_reason("template store poisoned"))?;
    *guard = loaded;
    Ok(total)
}

/// One normalized frame, plus the integral images every window lookup reuses,
/// held at each supported scale.
#[napi]
pub struct Frame {
    /// Grayscale canvas per entry in `SCALES`; index 0 is full resolution.
    levels: Vec<GrayImage>,
    integrals: Vec<Integral>,
}

#[napi]
impl Frame {
    /// Decode an image from disk, convert to grayscale, strip any title bar,
    /// crop to the game viewport and scale to the 1280x720 working canvas.
    #[napi(factory)]
    pub fn load(image_path: String) -> Result<Frame> {
        let decoded = image::open(&image_path)
            .map_err(|e| Error::from_reason(format!("cannot decode {image_path}: {e}")))?;
        let full = normalize_gray(&to_gray_opencv(&decoded));
        // Building the coarse levels up front costs about a millisecond and lets
        // any search pick its scale without extra work per call.
        let levels: Vec<GrayImage> = SCALES.iter().map(|&s| downscale(&full, s)).collect();
        let integrals = levels.iter().map(Integral::new).collect();
        Ok(Frame { levels, integrals })
    }

    #[napi(getter)]
    pub fn width(&self) -> u32 {
        self.levels[0].width()
    }

    #[napi(getter)]
    pub fn height(&self) -> u32 {
        self.levels[0].height()
    }

    /// Release the large per-frame pixel and integral buffers immediately.
    ///
    /// N-API objects normally wait for V8's garbage collector before their
    /// Rust fields are dropped. A new frame is created on every analyzer tick,
    /// so waiting for a GC cycle creates multi-gigabyte allocation spikes.
    /// The TypeScript owner calls this exactly once from a `finally` block.
    #[napi]
    pub fn dispose(&mut self) {
        self.levels.clear();
        self.integrals.clear();
    }

    /// Highest-scoring template of `template_set` within `roi`.
    ///
    /// `scale` searches a downscaled copy of the frame against equally
    /// downscaled templates: 1 (default) is full resolution, 2 and 4 trade a
    /// little precision for a large cost reduction on big templates. The
    /// returned position is always in full-resolution canvas coordinates.
    ///
    /// Returns `null` when the category is unknown or every template in it is
    /// larger than the search window, matching the "no detection" case the
    /// caller already handles.
    #[napi]
    pub fn match_best(
        &self,
        template_set: String,
        roi: Roi,
        scale: Option<u32>,
    ) -> Result<Option<Hit>> {
        self.check_roi(&roi)?;
        let scale = scale.unwrap_or(1);
        let Some(level) = scale_index(scale) else {
            return Err(Error::from_reason(format!(
                "unsupported scale {scale}, expected one of {SCALES:?}"
            )));
        };

        let guard = TEMPLATES
            .read()
            .map_err(|_| Error::from_reason("template store poisoned"))?;
        let Some(per_scale) = guard.get(&template_set) else {
            return Ok(None);
        };

        // Shrink the window to match, keeping at least one pixel in each axis.
        let rect = Rect::new(
            roi.x / scale,
            roi.y / scale,
            (roi.w / scale).max(1),
            (roi.h / scale).max(1),
        );
        Ok(
            match_best(&self.levels[level], &self.integrals[level], rect, &per_scale[level]).map(
                |m| Hit {
                    name: m.name,
                    score: m.score,
                    x: m.x * scale,
                    y: m.y * scale,
                },
            ),
        )
    }

    /// PNG-encode the normalized canvas as-is.
    ///
    /// Diagnostic only: this is what every ROI is measured against, so being
    /// able to look at it is how you tell a mis-detected title bar or a wrong
    /// letterbox crop from a genuinely absent element.
    #[napi]
    pub fn normalized_to_png(&self) -> Result<Buffer> {
        let gray = &self.levels[0];
        let mut encoded = Vec::new();
        PngEncoder::new(&mut encoded)
            .write_image(
                gray.as_raw(),
                gray.width(),
                gray.height(),
                image::ExtendedColorType::L8,
            )
            .map_err(|e| Error::from_reason(format!("png encode failed: {e}")))?;
        Ok(Buffer::from(encoded))
    }

    /// Crop `roi`, apply a binary threshold and PNG-encode it, ready to hand
    /// straight to the OCR worker.
    #[napi]
    pub fn binarize_roi_to_png(&self, roi: Roi, threshold: u8) -> Result<Buffer> {
        self.check_roi(&roi)?;

        let mut out = GrayImage::new(roi.w, roi.h);
        for y in 0..roi.h {
            for x in 0..roi.w {
                let v = self.levels[0].get_pixel(roi.x + x, roi.y + y)[0];
                out.put_pixel(x, y, image::Luma([if v > threshold { 255 } else { 0 }]));
            }
        }

        let mut encoded = Vec::new();
        PngEncoder::new(&mut encoded)
            .write_image(out.as_raw(), roi.w, roi.h, image::ExtendedColorType::L8)
            .map_err(|e| Error::from_reason(format!("png encode failed: {e}")))?;
        Ok(Buffer::from(encoded))
    }

    /// Reject out-of-bounds regions here so a bad ROI surfaces as a JS
    /// exception instead of panicking across the FFI boundary.
    fn check_roi(&self, roi: &Roi) -> Result<()> {
        if roi.w == 0 || roi.h == 0 {
            return Err(Error::from_reason("roi has zero width or height"));
        }
        if roi.x + roi.w > self.levels[0].width() || roi.y + roi.h > self.levels[0].height() {
            return Err(Error::from_reason(format!(
                "roi {},{},{},{} exceeds frame {}x{}",
                roi.x,
                roi.y,
                roi.w,
                roi.h,
                self.levels[0].width(),
                self.levels[0].height()
            )));
        }
        Ok(())
    }
}

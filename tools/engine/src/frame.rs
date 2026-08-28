//! One normalised frame, ready to be probed.
//!
//! Grayscale conversion, title-bar detection, viewport crop and the scale to the
//! fixed 1280x720 canvas all live in `svwb-vision-native`, which reproduces
//! OpenCV's BGR2GRAY weights and INTER_LINEAR sampling so existing thresholds
//! keep their meaning.
//!
//! The one difference from the Node addon's equivalent: this takes a decoded
//! image rather than a path. That is the whole point of the seam - once nothing
//! downstream needs a file, live capture can hand over the bitmap it already has
//! instead of PNG-encoding it to disk for another process to decode again.

use image::DynamicImage;
use image::ImageEncoder;
use svwb_vision_native::{GrayImage, Integral, Rect, downscale, normalize_gray, to_gray_opencv};

use crate::templates::SCALES;

/// Normalised canvas and integral images, one per entry in [`SCALES`].
///
/// Holds roughly 20 MB of buffers. One is built per tick and dropped at the end
/// of it - the JS version needed an explicit `dispose()` in a `finally` block
/// because waiting for V8's GC produced multi-gigabyte allocation spikes that
/// starved the renderer. Here the scope is the lifetime, so there is nothing to
/// forget to call.
pub struct Frame {
    pub(crate) levels: Vec<GrayImage>,
    pub(crate) integrals: Vec<Integral>,
}

impl Frame {
    /// Normalise a decoded image and build every level up front.
    ///
    /// Preparing the coarse levels eagerly costs about a millisecond and lets
    /// any search pick its scale with no extra work per call.
    pub fn from_image(decoded: &DynamicImage) -> Self {
        let full = normalize_gray(&to_gray_opencv(decoded));
        let levels: Vec<GrayImage> = SCALES.iter().map(|&s| downscale(&full, s)).collect();
        let integrals = levels.iter().map(Integral::new).collect();
        Self { levels, integrals }
    }

    pub fn width(&self) -> u32 {
        self.levels[0].width()
    }

    pub fn height(&self) -> u32 {
        self.levels[0].height()
    }

    /// PNG-encode the normalised canvas as-is.
    ///
    /// Diagnostic only. This is what every window is measured against, so being
    /// able to look at it is how you tell a mis-detected title bar or a wrong
    /// letterbox crop from a genuinely absent element. It is also less revealing
    /// than the raw colour screenshot.
    pub fn normalised_to_png(&self) -> Option<Vec<u8>> {
        let gray = &self.levels[0];
        let mut encoded = Vec::new();
        image::codecs::png::PngEncoder::new(&mut encoded)
            .write_image(
                gray.as_raw(),
                gray.width(),
                gray.height(),
                image::ExtendedColorType::L8,
            )
            .ok()?;
        Some(encoded)
    }

    /// Crop `window`, apply a binary threshold and PNG-encode it.
    ///
    /// This is what a recogniser outside this process is given: a few hundred
    /// bytes rather than the whole 1280x720 canvas. It is also what the shipped
    /// OCR path already feeds Tesseract, so a host-side reader sees exactly the
    /// pixels the current implementation sees - the comparison between them is
    /// then about recognition, not about preprocessing.
    ///
    /// `None` for a window outside the canvas: that is a calibration bug, and it
    /// must not be silently croppable to something that reads as a miss.
    pub fn binarize_to_png(&self, window: Rect, threshold: u8) -> Option<Vec<u8>> {
        if !self.contains(window) {
            return None;
        }
        let source = &self.levels[0];
        let mut cropped = GrayImage::new(window.w, window.h);
        for y in 0..window.h {
            for x in 0..window.w {
                let value = source.get_pixel(window.x + x, window.y + y)[0];
                cropped.put_pixel(x, y, image::Luma([if value > threshold { 255 } else { 0 }]));
            }
        }

        let mut encoded = Vec::new();
        image::codecs::png::PngEncoder::new(&mut encoded)
            .write_image(cropped.as_raw(), window.w, window.h, image::ExtendedColorType::L8)
            .ok()?;
        Some(encoded)
    }

    /// Crop `window` out of the canvas unchanged, as a PNG.
    ///
    /// The template-cutting counterpart to [`Self::binarize_to_png`]: templates
    /// are matched against grey pixels, so they must be cut as grey pixels. Same
    /// `None` contract - a window outside the canvas is a bug, not a miss.
    pub fn crop_to_png(&self, window: Rect) -> Option<Vec<u8>> {
        if !self.contains(window) {
            return None;
        }
        let source = &self.levels[0];
        let mut cropped = GrayImage::new(window.w, window.h);
        for y in 0..window.h {
            for x in 0..window.w {
                cropped.put_pixel(x, y, *source.get_pixel(window.x + x, window.y + y));
            }
        }

        let mut encoded = Vec::new();
        image::codecs::png::PngEncoder::new(&mut encoded)
            .write_image(cropped.as_raw(), window.w, window.h, image::ExtendedColorType::L8)
            .ok()?;
        Some(encoded)
    }

    /// Whether a search window lies inside the canvas.
    ///
    /// A window that does not is a calibration bug, not a missed detection, and
    /// the two must not look alike to the caller: returning "no hit" for an
    /// out-of-bounds window is how a mis-shifted OCR window would go unnoticed.
    pub fn contains(&self, window: Rect) -> bool {
        window.w > 0
            && window.h > 0
            && window.x + window.w <= self.width()
            && window.y + window.h <= self.height()
    }
}

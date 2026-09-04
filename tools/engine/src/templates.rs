//! The template store: every `resources/templates/<set>/*.png`, decoded once and
//! prepared at each supported scale.
//!
//! Owned as a plain value and passed to whoever needs it. The Node addon had to
//! keep the equivalent in a `static RwLock<HashMap<..>>` because napi entry
//! points are free functions with nowhere to hang state; nothing here is a free
//! function, so nothing here needs a global.
//!
//! The store also decides the scale, rather than accepting one from the caller.
//! `match()` in `visionNative.ts` took `scale = SCALE[templateSet] ?? 1` as a
//! defaulted argument, which left every call site able to pass a scale the set
//! was never verified at. A set has exactly one verified scale, so it is a
//! property of the set.

use std::collections::HashMap;
use std::path::Path;

use svwb_vision_native::{MatchResult, Template, downscale, match_best, to_gray_opencv};

use crate::calibration::downscale_factor_for;
use crate::frame::Frame;

/// Scales every set is prepared at, so a search never rescales at match time.
/// Index 0 is full resolution.
pub const SCALES: [u32; 3] = [1, 2, 4];

/// Best-scoring template within a search window, in full-resolution canvas
/// coordinates regardless of the scale the search actually ran at.
pub type Hit = MatchResult;

fn level_of(scale: u32) -> Option<usize> {
    SCALES.iter().position(|s| *s == scale)
}

#[derive(Debug)]
pub enum LoadError {
    ReadDir { path: String, cause: String },
    Decode { path: String, cause: String },
}

impl std::fmt::Display for LoadError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            LoadError::ReadDir { path, cause } => write!(f, "cannot read {path}: {cause}"),
            LoadError::Decode { path, cause } => write!(f, "cannot decode {path}: {cause}"),
        }
    }
}

/// One set, prepared at every entry in [`SCALES`].
struct PreparedSet {
    /// Verified scale for this set, from [`downscale_factor_for`].
    scale: u32,
    per_scale: Vec<Vec<Template>>,
}

pub struct TemplateStore {
    sets: HashMap<String, PreparedSet>,
}

impl TemplateStore {
    /// Load every `<root>/<set>/*.png`, keyed by directory name.
    pub fn load(root: &Path) -> Result<Self, LoadError> {
        let entries = std::fs::read_dir(root).map_err(|e| LoadError::ReadDir {
            path: root.display().to_string(),
            cause: e.to_string(),
        })?;

        let mut sets = HashMap::new();
        for entry in entries.flatten() {
            let dir = entry.path();
            if !dir.is_dir() {
                continue;
            }
            let Some(name) = dir.file_name().and_then(|s| s.to_str()) else {
                continue;
            };

            let listing = std::fs::read_dir(&dir).map_err(|e| LoadError::ReadDir {
                path: dir.display().to_string(),
                cause: e.to_string(),
            })?;
            let mut files: Vec<_> = listing
                .flatten()
                .map(|f| f.path())
                .filter(|p| p.extension().and_then(|e| e.to_str()) == Some("png"))
                .collect();
            // Stable order keeps tie-breaking between equal scores deterministic.
            files.sort();

            let mut grays = Vec::new();
            for file in files {
                let label = file
                    .file_stem()
                    .and_then(|s| s.to_str())
                    .unwrap_or_default()
                    .to_string();
                let decoded = image::open(&file).map_err(|e| LoadError::Decode {
                    path: file.display().to_string(),
                    cause: e.to_string(),
                })?;
                grays.push((label, to_gray_opencv(&decoded)));
            }
            if grays.is_empty() {
                continue;
            }

            let per_scale = SCALES
                .iter()
                .map(|&s| {
                    grays
                        .iter()
                        .map(|(label, gray)| Template::new(label.clone(), &downscale(gray, s)))
                        .collect()
                })
                .collect();

            sets.insert(
                name.to_string(),
                PreparedSet { scale: downscale_factor_for(name), per_scale },
            );
        }

        Ok(Self { sets })
    }

    pub fn len(&self) -> usize {
        self.sets.values().map(|s| s.per_scale[0].len()).sum()
    }

    pub fn is_empty(&self) -> bool {
        self.sets.is_empty()
    }

    /// Highest-scoring template of `set` within `window`.
    ///
    /// `None` means "no detection", the case every caller already handles: an
    /// unknown set name, or every template in it being larger than the window.
    /// An out-of-bounds window is a programming error rather than a miss, so it
    /// is caught by [`Frame::contains`] before reaching here.
    pub fn best_in(&self, frame: &Frame, set: &str, window: svwb_vision_native::Rect) -> Option<Hit> {
        let prepared = self.sets.get(set)?;
        let level = level_of(prepared.scale)?;
        let scale = prepared.scale;

        // Shrink the window to match the level, keeping at least one pixel per axis.
        let scaled = svwb_vision_native::Rect::new(
            window.x / scale,
            window.y / scale,
            (window.w / scale).max(1),
            (window.h / scale).max(1),
        );

        match_best(
            &frame.levels[level],
            &frame.integrals[level],
            scaled,
            &prepared.per_scale[level],
        )
        .map(|m| Hit { name: m.name, score: m.score, x: m.x * scale, y: m.y * scale })
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn every_supported_scale_has_a_level() {
        for s in SCALES {
            assert!(level_of(s).is_some(), "scale {s} has no prepared level");
        }
        assert!(level_of(3).is_none(), "3 is not a supported scale");
    }

    /// The scale a set ships at must be one the store actually prepares,
    /// otherwise `best_in` silently returns None for that whole set.
    #[test]
    fn calibrated_scales_are_all_supported() {
        use crate::calibration::templates as t;
        for set in [
            t::CLASSES, t::EMBLEMS, t::PLAY_ORDER, t::RESULT, t::RESULT_MID,
            t::MODES_CPU, t::MODES_2PICK, t::MODES_PLAZA, t::CURSOR,
            t::CUSTOM, t::HISTORY, t::REPLAY_CHROME, t::SCORE_SYSTEM, t::MP_GAIN,
        ] {
            let scale = downscale_factor_for(set);
            assert!(level_of(scale).is_some(), "{set} wants unsupported scale {scale}");
        }
    }
}

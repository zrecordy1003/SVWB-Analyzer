//! Live capture: the game window, straight into memory.
//!
//! This is what plan P3 exists for. The old pipeline had two Rust programs in
//! the same workspace passing a bitmap to each other via PNG-encode -> write ->
//! rename -> read -> PNG-decode, with a JS process in the middle - the system's
//! single largest fixed cost, and unfixable by tuning. Here the frame goes from
//! Windows Graphics Capture into [`Frame::from_image`] without touching disk.
//!
//! # Shape
//!
//! WGC delivers frames on its own thread via `start_free_threaded`; the handler
//! writes each one into a shared single-frame slot, and [`CaptureSource`] takes
//! the latest on each tick. A slot rather than a queue on purpose: the analyzer
//! wants the NEWEST frame, and a queue behind a slow tick would have it reading
//! progressively staler screens - the same reason the old capture tool
//! overwrote one file instead of numbering them.
//!
//! # Who owns the HWND
//!
//! The host. Window detection is `node-window-manager`, an Electron binding
//! (decision A-6), and it already knows when the game minimises - which matters
//! because WGC cannot capture a minimised window. So the host sends `attach` /
//! `detach` and the engine owns everything after the handle, replacing the old
//! arrangement where the host spawned and killed a whole capture process.

#![cfg(windows)]

use std::sync::{Arc, Condvar, Mutex};
use std::time::Instant;

use windows_capture::graphics_capture_api::GraphicsCaptureApi;
use windows_capture::settings::{
    CursorCaptureSettings, DrawBorderSettings, MinimumUpdateIntervalSettings,
    SecondaryWindowSettings,
};

use svwb_vision_native::{GrayImage, bgra_to_gray_opencv};

use crate::calibration::timing;
use crate::frame::Frame;
use crate::frame_source::{FrameError, FrameSource, SourceControl, TimedFrame};

#[derive(Debug, Eq, PartialEq)]
struct OptionalCaptureSettings {
    cursor: CursorCaptureSettings,
    border: DrawBorderSettings,
    secondary_windows: SecondaryWindowSettings,
    minimum_update_interval: MinimumUpdateIntervalSettings,
}

fn optional_settings_for_support(
    cursor: bool,
    border: bool,
    secondary_windows: bool,
    minimum_update_interval: bool,
) -> OptionalCaptureSettings {
    OptionalCaptureSettings {
        cursor: if cursor {
            CursorCaptureSettings::WithoutCursor
        } else {
            CursorCaptureSettings::Default
        },
        border: if border {
            DrawBorderSettings::WithoutBorder
        } else {
            DrawBorderSettings::Default
        },
        secondary_windows: if secondary_windows {
            SecondaryWindowSettings::Exclude
        } else {
            SecondaryWindowSettings::Default
        },
        minimum_update_interval: if minimum_update_interval {
            MinimumUpdateIntervalSettings::Custom(timing::TICK)
        } else {
            MinimumUpdateIntervalSettings::Default
        },
    }
}

fn optional_settings_for_platform() -> OptionalCaptureSettings {
    optional_settings_for_support(
        GraphicsCaptureApi::is_cursor_settings_supported().unwrap_or(false),
        GraphicsCaptureApi::is_border_settings_supported().unwrap_or(false),
        GraphicsCaptureApi::is_secondary_windows_supported().unwrap_or(false),
        GraphicsCaptureApi::is_minimum_update_interval_supported().unwrap_or(false),
    )
}

/// One captured frame exactly as WGC delivered it: tightly packed BGRA rows.
#[derive(Default)]
struct Bgra {
    width: u32,
    height: u32,
    pixels: Vec<u8>,
}

/// The newest captured frame, plus a sequence number so a reader can tell
/// "new frame" from "the one I already took". Sequence 0 means none yet.
#[derive(Default)]
struct Slot {
    latest: Bgra,
    sequence: u64,
    /// Set by `on_closed`: the window is gone and no more frames will come.
    closed: bool,
}

struct Shared {
    slot: Mutex<Slot>,
    arrived: Condvar,
}

/// Receives WGC frames and publishes the latest into the slot.
///
/// This runs for EVERY frame the window produces - up to the game's frame rate
/// where the OS cannot throttle delivery (`MinimumUpdateInterval` needs Windows
/// 11 24H2) - while a tick takes one every 500ms. So it does the least it can:
/// one copy of the rows into a buffer it owns, then a swap with the slot. The
/// colour work waits until a tick actually takes the frame. Measured at
/// 2560x1440 with delivery unthrottled, the old per-frame BGRA-to-RGBA swap into
/// a fresh allocation cost 280ms of CPU every second.
struct SlotWriter {
    shared: Arc<Shared>,
    /// The buffer being filled. Swapped with the slot's rather than copied, so
    /// after the first frame neither side allocates.
    back: Bgra,
}

impl windows_capture::capture::GraphicsCaptureApiHandler for SlotWriter {
    type Flags = Arc<Shared>;
    type Error = Box<dyn std::error::Error + Send + Sync>;

    fn new(ctx: windows_capture::capture::Context<Self::Flags>) -> Result<Self, Self::Error> {
        Ok(Self {
            shared: ctx.flags,
            back: Bgra::default(),
        })
    }

    fn on_frame_arrived(
        &mut self,
        frame: &mut windows_capture::frame::Frame,
        _control: windows_capture::graphics_capture_api::InternalCaptureControl,
    ) -> Result<(), Self::Error> {
        let mut buffer = frame.buffer()?;
        let (width, height) = (buffer.width(), buffer.height());
        let pitch = buffer.row_pitch() as usize;
        let row = width as usize * 4;
        let raw = buffer.as_raw_buffer();
        if height == 0 || pitch < row || raw.len() < pitch * (height as usize - 1) + row {
            return Ok(()); // a torn frame is skipped, not fatal
        }

        // Rows only: the mapped texture pads each one out to `pitch`. The
        // resize is a no-op after the first frame of a given size.
        self.back.pixels.resize(row * height as usize, 0);
        for (dst, src) in self.back.pixels.chunks_exact_mut(row).zip(raw.chunks(pitch)) {
            dst.copy_from_slice(&src[..row]);
        }
        self.back.width = width;
        self.back.height = height;

        let mut slot = self.shared.slot.lock().unwrap();
        std::mem::swap(&mut slot.latest, &mut self.back);
        slot.sequence += 1;
        drop(slot);
        self.shared.arrived.notify_all();
        Ok(())
    }

    fn on_closed(&mut self) -> Result<(), Self::Error> {
        self.shared.slot.lock().unwrap().closed = true;
        self.shared.arrived.notify_all();
        Ok(())
    }
}

type Control =
    windows_capture::capture::CaptureControl<SlotWriter, Box<dyn std::error::Error + Send + Sync>>;

/// A [`FrameSource`] over live Windows Graphics Capture.
///
/// Starts idle. Frames flow only between an `Attach` and the next `Detach` (or
/// the window closing); while idle, `next_frame` reports [`FrameError::NotReady`]
/// and the live loop simply keeps polling for commands.
pub struct CaptureSource {
    session: Option<(u64, Control, Arc<Shared>)>,
    /// Sequence number `gray` was converted from; 0 for none.
    last_taken: u64,
    /// The last frame taken, already converted, for the ticks that find no
    /// newer one - see `next_frame`.
    gray: Option<GrayImage>,
}

impl CaptureSource {
    pub fn new() -> Self {
        Self {
            session: None,
            last_taken: 0,
            gray: None,
        }
    }

    fn detach(&mut self) {
        if let Some((_, control, _)) = self.session.take() {
            // A failed stop means the capture thread is already gone, which is
            // the outcome we wanted.
            let _ = control.stop();
        }
        self.last_taken = 0;
        self.gray = None;
    }

    fn attach(&mut self, hwnd: u64) -> Result<(), String> {
        // Idempotent, as the protocol promises: the host polls every second and
        // re-sends attach on each pass; restarting the WGC session each time
        // would drop frames on every poll.
        if let Some((current, _, shared)) = &self.session {
            if *current == hwnd && !shared.slot.lock().unwrap().closed {
                return Ok(());
            }
        }
        self.detach();

        let window = windows_capture::window::Window::from_raw_hwnd(hwnd as *mut std::ffi::c_void);
        if !window.is_valid() {
            return Err("the supplied HWND is not a capturable top-level window".into());
        }

        let shared = Arc::new(Shared {
            slot: Mutex::new(Slot::default()),
            arrived: Condvar::new(),
        });
        // Cursor, border, secondary-window and OS-side interval controls were
        // introduced in different Windows releases. Passing a non-default
        // value for an absent property makes windows-capture reject the whole
        // session, so each preference is applied only when this OS advertises
        // it. Frame cadence is still enforced by the single-frame slot and the
        // analyzer tick on older systems.
        let optional = optional_settings_for_platform();
        let settings = windows_capture::settings::Settings::new(
            window,
            // The cursor can sit on the numbers being read; the cursor PROBE
            // exists for the frames where the user parks it there anyway.
            optional.cursor,
            optional.border,
            optional.secondary_windows,
            optional.minimum_update_interval,
            windows_capture::settings::DirtyRegionSettings::Default,
            windows_capture::settings::ColorFormat::Bgra8,
            Arc::clone(&shared),
        );

        let control =
            windows_capture::capture::GraphicsCaptureApiHandler::start_free_threaded(settings)
                .map_err(|e| format!("cannot start capture: {e}"))?;
        self.session = Some((hwnd, control, shared));
        Ok(())
    }
}

impl Default for CaptureSource {
    fn default() -> Self {
        Self::new()
    }
}

impl FrameSource for CaptureSource {
    fn next_frame(&mut self) -> Result<TimedFrame, FrameError> {
        let Some((_, _, shared)) = &self.session else {
            return Err(FrameError::NotReady);
        };

        let slot = shared.slot.lock().unwrap();
        if slot.closed {
            // The game window is gone. Not `Exhausted` - the engine stays up and
            // the host re-attaches when the game comes back; ending the run here
            // would take the state machine's open match down with it.
            drop(slot);
            self.detach();
            return Err(FrameError::NotReady);
        }
        if slot.sequence == 0 {
            return Err(FrameError::NotReady);
        }
        // Keep rather than take, and NO freshness check, on purpose.
        //
        // WGC only delivers a frame when the window's content changes, so a
        // static screen stops the stream. The old pipeline re-read the same PNG
        // on every tick regardless, and the consensus rules were built on that:
        // a static BP value settles by being read on several ticks of the SAME
        // unchanged screen. Handing out each frame once would make "the screen
        // stopped animating" indistinguishable from "the screen went away", and
        // quietly starve every Tally-based agreement. So an unchanged sequence
        // hands out the same frame again, from the grey kept last time - which
        // also spares a static screen the conversion.
        if slot.sequence != self.last_taken || self.gray.is_none() {
            let latest = &slot.latest;
            let Some(gray) = bgra_to_gray_opencv(latest.width, latest.height, &latest.pixels)
            else {
                return Err(FrameError::NotReady);
            };
            self.gray = Some(gray);
            self.last_taken = slot.sequence;
        }
        drop(slot);

        Ok(TimedFrame {
            frame: Frame::from_gray(self.gray.as_ref().expect("converted above")),
            at: Instant::now(),
        })
    }

    fn describe(&self) -> String {
        match &self.session {
            Some(_) => "wgc:attached".into(),
            None => "wgc:idle".into(),
        }
    }

    fn control(&mut self, request: SourceControl) -> Result<(), String> {
        match request {
            SourceControl::Attach { hwnd } => self.attach(hwnd),
            SourceControl::Detach => {
                self.detach();
                Ok(())
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn unsupported_optional_capture_features_fall_back_to_defaults() {
        assert_eq!(
            optional_settings_for_support(false, false, false, false),
            OptionalCaptureSettings {
                cursor: CursorCaptureSettings::Default,
                border: DrawBorderSettings::Default,
                secondary_windows: SecondaryWindowSettings::Default,
                minimum_update_interval: MinimumUpdateIntervalSettings::Default,
            }
        );
    }

    #[test]
    fn supported_optional_capture_features_keep_the_preferred_behavior() {
        assert_eq!(
            optional_settings_for_support(true, true, true, true),
            OptionalCaptureSettings {
                cursor: CursorCaptureSettings::WithoutCursor,
                border: DrawBorderSettings::WithoutBorder,
                secondary_windows: SecondaryWindowSettings::Exclude,
                minimum_update_interval: MinimumUpdateIntervalSettings::Custom(timing::TICK),
            }
        );
    }
}

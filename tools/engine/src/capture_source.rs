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

use crate::calibration::timing;
use crate::frame::Frame;
use crate::frame_source::{FrameError, FrameSource, SourceControl, TimedFrame};

/// The newest captured frame, plus a sequence number so a reader can tell
/// "new frame" from "the one I already took".
#[derive(Default)]
struct Slot {
    image: Option<image::DynamicImage>,
    sequence: u64,
    /// Set by `on_closed`: the window is gone and no more frames will come.
    closed: bool,
}

struct Shared {
    slot: Mutex<Slot>,
    arrived: Condvar,
}

/// Receives WGC frames and publishes the latest into the slot.
struct SlotWriter {
    shared: Arc<Shared>,
    scratch: Vec<u8>,
}

impl windows_capture::capture::GraphicsCaptureApiHandler for SlotWriter {
    type Flags = Arc<Shared>;
    type Error = Box<dyn std::error::Error + Send + Sync>;

    fn new(
        ctx: windows_capture::capture::Context<Self::Flags>,
    ) -> Result<Self, Self::Error> {
        Ok(Self { shared: ctx.flags, scratch: Vec::new() })
    }

    fn on_frame_arrived(
        &mut self,
        frame: &mut windows_capture::frame::Frame,
        _control: windows_capture::graphics_capture_api::InternalCaptureControl,
    ) -> Result<(), Self::Error> {
        let width = frame.width();
        let height = frame.height();
        let mut buffer = frame.buffer()?;
        let bgra = buffer.as_nopadding_buffer(&mut self.scratch);

        // BGRA -> RGBA. The old tool wrote PNGs, which decode as RGB(A), so
        // every calibrated threshold was measured against that channel order -
        // handing BGRA through unswapped would silently shift the grayscale
        // weights and with them every score.
        let mut rgba = vec![0u8; bgra.len()];
        for (out, px) in rgba.chunks_exact_mut(4).zip(bgra.chunks_exact(4)) {
            out[0] = px[2];
            out[1] = px[1];
            out[2] = px[0];
            out[3] = px[3];
        }
        let Some(imag) = image::RgbaImage::from_raw(width, height, rgba) else {
            return Ok(()); // a torn frame is skipped, not fatal
        };

        let mut slot = self.shared.slot.lock().unwrap();
        slot.image = Some(image::DynamicImage::ImageRgba8(imag));
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

type Control = windows_capture::capture::CaptureControl<
    SlotWriter,
    Box<dyn std::error::Error + Send + Sync>,
>;

/// A [`FrameSource`] over live Windows Graphics Capture.
///
/// Starts idle. Frames flow only between an `Attach` and the next `Detach` (or
/// the window closing); while idle, `next_frame` reports [`FrameError::NotReady`]
/// and the live loop simply keeps polling for commands.
pub struct CaptureSource {
    session: Option<(u64, Control, Arc<Shared>)>,
    last_taken: u64,
}

impl CaptureSource {
    pub fn new() -> Self {
        Self { session: None, last_taken: 0 }
    }

    fn detach(&mut self) {
        if let Some((_, control, _)) = self.session.take() {
            // A failed stop means the capture thread is already gone, which is
            // the outcome we wanted.
            let _ = control.stop();
        }
        self.last_taken = 0;
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

        let window =
            windows_capture::window::Window::from_raw_hwnd(hwnd as *mut std::ffi::c_void);
        if !window.is_valid() {
            return Err("the supplied HWND is not a capturable top-level window".into());
        }

        let shared = Arc::new(Shared { slot: Mutex::new(Slot::default()), arrived: Condvar::new() });
        let settings = windows_capture::settings::Settings::new(
            window,
            // The cursor can sit on the numbers being read; the cursor PROBE
            // exists for the frames where the user parks it there anyway.
            windows_capture::settings::CursorCaptureSettings::WithoutCursor,
            windows_capture::settings::DrawBorderSettings::WithoutBorder,
            windows_capture::settings::SecondaryWindowSettings::Exclude,
            // WGC may deliver more; one per tick is all the analyzer reads.
            windows_capture::settings::MinimumUpdateIntervalSettings::Custom(timing::TICK),
            windows_capture::settings::DirtyRegionSettings::Default,
            windows_capture::settings::ColorFormat::Bgra8,
            Arc::clone(&shared),
        );

        let control = windows_capture::capture::GraphicsCaptureApiHandler::start_free_threaded(
            settings,
        )
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

        let mut slot = shared.slot.lock().unwrap();
        if slot.closed {
            // The game window is gone. Not `Exhausted` - the engine stays up and
            // the host re-attaches when the game comes back; ending the run here
            // would take the state machine's open match down with it.
            drop(slot);
            self.detach();
            return Err(FrameError::NotReady);
        }
        // Clone-and-keep rather than take, and NO freshness check, on purpose.
        //
        // WGC only delivers a frame when the window's content changes, so a
        // static screen stops the stream. The old pipeline re-read the same PNG
        // on every tick regardless, and the consensus rules were built on that:
        // a static BP value settles by being read on several ticks of the SAME
        // unchanged screen. Handing out each frame once would make "the screen
        // stopped animating" indistinguishable from "the screen went away", and
        // quietly starve every Tally-based agreement. The clone costs ~3.7MB
        // against the ~20MB the frame pipeline allocates per tick anyway.
        let Some(decoded) = slot.image.clone() else {
            return Err(FrameError::NotReady);
        };
        self.last_taken = slot.sequence;
        drop(slot);

        Ok(TimedFrame { frame: Frame::from_image(&decoded), at: Instant::now() })
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

use clap::Parser;
use serde::Serialize;
use std::path::PathBuf;

#[derive(Debug, Parser)]
#[command(name = "svwb-capture-tool", version, about = "Capture a Shadowverse: Worlds Beyond window")]
struct Cli {
    /// Verified Win32 window handle supplied by the Electron main process.
    #[arg(long)]
    hwnd: usize,

    /// PNG path consumed by the image analyzer.
    #[arg(long)]
    output: PathBuf,

    /// Minimum delay between saved frames. The capture API may deliver more frames.
    #[arg(long, default_value_t = 500, value_parser = clap::value_parser!(u64).range(50..))]
    interval_ms: u64,

    /// Include the cursor in captured frames. Disabled by default because it can obscure OCR.
    #[arg(long, default_value_t = false)]
    include_cursor: bool,
}

#[derive(Serialize)]
struct Status<'a> {
    event: &'a str,
    message: &'a str,
    output: Option<&'a str>,
}

fn emit_status(event: &str, message: &str, output: Option<&std::path::Path>) {
    let output = output.and_then(std::path::Path::to_str);
    let status = Status {
        event,
        message,
        output,
    };

    if let Ok(line) = serde_json::to_string(&status) {
        println!("{line}");
    }
}

#[cfg(not(windows))]
fn main() {
    let _ = Cli::parse();
    emit_status("error", "svwb-capture-tool can only run on Windows", None);
    std::process::exit(1);
}

#[cfg(windows)]
fn main() {
    if let Err(error) = native_capture::run(Cli::parse()) {
        emit_status("error", &error.to_string(), None);
        std::process::exit(1);
    }
}

#[cfg(windows)]
mod native_capture {
    use super::{emit_status, Cli};
    use std::error::Error;
    use std::ffi::c_void;
    use std::fs;
    use std::os::windows::ffi::OsStrExt;
    use std::path::{Path, PathBuf};
    use std::time::{Duration, Instant};
    use windows::core::PCWSTR;
    use windows::Win32::Storage::FileSystem::{
        MoveFileExW, MOVEFILE_REPLACE_EXISTING, MOVEFILE_WRITE_THROUGH,
    };
    use windows_capture::capture::{Context, GraphicsCaptureApiHandler};
    use windows_capture::encoder::ImageFormat;
    use windows_capture::frame::Frame;
    use windows_capture::graphics_capture_api::InternalCaptureControl;
    use windows_capture::settings::{
        ColorFormat, CursorCaptureSettings, DirtyRegionSettings, DrawBorderSettings,
        MinimumUpdateIntervalSettings, SecondaryWindowSettings, Settings,
    };
    use windows_capture::window::Window;

    type CaptureError = Box<dyn Error + Send + Sync>;

    struct CaptureConfig {
        output: PathBuf,
        temporary: PathBuf,
        interval: Duration,
    }

    struct FrameWriter {
        config: CaptureConfig,
        last_saved: Option<Instant>,
    }

    impl GraphicsCaptureApiHandler for FrameWriter {
        type Flags = CaptureConfig;
        type Error = CaptureError;

        fn new(ctx: Context<Self::Flags>) -> Result<Self, Self::Error> {
            emit_status("started", "capture session started", Some(&ctx.flags.output));
            Ok(Self {
                config: ctx.flags,
                last_saved: None,
            })
        }

        fn on_frame_arrived(
            &mut self,
            frame: &mut Frame,
            _capture_control: InternalCaptureControl,
        ) -> Result<(), Self::Error> {
            if self
                .last_saved
                .is_some_and(|saved_at| saved_at.elapsed() < self.config.interval)
            {
                return Ok(());
            }

            let save_result = (|| -> Result<(), CaptureError> {
                let temporary = self.config.temporary.to_str().ok_or("temporary path is not UTF-8")?;
                frame.save_as_image(temporary, ImageFormat::Png)?;
                replace_file_atomically(&self.config.temporary, &self.config.output)?;
                Ok(())
            })();

            match save_result {
                Ok(()) => {
                    self.last_saved = Some(Instant::now());
                    emit_status("frame_saved", "frame saved", Some(&self.config.output));
                }
                Err(error) => {
                    emit_status("frame_error", &error.to_string(), Some(&self.config.output));
                }
            }

            Ok(())
        }

        fn on_closed(&mut self) -> Result<(), Self::Error> {
            emit_status("window_closed", "capture target closed", Some(&self.config.output));
            Ok(())
        }
    }

    pub fn run(cli: Cli) -> Result<(), CaptureError> {
        let output_parent = cli.output.parent().ok_or("output path has no parent directory")?;
        fs::create_dir_all(output_parent)?;

        let window = Window::from_raw_hwnd(cli.hwnd as *mut c_void);
        if !window.is_valid() {
            return Err("the supplied HWND is not a capturable top-level window".into());
        }

        let config = CaptureConfig {
            temporary: temporary_path(&cli.output)?,
            output: cli.output,
            interval: Duration::from_millis(cli.interval_ms),
        };
        let cursor = if cli.include_cursor {
            CursorCaptureSettings::WithCursor
        } else {
            CursorCaptureSettings::WithoutCursor
        };
        let settings = Settings::new(
            window,
            cursor,
            DrawBorderSettings::WithoutBorder,
            SecondaryWindowSettings::Exclude,
            MinimumUpdateIntervalSettings::Custom(config.interval),
            DirtyRegionSettings::Default,
            ColorFormat::Bgra8,
            config,
        );

        FrameWriter::start(settings)?;
        Ok(())
    }

    fn temporary_path(output: &Path) -> Result<PathBuf, CaptureError> {
        let file_name = output.file_name().ok_or("output path has no file name")?;
        Ok(output.with_file_name(format!("{}.tmp.png", file_name.to_string_lossy())))
    }

    fn replace_file_atomically(from: &Path, to: &Path) -> Result<(), CaptureError> {
        let from = wide_path(from);
        let to = wide_path(to);
        let retry_delays = [
            Duration::from_millis(10),
            Duration::from_millis(25),
            Duration::from_millis(50),
        ];
        let mut last_error = None;

        for delay in retry_delays.into_iter().chain(std::iter::once(Duration::ZERO)) {
            match unsafe {
                MoveFileExW(
                    PCWSTR(from.as_ptr()),
                    PCWSTR(to.as_ptr()),
                    MOVEFILE_REPLACE_EXISTING | MOVEFILE_WRITE_THROUGH,
                )
            } {
                Ok(()) => return Ok(()),
                Err(error) => {
                    last_error = Some(error);
                    if !delay.is_zero() {
                        std::thread::sleep(delay);
                    }
                }
            }
        }

        Err(last_error.expect("MoveFileExW returned no result").into())
    }

    fn wide_path(path: &Path) -> Vec<u16> {
        path.as_os_str()
            .encode_wide()
            .chain(std::iter::once(0))
            .collect()
    }
}

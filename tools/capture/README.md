# SVWB Capture Tool

Windows-native frame capture helper for SVWB Analyzer. It captures an already verified game `HWND` through Windows Graphics Capture and writes the latest image using an atomic file replacement.

## Build on Windows

Install the stable Rust MSVC toolchain, then run from the repository root:

```powershell
pnpm run capture:build
```

The script produces `tools/svwb-capture-tool.exe`, which is the executable bundled by Electron Builder.

## Protocol

Arguments:

```text
--hwnd <decimal Win32 HWND>
--output <absolute path to svwb.png>
--interval-ms <minimum saved-frame interval; default 500>
--include-cursor <optional; default false>
```

One JSON object is emitted per line on stdout. Events are `started`, `frame_saved`, `frame_error`, `window_closed`, and `error`.

The caller reads only the final PNG. Frames are written to `<output filename>.tmp.png` and moved over the final path with `MOVEFILE_REPLACE_EXISTING`, so readers never consume a partially written image.

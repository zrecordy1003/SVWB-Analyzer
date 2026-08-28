/**
 * The engine executable's filename.
 *
 * Cargo names the binary `svwb-engine.exe` on Windows and `svwb-engine`
 * everywhere else. Three call sites hardcoded the `.exe` form, which made
 * `pnpm dev` throw during startup migration on macOS and took the four
 * database-backed tests with it - even though the engine crate itself is
 * cross-platform (live capture is the only Windows-only part, and it is
 * `cfg`-gated).
 *
 * Recognition still cannot run without a game to capture; this only keeps the
 * paths that do work on macOS - migrations, the data layer, `replay` over
 * fixtures - from failing on a filename.
 */
export const ENGINE_BINARY = process.platform === 'win32' ? 'svwb-engine.exe' : 'svwb-engine'

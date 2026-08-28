//! `svwb-engine` - the perception engine.
//!
//! Capture -> recognise -> decide -> persist, in one process. See
//! docs/engine-refactor-plan.md for why, and for what is still to come.
//!
//! The crate is a library with a thin binary on top rather than a binary alone,
//! so integration tests can drive the real pipeline over the shipped fixtures.
//! A state machine that can only be reached through a process boundary is how
//! the JS analyzer ended up with a 953-line hand-copied mirror standing in for
//! it in the test suite.
//!
//! The layering, outermost first:
//!
//!   [`frame_source`]  where frames come from (a file today, live capture later)
//!   [`frame`]         one normalised frame
//!   [`templates`]     the template store, and matching against it
//!   [`calibration`]   measured windows, scales, thresholds, timings
//!   [`reading`]       scores -> an interpreted [`machine::Reading`]
//!   [`machine`]       (phase, reading, now) -> what changed
//!   [`phase`]         where the machine is in one match's life
//!   [`accumulate`]    debouncing and multi-frame consensus
//!   [`protocol`]      the JSON Lines contract with the host
//!
//! Nothing below `frame_source` performs I/O, which is what makes all of it
//! testable without a game, a database or Electron.

pub mod accumulate;
pub mod calibration;
#[cfg(windows)]
pub mod capture_source;
pub mod diagnostics;
pub mod frame;
pub mod frame_source;
pub mod host;
pub mod live;
pub mod machine;
pub mod numbers;
pub mod phase;
pub mod protocol;
pub mod reading;
pub mod store;
pub mod replay;
pub mod templates;

//! Code shared by the OMP Desktop app and its persona service `omp-desktopd`.
// `clippy.toml` (in the parent app crate) routes every spawn through
// `spawn_gate`; the moved suites start their helper processes (`sh`,
// `true`) directly, like the app's own tests do.
#![cfg_attr(test, allow(clippy::disallowed_methods))]

pub mod approval;
pub mod child_path;
pub mod json_store;
pub mod persona_fs_security;
pub mod persona_paths;
pub mod persona_pipe_security;
pub mod persona_protocol;
pub mod persona_quiet;
pub mod proc_util;
#[cfg(any(test, feature = "test-support"))]
pub mod test_support;

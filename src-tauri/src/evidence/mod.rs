//! Evidence host, private artifacts and user-configured collection policies.

pub mod commands;
mod fingerprint;
mod host;
mod media;
pub mod presets;
mod snapshots;
#[cfg(test)]
mod tests;
mod worker;

pub use host::EvidenceHost;

//! The persona service `omp-desktopd`: one omp session per user, driven by
//! interval, schedule and manual wake-ups.

pub mod autostart;
pub mod budget;
pub mod core;
pub mod inbox;
pub mod paths;
pub mod scheduler;
pub mod server;
pub mod session;
pub mod wake;

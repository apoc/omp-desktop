//! The composer's voice spectrum: while voice to text or a live conversation
//! records, the app reads the default microphone itself and emits
//! `voice://spectrum` equalizer frames. omp's own capture runs in its child
//! process, out of reach, so this is a second, analysis-only reader of the
//! same device; nothing is recorded or kept.
//!
//! The webview only says start or stop; one capture serves the active tab.

mod analysis;
mod capture;

use std::sync::{Mutex, PoisonError};

use serde::Serialize;
use tauri::{AppHandle, Emitter};

pub use analysis::BANDS;
use capture::Capture;

/// The event every frame goes out on.
pub const EVENT: &str = "voice://spectrum";

#[derive(Clone, Serialize)]
struct Frame {
    /// Low to high frequency, `0..=255`.
    bands: [u8; BANDS],
}

/// At most one capture at a time.
#[derive(Default)]
pub struct VoiceSpectrum {
    capture: Mutex<Option<Capture>>,
}

impl VoiceSpectrum {
    /// Starts emitting frames to `app`; a running capture is left as it is.
    pub fn start(&self, app: AppHandle) -> Result<(), String> {
        let mut capture = self.capture.lock().unwrap_or_else(PoisonError::into_inner);
        if capture.is_none() {
            *capture = Some(Capture::start(move |bands| {
                if let Err(e) = app.emit(EVENT, Frame { bands: *bands }) {
                    eprintln!("[omp-desktop] {EVENT}: {e}");
                }
            })?);
        }
        drop(capture);
        Ok(())
    }

    /// Stops the capture, if any, and waits for its thread.
    pub fn stop(&self) {
        let running = self
            .capture
            .lock()
            .unwrap_or_else(PoisonError::into_inner)
            .take();
        drop(running); // joins outside the lock
    }
}

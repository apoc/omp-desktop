//! The composer's voice spectrum: while voice to text or a live conversation
//! records, the app reads the default microphone itself and emits
//! `voice://spectrum` equalizer frames. omp's own capture runs in its child
//! process, out of reach, so this is a second, analysis-only reader of the
//! same device; nothing is recorded or kept.
//!
//! The webview only says start (with a band count) or stop; one capture
//! serves the active tab.

mod analysis;
mod capture;

use std::sync::{Mutex, PoisonError};

use serde::Serialize;
use tauri::{AppHandle, Emitter};

use analysis::{MAX_BANDS, MIN_BANDS};
use capture::Capture;

/// The event every frame goes out on.
pub const EVENT: &str = "voice://spectrum";

#[derive(Clone, Serialize)]
struct Frame<'a> {
    /// Low to high frequency, `0..=255`, as many as the start asked for.
    bands: &'a [u8],
}

/// At most one capture at a time, with its band count.
#[derive(Default)]
pub struct VoiceSpectrum {
    capture: Mutex<Option<(usize, Capture)>>,
}

impl VoiceSpectrum {
    /// Starts emitting `bands`-wide frames to `app`. A running capture with
    /// the same count is left as it is; another count replaces it.
    pub fn start(&self, app: AppHandle, bands: u16) -> Result<(), String> {
        let bands = band_count(bands)?;
        let mut capture = self.capture.lock().unwrap_or_else(PoisonError::into_inner);
        if capture.as_ref().is_some_and(|(count, _)| *count == bands) {
            return Ok(());
        }
        // The old reader lets go of the device before the new one opens it.
        drop(capture.take());
        let started = Capture::start(bands, move |levels| {
            if let Err(e) = app.emit(EVENT, Frame { bands: levels }) {
                eprintln!("[omp-desktop] {EVENT}: {e}");
            }
        })?;
        *capture = Some((bands, started));
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

/// The webview's band count, refused outside `MIN_BANDS..=MAX_BANDS`
/// before any device opens.
fn band_count(bands: u16) -> Result<usize, String> {
    let bands = usize::from(bands);
    if (MIN_BANDS..=MAX_BANDS).contains(&bands) {
        Ok(bands)
    } else {
        Err(format!(
            "band count {bands} is outside {MIN_BANDS}..={MAX_BANDS}"
        ))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn only_band_counts_the_settings_offer_are_accepted() {
        for bands in [8_u16, 16, 32, 64, 128] {
            assert_eq!(band_count(bands), Ok(usize::from(bands)));
        }
        for bands in [0_u16, 7, 129, u16::MAX] {
            assert!(band_count(bands).unwrap_err().contains("outside"));
        }
    }
}

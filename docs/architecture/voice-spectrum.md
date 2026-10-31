# Voice spectrum

Code: `src-tauri/src/voice_spectrum/` (`mod.rs` manager, `capture.rs` microphone thread, `analysis.rs` FFT and bands), `src/app/voice-spectrum.js` (`OMP_VOICE_SPECTRUM`), `src/app/use-voice-spectrum.jsx`, `src/design/voice-spectrum.jsx`, `.voice-spectrum` in `src/design/layout/composer.css`, `live.js` `voiceSpectrumStart`/`voiceSpectrumStop`/`onVoiceSpectrum`. Tests: `analysis.rs` unit tests, `tests/test-voice-spectrum.mjs`.

An equalizer of the microphone right above the composer input while voice to text records or a live call is connected and unmuted (`OMP_VOICE_SPECTRUM.shouldRun(dictation, liveVoice)`).

## Why the app reads the microphone itself

omp captures the microphone natively in its own process and reports at most RMS levels (`live_levels`, live calls only; dictation sends none). A spectrum needs samples, so Rust opens the **default input device** a second time through cpal, purely for analysis: nothing is recorded, stored or sent anywhere. Shared-mode capture lets both readers run (WASAPI shared, CoreAudio, ALSA `default` through PulseAudio/PipeWire). omp's WASAPI capture uses the default console endpoint, the same one cpal's `default_input_device` picks on Windows.

Platforms:

- **macOS**: the app process itself now opens the microphone, so TCC asks for OMP Desktop; `NSMicrophoneUsageDescription` and the `com.apple.security.device.audio-input` entitlement (`packaging/`) cover it, as they cover omp's capture.
- **Windows**: governed by Settings → Privacy → Microphone → "Let desktop apps access your microphone".
- **Linux**: cpal's ALSA backend. Building needs `libasound2-dev` (in `tests.yml` and `release.yml`); the `.deb` depends on `libasound2`, the `.rpm` on `alsa-lib`; the AppImage uses the system library.

No microphone, no permission or an unsupported sample format makes `voice_spectrum_start` fail; the hook logs it and shows nothing. Voice capture itself is unaffected.

## Rust

- `VoiceSpectrum` (managed `Arc`) holds at most one `Capture` with its band count. `voice_spectrum_start { bands }` (async, `spawn_blocking`: opening a device takes a moment) refuses a count outside `MIN_BANDS..=MAX_BANDS` (8..=128) before any device opens, keeps a running capture of the same count and replaces one of another count (the old reader lets go of the device first); `voice_spectrum_stop` drops it. The webview sends nothing but start with a count, and stop.
- `Capture` owns a `voice-spectrum` thread that creates the cpal stream, plays it and drops it, so the platform stream never crosses threads. The start call waits for the thread's open result. Dropping the `Capture` signals the thread and joins it.
- The cpal callback converts its block to `f32` (any integer or float format cpal reports), mixes channels to mono and pushes into a `Ring` of the newest `FFT_SIZE` (4096) samples behind a short-held mutex.
- Every 33 ms the thread copies the ring under its lock (`Analyzer::load`, Hann window) and then, without it, runs `Analyzer::levels`: real FFT (`realfft`), `bands` log-spaced bands from 80 Hz to 8 kHz (or 0.45 × the sample rate), each wider band's peak bin and each band of at most two bins (the bass at high counts, narrower than the FFT's 11.7 Hz resolution) read between bins at its centre so neighbouring bars differ, as dBFS plus a 4.5 dB/octave tilt around 1 kHz (speech falls towards the treble), mapped from −85..−25 dB to `0..=255`. The frame goes out as `voice://spectrum` `{ bands: [u8] }` from a buffer the analyser reuses.

## Frontend

- `live.js` queues start and stop on one promise chain: both are async Rust commands on worker threads, so a stop could otherwise finish before the start it follows and leave the reader running.
- `useVoiceSpectrum(bridge, active, bands)` (`app-live.jsx`; `bands` is the `voiceSpectrumBands` tweak, Settings › Composer › Voice › Spectrum bars: 16, 32, 48, 64 (default), 96 or 128): while `active`, listens to `voice://spectrum` (newest frame into a ref, so ~30 frames a second re-render nothing) and starts the reader; returns the ref once the start succeeded, else `null`. When inactive, including the first render after a window reload, it sends a stop.
- `VoiceSpectrum` (`design/voice-spectrum.jsx`) draws on a DPR-sized canvas each animation frame with `OMP_VOICE_SPECTRUM.step` (its state is rebuilt when a frame brings another bar count): an exponential approach (28 ms rise, 150 ms fall), peak caps that hold 320 ms and then fall with gravity, a frame gap capped at 100 ms; it stops redrawing at rest. Bars use a horizontal gradient of `--accent` → `--cyan` → `--lilac`, glow with `--accent-glow` as they rise, carry `--fg` peak caps and a faint reflection under the baseline; colours are re-read every second, so a theme switch shows up. The 44 px panel fades in.

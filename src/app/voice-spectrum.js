// The composer's voice spectrum: when it runs, and the bar physics between
// Rust's ~30 frames a second (fast rise, slower fall, peak caps that hold and
// then drop). The canvas is design/voice-spectrum.jsx; the frames come from
// src-tauri/src/voice_spectrum through OMP_BRIDGE.onVoiceSpectrum.
(function () {
  const BANDS = 32;
  // Time constants (ms) of the exponential approach to a new frame.
  const ATTACK_MS = 28;
  const RELEASE_MS = 150;
  // A peak cap rests this long on its high, then falls with this
  // acceleration (bar heights per ms²): about half a second from the top.
  const PEAK_HOLD_MS = 320;
  const PEAK_GRAVITY = 0.000008;
  // Below this every bar and cap is considered at rest (heights are 0..1).
  const REST = 0.002;

  // Whether the microphone is recording for the active tab: voice to text
  // while it records, a live call while connected and not muted.
  function shouldRun(dictation, live) {
    if (dictation?.active && dictation.phase === "recording") return true;
    return !!live?.active && !live.muted && live.phase !== "connecting" && live.phase !== "stopping";
  }

  function createState(bands = BANDS) {
    return {
      values: new Float32Array(bands),
      peaks: new Float32Array(bands),
      holds: new Float32Array(bands),
      speeds: new Float32Array(bands),
    };
  }

  // Moves `state` `dtMs` towards `target` (0..255 per band, or null for
  // silence). Mutates the arrays (it runs every animation frame) and returns
  // whether anything still moves, so the canvas can stop redrawing at rest.
  function step(state, target, dtMs) {
    const dt = Math.max(0, Math.min(dtMs, 100)); // a hidden window resumes calmly
    const rise = 1 - Math.exp(-dt / ATTACK_MS);
    const fall = 1 - Math.exp(-dt / RELEASE_MS);
    const { values, peaks, holds, speeds } = state;
    let moving = false;
    for (let i = 0; i < values.length; i++) {
      const goal = target ? Math.min(1, Math.max(0, (target[i] ?? 0) / 255)) : 0;
      const v = values[i] + (goal - values[i]) * (goal > values[i] ? rise : fall);
      values[i] = v;
      if (v >= peaks[i]) {
        peaks[i] = v; holds[i] = PEAK_HOLD_MS; speeds[i] = 0;
      } else if (holds[i] > 0) {
        holds[i] = Math.max(0, holds[i] - dt);
      } else {
        speeds[i] += PEAK_GRAVITY * dt;
        peaks[i] = Math.max(v, peaks[i] - speeds[i] * dt);
      }
      if (Math.abs(goal - v) > REST || peaks[i] - v > REST || v > REST) moving = true;
    }
    return moving;
  }

  window.OMP_VOICE_SPECTRUM = { BANDS, shouldRun, createState, step };
})();

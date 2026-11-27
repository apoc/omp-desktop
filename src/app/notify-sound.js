// Notification sounds (#91, docs/architecture/notification-sounds.md): a short
// synthesised sound when a question opens in any tab or a turn finished.
// Pure decisions (`prefsFrom`, `cue`) plus `play`, which asks Rust to
// synthesise and play the sound (`notify_sound_play`, src-tauri/src/
// notify_sound/): the webview's own audio is not used. live.js
// `_applyAttention` asks `cue` per tracker snapshot and plays the answer;
// Settings → Session → Sounds picks and previews the sounds.
//
// Exposes `window.OMP_NOTIFY_SOUND`; IIFE per the project rule for plain
// <script> tags. Regression: test-notify-sound.mjs.
(function () {
  const NONE = "none";
  /** When a cue may play (`notifySound` tweak). */
  const MODES = Object.freeze(["off", "background", "always"]);

  /** The catalogue: ids Rust synthesises (notify_sound/synth.rs lists the
   *  same ids; a Rust test scans this literal), with their Settings labels. */
  const SOUNDS = Object.freeze([
    { id: "chime", label: "Chime" },
    { id: "bell", label: "Bell" },
    { id: "pop", label: "Pop" },
    { id: "knock", label: "Knock" },
    { id: "rise", label: "Rise" },
    { id: "blip", label: "Blip" },
  ].map(Object.freeze));
  /** The `soundVolume` range: percent, in steps of 5 (the Settings slider). */
  const VOLUME = Object.freeze({ min: 0, max: 100, step: 5 });
  const known = id => id === NONE || SOUNDS.some(s => s.id === id);

  /** The sound prefs out of tweak-shaped `values`; every invalid field reads
   *  as its default (`defaults` = TWEAK_DEFAULTS). The volume parses as the
   *  Settings slider does (settings-schema.js `clamp`): a number, stepped
   *  from `VOLUME.min` and kept within bounds. */
  function prefsFrom(values, defaults) {
    const pick = (v, d, ok) => (ok(v) ? v : d);
    const raw = values?.soundVolume;
    const n = Number(raw);
    const stepped = VOLUME.min + Math.round((n - VOLUME.min) / VOLUME.step) * VOLUME.step;
    return {
      mode: pick(values?.notifySound, defaults.notifySound, v => MODES.includes(v)),
      attention: pick(values?.soundAttention, defaults.soundAttention, known),
      finished: pick(values?.soundFinished, defaults.soundFinished, known),
      volume: raw === null || raw === "" || !Number.isFinite(n)
        ? defaults.soundVolume
        : Math.min(VOLUME.max, Math.max(VOLUME.min, stepped)),
    };
  }

  /** Which cue a tracker snapshot calls for: "attention" (a question opened),
   *  "finished" (a session went busy → idle), or null. `previous`/`next` are
   *  the tracker's per-session entries; a first snapshot (no `previous`) is
   *  silent, as is a vanished entry (process exit, closed tab). One snapshot,
   *  one cue; attention outranks finished unless its sound is `none`, then a
   *  finish in the same snapshot still plays. */
  function cue({ previous, next, focused, prefs }) {
    if (!previous || !next || prefs.mode === "off" || (prefs.mode === "background" && focused)) return null;
    if (prefs.attention !== NONE && window.OMP_ATTENTION.newAsk(previous, next)) return "attention";
    if (prefs.finished === NONE) return null;
    const finished = Object.keys(previous).some(id => previous[id]?.busy === true && next[id]?.busy === false);
    return finished ? "finished" : null;
  }

  /** Play catalogue sound `id` at `volume` (0–100; Rust computes the gain).
   *  Silent for `none`, an unknown id or volume 0; a missing Tauri runtime or
   *  a failed invoke is swallowed — a sound never raises an error. */
  function play(id, volume) {
    if (!(known(id) && id !== NONE) || !(volume > 0)) return;
    try {
      window.__TAURI__?.core?.invoke("notify_sound_play", { sound: id, volume: Math.min(100, Math.round(volume)) })?.catch?.(() => {});
    } catch { /* no usable runtime: stay silent */ }
  }

  window.OMP_NOTIFY_SOUND = Object.freeze({ NONE, SOUNDS, MODES, VOLUME, prefsFrom, cue, play });
})();

# Notification sounds (#91)

A short sound when an agent needs the user or a turn finished, in any tab. The sounds are synthesised in the webview with Web Audio, so the app ships no audio files and needs no CSP change (Web Audio is not a fetch).

## Decisions

- **D1 Events.** Two cues, both read from Rust's tracker overlay in `live.js` `_applyAttention` (`agent://attention`; the same per-session entries `{ busy, asks, asksOpened, background }` the dock bounce uses), for every registered tab, background tabs included:
  - *attention*: a question opened in some session (`OMP_ATTENTION.newAsk(previous, next)`: the session's `asksOpened` rose; omp's ask tool, a tool-approval prompt, a form request);
  - *finished*: a session's entry went from `busy: true` to `busy: false` (entry present in both snapshots). A vanished entry (process exit, tab closed) is not a finish. An aborted turn counts as finished.
  - One snapshot plays at most one sound; attention outranks finished.
  - No sound for the first snapshot (`trackerLive` null) or the initial `attention_snapshot` reply (`bounce === false`), as with the bounce: their state is not new.
- **D2 When.** Tweak `notifySound`: `"off"` (default; no new sound for existing users) | `"background"` (only while the window is not focused, `document.hasFocus() !== true`) | `"always"`.
- **D3 Which sound.** Tweaks `soundAttention` (default `"bell"`) and `soundFinished` (default `"chime"`): one of the catalogue ids or `"none"` (that cue stays silent). Catalogue, all synthesised from oscillators with a short attack and exponential decay, each under ~1 s: `chime`, `bell`, `pop`, `knock`, `rise`, `blip`. An unknown stored id reads as the default.
- **D4 Volume.** Tweak `soundVolume`, 0–100 (step 5, default 60), perceptual: gain = `(v/100)²` times a fixed headroom cap. 0 plays nothing.
- **D5 Audio context.** One lazily created `AudioContext` (`webkitAudioContext` fallback). Autoplay rules (WebView2, WKWebView, WebKitGTK) may start a context outside a user gesture suspended, so the module installs a one-time capture `pointerdown`/`keydown` listener that creates and resumes it; `play` resumes it too. No Web Audio (or creation throws) → silent no-op, never an error.
- **D6 Settings.** Settings → Session, new group "Sounds": `notifySound` as a seg row ("Play sounds": off / in background / always); a custom row `sounds` (owns `soundAttention`, `soundFinished`; shown only when `notifySound` is not `off`) with one line per cue: a seg of `none` + the catalogue and a ▶ preview button; picking a sound previews it too; `soundVolume` as a slider row (shown only when not `off`). Preview plays regardless of `notifySound`'s focus rule.
- **D7 Prefs path.** `live.js` keeps the sound prefs next to `sessionPrefs`: initial from `OMP_TWEAKS_STORE.read()`, kept current by `OMP_BRIDGE.setSessionPrefs` (app-live already passes the whole tweaks object). Validation lives in the sound module (`prefsFrom`), not in `OMP_SESSION_PREFS` (booleans only).
- **D8 Custom sound files are out of scope.** The issue asks for them as a preference; they need a Rust-side file pick, read cap and decode path. Built-in synthesised sounds ship first.

## Code

- `src/app/notify-sound.js` (`window.OMP_NOTIFY_SOUND`, plain IIFE, loads before `live.js`): `SOUNDS`, `MODES`, `prefsFrom(values, defaults)`, `cue({ previous, next, focused, prefs })` → `"attention" | "finished" | null` (pure), `play(id, volume)`, the gesture unlock. Regression: `tests/test-notify-sound.mjs`.
- `live.js` `_applyAttention` plays `cue`'s sound; `setSessionPrefs` updates the prefs.
- `design/settings/rows-sounds.jsx` (`sounds` custom row).

# CLAUDE.md

Tauri 2 desktop shell for `omp` (oh-my-pi). React UI loaded from `src/` by Tauri's asset server. Rust backend spawns `omp --mode rpc` per tab. **No bundler** — JSX is transpiled in-browser by `@babel/standalone`.

## Commands

| Task | Command |
|---|---|
| Install Tauri CLI | `npm install` |
| Dev | `npm run dev` |
| Prod build | `npm run build` |
| Rust check (CI) | `cd src-tauri && cargo check --locked` |
| Rust fmt | `cd src-tauri && cargo fmt` |
| Rust lint (must stay clean) | `cd src-tauri && cargo +nightly clippy --all-targets --all-features -- -W clippy::pedantic -W clippy::nursery -D warnings` |
| Rust tests | `cd src-tauri && cargo test` |
| Probe omp RPC | `node test-rpc.mjs` |
| Keymap chord regression | `node test-keymap.mjs` (or `npm run test:keymap`) |
| Chat scroll-pin regression | `node test-scroll-pin.mjs` (or `npm run test:scroll-pin`) |
| Slash-command palette regression | `node test-slash-commands.mjs` (or `npm run test:slash-commands`) |
| Prompt history regression | `node test-prompt-history.mjs` (or `npm run test:prompt-history`) |
| Subagent manager reducer regression | `node test-subagents.mjs` (or `npm run test:subagents`) |
| Updater state regression | `node test-updater.mjs` (or `npm run test:updater`) |
| Updater feed assembly regression | `node test-updater-json.mjs` (or `npm run test:updater-json`) |

`omp` must be on PATH (`%LOCALAPPDATA%\omp\omp.exe` on Win). CI = `cargo check` + `cargo test` on win/linux/mac.

## Architecture

Three layers:

1. **Rust (`src-tauri/src/`)** — `agent/` module:
   - `mod.rs` — `AgentBridge` public API (start/stop/send/last_error).
   - `inner.rs` — `BridgeInner` per-session: generation token, `Arc<Mutex<ChildStdin>>`, child handle.
   - `spawn.rs` — `spawn_omp` candidate resolution + Win `CREATE_NO_WINDOW`.
   - `reader.rs` — stdout/stderr threads + bounded `read_until_capped` (16 MiB).

   `AgentBridge` = `HashMap<session_id, BridgeInner>`. Per-session stdin lock so writes don't serialise through the map. Reader emits `agent://line/{id}` per stdout line, `agent://exit/{id}` (empty payload = clean, non-empty = reason) — except a startup death before any frame ever arrived, where the reader substitutes a bounded stderr tail (`reader::StderrTail`) for the empty payload so a silent crash isn't read as a clean exit; also cached in `last_errors` so a background tab's death is visible from `session_status` without waiting for a switch. Tauri commands in `lib.rs`: `start_session`, `stop_session`, `send_command`, `session_status`, `open_project`, `take_pending_open_projects`. `Drop` + `stop_session` kill children — no orphans on hot-reload.

2. **Bridge (`src/live.js`)** — listens to `agent://line/{id}` for active session only. Holds per-session live state and a `sessionRegistry` (tabs). Tab switch: snapshot → tear down listeners → restore (or reset+`_initFetch`) → re-listen. Exposes `window.OMP_BRIDGE` (commands + `onUpdate`) and legacy `window.OMP_DATA`.

3. **React (`src/app-live.jsx` + `src/app/` + `src/design/*/`)** — sole React root. Uses `useBridgeSnapshot` (in `src/app/use-bridge-snapshot.jsx`) to mirror `OMP_BRIDGE.onUpdate` into hooks. Cross-cutting effects (theme on `<html>`) live there; keyboard shortcuts are resolved and dispatched by `src/app/use-keymap.jsx` (registry in `src/app/keymap.js`). Constants/framing strings in `src/app/constants.js`. Pure RPC↔UI shape transforms in `src/adapter.js` (no side effects, depends on `model-names.js`).

## Session model

One tab = one omp process. `default` session started in `lib.rs::setup`; new tabs via `OMP_BRIDGE.openSession(cwd)` → `start_session`. Tab switch preserves in-flight bubbles via `sessionSnapshots`; after re-listen, `get_messages` is called and `_handleResponse` merges persisted turns with cached `streamingBubble` (omp doesn't persist incomplete turns).

Each tab also owns its **profile**: `omp --profile <id>` isolates auth/sessions/settings/caches under `~/.omp/profiles/<id>/`. The profile list lives in `<app config>/profiles.json` (`src-tauri/src/profiles.rs`); the reserved id `default` means *no* `--profile` flag, i.e. omp's own `~/.omp/agent`. Ids are slugified at creation and immutable — rename changes the label only. A profile is fixed at spawn, so `OMP_BRIDGE.switchSessionProfile(id, profileId)` stops and respawns that one tab's process (its transcript is dropped with it); `saved_sessions` resolves its root per profile, so history/resume stay inside the tab's own tree. `delete_profile` only unlists — it never deletes `~/.omp/profiles/<id>/`, and `OMP_BRIDGE.deleteProfile` refuses ids still in use by an open tab (only the frontend knows the tab set).

`create_profile` also seeds `~/.omp/profiles/<id>/agent/models.yml` with a single keyless provider (`providers: {anthropic: {auth: none}}`, see `profiles::seed_bootstrap`) — RPC mode is non-interactive and omp exits at startup once no model resolves, so without the seed a fresh profile's tab would die before ever reaching `/login`. It never overwrites an existing `models.yml` (a re-created id, or a user who already wrote one, keeps theirs), and `clear_profile_bootstrap` removes it after a successful login, but only while the file is still byte-identical to what it seeded.

The same menu ticks one profile as the **startup default**, stored as `ProfilesFile::startup` — a *pointer*, not a reordering, since `normalize` pins the built-in entry first and ids are the join key for on-disk data. `None`/absent means the built-in profile. It governs `lib.rs::setup`'s launch session and any tab opened with no active tab to inherit from; `openSession` otherwise inherits the active tab's profile, and running tabs are never moved. The pointer is re-validated against the list on every load and inside every `mutate`, so deleting or hand-editing away the ticked profile degrades to the built-in one instead of dangling. `list_profiles` returns `{profiles, startupId}` in one payload so the menu can't render a checkmark against a stale default.

## Subagent manager

Replaces the old prototype-only "peer session" split/rail widgets (removed). omp streams subagent activity over RPC once subscribed: `set_subagent_subscription` (`off | progress | events`), frames `subagent_lifecycle` / `subagent_progress` / `subagent_event`, plus `get_subagents` (running agents only) and `get_subagent_messages` (tails an agent's session file by byte offset). `src/app/subagents.js` is the pure reducer over those frames (regression: `test-subagents.mjs`); `live.js` keeps its result in `state.subagents`, snapshotted per tab like the transcript.

- omp's registry *deletes* an agent on its terminal status, so the desktop keeps finished agents itself until the session changes (`_resetSessionVars`). Don't replace the local copy with `get_subagents`.
- `_initFetch` re-asserts the subscription (a respawned process starts at `off`) and calls `get_subagents` on every activation — but drops its post-negotiate batch if a tab switch started meanwhile (`_switchGen`), since it would still address the tab being left; `mergeSnapshots` marks agents that were live locally but are no longer listed as ended with `unknownOutcome` (finished outside the journal replay window).
- A dead process (the `agent://exit` listener, or a startup error surfaced on activation) ends its live agents via `mergeSnapshots(…, [])` — nothing else ever would.
- Receive time is not start time: journal-replayed frames arrive late, so `applyProgress` pulls `startedAt` back to `now - progress.durationMs`.
- `events` is the expensive level: only while an agent the manager actually holds is on screen in the inspector (`useSubagentManager` derives `inspecting` from the resolved agent, not the raw id → `OMP_BRIDGE.setSubagentInspecting`). `_switchToSession` downgrades the process being left before `activeSessionId` moves, but leaves the flag to the UI.
- The Rust bridge only forwards allowlisted command types (`ALLOWED_COMMAND_TYPES` in `src-tauri/src/agent/mod.rs`) — a new RPC command in `live.js` must be added there too, or `send_command` rejects it before it reaches omp.
- The manager pane *is* the tweaks `layout: "split"` column (`.window.is-split`); open/close goes through `setTweak`. Transcripts (`state.subagentTranscripts`) are ephemeral — not snapshotted, dropped on tab switch, refetched on demand; a response landing after a switch is discarded.

## In-app updates

`src-tauri/src/updater.rs` over `tauri-plugin-updater` (issue #19). The feed is `latest.json` on the newest **published, non-prerelease** GitHub release (`plugins.updater.endpoints` in `tauri.conf.json`), verified against the minisign key in `plugins.updater.pubkey`. Two commands: `app_update_check` parks the plugin's `Update` in `UpdaterState` and returns a serialisable `UpdateInfo`, and `app_update_install` installs whatever is parked. The download URL never crosses IPC, so the webview can only install what the signed feed announced. Progress arrives as throttled `update://progress` events.

- **Self-install is deliberately narrower than the plugin** (`can_self_install`): only AppImage/MSI/NSIS/`.app`. On macOS the executable must also sit in `*.app/Contents/MacOS`. tauri-utils reports `BundleType::App` for *every* unpatched macOS binary, and for a `tauri dev` binary the plugin would move `target/debug` away and delete it. `.deb`/`.rpm` (the plugin would `pkexec dpkg -i`, falling back to a TTY `sudo`) and unbundled `tauri dev`/source builds are notify-only; the UI links to the release page instead.
- **Relaunch skips `Drop`.** Off Windows, `request_restart` ends the process without dropping managed state, so `AgentBridge::shutdown_all` kills the omp children explicitly first; on Unix they sit in their own process group and would be orphaned otherwise. On Windows the plugin exits right after launching the installer, and the `KILL_ON_JOB_CLOSE` job objects take every omp tree down with the process. We deliberately don't override the plugin's `on_before_exit`: it runs *before* the installer launch, and killing omp there would strand every tab if the launch then failed.
- **The plugin's Linux `check()` sets `SSL_CERT_FILE`/`SSL_CERT_DIR` process-wide** when they are unset. `run()` snapshots them first (`spawn::record_launch_env`), and `sanitize_child_env` strips the injected ones from every omp child. Without that, OpenSSL tools the agent runs would look for a Debian CA path that doesn't exist on Fedora/RHEL.
- Frontend: `app/updater.js` is the pure reducer plus the shared phase selectors `isBusy`/`isInstalling` (regression: `test-updater.mjs`). `app/use-updater.jsx` owns the timer (15 s after launch, then every 6 h) and the modal state; its public `check()` is always a manual check. Download progress is subscribed only for the duration of `OMP_BRIDGE.installUpdate(onProgress)`. `design/update-modal.jsx` renders it. A background check never opens anything; it only lights the tab-bar pill. The `updateCheck`/`skippedUpdate` tweaks persist auto-check and "skip this version". Release notes render as plain text: `notes` is not covered by the signature.
- Release signing: `bundle.createUpdaterArtifacts` lives in `src-tauri/tauri.release.conf.json`, merged only by `release.yml` (`--config`); in `tauri.conf.json` it would make every local `npm run build` fail for lack of the private key. The key lives only in the `TAURI_SIGNING_PRIVATE_KEY` repo secret (plus `_PASSWORD` if it has one) and is **never** committed. Rotating it strands every installed copy.

## OS folder opens ("Open with OMP Desktop")

`src-tauri/src/external_open.rs` + `src-tauri/packaging/`. Three delivery paths, one queue:

|Platform|Delivery|Registration|
|---|---|---|
|macOS|`RunEvent::Opened { urls }` (hence `run()` ends in `build().run(cb)`, not `Builder::run` — `RunEvent` needs a callback)|`src-tauri/packaging/Info.plist`: `CFBundleDocumentTypes` / `LSItemContentTypes = public.folder`, rank `Alternate`|
|Windows|Executable launched with the folder in argv; forwarded to the running instance by `tauri-plugin-single-instance`|`src-tauri/packaging/windows-folder-verb.nsh` (NSIS) + `.wxs` (MSI): `Directory\shell` and `Directory\Background\shell` verbs, command `"<exe>" "%V"`|
|Linux|Same as Windows|`src-tauri/packaging/omp-desktop.desktop`: `MimeType=inode/directory` + `%F` on `Exec`|

`bundle.fileAssociations` cannot express any of this — it is keyed by file extension (`ext` is required) and a folder has none.

Requests land in `OpenProjectState` (capped at 32) and are announced with a payload-free `open://project` event. The **queue is the source of truth**: `take_pending_open_projects` empties it, so `live.js` treats the startup drain and the event handler as the same idempotent call — no request ids, no acknowledgement. `_drainExternalOpens` serialises drains (each open switches the active tab) and isolates each open so one failure cannot discard the rest of an already-taken batch. An event that arrives while the guard is up sets `_externalOpenWake` instead of being dropped, and the drain owes one more `take` before it may stop: the lossy window is *not* synchronous — Rust empties the queue when `take_pending` releases its mutex, but the guard clears only once the IPC response is back in JS, and an event travelling the other channel can overtake that response. A failed `take` round-trip is distinguished from an empty queue (`null` fallback) and leaves the folders queued for the next event. The drain is armed only after the profile list *and* the launch tab's activation have settled: earlier and the new tab would inherit the provisional built-in profile, or race the activation of the tab it is about to retire. If the launch tab is still pathless with an empty transcript (`_isRetirableLaunchTab`) *and* the tab this open created is still active (a tab click mid-open bumps `_switchGen`, so the check would otherwise close the tab the user just picked), it is closed — an "Open with" should leave the folder's tab, not a stray empty one.

Paths are canonicalised in Rust (`canonical_folder`) before they reach the frontend: they arrive from argv/LaunchServices and become an omp `--cwd`, a git-watch root and a tab label. Non-directories and missing paths are logged and dropped; the Windows verbatim `\\?\` prefix is stripped (`gix` and omp choke on it). A *relative* argv path is joined onto the directory its argv was produced in — the single-instance plugin's `cwd` for a forwarded open, this process' own for a cold start — because `canonicalize` alone resolves against the running instance's cwd, so `omp-desktop .` in another shell would open the wrong folder.

## Frontend load order (`src/index.html`)

Script order **is** the dependency graph:

1. Vendored libs: React, ReactDOM, Babel, `marked.min.js`, `highlight.min.js` + marked-wiring inline.
2. App constants: `app/constants.js` → `app/keymap.js` (plain, IIFE — defines `window.OMP_KEYMAP`; must load before any Babel file that calls `OMP_KEYMAP.matches`/`.keysFor`, including `composer.jsx`, `shortcuts-modal.jsx`, `use-keymap.jsx`) → `mentions.js` (plain, IIFE) → `app/image-attach.js` (plain, IIFE — defines `window.OMP_IMAGES`; `composer.jsx` destructures it at top level) → `app/slash-commands.js` (plain, IIFE — defines `window.OMP_SLASH`; `composer.jsx` and `live.js` both destructure it at top level, so this must load before either) → `app/scroll-pin.js` (plain, IIFE — defines `window.OMP_SCROLL_PIN`; `chat/chat-view.jsx` destructures it at top level, so this must load before it) → `app/prompt-history.js` (plain, IIFE — defines `window.OMP_PROMPT_HISTORY`; `composer.jsx` references it in event handlers, and `live.js` reads it at its own top-level IIFE init — not just inside a later-called function — so this must load before `live.js` too, same constraint as `slash-commands.js`) → `app/subagents.js` (plain, IIFE — defines `window.OMP_SUBAGENTS`; `design/subagents/*.jsx` destructure it at top level and `live.js` reads it at its top-level IIFE init, so this must load before both) → `app/updater.js` (plain, IIFE — defines `window.OMP_UPDATER`; only read inside `design/update-modal.jsx` and `app/use-updater.jsx` function bodies). **Before** the `design/` layer *and* before `app/use-bridge-snapshot.jsx` — `profile-menu.jsx`, `chrome.jsx`, `live.js` and `use-bridge-snapshot.jsx` destructure `DEFAULT_PROFILE_ID`/`isSubmitEnter` off `window` at *top level*, so moving this after any of them silently yields `undefined` (no resolver, no error). `composer.jsx` and `chat/ask-bubble.jsx` only call `isSubmitEnter` inside handlers — late-bound global lookups, insensitive to script order.
3. Tweaks: `tweaks/style.js`, `tweaks/use-tweaks.js` (plain, IIFE) → `tweaks/panel.jsx`, `tweaks/controls.jsx` (Babel; controls depends on panel).
4. UI primitives: `ui/icons.jsx` (defines `Icon`, `TOOL_META`) → `ui/sparks.jsx` → `ui/markdown.jsx` → `ui/plan-annotations.jsx`.
5. Chat: `chat/user-bubble.jsx` → `chat/eval-cell.jsx` → `chat/assistant-bubble.jsx` → `chat/tool-card.jsx` → `chat/ask-bubble.jsx` → `chat/chat-view.jsx`.
   Then subagents: `subagents/subagent-bits.jsx` → `subagent-inspector.jsx` → `subagent-pane.jsx` (destructures `SubagentInspector`) → `subagent-rail-card.jsx`, all before `chrome.jsx`, whose `AmbientRail` destructures `window.SubagentRailCard` at top level.
6. `design/mention-menu.jsx` → `design/composer.jsx` → `design/profile-menu.jsx` (before `chrome.jsx`, which destructures `window.ProfileMenu`) → `design/chrome.jsx` → `design/panels.jsx` → the remaining panels/modals → `design/shortcuts-modal.jsx` (after `history-modal.jsx`; reads `window.OMP_KEYMAP` at top level) → `design/update-modal.jsx`.
7. Live data: `model-names.js` → `adapter.js` → `live.js`.
8. `app/use-bridge-snapshot.jsx` (after `live.js`, whose snapshot it mirrors).
9. `app/use-keymap.jsx` (after `live.js` — calls `bridge.listKeybindings`; after `use-bridge-snapshot.jsx`; before `app-live.jsx`).
   → `app/use-subagent-manager.jsx` (UI state for the subagent manager; before `app-live.jsx`).
   → `app/use-updater.jsx` (in-app updater state; before `app-live.jsx`).
10. `app-live.jsx` last.

When adding a file, insert at the correct point — there is no resolver to catch ordering bugs.

### IIFE rule

Plain `<script>` tags share document top-level scope; Babel `type="text/babel"` scripts intersect with it via destructures. Every plain script declaring top-level `const`/`function`/`class` **MUST** be `(function(){ …; window.X = X; })();` — see `app/constants.js`, `tweaks/style.js`, `tweaks/use-tweaks.js`. Bare `window.X = {…}` assignments are fine (`model-names.js`). Babel-transformed files do not need wrapping.

## Authoritative source

`src/design/` is the live-wired copy. Root-level `design/` is a gitignored read-only prototype reference. **Never** regenerate `src/design/` from `design/` — it overwrites bridge wiring. Edit `src/design/` directly.

## God-file prevention

Soft caps:

| Kind | Cap |
|---|---|
| `.jsx` | ~250 lines |
| `.js` | ~400 lines |
| `.rs` | ~250 lines |
| `.css` | ~300 lines |

Guidelines, not hard limits. Cohesion matters more than count.

Rules:
1. Split by responsibility, not symbol count. Group component families (e.g. `chat/`); never alphabetic splits.
2. One component per file when it has its own non-trivial state/effects (e.g. `EvalCell`, `ScrubbableDiff`, `AnnotablePlan`).
3. Co-locate primitives only when one is a private helper of the other (`InlinePlan` with `AssistantBubble`).
4. CSS splits by visual layer, not component. Don't sub-split `chat.css` unless a layer exceeds ~150 lines.
5. Rust modules split by concern when there are multiple `pub` surfaces or a long private helper section.
6. After splitting, update `src/index.html` script order in dependency order — never append.
7. Don't extract for symmetry. Tightly-related layers (e.g. `chrome.jsx`) stay together.

Trigger: 6th major component in one file, or 4th unrelated concern in one Rust module → split before further growth.

## Things easy to break

- `omp --mode rpc`, **not** `omp --rpc` (latter falls through to TUI, floods stdout with ANSI).
- Blank-line stdout: `agent/reader.rs` distinguishes EOF (`(0,_)`) from blank lines and strips CR/LF. Don't revert to `reader.lines()` with blanket `_ => break` — silently kills reader on first blank line.
- Window controls use document-level click delegation (React mounts after `DOMContentLoaded`); `querySelector` in `_setupWindowChrome` would miss it.
- `set_model` response **must** call `notify()` immediately, else next `turn_start` re-emits stale `state.model` and UI reverts.
- Long `if/else if` chains in `_handleResponse` (`live.js`): a single misplaced `}` cascades — `_handleResponse` never closes, IIFE syntax errors, `window.OMP_DATA` never set. Re-verify brace structure when inserting branches.
- Frameless window via DWM: `decorations: false` + `platform.css` strips outer padding/shadow under `.tauri-native`. CSS uses `color-mix(in oklab, …)` — needs WebView2 ≥ 101.
- Strict CSP: `default-src 'self'; script-src 'self' 'unsafe-inline' 'unsafe-eval'; …`. Asset protocol disabled. `tauri-plugin-shell` deliberately removed. Don't add CDN tags or `convertFileSrc()` without revisiting both.
- Thinking levels are RPC-driven. Cycle = `cycle_thinking_level` (response carries new level). Set = `set_thinking_level`. Valid: `off | minimal | low | medium | high | xhigh`. Never invent fallbacks like `auto`/`extended` — RPC silently ignores them.
- No CDN dependencies. React/ReactDOM/Babel/marked/hljs are vendored. App must work offline.
- `tauri-plugin-single-instance` must stay the **first** plugin registered, and is deliberately `cfg`'d to Windows/Linux only — on macOS `LaunchServices` already reuses the running instance, and the plugin would fight it.
- Tauri's built-in Linux desktop template has a bare `Exec={{exec}}`: without `src-tauri/packaging/omp-desktop.desktop`'s `%F` the folder the user picked never reaches argv and "Open with" silently opens an empty app. Same trap for the `MimeType` line — dropping it removes the app from the file manager's menu entirely, and dropping its `{{mime_type}}` half would silently strip any future `fileAssociations`/deep-link registration from the Linux entry alone.
- `src-tauri/packaging/windows-folder-verb.wxs` hardcodes the `Open with OMP Desktop` label and re-derives `Win64` (preprocessor defines don't cross `.wxs` files; a 32-bit component would write to `Wow6432Node`, where 64-bit Explorer never looks). Keep the label in sync with `productName`.
- `std::env::args()` **panics** on a non-UTF-8 argument, and a Linux folder name is an arbitrary byte string that `%F` passes verbatim — the launch-argv ingest in `setup` must stay on `args_os()`, or "Open with" on such a folder kills the app at startup instead of logging one dropped request. Only the cold start is protected: `tauri-plugin-single-instance`'s *sending* process collects `std::env::args()` itself, so a forwarded open on such a folder aborts that process before anything reaches us (plugin limitation, not ours).

## Code style

**General:**
- Follow existing architectural patterns before introducing new ones. Optimize for clarity first, then allocation efficiency.
- Run fmt + lint locally before finalizing any change. Don't ship code that fails fmt or clippy.
- Only format files you actually modified. Never do bulk formatting-only rewrites.
- Prefer surgical `edit` over full-file `write` when the file already exists. Full rewrites only when (a) creating a new file, (b) >~70% of lines genuinely change, or (c) restructuring would require so many anchors that `edit` becomes brittle. Never rewrite a file just to change a few lines — it loses formatting, drops invariants you didn't notice, and bloats diffs.

**Rust:**
- **Toolchain/edition:** edition **2021**, stable toolchain (clippy only is nightly). No `rust-version` key — check `src-tauri/Cargo.toml` before using a newer-edition or recently-stabilised feature; don't assume 2024 idioms (`gen` blocks, RPIT lifetime capture changes) are available.
- **Verify before finishing a task:** `cargo fmt` → `cargo test --locked` → `cargo +nightly clippy --all-targets --all-features -- -W clippy::pedantic -W clippy::nursery -D warnings`. Pedantic+nursery is stricter than the generic `clippy -D warnings`; `redundant_clone` and `too_many_arguments` fire here and are hard errors.
- **Errors:** `thiserror`/`anyhow` are deliberately *not* dependencies. Tauri serialises command errors to JS, so the IPC boundary is `Result<T, String>` — 25 of the 31 `#[tauri::command]` fns; the rest return `ProfileList`, `Option<String>`, `Vec<String>`, or nothing. Internal helpers match it (`json_store::with_lock_str` exists purely to tunnel `String` errors through `io::Error`). Add `thiserror` only alongside a genuine library-shaped module with variants a caller matches on — not to restyle existing `String` errors.
- No `unwrap`/`expect` outside `#[cfg(test)]` unless the invariant is unrecoverable **and** commented (see `run()`'s documented `# Panics`).
- Prefer borrowing (`&str`, `&[T]`, `&Path`) in params; owned only when ownership is required. No needless `String`↔`&str` conversions.
- **Cloning is a last resort, and every surviving `.clone()` must be load-bearing.** Before writing one, in this order:
  1. **Borrow instead.** Take `&T`, return `&T`, or narrow the scope so the original is still live.
  2. **Move instead.** A value used once after its last read doesn't need a copy — this is the most common needless clone. `FnOnce` closures, `match` arms and the tail of a function can all take ownership (`file.startup = next;`, not `next.clone()`).
  3. **Restructure.** Compute the consuming use last so the earlier one can borrow, or hand out an index/id instead of a duplicate.
  4. **Then clone, with a reason at the callsite** — the comment says *why the duplication is intentional*, not that it is a clone.
- Clone-specific rules:
  - `Arc::clone(&x)` / `Rc::clone(&x)` for refcount bumps — **never** bare `x.clone()`. The explicit form says "cheap handle, shared owner"; `.clone()` on an `Arc` field is indistinguishable from a deep copy at the callsite. No lint enforces this (`clone_on_ref_ptr` is `restriction`, not in pedantic/nursery), so it is convention- and review-enforced.
  - Never `.clone()` into an existing binding (`*dst = src.clone()`); that's `clone_from`, and clippy's `assigning_clones` is a hard error here.
  - Never clone to silence the borrow checker. A borrowck error is a lifetime/structure problem; a clone hides it and costs an allocation on every call.
  - Never clone a `Copy` type, a `&str` you could pass through, or a collection you only iterate.
  - **Tests are not exempt, and "the callee needs an owned value" is not a justification — it is the cue to restructure.** A clone repeated across callsites belongs in one helper, or the type needs a consuming accessor. Precedent in `profiles.rs`: 15 × `let path = store.path.clone(); drop(store);` became `store.into_path()` (consumes the store, zero allocation), and 5 × `ProfileStore::load(store.path.clone())` became `store.reopen()` — one documented clone inside the helper instead of one per test. Net 21 → 6 clones in that file, all six now carrying a reason — one of the six, `ProfileStore::load(path.clone())` in a quarantine test, looks like the exact `reopen()`-eligible shape above but isn't: that test reads `path` again afterward to locate the quarantined file, so `reopen()`'s self-borrowing signature doesn't fit and the documented clone stays.
- The lint gate (see **Verify** above) already errors on `redundant_clone` (nursery) and `assigning_clones` (default-warn), and `clone_on_copy` covers cloning a `Copy` type — so a clone that survives it is either justified or in a blind spot. Reviewers should treat an uncommented one as a finding.
- Prefer iterators over index loops; never collect into a `Vec` just to iterate it once. `Vec::with_capacity` when the size is known. `Cow` only when it measurably reduces allocations.
- Avoid `Box<dyn Trait>` where generics work. No unnecessary `Arc`/`Mutex`/async primitives. Keep lifetimes simple — no lifetime abstractions without a clear benefit.
- **Async:** Tauri owns the tokio runtime; this crate spawns no tasks of its own. Never hold a `std::sync::Mutex` guard across an `.await` — the existing locks (`AgentBridge.sessions`, `ProfileStore.cache`, `RuleBook`) are all acquired and dropped inside synchronous blocks; keep it that way. Long/blocking work goes through `spawn_blocking` (see `list_saved_sessions`, `workspace_status`).
- No `unsafe` without a `// SAFETY:` comment. It lives in exactly two modules: `agent/supervisor.rs` (Win32 job objects; `libc::kill` on unix) and the `pid_is_alive` probe in `json_store.rs`. Note the invariant is *not* currently met file-wide — 8 of `supervisor.rs`'s 10 `unsafe` blocks are annotated; the `mem::zeroed()` at `supervisor.rs:121` and a test `libc::kill` are not. Annotate them if you touch them; don't cite the file as a clean example. Prefer the safe std API when one exists — the unix process-group setup uses `Command::process_group(0)`, not FFI.
- Minimise temporary allocations in hot paths (reader loop, per-line dispatch, IPC payload construction).
- Idiomatic Rust over clever abstractions. Preserve existing module/naming conventions.
- Module-level `#![allow(clippy::needless_pass_by_value)]` in `lib.rs` is intentional — Tauri `#[command]` requires owned types.

**Frontend:**
- Prettier for JS/TS; respect any present ESLint config. Use repo-configured npm scripts when present (none currently — no JS test/lint pipeline in this repo).
- Don't reformat unrelated files. Preserve existing import ordering/style.
- Prefer TS types over `any` (when TS is present; this repo is JSX).

**Tauri:**
- Keep FE/BE boundaries explicit. Don't expose unnecessary commands.
- Validate/sanitise all inputs crossing the IPC boundary. Strongly typed payloads.
- No blocking ops inside async commands. Off-thread `kill+wait` (see `start_session`/`stop_session`).
- Isolate platform-specific logic (e.g. `CREATE_NO_WINDOW` lives in `agent/spawn.rs`).

**Disallowed unless justified:** clone-heavy ownership; owned `String`/`Vec` params where borrows suffice; collecting only to iterate once; unneeded boxing; async tasks without lifecycle justification; large formatting-only rewrites; formatting unrelated files.

## Tests

All non-trivial code **must** have test coverage before committing. This is not optional.

**Rust:**
- Every pure/logic function gets a `#[cfg(test)] mod tests` block in the same file.
- Integration behaviour (spawn, IPC, reader) gets at least one test verifying the happy path and one for the main failure mode.
- Run `cargo test` before every commit. A commit that adds logic without tests is rejected.

**Frontend (JS/JSX):**
- Pure state-transformation functions (message mapping, event handlers, bridge methods) are extracted so they can be tested in isolation.
- Use the `eval` kernel (`===== js =====` cells) to exercise logic inline when no test framework is wired.
- Non-trivial `live.js` additions (new event handlers, new bridge methods) must be accompanied by a notebook-style proof-of-correctness cell or a note explaining why the function is too side-effectful to test directly.

**What counts:**
- A test that imports the function and asserts on its output counts.
- A test that only verifies the function doesn't throw does not count.
- Snapshot tests and "it renders" checks do not count as logic coverage.

## CI / release

- `.github/workflows/ci.yml` — `cargo check --locked` + `cargo test --locked` on win/linux/mac for `src-tauri/**`, `src/**`, or workflow changes.
- `.github/workflows/release.yml` — a signed `tauri build` per platform, then one `updater-json` job that assembles `latest.json` via `.github/scripts/updater-json.mjs`, with the matching CHANGELOG section as notes. The rationale and the guards are documented in the workflow header and the script. Users see an update only once the draft is published. Dry run: `gh workflow run release.yml --ref <branch> -f tag=vX.Y.Z-rc.N`, then delete the draft.

## Changelog workflow

`CHANGELOG.md` follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/).

**During development:** every user-facing change goes into the `[Unreleased]` section at the top, grouped under `### Added`, `### Fixed`, or `### Changed`.

**On release** (triggered by the user saying "release X.Y.Z"):
1. Rename `## [Unreleased]` to `## [X.Y.Z] - YYYY-MM-DD` (today's date).
2. Insert a new empty `## [Unreleased]` section above it.
3. Bump `version` in `src-tauri/Cargo.toml` and `src-tauri/tauri.conf.json` to `X.Y.Z`.
4. Update `src-tauri/Cargo.lock`: `cargo update --manifest-path src-tauri/Cargo.toml --package omp-desktop`.
5. Commit: `git add CHANGELOG.md src-tauri/Cargo.toml src-tauri/tauri.conf.json src-tauri/Cargo.lock && git commit -m "chore: release vX.Y.Z"`.
6. Tag: `git tag vX.Y.Z`.
7. Push: `git push origin master --tags`.
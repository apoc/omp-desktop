# AGENTS.md

Tauri 2 desktop shell for `omp` (oh-my-pi). React UI served from `src/` in `tauri dev` (**no bundler** — JSX is transpiled in-browser by `@babel/standalone`) and from the precompiled `dist/` in release builds. Rust backend spawns `omp --mode rpc-ui` per tab.

Feature internals (RPC frames, state machines, measured omp behaviour) live in `docs/architecture/` — read the matching file before touching that feature:

|File|Feature|Code|
|---|---|---|
|`session-model.md`|tabs = omp processes, profiles, startup default, per-tab composer/plan state|`profiles.rs`, `app/session-ui.js`|
|`project-navigation.md`|tab grouping by (profile, folder), drag/keyboard reorder, recent projects|`app/project-nav.js`, `app/drag-reorder.js`, `ui/use-drag-reorder.js`, `recent_projects.rs`|
|`reopening-tabs.md`|`open-tabs.json` persistence and launch restore|`open_tabs.rs`, `live.js` `_restoreOpenTabs`|
|`session-title.md`|auto/manual `/rename` of tabs|`app/session-title.js`|
|`recent-models.md`|model picker MRU from omp's `agent.db`|`model_usage.rs`|
|`message-queue.md`|steer/follow-up queue strip|`app/message-queue.js`, `design/queue-strip.jsx`|
|`ask-dialog.md`|omp's ask tool dialog, tool-approval prompts, auto-approval rows, grants bound to their prompt|`app/ask-dialog.js`, `chat/ask-dialog.jsx`, `app/approval.js`, `chat/approval-row.jsx`, `approval.rs`, `agent/approvals.rs`|
|`approval-mode.md`|tool approval mode (global default, per-project override), restart-on-change|`approval_mode.rs`, `app/approval-mode.js`, `live.js` `_respawnSession`|
|`turn-status.md`|run state, failed requests, auto-retry rows, job rows, streaming replies from delta frames (dropped-replay copy)|`app/turn-status.js`, `app/stream-delta.js`, `agent/inflight.rs`|
|`remote-access.md`|phone remote access: TLS server, pairing/auth, tracker, publisher, protocol limits, Web Push, security model, limits|`src-tauri/src/remote/`, `src/remote/`, `app/remote-view.js`, `app/use-remote.jsx`, `design/settings/rows-remote-*.jsx`|
|`chat-collapse.md`|collapsible tool cards and thinking, auto-collapse, per-tab toggles|`app/chat-collapse.js`, `ui/collapse-toggle.jsx`, `chat/chat-view.jsx`|
|`terminal.md`|per-tab shell panel: Rust tab registry and spawn slots, cwd/shell ownership, `terminal.json`, `terminal_*`/`close_tab`/`close_all_tabs` commands, seq/instance events, output ring + replay, ack flow control, tree kill, reload behaviour, key routing, security note|`terminal/`, `app/terminal.js`, `app/terminal-stream.js`, `app/terminal-xterm.js`, `app/use-terminal.jsx`, `design/terminal-panel.jsx`, `design/settings/rows-programs.jsx`|
|`subagents.md`|subagent manager|`app/subagents.js`, `design/subagents/`|
|`conversation-tree.md`|conversation tree + prompt-cache model, branch/fork|`conversation_tree/`, `app/conversation-tree*.js`|
|`git-browser.md`|git browser: files tree, full-file inline diff, commit graph, browse a commit|`src-tauri/src/git_browser/`, `app/git-browser.js`, `app/use-git-browser.jsx`, `design/git/`|
|`file-preview.md`|file preview of read-card paths and agent file links, read-card image thumbnails, write-card paths to the git browser|`project_file.rs`, `app/file-preview.js`, `design/chat/file-preview.jsx`, `design/chat/tool-card.jsx`|
|`goal-mode.md`|goal mode, auto-continue|`app/goal.js`, `goal_config.rs`|
|`updater.md`|in-app updates, release signing|`updater.rs`, `app/updater.js`|
|`external-open.md`|"Open with OMP Desktop" on macOS/Windows/Linux|`external_open.rs`, `src-tauri/packaging/`|
|`frontend-load-order.md`|full `src/index.html` script-order rationale|`src/index.html`|
|`release-frontend.md`|`dist/` build, CSP check, `?v=` asset stamping|`scripts/build-frontend.mjs`|
|`widgets.md`|rail widget plugins: Rust scheduler state machine, approval/fingerprint, `widgets_*` commands and `widgets://` events, runner|`src-tauri/src/widgets/`, `app/widgets.js`, `app/use-widgets.jsx`, `design/widgets/`|
|`extension-widgets.md`|omp extension `setStatus`/`setWidget` as rail cards: wire frames, per-tab state, the Rust copy for dropped replays, lifecycle|`agent/ext_ui.rs`, `app/extension-widgets.js`, `live.js` `state.extWidgets`|
|`browser.md`|per-tab Chromium: Rust-owned `browser.json` setting and discovery, lazy CDP proxy (admission, tap), agent-follow, screencast flow control/input, isolated annotation overlay and capture, lifecycle, security and known limits|`browser/`, `app/browser*.js`, `app/use-browser.jsx`, `design/browser-*.jsx`|
|`settings.md`|Settings app tab (state, keys, Escape rule), schema and search, custom rows, storage homes, session behaviours (reopen tabs, busy-close guard, auto-name, auto-compaction/retry, send key, paste collapse, follow output, scrollback, default side, accent tokens)|`app/settings-schema.js`, `app/settings-tab.js`, `app/session-prefs.js`, `app/accent.js`, `design/settings/`, `design/confirm-close.jsx`, `lib.rs` `CloseGuard`|
|`pr-automation.md`|Changes rail card: current-branch PR discovery (gix + trusted `gh`, GraphQL + head-filtered REST, fail-closed selection), CI line, read cadence and visibility gating, `ghMissing`/`retryable` errors, opt-in Auto-fix dispatch and feedback identities|`pr_automation/`, `app/pr-automation.js`, `app/use-pr-automation.jsx`, `design/pr-automation-*.jsx`, `design/pr-checks.jsx`, `live.js` `prAutomationSnapshot`/`prAutomationSend`|

User-facing rail widget contract (`widgets.json`, approval, output schema v1, limits, trust model): `docs/widgets.md`. Keep it in sync with any change to those.

## Commands

|Task|Command|
|---|---|
|Install Tauri CLI|`npm install`|
|Dev|`npm run dev`|
|Prod build|`npm run build` (= `tauri build --config src-tauri/tauri.dist.conf.json`: embeds the precompiled `dist/`)|
|Build `dist/` only|`npm run build:frontend` (writes the gitignored `dist/`; also the last step of `npm test`)|
|Rust check (CI)|`cd src-tauri && cargo check --locked`|
|Rust fmt|`cd src-tauri && cargo fmt`|
|Rust lint (must stay clean)|`cd src-tauri && cargo +nightly clippy --all-targets --all-features -- -W clippy::pedantic -W clippy::nursery -D warnings`|
|Rust tests|`cd src-tauri && cargo test` (the real-Chromium tests skip without a browser; `OMP_REQUIRE_CHROMIUM=1`, set in CI, makes that a failure)|
|All JS regression scripts|`npm test`|
|One JS regression|`node tests/test-<name>.mjs` (or `npm run test:<name>`)|
|Probe omp RPC (needs a live omp, not in `npm test`)|`node tests/test-rpc.mjs`|
|Simulated omp: replays a recorded session (no model, no network)|`bun build --compile scripts/omp-sim.mjs --outfile <dir>/omp.exe`, then start the app with `<dir>` first on PATH and `OMP_SIM_SESSION=<session.jsonl>` (other `OMP_SIM_*` knobs: header of `scripts/omp-sim.mjs`)|

Regression files are mostly named after the `src/app/<name>.js` module they cover (`app/turn-status.js` → `test-turn-status.mjs`); exceptions: `test-markdown.mjs` (`app/marked-setup.js`), `test-recent-models.mjs` (`adapter.js`), `test-tool-output.mjs` (bash tool card), `test-updater-json.mjs` (`.github/scripts/updater-json.mjs`), `test-widget-examples.mjs` (`examples/widgets/git.sh`, parsed with `app/widgets.js`), `test-browser-runtime.mjs` (`app/browser-screen.js` and `app/use-browser.jsx`, run against DOM/React stubs), `test-pr-automation-bridge.mjs` (`live.js` `prAutomationSnapshot`/`prAutomationSend`, with `app/pr-automation.js`). A new test file must be added to the `npm test` chain in `package.json`, with its own `test:<name>` script.

`omp` must be on PATH (`%LOCALAPPDATA%\omp\omp.exe` on Win). CI and every release run the same suite (`.github/workflows/tests.yml`): `cargo test --locked` on win/linux/mac with `OMP_REQUIRE_CHROMIUM=1` (the runner images ship Google Chrome), plus `npm test`.

**omp version floor.** `MIN_OMP_VERSION` in `src-tauri/src/agent/spawn.rs` (currently 18.13.2, for rebuildable `messageUpdates: "delta"` frames) is the only omp version knowledge in the app: `spawn_omp` refuses an older or unreadable omp, and only a pass is cached, so an `omp update` takes effect without an app restart. A change that starts using an RPC command, event or `get_state` field from a newer omp release raises the constant in the same commit (plus a CHANGELOG line); no code branches on the omp version or keeps a fallback for an omp below the floor. Finding a command's first release in omp's repo: `git log --reverse --format=%h -S '"<command>"' -- packages/coding-agent/src/modes/rpc`, then `git tag --contains <sha> --sort=v:refname` (first line; plain `--contains` sorts `v18.4.10` before `v18.4.9`). State fields are unquoted (`-S 'isSettled:'`), and agent-core events live outside `modes/rpc`, so widen the path for those.

## Repo map

|Path|What|
|---|---|
|`src-tauri/src/lib.rs`|Tauri setup, plugin registration, `generate_handler!` list, session commands|
|`src-tauri/src/agent/`|`AgentBridge` (`mod.rs`, also `ALLOWED_COMMAND_TYPES`), per-session `inner.rs`, `spawn.rs` (omp resolution, version floor, `CREATE_NO_WINDOW`), `reader.rs` (stdout/stderr threads, 16 MiB `read_until_capped`, credential redaction), `journal.rs` (in-memory event ring for `replay_events` after a tab switch), `ext_ui.rs` (latest extension status lines/widgets per session, `extension_ui_state`), `inflight.rs` (the assistant message being streamed, rebuilt from delta frames, `streaming_message`), `approvals.rs` (open tool-approval prompts per process; `approval_approve_and_grant` answers one and saves its rule in one call)|
|`src-tauri/src/supervisor.rs`|process-tree kill for every spawn (omp, widget plugins, Chromium, the Windows terminal shell): process group / Job Object; `pid_is_alive`, `kill_group_if_leader`|
|`src-tauri/src/spawn_gate.rs`|the gate every child process starts through (`spawn`/`output`/`status`, `shared()` around spawns made for us, `exclusive()` for Chromium's launch; shared holds never wait for a queued exclusive), so no child but Chromium gets its CDP pipe ends (Windows inheritance, macOS non-atomic close-on-exec); `clippy.toml` `disallowed-methods` checks it in the local clippy run (not in CI)|
|`src-tauri/src/program_setting.rs`|one-program setting shared by `terminal.json` and `browser.json` (file + lock, in-memory cache, refuse-to-overwrite policy) and the path rules (`typed_path`, `is_executable_file`)|
|`src-tauri/src/test_support.rs`|`#[cfg(test)]` helpers shared by module test suites: `eventually`, `wait_until`, `executable` — use these, don't copy them|
|`src-tauri/src/conversation_tree/`|`conversation_tree` command: session-file family + parsing|
|`src-tauri/src/saved_sessions/`|omp's persisted session history (history panel, resume)|
|`src-tauri/src/keybindings/`|omp's keybindings per profile (read-only) merged with the desktop overlay|
|`src-tauri/src/{profiles,open_tabs,recent_projects}.rs`|JSON stores in `<app config>/` (via `json_store.rs`: atomic write, snapshot/rollback; `config_file.rs` `ConfigFile`: the store's file, or its bytes in memory when there is no config folder — open tabs, recent projects, keybinding overlay)|
|`src-tauri/src/{git,git_watcher,workspace,files}.rs`|branch/HEAD info, `.git/HEAD` watcher, `workspace.rs` = path validation + stage/discard (`workspace_accept`/`workspace_reject`) via the `git` binary, `@`-mention paths|
|`src-tauri/src/git_browser/`|git browser reads via gix (`git_browser_*` commands): `status.rs` (status merge, file tree), `file.rs` (full-file inline diff, caps), `log.rs` (commit walk, refs, ahead/behind), `graph.rs` (lane layout), `commit.rs` (files a commit touched)|
|`src-tauri/src/project_file.rs`|`project_file_read`: one file of the tab's project for the preview (folder from the tab registry, never the webview; symlink-escape refusal; text/image caps; base64 images)|
|`src-tauri/src/{omp_cli,stats,goal_config}.rs`|one-shot `omp <subcommand>` runs (Usage panel, goal auto-continue)|
|`src-tauri/src/{approval,model_usage,updater,external_open,child_path,navigation_guard}.rs`|tool-approval rules, model MRU, updater, OS folder opens, child PATH, webview navigation guard|
|`src-tauri/src/approval_mode.rs`|tool approval mode store (`approval-mode.json`: default + per-project override), `resolve` for `start_session`, `approval_mode_*` commands|
|`src-tauri/src/widgets/`|rail widget plugins: `config.rs` (`widgets.json` load/validate, matching), `schedule.rs` (pure trigger/run scheduler), `trust.rs` (fingerprint, `widget-approvals.json`), `snapshot.rs` (`ScriptStore`: verified script copies runs execute, `<app cache>/widget-runs/store/<fingerprint>`), `host.rs` (`WidgetHost`: scheduler thread, run registry, emits), `run.rs` (spawn, timeout, stdout cap, process-tree kill), `context.rs` (git context), `redact.rs`|
|`src-tauri/src/private_fs.rs`|`private_dirs`: `0700` directory builder (unix) for the browser's instance dirs and widget script copies; `pid_dirs` (per-process `<root>/<pid>` dirs, for pruning dead ones) and `remove_dir_retrying` (Windows files still held open)|
|`src-tauri/src/redaction.rs`|credential key list + placeholder shared by `agent/reader.rs` and `widgets/redact.rs`|
|`src-tauri/src/text.rs`|`prefix_within`: byte-bounded, char-safe prefix — the one helper for capping text by bytes (`agent/reader.rs` stderr tail, `agent/ext_ui.rs`, `widgets/context.rs`); `join_nonblank`: a child's stderr tail as one UI line (omp, Chromium)|
|`src-tauri/src/child_run.rs`|bounded child runs: pipe drain threads (capped head or rolling tail), deadline-bounded exit wait, tree termination — shared by `widgets/run.rs` and `pr_automation/gh.rs`; use it for any new one-shot child with caps and a deadline|
|`src-tauri/src/pr_automation/`|Changes rail card's PR lookup (`pr_automation_snapshot`): `git.rs` (branch/HEAD/upstream via gix), `gh.rs` (trusted `gh api`: GraphQL and the head-filtered REST pulls list, signed-out detection), `feedback.rs` (fail-closed PR selection and feedback parsing); a missing `gh` is the typed `ghMissing` failure, GitHub lag the `retryable` one (`docs/architecture/pr-automation.md`)|
|`src/app/widgets.js`, `src/app/use-widgets.jsx`, `src/design/widgets/`|widget output parser + limits (`widgets.js`), thin hook (snapshot + `widgets://` events → cards, view state → Rust), card/approval/error/block renderers|
|`src-tauri/src/browser/`|per-tab Chromium manager (`mod.rs`); `process/` (`browser.json` setting, discovery, launch with fallback and stderr tail, CDP pipe hand-over, instance dir/overlay/pid files, pruning, orphan reaping), `broker/` (the one CDP connection over Chromium's debugging pipe: per-client sessions, routing, bounded outboxes, test fake), `proxy/` (agent-facing CDP endpoint: same-user peer check, admission, routing, `/json` discovery from the broker, WebSocket pump, observer feed, intent tap), `cdp.rs` (panel CDP client on a broker client), `view/` (pages, follow and hold, frame flow control, input, event payloads), `annotate/` (isolated overlay, picks, clipped capture), `commands.rs` (panel IPC); read `docs/architecture/browser.md` before changing these|
|`src/app/browser.js`, `src/app/browser-screen.js`, `src/app/use-browser.jsx`|pure URL/input/Esc/chip/message/Chromium-menu helpers; canvas painting, frame acks and DOM input through a focus sink; per-tab panel/listener/chip lifecycle|
|`src/design/browser-{dock,panel,toolbar,chips}.jsx`, `src/design/layout/browser.css`|resizable/full-view browser dock, page tabs, toolbar, annotation popover/markers and composer chips (the Settings → Browser `chromium` row is `design/settings/rows-programs.jsx`)|
|`examples/widgets/`|bundled widget plugins + `widgets.example.json` (`docs/widgets.md`)|
|`src-tauri/src/terminal/`|`TerminalManager` (`mod.rs`: tab registry `id → { folder, Idle/Spawning/Live slot }`, cwd choice, `terminal_*` backend), `wire.rs` (`TerminalStatus`/`ReplayWire` shapes, `TauriEmit`, `windowsPty` + ConPTY floor), `settings.rs` (`terminal.json` shell setting), `shell.rs` (shell resolution/validation, login args, environment), `shells.rs` (installed shells for the Settings → Terminal shell menu: per-platform list, existence check), `pty.rs` (`Pty`, spawn), `threads.rs` (reader/waiter/writer thread bodies), `pump.rs` (`Emit`, coalesced, seq-numbered base64 `terminal://data`/`exit` events), `stream.rs` (state shared by pump/waiter/`Pty`: ring, ack flow control, exit), `ring.rs` (per-shell output ring for `terminal_replay`), `kill.rs` (tree kill: pty session id on unix, Job Object via `ProcessSupervisor::attach_process` on Windows)|
|`src-tauri/packaging/`|Info.plist, Linux `.desktop`, Windows folder verb (`.nsh` + `.wxs`)|
|`src/live.js`|the bridge: per-session live state, `sessionRegistry`, `window.OMP_BRIDGE`|
|`src/adapter.js`|pure RPC ↔ UI shape transforms|
|`src/app/*.js`|pure logic modules (`window.OMP_*`), each with a regression test|
|`src/app/use-*.jsx`|React hooks wiring bridge state to UI|
|`src/app/terminal.js`|pure terminal-panel state over Rust's `TerminalStatus`, clipboard chords, shell label, Settings shell-menu rows, height clamp (`window.OMP_TERMINAL`); which keys leave the xterm is `app/keymap.js` `guestShouldBypass`|
|`src/app/terminal-stream.js`|pure output-sync reducer: instance adoption, seq dedupe, gap → replay, queue while replaying, acks (`window.OMP_TERMINAL_STREAM`)|
|`src/app/terminal-xterm.js`|builds a tab's xterm (OSC 8 off, fit addon, key routing), ConPTY option, theme colours, exit/failure lines (`window.OMP_TERMINAL_XTERM`)|
|`src/app/use-terminal.jsx`|per-tab xterm instances, data/exit listeners, runs the stream reducer's actions (replays, writes, acks), spawn/fit (the hook, not pure)|
|`src/app-live.jsx`|sole React root|
|`src/design/`|UI components: `chat/`, `subagents/`, `ui/` (primitives, markdown), `settings/` (Settings page: controls, page, custom rows, shortcuts editor), `tweaks/` (`use-tweaks.js`: tweak storage), `git/` (git browser), `layout/` (CSS partials via `_index.css`)|
|`src/app/settings-schema.js`, `src/app/settings-tab.js`, `src/design/settings/`|Settings page sections/rows/search (`OMP_SETTINGS`), the Settings app tab's state (`OMP_SETTINGS_TAB`), custom rows via `OMP_SETTINGS_ROWS` (`docs/architecture/settings.md`)|
|`src/design/terminal-panel.jsx`|terminal panel chrome (head, drag handle, xterm mount node) and the per-tab panel list|
|`src-tauri/src/remote/`|phone remote access (`docs/architecture/remote-access.md`): `manager.rs` + `manager/` (settings, lifecycle, status and phone operations), `server.rs` + `server/` (TLS listener, routes, transport), `http.rs` + `http/` (bounded reads, admission, responses), `ws.rs` + `ws/` (authentication/pump, frames, messages), `hub.rs` + `hub/` (publication, state, connections, actions), `tls.rs`/`net.rs`, `devices.rs`/`pairing.rs`, `tracker.rs`, `push*.rs`, `lock.rs` (screen-lock probe for "only while locked" pushes: `CGSession` on macOS, WTS session flags on Windows, logind `LockedHint` on Linux), `commands.rs`/`bridge.rs`|
|`src/remote/`|the phone page (plain JS, embedded by `assets.rs`): `client.js` (pure protocol helpers), `scanner.js` (camera), `sessions.js` (header/sheet), `transcript.js` (rendering, asks, scroll), `remote.js` (transport/composer coordinator), `sw.js`, `index.html`, `remote.css`|
|`src/app/remote-view.js`, `src/app/use-remote.jsx`, `src/design/settings/rows-remote-{shared,server,phones}.jsx`|bounded phone views + serial action dispatch (`OMP_REMOTE_VIEW`), the publisher hook, shared remote settings state/controls and the server/phone row families|
|`src/app/path-setting.js`, `src/design/path-setting.jsx`|a Rust-owned program path setting in Settings (terminal shell, browser Chromium): menu rows (`OMP_PATH_SETTING`); `usePathSetting` / `PathPicker`|
|`src/index.html`|script load order = dependency graph|
|`scripts/`|`build-frontend.mjs` (`dist/`), `vendor-react.mjs`, `vendor-xterm.mjs`, `omp-sim.mjs` (omp RPC simulator replaying a session file: full/delta `message_update`, pacing, timing log)|
|`tests/`|JS regression scripts|
|`.github/`|`workflows/{tests,ci,release}.yml`, `scripts/updater-json.mjs`|

## Architecture

Three layers:

1. **Rust (`src-tauri/src/`)** — `AgentBridge` = `HashMap<session_id, BridgeInner>`. Per-session stdin lock so writes don't serialise through the map. Reader emits `agent://line/{id}` per stdout line, `agent://exit/{id}` (empty payload = clean, non-empty = reason) — except a startup death before any frame ever arrived, where the reader substitutes a bounded stderr tail (`reader::StderrTail`) for the empty payload so a silent crash isn't read as a clean exit; also cached in `last_errors` so a background tab's death is visible from `session_status`. `Drop` + `stop_session` kill children — no orphans on hot-reload.

2. **Bridge (`src/live.js`)** — listens to `agent://line/{id}` for the active session only. Holds per-session live state and a `sessionRegistry` (tabs). Tab switch: snapshot → tear down listeners → restore (or reset+`_initFetch`) → re-listen. A background tab's frames are not processed until it is activated. Exposes `window.OMP_BRIDGE` (commands + `onUpdate`) and legacy `window.OMP_DATA`.

3. **React (`src/app-live.jsx` + `src/app/` + `src/design/*/`)** — `useBridgeSnapshot` (`src/app/use-bridge-snapshot.jsx`) mirrors `OMP_BRIDGE.onUpdate` into hooks. Keyboard shortcuts: `src/app/use-keymap.jsx` (registry `src/app/keymap.js`, which also holds `guestShouldBypass`, the one rule for which keys leave a focused terminal or browser page for the app). Constants/framing strings: `src/app/constants.js`.

One tab = one omp process (`--profile <id>`; `default` = no flag). `lib.rs::setup` spawns nothing; the frontend reopens the previous run's tabs.

## Cross-feature invariants

- A new RPC command sent from `live.js` must be added to `ALLOWED_COMMAND_TYPES` (`src-tauri/src/agent/mod.rs`), or `send_command` rejects it. A Rust test scans `live.js` for the literal `{ type: "…"` form.
- `OMP_BRIDGE.abort()` must stay **id-less**: a pending-id match returns from `_handleResponse` before the `abort` branch (auto-rename and goal-mode bookkeeping depend on it).
- A desktop-made transcript entry must never carry a `ts` (the get_messages merge matches by omp message `ts`).
- Any new child process that must resolve a user-installed binary goes through `child_path` (`child_path::apply_child_path` for a `std::process::Command` started by absolute path outside a project, as Chromium's launch does; `child_path::child_path()` for a builder that is not one, as the terminal's `portable-pty` `CommandBuilder` in `terminal/shell.rs` does; `child_path::child_path_dirs()` to search those folders yourself, as the shell list and Chromium discovery do) — the MSI relaunch has a machine-only PATH. A child started in a project folder must not find its program through an empty or relative PATH entry, which would resolve inside the project: omp and `git` are located as an absolute path in `child_path::child_path_dirs()` (the folders of `child_path::trusted_child_path`) with `child_path::locate_program` and spawned by that path with those folders as their PATH (`spawn::Omp`, `workspace::git`), and widget plugins get `child_path::apply_trusted_child_path`; all pass that trusted PATH on.
- `omp --profile <unknown>` silently creates that profile's directory: resolve a profile through `profiles::resolve_owned` before any `omp --profile` run. Agent dir per profile: `profiles::agent_dir_for`.
- omp's `agent.db` (WAL): open read-only, never `immutable=1`, never `SQLITE_OPEN_CREATE`, short `busy_timeout`, one connection per query.
- Paths reaching the frontend from the OS are canonicalised in Rust (`external_open::canonical_folder`); tab paths and recent entries must stay in that form.
- `bundle.createUpdaterArtifacts` lives only in `src-tauri/tauri.release.conf.json`. The updater signing key lives only in the `TAURI_SIGNING_PRIVATE_KEY` repo secret and is **never** committed; rotating it strands every installed copy.
- Relaunch after update skips `Drop` (so does `RunEvent::Exit`): both go through `lib.rs::kill_child_processes`, where `remote::bridge::stop` stops the remote server and phone sockets first, `AgentBridge::shutdown_all` kills omp children next, `BrowserManager::shutdown_all` the tabs' headless Chromium next, `WidgetHost::kill_all` the running widget plugins next and `TerminalManager::shutdown_all` every terminal shell tree last. Don't override the updater plugin's `on_before_exit`.
- `close_tab` (`live.js` `_closeTab`, behind `closeSession`, a failed start's rollback and a respawn whose tab was closed meanwhile) is the **only** path that ends a tab: it stops omp, the tab's browser, widgets, git watcher and terminal together (`lib.rs` `end_tabs`). `close_all_tabs` does the same for every terminal tab registered when it starts (the tab set; their browsers end side by side through `BrowserManager::release_many` and their shells together through `TerminalManager::close_tabs`, a tab registered meanwhile is left alone) and is invoked once at webview boot, before `_restoreOpenTabs` (tab ids are never reused across a reload, so anything registered then is an orphan of the previous document). `stop_session` is for respawns under the same tab id only (profile switch, approval-mode restart) and must **not** touch the browser or terminal: the tab keeps its browser and shell while omp restarts under the same id. `start_session` registers the terminal tab (`TerminalManager::register_tab`) before it spawns omp, and fails when the tab's browser can't be allocated (`allocate_if_available`; only an app run without managed browsers at all starts omp without the overlay).
- Terminal policy lives in Rust (`docs/architecture/terminal.md`): the webview sends only a tab id, keystrokes, sizes, acks and replay cursors — never a cwd or shell path for a spawn. The shell setting is `<app config>/terminal.json`, written only through `terminal_set_shell` / `terminal_pick_shell` (both `SettingsStore::set_shell`: validated as an absolute path to an executable, `program_setting`); no `localStorage` copy. The Settings → Terminal shell menu sends `""`, a path from Rust's installed list (`terminal/shells.rs`) or the stored setting back, and "other…" gets its path from the native dialog in Rust; `terminal_set_shell` itself accepts any path that passes validation.
- Every omp spawn resolves its `--approval-mode` through `ApprovalModeStore::resolve` in `start_session`; the frontend never sends a mode. A mode change restarts omp through `live.js` `_respawnSession` with `--resume` (idle tabs at once, busy tabs at turn end), never through `close_tab` (`docs/architecture/approval-mode.md`).
- Git reads go through gix in `git_browser/` (and `git.rs`, `widgets/context.rs`), never a `git` subprocess; the `git` binary runs only for `workspace::accept`/`reject` (index/worktree mutation). The webview sends only a project path, a project-relative (or an edit card's) file path and a sha — never git arguments (`docs/architecture/git-browser.md`). A read that can reach git's filter pipeline (status, a work-tree file) opens the repo through `git_browser::open`, which drops the filter drivers the repository's own config defines, and never lets gix descend into a submodule's work tree (its config is out of `open`'s reach) — otherwise previewing an extracted repository runs its commands. gix runs the remaining drivers (and `git`, to find its installation config) itself: every discovery goes through `spawn_gate::discover`, which hands back the guard with the repository, and a read holds it as long as it reads (`git_browser::open` passes it on).
- A tab's browser (`src-tauri/src/browser/`) belongs to the tab, not to its omp process: `stop_session` (profile switch, approval-mode restart) never touches it, and the respawned omp gets the same overlay and Chromium; only tab close (`close_tab` / `close_all_tabs`) and `kill_child_processes` end it. Browser policy lives in Rust like the terminal's: the webview sends only a tab id, sizes, input, page URLs (allowlisted in Rust), page tab ids, frame acks and pick rects — never a browser path for a launch. The Chromium setting is `<app config>/browser.json`, written only through `browser_set_path` / `browser_pick_path` (`browser::SettingsStore::set_path`: validated as an absolute path to an executable, `program_setting`) and read at each launch; no `localStorage` copy. A stored path that stops working is a launch error, never a fallback to another browser.
- Every child process starts through `spawn_gate.rs` (`docs/architecture/browser.md`): `spawn_gate::spawn`/`output`/`status`, or a spawn made for us (portable-pty, `open`, gix) under `spawn_gate::shared()`. Chromium's launch holds the gate exclusively while its CDP pipe ends could reach another child (Windows hands every inheritable handle to every child created then; macOS sets close-on-exec on a new pipe only after creating it), so a spawn outside the gate could inherit a way into the browser past the broker. `clippy.toml` rejects `Command::spawn`/`output`/`status`, `SlavePty::spawn_command`, `open::that*` and `gix::discover`/`open` elsewhere (tests are exempt in `lib.rs`); that is only checked by the local clippy command under **Verify** — CI runs no clippy — so run it, and give a new spawning dependency an entry there.

## Frontend load order (`src/index.html`)

Script order **is** the dependency graph; there is no resolver to catch ordering bugs. Full rationale per file: `docs/architecture/frontend-load-order.md`.

- Order: vendored libs (React, Babel, marked, hljs) → `app/marked-setup.js` → plain `app/*.js` IIFE modules → `tweaks/use-tweaks.js` → `design/ui/` primitives → `design/chat/` → `design/subagents/` → `design/*` (composer, chrome, panels, modals, conversation tree, `settings/`) → `model-names.js` → `app/turn-status.js` → `app/session-prefs.js` → `app/transcript-merge.js` → `adapter.js` → `app/session-title.js` → `app/stream-delta.js` → `live.js` → `app/use-*.jsx` hooks → `app-live.jsx` last.
- A file that **destructures a global at top level** (`const { X } = window`) must load after the file defining it — misordered, it silently yields `undefined`. A lookup inside a function body is late-bound and order-insensitive.
- Plain `app/*.js` modules that `live.js` reads at its top-level IIFE init must load before `live.js`.
- Babel scripts share one top-level scope: destructure under a unique alias (`_TD_Fmt`), never a second `const` of the same name.
- Deferred `dist/` scripts run *before* DOMContentLoaded/load, Babel's after: JSX must not depend on either event or on `document.readyState`.
- No inline `<script>` or `on*=` attribute in `index.html` (release CSP; the build fails on them). Keep the Babel/React tags in their plain form: `build-frontend.mjs` matches them literally.
- When adding a file, insert it at the correct point — never append; after a split, update the order in dependency order.
- NEVER hand-add a query, fragment, whitespace, `&`, `\`, or CDN URL to an asset reference in `src/index.html`/`src/**/*.css`, and never `@import` anything but a bare app-relative quoted or `url()` path — `build-frontend.mjs` appends the `?v=<version>` stamp and fails closed on anything else (`docs/architecture/release-frontend.md`).

### IIFE rule

Plain `<script>` tags share document top-level scope; Babel `type="text/babel"` scripts intersect with it via destructures. Every plain script declaring top-level `const`/`function`/`class` **MUST** be `(function(){ …; window.X = X; })();` — see `app/constants.js`, `app/settings-tab.js`, `tweaks/use-tweaks.js`. Bare `window.X = {…}` assignments are fine (`model-names.js`). Babel-transformed files do not need wrapping.

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

- `omp --mode rpc-ui`, **not** `omp --rpc` (latter falls through to TUI, floods stdout with ANSI).
- Browser settings overlay: `agent/spawn.rs::omp_args` appends one `--config=<path>` token **last**, after `--approval-mode=<mode>` and profile/resume/cwd. Preserve this order and keep the overlay browser-only (`browser.cdpUrl` plus `browser.relay: false`, so an enabled omp relay can't outrank the panel's browser) so it does not change the tab's approval policy or replace its normal profile settings.
- Browser annotation overlay (`docs/architecture/browser.md`): render with CSSOM (`element.style`) and `textContent` only, so strict page CSP/Trusted Types cannot block it. Install in the `omp-annotate` isolated world **per attached page target**, including the current document and later navigations; the binding belongs only to that world's tracked contexts, and a pick counts only right after a mouse release the panel itself sent.
- Browser CDP endpoint (`docs/architecture/browser.md`): Chromium runs with `--remote-debugging-pipe` and opens no port; the broker (`browser/broker/`) is the only way into it, for the panel and the agent alike. Never add `--remote-debugging-port` or any other way into Chromium besides the broker: the placeholder port is the only listener, and it checks the peer's OS user (`proxy/peer.rs`) before reading anything, failing closed where it cannot tell. The proxy tap observes intent without changing transport: the pump threads only run the bounded queueing (`proxy/feed.rs`) before forwarding; JSON parsing and the follow callback stay on the observer thread, fed by a nonblocking bounded queue. Tap failure disables observation for that connection, never forwarding; the tap must never block or alter what is forwarded. Request admission (`proxy/http.rs::admit`) and routing run before anything can launch Chromium.
- Blank-line stdout: `agent/reader.rs` distinguishes EOF (`(0,_)`) from blank lines and strips CR/LF. Don't revert to `reader.lines()` with blanket `_ => break` — silently kills reader on first blank line.
- Window controls use document-level click delegation (React may mount before or after `DOMContentLoaded` — after in `tauri dev`, before in release `dist/`); a `querySelector` in `_setupWindowChrome` would be timing-dependent.
- `set_model` response **must** call `notify()` immediately, else next `turn_start` re-emits stale `state.model` and UI reverts.
- Commands and skill invocations must reach omp as an RPC `prompt` (`streamingBehavior` mid-stream): omp's `steer`/`follow_up` frames skip command *and* skill dispatch. `OMP_SLASH.isCommandInvocation` (`app/slash-commands.js`) is the one predicate for it — a known leading command, or a `/skill:<name>` token anywhere in the draft that omp would invoke (#30, ported from omp's `parseSkillInvocation`/`allowsSkillTokens`) — used by `live.js` `steer`/`followUp` (`send` always goes out as a `prompt`; `OMP_SLASH.queuedFrame` builds the frame) and by `OMP_SLASH.routeSubmit`, which `app-live.jsx` uses to route a submit and for plan-mode framing. The classification is of the typed draft, before browser annotations (page data) merge in. A `/` after other prompt text opens a skills-only popup (`midPromptSlashToken` + `skillMenu`, omp's `midPromptSkillTokenMatches` rules).
- Long `if/else if` chains in `_handleResponse` (`live.js`): a single misplaced `}` cascades — `_handleResponse` never closes, IIFE syntax errors, `window.OMP_DATA` never set. Re-verify brace structure when inserting branches.
- The get_messages merge after a tab switch (`mergeTranscript`, `app/transcript-merge.js`) matches entries by omp message, not by position: a user or assistant entry built from an omp message carries that message's `timestamp` as `ts` (live: `message_start`/`message_end`, a `message_update` only through the dropped-replay copy `streamSnapshot`, and the echo that dedupes a `send` bubble; get_messages: `adaptAgentMessages`) and takes the persisted copy with the same kind and `ts`. Everything else stays in place — cards, notes, job rows, bubbles of messages the adapter skips (one that went straight to a tool call) or omp dropped from its context (a retried attempt, a refusal, an output-less failure after a rebuild). A desktop-made entry must never carry a `ts`. Persisted entries with no live counterpart (frames lost while the tab was in the background, the history of a tab that had none yet) go in at their place in omp's order, and before a trailing `send` bubble still waiting for its echo; once `_trimMessages` cut the head (`state.trimmed`, per tab), those before the first message both sides share stay out. omp's order, never `ts` order: a steer or follow-up is stamped when sent but joins the context when delivered, after later-stamped replies. omp adds a message to get_messages only at its `message_end`, so a streaming entry with a copy is stale (its end frame was lost): the copy replaces it, and the handler drops `streamingBubble` when its `ts` is among the raw messages. A delta `message_update` carries no timestamp: a bubble left streaming by lost frames that receives another `messageId`'s updates takes that message's `ts` from `streamSnapshot` when the copy names it, otherwise only at its `message_end`. Positional pairing shifted every later entry as soon as the two sides disagreed.
- Frameless window via DWM: `decorations: false` + `platform.css` strips outer padding/shadow under `.tauri-native`. CSS uses `color-mix(in oklab, …)` — needs WebView2 ≥ 101. The status bar's and toolbar's narrow-width collapse uses CSS container queries (WebKitGTK ≥ 2.40, WebView2 ≥ 105); an older webview only clips the row.
- Strict CSP, two variants that differ in one token. `tauri.conf.json` (dev): `default-src 'self'; script-src 'self' 'unsafe-inline'; …` — `'unsafe-inline'` only because Babel runs its output as inline `<script>`s. `tauri.dist.conf.json` (release) overrides it with `script-src 'self'`, so an inline event handler that ever reaches the DOM (`<img onerror>`) cannot run where users are; `build-frontend.mjs` enforces the one-token difference, so edit both files together. Neither has `'unsafe-eval'`: nothing uses `eval`/`new Function`. Tauri's own init scripts are injected natively and are unaffected. Asset protocol disabled. `tauri-plugin-shell` deliberately removed. Don't add CDN tags or `convertFileSrc()` without revisiting both.
- Markdown is rendered with `dangerouslySetInnerHTML` (`ui/markdown.jsx`, `ui/plan-annotations.jsx`) into an origin that exposes `window.__TAURI__`, so `app/marked-setup.js` renders **all** raw HTML — block and inline — as escaped text. That takes two renderers: `html`, and `text` for `escaped: true` tokens — an inline `<pre>`/`<code>`/`<kbd>`/`<script>` still flips marked's lexer into raw-block mode, whose text tokens carry unescaped source that the default renderer emits verbatim (escape them the way marked escapes other text, keeping `&…;` references, or `&amp;` shows literally for the rest of the message). Don't add a tag allowlist or a hand-written sanitizer; the dev CSP still runs inline handlers, so the renderer is the only guard in `tauri dev`. `test-markdown.mjs` loads the vendored marked plus the setup file and fails on any element or attribute the renderers don't produce — rerun it after every marked upgrade.
- Code blocks carry a copy button (#33) emitted by marked-setup.js's `code` renderer as handler-less markup — the release CSP forbids inline handlers. The markdown container's `onClick` (`copyCodeBlockClick`) resolves it and copies the block's `<code>` `textContent`, which is the fence verbatim because hljs only adds spans. Its icon and label are CSS pseudo-elements, so a manual selection never picks up button text. `test-markdown.mjs` allowlists exactly `button`/`aria-label` for it and checks the copied text.
- Markdown *source* built from arbitrary text — a refused message (`message-queue.js` `failureNote`) — wraps it with `OMP_MARKDOWN.fenceCode`, a fence longer than any backtick run inside. A fixed ```` ``` ```` fence lets an embedded fence line close the block, and everything after it renders as markdown. `test-markdown.mjs` covers it.
- Thinking levels are omp's. The composer's thinking pill opens a menu (`design/thinking-menu.jsx`, #10) of `get_available_thinking_levels` — the levels the tab's current model supports, `off` first, out of `off | minimal | low | medium | high | xhigh | max` (omp leaves its `auto` selector out of the list) — fetched on every open and again on a model change while open; a pick is `set_thinking_level`. `app.thinking.cycle` (Shift+Tab) and the desktop's own `/thinking` palette entry still *cycle*: `cycle_thinking_level` goes off → auto → each level → off, and its response carries the new selector (`auto` included), or `null` when the model has no thinking. omp's own builtin is `/effort [level]` (18.5.0+); omp has no `/thinking` builtin. The displayed level follows omp's `thinking_level_changed`, which every change emits — a pick (the only confirmation `set_thinking_level` gets; omp may clamp it), a cycle, a typed `/effort <level>`, a model switch re-clamping the level, `auto` resolving per turn — and `get_state` (activation, `agent_start`/`agent_end`/`turn_end`, `config_update`). Both carry the *effective* level: in `auto` mode the pill says `auto` only until the next of them, then what auto resolved to — so the menu sends a pick even for the ticked row, which is how an auto-resolved level gets pinned. An unset level reads as `off`, as in omp's own UI. Never send a level omp did not list: `set_thinking_level` does not refuse an unknown one, it resolves it to no level at all. A future `set_event_filter` list must keep `thinking_level_changed`.
- No CDN dependencies. React/ReactDOM/Babel/marked/hljs/xterm/jsQR are vendored (jsQR, `src/remote/jsQR.js`, is the unminified webpack UMD build of `jsqr@1.4.0` with a header recording version and SHA-256 — never hand-edit the library body). App must work offline. Babel, marked (`lib/marked.umd.js`) and hljs (`@highlightjs/cdn-assets`) are copied verbatim from npm. xterm.js (`src/xterm.js`, `src/xterm.css`, `src/xterm-addon-fit.js`) is copied from the `@xterm/xterm`/`@xterm/addon-fit` npm packages by `node scripts/vendor-xterm.mjs <xterm version> <addon-fit version>` (installs them into a temp dir — they are not dependencies; the two `.js` files lose the sourcemap comment and gain a `/*!` version + MIT license banner, `xterm.css` is verbatim) — never hand-edit them; the banner records the version, rerun the script to bump it. React 19 ships no UMD build, so `src/react{,-dom}.{development,production}.js` are generated: `bun scripts/vendor-react.mjs <version>` writes all four — never hand-edit them, and always commit the four together (a stale pair would mean `tauri dev` and `dist/` builds run different React versions). Since marked 15 renderers receive *raw* token fields (`href`, `title`, `lang`, raw HTML, autolink `text`), so the renderers in `app/marked-setup.js` escape them themselves — and decode character references in a link's `href` *before* the scheme check, or `&#106;avascript:` slips through as a relative URL.
- `tauri-plugin-single-instance` must stay the **first** plugin registered, and is deliberately `cfg`'d to Windows/Linux only — on macOS `LaunchServices` already reuses the running instance, and the plugin would fight it.
- The main window's `"dragDropEnabled": false` (`tauri.conf.json`) is what lets the composer take dropped images (#50): with Tauri's native file drop on, Tauri takes every file drop before the page sees it, on every platform (on Windows it swallows all HTML5 drag events). Nothing listens to `tauri://drag-drop`; a feature that needs dropped *paths* must not flip it back without moving the image drop over. With it off, the webview's own drop handling is live: `app-live.jsx` refuses a file dropped outside the composer and a link dropped off an editable field (`OMP_IMAGES.refusesStrayDrop`), so a drop never navigates the webview or opens a link in the system browser through `navigation_guard.rs`.
- Tauri's built-in Linux desktop template has a bare `Exec={{exec}}`: without `src-tauri/packaging/omp-desktop.desktop`'s `%F` the folder the user picked never reaches argv and "Open with" silently opens an empty app. Same trap for the `MimeType` line — dropping it removes the app from the file manager's menu entirely, and dropping its `{{mime_type}}` half would silently strip any future `fileAssociations`/deep-link registration from the Linux entry alone.
- `src-tauri/packaging/windows-folder-verb.wxs` hardcodes the `Open with OMP Desktop` label and re-derives `Win64` (preprocessor defines don't cross `.wxs` files; a 32-bit component would write to `Wow6432Node`, where 64-bit Explorer never looks). Keep the label in sync with `productName`.
- `std::env::args()` **panics** on a non-UTF-8 argument, and a Linux folder name is an arbitrary byte string that `%F` passes verbatim — the launch-argv ingest in `setup` must stay on `args_os()`, or "Open with" on such a folder kills the app at startup instead of logging one dropped request. Only the cold start is protected: `tauri-plugin-single-instance`'s *sending* process collects `std::env::args()` itself, so a forwarded open on such a folder aborts that process before anything reaches us (plugin limitation, not ours).
- Rail widget plugins (`docs/architecture/widgets.md`): **every** spawn is preceded by a fingerprint check against the approval store — no path may start a plugin without it — and runs the verified copies that check hashed (`widgets/snapshot.rs`), never a checked script path. Triggers, timers, matching and run queues live in Rust (`widgets/schedule.rs`), never in React or `live.js`; the frontend sends only plugin ids, an approval fingerprint and view state (`widgets_set_view`), never a path, command, trigger or context. `WidgetHost::kill_all` sits beside `AgentBridge::shutdown_all` in `kill_child_processes`, called on the updater relaunch path (which skips `Drop`) and on `RunEvent::Exit`; drop it and a relaunch orphans running plugins.
- Remote access (`docs/architecture/remote-access.md`): the phone page must load `highlight.min.js` before `marked-setup.js` (the HTML escaping is installed only when `window.hljs` exists; without it assistant markdown renders raw HTML into a page that holds the device token). The tracker hook (`remote/tracker.rs` `on_frame`, called from the stdout reader) must stay O(1) and non-blocking: no I/O, no scans, sinks only enqueue. Push subscriptions are accepted only for the endpoint allowlist in `push_subs.rs`; never widen it or send to a stored URL outside it. `remote_apply_settings` takes the complete settings object: send everything, never a partial.

## Code style

**General:**
- Follow existing architectural patterns before introducing new ones. Optimize for clarity first, then allocation efficiency.
- Run fmt + lint locally before finalizing any change. Don't ship code that fails fmt or clippy.
- Only format files you actually modified. Never do bulk formatting-only rewrites.
- Prefer surgical `edit` over full-file `write` when the file already exists. Full rewrites only when (a) creating a new file, (b) >~70% of lines genuinely change, or (c) restructuring would require so many anchors that `edit` becomes brittle. Never rewrite a file just to change a few lines — it loses formatting, drops invariants you didn't notice, and bloats diffs.

**Rust:**
- **Toolchain/edition:** edition **2021**, stable toolchain (clippy only is nightly). No `rust-version` key — check `src-tauri/Cargo.toml` before using a newer-edition or recently-stabilised feature; don't assume 2024 idioms (`gen` blocks, RPIT lifetime capture changes) are available.
- **Verify before finishing a task:** `cargo fmt` → `cargo test --locked` → `cargo +nightly clippy --all-targets --all-features -- -W clippy::pedantic -W clippy::nursery -D warnings`. Pedantic+nursery is stricter than the generic `clippy -D warnings`; `redundant_clone` and `too_many_arguments` fire here and are hard errors.
- **Errors:** `thiserror`/`anyhow` are deliberately *not* dependencies. Tauri serialises command errors to JS, so the IPC boundary is `Result<T, String>` — most `#[tauri::command]` fns; the rest return `ProfileList`, `Option<String>`, `Vec<String>`, or nothing. Internal helpers match it (`json_store::with_lock_str` exists purely to tunnel `String` errors through `io::Error`). Add `thiserror` only alongside a genuine library-shaped module with variants a caller matches on — not to restyle existing `String` errors.
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
- **Async:** Tauri owns the tokio runtime; this crate spawns no tasks of its own. Never hold a `std::sync::Mutex` guard across an `.await` — the existing locks (`AgentBridge.sessions`, `ProfileStore.cache`, `RuleBook`) are all acquired and dropped inside synchronous blocks; keep it that way. Long/blocking work goes through `spawn_blocking` (see `list_saved_sessions`, `git_browser_status`).
- No `unsafe` without a `// SAFETY:` comment. It lives in exactly seven production modules: `supervisor.rs` (Win32 job objects — `CreateJobObjectW`, `SetInformationJobObject`, `AssignProcessToJobObject`, `CloseHandle`, also for the terminal's shell via `attach_process`; `libc::kill` on unix; `pid_is_alive` — `kill(pid, 0)` on unix, `OpenProcess`/`GetExitCodeProcess`/`GetLastError` on Windows — used by `json_store.rs`'s lock takeover, the browser's instance pruning and the widget run-directory pruning; `kill_group_if_leader` — `getpgid`/`getpgrp` plus a group `SIGKILL`, never the app's own group — for the browser's orphan reaper), `terminal/kill.rs` (`libc::kill`/`getsid`: kills a terminal by session id; `libc::waitid`: observes the shell's exit without reaping it; `libc::proc_listallpids` on macOS; the tests' `process_exists` probe), `program_setting.rs` (`libc::access(X_OK)` in `is_executable_file` on unix: whether this user may run a file, as `execvp` decides it; std has no safe form), `browser/process/pipe.rs` (Chromium's CDP pipe: `pre_exec` with `fcntl`/`dup2`/`close` onto fds 3/4 on unix; `SetHandleInformation` on Windows, under the exclusive spawn gate), `browser/proxy/peer.rs` (the peer's OS user: `GetExtendedTcpTable`, `OpenProcess`/`GetCurrentProcess`/`GetProcessTimes`/`OpenProcessToken`/`GetTokenInformation`/`EqualSid` on Windows, the opened handles adopted by `OwnedHandle::from_raw_handle`; `geteuid` on macOS), `remote/net.rs` (`libc::getifaddrs`/`freeifaddrs` on unix: enumerates active non-loopback IPv4 interfaces) and `remote/lock.rs` (the screen-lock probe — macOS: `cast_unchecked` of the `CGSessionCopyCurrentDictionary` session dictionary to its CFString → CFType key/value types; Windows: `WTSQuerySessionInformationW(WTSSessionInfoEx)`, an unaligned read of its `WTSINFOEXW` and the level-1 union field, `WTSFreeMemory`; Linux needs none, zbus is safe). New test code calls their helpers (`kill::process_exists`, `supervisor::pid_is_alive`) instead of FFI of its own; the older widgets tests still carry their own `kill(pid, 0)` probes and a supervisor test SIGKILLs its leaked grandchildren directly. Prefer the safe std API when one exists — the unix process-group setup uses `Command::process_group(0)`, not FFI, and the pipes themselves come from `std::io::pipe`.
- Minimise temporary allocations in hot paths (reader loop, per-line dispatch, IPC payload construction).
- Idiomatic Rust over clever abstractions. Preserve existing module/naming conventions.
- Module-level `#![allow(clippy::needless_pass_by_value)]` in `lib.rs` is intentional — Tauri `#[command]` requires owned types.

**Frontend:**
- Prettier for JS/TS; respect any present ESLint config. Use repo-configured npm scripts when present (`npm test` runs the JS regression scripts; there is no JS lint pipeline).
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

- `.github/workflows/tests.yml` — the shared test gate, a reusable workflow (`workflow_call`): `cargo test --locked` on win/linux/mac (with `OMP_REQUIRE_CHROMIUM=1`: a runner without Chrome fails the real-Chromium tests instead of skipping them), plus `npm test`. It is called by both workflows below, so CI and releases can't drift apart.
- `.github/workflows/ci.yml` — runs `tests.yml` on every PR, and on pushes to master that touch `src-tauri/**`, `src/**`, `tests/**`, `package.json`, `scripts/**`, `.github/scripts/**` or the workflows.
- `.github/workflows/release.yml` — `tests.yml` first; nothing builds unless it passes. Then a signed `tauri build` per platform, then one `updater-json` job that assembles `latest.json` via `.github/scripts/updater-json.mjs`, with the matching CHANGELOG section as notes. The rationale and the guards are documented in the workflow header and the script. Users see an update only once the draft is published. Actions minutes are limited: verify in-progress branches locally (`npm test`, `cargo test`, `npx tauri build --no-bundle --config src-tauri/tauri.dist.conf.json`); a dry run (`gh workflow run release.yml --ref <branch> -f tag=vX.Y.Z-rc.N`, then delete the draft) only when the user asks for one.

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
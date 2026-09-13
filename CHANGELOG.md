# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/).

## [Unreleased]

### Added

- Event journal + replay — each session keeps a bounded 256-event ring (`agent/journal.rs`); switching back to a tab after missing live events now calls `replay_events` and merges the gap instead of leaving the UI stale, with a `dropped` flag surfaced when the ring has already evicted the needed range.
- Credential redaction — `sanitize_frame`/`sanitize_line` in `agent/reader.rs` recursively strip known-sensitive keys (`authorization`, `apikey`, headers, tokens, …) from every RPC frame before it reaches `agent://line` or gets logged.
- Desktop approval rules — session- and project-scoped "always allow" rules for tool-approval prompts (`src-tauri/src/approval.rs`). Approval-prompt ask cards gained "Allow for this session" / "Always allow in this project" buttons; matching prompts are auto-answered on stdin without round-tripping through the UI. Rules are listed/revocable from a new rules panel (bridge methods `grantApprovalRule`/`revokeApprovalRule`/`listApprovalRules`). Spawn now passes `--approval-mode write` (probed against `omp --help` first, so older `omp` builds fall back to prior behavior).
- Process-tree supervision — `agent/supervisor.rs` puts each spawned `omp` in a Windows Job Object / Unix process group so `stop_session` and app exit kill the whole tree, not just the direct child, eliminating orphaned grandchildren.
- Command allowlist — `AgentBridge::send` validates the RPC command `type` against a fixed allowlist before writing to stdin, rejecting anything unrecognized instead of forwarding it blind.
- Atomic write + snapshot/rollback kit — `src-tauri/src/json_store.rs` adds `write_atomic` (temp file + rename, with orphan sweep), a bounded `SnapshotRing`, and an advisory cross-process file lock with stale-owner takeover; used by the approval rules store so a crash mid-write can't corrupt a project's rules file under `<app config>/approval-rules/`.
- Workspace changes panel — new Changes tab (`workspace_status`/`workspace_diff`/`workspace_accept`/`workspace_reject` commands, `src-tauri/src/workspace.rs`) shows `git status`/`git diff` for the active session's working tree with per-file accept/reject, capped at 200 files / 256 KiB / 2000 lines per diff to keep the UI responsive on large changesets.
- Session-identity discipline — saved-session parsing now prefers the filename-derived UUID over whatever `session.id` the JSONL body happens to contain (`canonical_id_from_stem`), so a copied/renamed session file can't collide with or shadow another session's history.
- Four-state run projection — the tab bar now shows a running/waiting-on-you/idle/failed dot per session (`runStateOf()` in `live.js`), so you can tell which background tab needs attention without switching to it.
- Method-aware ask cards — `confirm` and `editor` extension-UI prompts (previously silently auto-cancelled) now render as proper chat cards (yes/no buttons; multi-line textarea with Submit/Cancel), and `input` prompts moved from a blocking `window.prompt()` to the same chat-card treatment as `select`. Wire shapes were ground-truthed against the installed `omp` binary — `confirm` responds with `{confirmed: bool}`, not `{value}`.
- IME composition guard — Enter-to-send in the composer now ignores Enter keystrokes that are part of an IME composition (`e.isComposing` / `keyCode === 229`), so committing CJK/IME input no longer sends a half-typed message.
- Explicit `--cwd` spawn argument — `spawn_omp` now passes the project path explicitly instead of relying solely on the child's inherited working directory. Session storage is still resolved by `omp` itself from `PI_CODING_AGENT_DIR`.
- `docs/agents/evidence/` — `test-rpc.mjs --evidence` probes a real `omp` process, redacts and shape-summarizes its `get_state` response, and writes a golden reference file for what the RPC surface currently looks like.

### Fixed

- Ask cards could be answered twice, or answered after the runtime had already cancelled/superseded them — `answerAsk` (and the new `answerConfirm`/`cancelAsk`) now only send a response when a matching still-open message is actually found, instead of unconditionally posting to stdin.

## [0.1.3] - 2026-09-13

### Added

- Conversation history panel (`Ctrl+H`/`⌘H`, `/history` command, or the clock icon in the tab bar) — browse, search, and resume past omp sessions persisted under `~/.omp/agent/sessions`. Backend adds `list_saved_sessions` (async, off the Tauri main thread) and a validated `resume` path on `start_session`; `resume` values are checked against the sessions directory before being forwarded to omp's argv, rejecting flag-shaped or out-of-tree paths.

### Fixed

- Tab switch drops all tool cards from chat — `get_messages` returns only text entries; tool/ask/compact cards live exclusively in live event state. Fixed by merging `get_messages` ground-truth text into the existing snapshot (preserving tool cards in-place) instead of replacing `state.messages` wholesale. `activeToolCards` indices are rebuilt after merge so in-flight `tool_execution_update` events continue landing correctly.
- Minimap cell stuck pulsating after tab switch — `streamingBubble` restored from snapshot was never cleared when `get_state` reported `isStreaming: false` (turn completed while away); `_applyRpcState` now retires the bubble and strips `streaming: true` entries from `state.messages` immediately, before `get_messages` arrives.
- Model picker empty / no models listed — `get_available_models` returns ~2 MiB (837 models), overflowing the RPC v1 1 MiB physical-frame cap and failing with `RPC response exceeded the transport limit`, leaving `state.models` empty. The bridge now negotiates protocol v2 (`negotiate_protocol`) in `_initFetch` before the large fetches and reassembles the resulting `rpc_chunk` sequence (base64 byte-segments → strict UTF-8 → JSON) in `handleLine`. Reassembly validates chunkId/index/count/byteLength, rejects interleaved or duplicate frames, and enforces the 64 MiB ceiling.
- Built `.app`/`.dmg` shows an empty model picker (and no working session) when launched from Finder/Dock/DMG, while `tauri dev` works — macOS hands a GUI-launched bundle a minimal `PATH` (`/usr/bin:/bin:/usr/sbin:/sbin`) that omits Homebrew, so `Command::new("omp")` in `agent/spawn.rs` failed to resolve `/opt/homebrew/bin/omp`; the default session never spawned and `get_available_models` never ran. `spawn_omp` and the `rpc-ui` probe now override the child `PATH`, appending common install dirs (`/opt/homebrew/{bin,sbin}`, `/usr/local/{bin,sbin}`, `~/.local/bin`, `~/.cargo/bin`) after the inherited entries (de-duplicated, inherited PATH still wins).

## [0.1.2] - 2026-05-11

### Fixed

- macOS freeze (spinning beach ball + high CPU) when opening a project folder via the + button — `blocking_pick_folder` was called from a command-handler thread, deadlocking against the main RunLoop; switched to callback-based `pick_folder` with an async command and `spawn_blocking` channel bridge

## [0.1.1] - 2026-05-10

### Added

- `/login` command with OAuth provider picker (fetches providers via `get_login_providers` RPC)
- Ask tool rendered as inline chat bubble with `rpc-ui` mode support _(requires [can1357/oh-my-pi#994](https://github.com/can1357/oh-my-pi/pull/994) to be merged)_

### Performance

- Fixed 13×13 minimap grid (169 cells); oldest row of 13 messages evicted at turn boundary once the grid is full, keeping memory and render cost bounded in long sessions
- `React.memo` on all bubble components (UserBubble, AssistantBubble, ToolCard, AskBubble, CompactRow); only the live streaming tail re-renders per token — stable history bails out
- Stable `_id` stamped on every message object in `live.js`; bubbles keyed by `_id` instead of array index, eliminating remount/fade-in blink when the oldest row is evicted
- `useCallback` on `handleAnnotate` and `handleAskAnswer` in App to stabilize function-prop refs and preserve memo bailouts for AssistantBubble and AskBubble

## [0.1.0] - 2026-05-10

### Added

- Initial Tauri 2 shell: spawns `omp --mode rpc` per tab, no bundler, JSX transpiled in-browser via `@babel/standalone`
- GitHub Actions CI (cargo check + cargo test on win/linux/mac) and release pipeline
- Per-tab omp process isolation — one process per tab, preserved across switches via session snapshots
- Model picker as a separate bridge view with on-load fetch and refresh button
- Markdown rendering with syntax highlighting (marked v12 + highlight.js) in chat
- Plan mode: full intent → drafting → review → running → done lifecycle with inline block annotations
- Slash command palette with arrow-key navigation, fuzzy filter, and Enter execution
- `/new` command to start a fresh omp session in the current tab
- Steer: send a message to the agent mid-turn without waiting for completion
- Compact tool cards: full expand/collapse card showing live progress and final result
- Task/quick_task tool cards: collapsible subagent panel with live-stream view on row click
- Eval cell tool cards: stream code and output live; syntax highlight on completion
- Auto-scroll chat to bottom as the agent streams output
- Minimap: dense grid heatmap with chat-bubble cross-highlight and per-kind tooltips
- Long paste collapse into `[paste #N +K lines]` inline tokens in the composer
- macOS-style traffic light window controls on Windows (DWM frameless)
- Autosave toggle button in the status bar
- Font size slider in the tweaks panel (75–150%, step 5)
- Git branch chip in the title bar via `gix` + `notify`
- OMP icon pack v1 as app icons across all platforms
- MIT license

### Fixed

- Black screen on startup — disable Tauri CSP hash injection, remove Google Fonts CDN link
- Git HEAD watcher — watch `.git/` directory instead of `HEAD` file to survive atomic rename on Linux/macOS
- Window drag — replaced custom handler with `data-tauri-drag-region`
- Diff block overflow — contained within chat column width
- Composer textarea: single-line default via `field-sizing: content`; focus restored after send; textarea stays enabled during streaming for steer input
- Phantom textarea scrollbar hidden at min-height
- Window control symbols: always colored red/yellow/green, no hover background bleed
- Tweaks panel: persist settings to `localStorage`; retheme to use app CSS variables
- Token and context gauge percentages truncated to one decimal place
- Stream line accumulation — handle in-place growing lines without duplication
- ToolCard: remove duplicate `return` statement; expand individual subagent rows, not the card header
- Plan annotations always reaching the prompt; `sendFeedback` working with annotations and no body text
- Plan running→done state transition
- Message history preserved across tab switches
- Tab name retained from folder path when `omp sessionName` is absent
- `_handleResponse` in `live.js` — missing closing brace caused silent IIFE syntax error
- Thinking level values aligned to valid RPC set (`off | minimal | low | medium | high | xhigh`)
- Rust agent: race-safe sessions, lock-free per-session stdin writes, no orphan child processes on hot-reload

### Changed

- Project renamed from `omp-desktop` to `Oh My Pi Desktop`
- Split large files into focused modules: `agent.rs` → `agent/`, `app.jsx` → `app-live.jsx` + `src/app/`, monolithic CSS and chat/UI/tweaks components into dedicated directories
- Plan mode moved from a dedicated side panel into the chat timeline

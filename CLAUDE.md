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
| Probe omp RPC | `node test-rpc.mjs` |

`omp` must be on PATH (`%LOCALAPPDATA%\omp\omp.exe` on Win). No JS test suite. CI = `cargo check` on win/linux/mac.

## Architecture

Three layers:

1. **Rust (`src-tauri/src/`)** — `agent/` module:
   - `mod.rs` — `AgentBridge` public API (start/stop/send/last_error).
   - `inner.rs` — `BridgeInner` per-session: generation token, `Arc<Mutex<ChildStdin>>`, child handle.
   - `spawn.rs` — `spawn_omp` candidate resolution + Win `CREATE_NO_WINDOW`.
   - `reader.rs` — stdout/stderr threads + bounded `read_until_capped` (16 MiB).

   `AgentBridge` = `HashMap<session_id, BridgeInner>`. Per-session stdin lock so writes don't serialise through the map. Reader emits `agent://line/{id}` per stdout line, `agent://exit/{id}` (empty payload = clean, non-empty = reason). Tauri commands in `lib.rs`: `start_session`, `stop_session`, `send_command`, `session_status`, `open_project`. `Drop` + `stop_session` kill children — no orphans on hot-reload.

2. **Bridge (`src/live.js`)** — listens to `agent://line/{id}` for active session only. Holds per-session live state and a `sessionRegistry` (tabs). Tab switch: snapshot → tear down listeners → restore (or reset+`_initFetch`) → re-listen. Exposes `window.OMP_BRIDGE` (commands + `onUpdate`) and legacy `window.OMP_DATA`.

3. **React (`src/app-live.jsx` + `src/app/` + `src/design/*/`)** — sole React root. Uses `useBridgeSnapshot` (in `src/app/use-bridge-snapshot.jsx`) to mirror `OMP_BRIDGE.onUpdate` into hooks. Cross-cutting effects (theme on `<html>`, ⌘K) live there. Constants/framing strings in `src/app/constants.js`. Pure RPC↔UI shape transforms in `src/adapter.js` (no side effects, depends on `model-names.js`).

## Session model

One tab = one omp process. `default` session started in `lib.rs::setup`; new tabs via `OMP_BRIDGE.openSession(cwd)` → `start_session`. Tab switch preserves in-flight bubbles via `sessionSnapshots`; after re-listen, `get_messages` is called and `_handleResponse` merges persisted turns with cached `streamingBubble` (omp doesn't persist incomplete turns).

## Frontend load order (`src/index.html`)

Script order **is** the dependency graph:

1. Vendored libs: React, ReactDOM, Babel, `marked.min.js`, `highlight.min.js` + marked-wiring inline.
2. Tweaks: `tweaks/style.js`, `tweaks/use-tweaks.js` (plain, IIFE) → `tweaks/panel.jsx`, `tweaks/controls.jsx` (Babel; controls depends on panel).
3. UI primitives: `ui/icons.jsx` (defines `Icon`, `TOOL_META`) → `ui/sparks.jsx` → `ui/markdown.jsx` → `ui/plan-annotations.jsx`.
4. Chat: `chat/user-bubble.jsx` → `chat/eval-cell.jsx` → `chat/assistant-bubble.jsx` → `chat/tool-card.jsx` → `chat/chat-view.jsx`.
5. `design/composer.jsx`, `design/chrome.jsx`, `design/panels.jsx`.
6. Live data: `model-names.js` → `adapter.js` → `live.js`.
7. App helpers: `app/constants.js` (plain, IIFE) → `app/use-bridge-snapshot.jsx`.
8. `app-live.jsx` last.

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

## Code style

**General:**
- Follow existing architectural patterns before introducing new ones. Optimize for clarity first, then allocation efficiency.
- Run fmt + lint locally before finalizing any change. Don't ship code that fails fmt or clippy.
- Only format files you actually modified. Never do bulk formatting-only rewrites.
- Prefer surgical `edit` over full-file `write` when the file already exists. Full rewrites only when (a) creating a new file, (b) >~70% of lines genuinely change, or (c) restructuring would require so many anchors that `edit` becomes brittle. Never rewrite a file just to change a few lines — it loses formatting, drops invariants you didn't notice, and bloats diffs.

**Rust:**
- `cargo fmt` (stable) before commit; nightly clippy `pedantic`+`nursery` clean, `-D warnings`.
- No `unwrap`/`expect` in production paths unless failure is provably unrecoverable.
- Prefer borrowing (`&str`, `&[T]`) over owned. `&str` for params unless ownership required. No needless `String`↔`&str` conversions.
- No `.clone()` to bypass borrowck unless duplication is intentional.
- No unnecessary `Arc`/`Mutex`/async primitives. Keep lifetimes simple and idiomatic — no complex lifetime abstractions without clear benefit.
- Iterators/slices over intermediate `Vec` collections. `Cow` only when it meaningfully reduces allocations.
- Minimize temporary allocations in hot paths (reader loop, per-line dispatch, IPC payload construction).
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

## CI / release

- `.github/workflows/ci.yml` — `cargo check --locked` on win/linux/mac for `src-tauri/**`, `src/**`, or workflow changes.
- `.github/workflows/release.yml` — bundles via `tauri build`.

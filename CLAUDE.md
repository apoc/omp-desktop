# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

Tauri 2 desktop shell for the [oh-my-pi](https://github.com/can1357/oh-my-pi) (`omp`) coding agent. The frontend is a React UI loaded directly from `src/` by Tauri's asset server. The Rust backend spawns `omp --mode rpc` child processes and shuttles JSON lines over stdin/stdout. There is no Node/Vite/webpack build for the frontend — JSX is transpiled in-browser by `@babel/standalone`.

## Commands

| Task | Command | Notes |
|------|---------|-------|
| Install Tauri CLI | `npm install` | Only `@tauri-apps/cli` — no runtime deps |
| Dev (frontend hot-reload + Rust rebuild) | `npm run dev` | Auto-opens DevTools in debug builds |
| Production build | `npm run build` | Bundles per `tauri.conf.json` |
| Rust type-check | `cd src-tauri && cargo check --locked` | What CI runs across win/linux/mac |
| Rust lint (strict) | `cd src-tauri && cargo +nightly clippy --all-targets -- -W clippy::pedantic -W clippy::nursery -D warnings` | Should stay clean |
| Probe omp RPC directly | `node test-rpc.mjs` (or `bun`) | Spawns `omp --mode rpc`, sends test prompt, dumps events for 15s. Standalone — does not touch the app |

`omp` must be on PATH (typically `%LOCALAPPDATA%\omp\omp.exe` on Windows). There is no JS test suite; CI runs `cargo check` on win/linux/mac.

## Architecture

Three layers:

1. **Rust (`src-tauri/src/`)** — `AgentBridge` lives in the `agent/` module:
   - `agent/mod.rs` — public `AgentBridge` struct and impl (start/stop/send/last_error)
   - `agent/inner.rs` — `BridgeInner` per-session record (generation token, per-stdin mutex, child handle)
   - `agent/spawn.rs` — `spawn_omp` candidate-list resolution + Windows `CREATE_NO_WINDOW` flag
   - `agent/reader.rs` — stdout/stderr reader threads + bounded `read_until_capped` (16 MiB cap)

   `AgentBridge` holds a `HashMap<session_id, BridgeInner>`. Each entry owns one `omp` child plus its `ChildStdin` wrapped in `Arc<Mutex<…>>` so writes don't serialise through the bridge map lock. A reader thread per session emits one Tauri event per stdout line: `agent://line/{session_id}`, plus `agent://exit/{session_id}` (payload is the empty string on clean exit, or a human-readable reason on error). Tauri commands in `lib.rs`: `start_session`, `stop_session`, `send_command`, `session_status`, `open_project`. The `Drop` impl + `stop_session` kill children — no orphan processes on hot-reload.

2. **Frontend bridge (`src/live.js`)** — Subscribes to `agent://line/{id}` for the *active* session only. Maintains `state` (per-session live vars: messages, kanban, ctx, model, sparkline, etc.) and a `sessionRegistry` Map (the tab list). Switching tabs calls `_switchToSession(id)`: snapshot current state into `sessionSnapshots`, tear down old listeners, restore the target session's snapshot (or reset + re-fetch), register new listeners, call `_initFetch()`. Exposes `window.OMP_BRIDGE` (commands + `onUpdate(cb)` subscription) and `window.OMP_DATA` (legacy globals read by some design components).

3. **React (`src/app-live.jsx` + `src/app/` + `src/design/*/`)** — `app-live.jsx` is the only React root. It subscribes to `OMP_BRIDGE.onUpdate` (via the `useBridgeSnapshot` hook), mirrors the snapshot into `useState` hooks, and renders components from `src/design/`. Cross-cutting effects (bridge subscription, theme reflection onto `<html>` classes, ⌘K shortcut) live in `src/app/use-bridge-snapshot.jsx`. Constants and prompt-framing strings live in `src/app/constants.js`.

Pure RPC↔UI shape transforms live in `src/adapter.js` (no side effects; depends on `model-names.js`).

## Session model (the non-obvious part)

**One tab = one omp process.** The `default` session is started by `lib.rs::setup` at app launch; additional sessions are created when the user picks a project folder (`OMP_BRIDGE.openSession(cwd)` → `invoke("start_session", { sessionId, cwd })`).

Switching tabs preserves in-flight streaming bubbles via `sessionSnapshots`. After re-listen, `get_messages` is called and `_handleResponse` merges the persisted completed turns with the cached `streamingBubble` (omp doesn't persist incomplete turns, so the snapshot is the only source for the in-progress bubble).

## Frontend load order (critical — `src/index.html`)

JSX has no build step, so script order is the dependency graph:

1. **Vendored libs** — React, ReactDOM, Babel standalone, `marked.min.js`, `highlight.min.js` + the inline marked-wiring block.
2. **Tweaks layer** (plain scripts then Babel):
   - `design/tweaks/style.js` (plain, IIFE-wrapped)
   - `design/tweaks/use-tweaks.js` (plain, IIFE-wrapped)
   - `design/tweaks/panel.jsx` (Babel — depends on `__TWEAKS_STYLE`)
   - `design/tweaks/controls.jsx` (Babel — depends on `TweakRow` from panel)
3. **UI primitives** (Babel):
   - `design/ui/icons.jsx` (defines `Icon`, `TOOL_META`)
   - `design/ui/sparks.jsx` (depends on `TOOL_META`)
   - `design/ui/markdown.jsx`
   - `design/ui/plan-annotations.jsx` (depends on `Icon`)
4. **Chat surface** (Babel — internal dep order matters):
   - `design/chat/user-bubble.jsx`
   - `design/chat/eval-cell.jsx`
   - `design/chat/assistant-bubble.jsx` (depends on `Icon`, `MarkdownContent`, `AnnotablePlan`)
   - `design/chat/tool-card.jsx` (depends on `Icon`, `TOOL_META`, `EvalCell`)
   - `design/chat/chat-view.jsx` (depends on `UserBubble`, `ToolCard`, `AssistantBubble`)
5. `design/composer.jsx`, `design/chrome.jsx`, `design/panels.jsx` (Babel)
6. **Live data layer** (plain scripts): `model-names.js` → `adapter.js` → `live.js` (live.js depends on both)
7. **App helpers** (must precede `app-live.jsx`):
   - `app/constants.js` (plain, IIFE-wrapped)
   - `app/use-bridge-snapshot.jsx` (Babel)
8. `app-live.jsx` last (depends on everything via `window` destructure)

Adding a new dependency means inserting it at the right point in this chain — there is no module resolver to catch ordering bugs.

### Plain `<script>` files MUST be IIFE-wrapped if they declare top-level `const`/`function`

Plain `<script>` tags share the document's top-level lexical scope. Two scripts each declaring `const X = ...` at top level produces `Identifier 'X' has already been declared`. Babel's `eval()`-based execution of `type="text/babel"` scripts intersects with this scope for any binding it produces (e.g. `const { X } = window` from a destructure).

Therefore every plain script that declares a top-level `const` / `function` / `class` must wrap its body in `(function () { ...; window.X = X; })();` — see `app/constants.js`, `design/tweaks/style.js`, `design/tweaks/use-tweaks.js` for examples. `model-names.js` is allowed bare because it only assigns to `window.MODEL_NAMES = {...}` (no top-level binding).

Babel-transformed `<script type="text/babel">` files are eval'd in their own scope by Babel's runtime; top-level `function` / `const` declarations there don't leak across scripts. They can stay un-wrapped.

## Authoritative source for `src/design/`

`src/design/` is the **live-wired** copy. The root `design/` directory (gitignored) is a read-only prototype reference. Never regenerate `src/design/` from `design/` — it would overwrite the wiring changes that connect components to `OMP_BRIDGE`/`OMP_DATA`. Edit `src/design/` directly.

## Preventing god files

Files in this repo grow fast — there is no module resolver to push back, and most surfaces (chat bubbles, tool cards, tweaks controls) are tempting to keep in one place. The current layout is the result of a deliberate split; keep it that way.

**Soft caps before the file should be reconsidered:**

| Kind | Cap | At-risk files today |
|------|-----|---------------------|
| `.jsx` (React component file) | ~250 lines | `tweaks/controls.jsx` (238) |
| `.js` (plain script) | ~400 lines | none |
| `.rs` (Rust module) | ~250 lines | `agent/mod.rs` (201) |
| `.css` (single file) | ~300 lines | `layout/overlays.css` (354), `layout/chat.css` (298) |

These are guidelines, not hard limits. A 400-line file with one cohesive responsibility is fine; a 200-line file mixing four concerns is not.

**Rules of thumb when authoring a change that would push a file over its cap:**

1. **Split by responsibility, not by symbol count.** Group related functions and components together. A "chat" folder with `user-bubble.jsx`, `assistant-bubble.jsx`, `tool-card.jsx` is good — each file has one component family. A "components-a-to-m.jsx" / "components-n-to-z.jsx" split is bad.
2. **One component per file when the component has its own non-trivial state, effects, or render branches.** `EvalCell`, `ScrubbableDiff`, `AnnotablePlan` each got their own file because each has internal state that wants room to breathe.
3. **Co-locate primitives only when one is a private helper of the other.** `InlinePlan` lives with `AssistantBubble` because it's only ever rendered from there. `CommentForm` lives with `AnnotablePlan` for the same reason.
4. **CSS splits by visual layer, not by component.** `layout/chat.css` covers chat bubbles, inline plan, tool cards, eval cells, and the diff viewer because they share a stacking context and visual language. Don't split `chat.css` further unless one of those layers grows beyond ~150 lines on its own.
5. **Rust modules split by concern when the file has multiple `pub` surfaces or a long private helper section.** `agent/` was split because spawn / reader / inner-state / public-API are four genuinely different concerns; the `mod.rs` re-uses them via `use super::inner::BridgeInner` etc. and the public surface is unchanged.
6. **When you split, update `src/index.html` script order accordingly.** Add the new files in dependency order; don't append them at the end and hope.
7. **Don't extract for symmetry.** `chrome.jsx` (294 lines) is six tightly-related window-chrome components forming one layer; arbitrarily breaking it up would hurt navigation. Splitting earns its keep when the parts are independently understandable.

If you find yourself adding a 6th major component to a file, or stacking a 4th unrelated concern into a Rust module, that's the signal — split before the file grows further.

## Things easy to break

- **`omp --mode rpc`, not `omp --rpc`** — `--rpc` is unrecognised; omp falls through to TUI mode and floods stdout with ANSI escapes.
- **Blank line in Rust stdout reader = `continue`, not `break`** — `agent/reader.rs` distinguishes EOF from blank lines via `read_until_capped` returning `(0, _)` for EOF and stripping CR/LF post-read. Reverting to `for line in reader.lines()` with a blanket `_ => break` kills the reader thread silently on the first blank line.
- **Window controls use document-level delegation** — `WindowChrome` is rendered by React after `DOMContentLoaded`, so `querySelector` in `_setupWindowChrome` would miss it. The delegated `click` handler on `document` is intentional.
- **`set_model` response must call `notify()` immediately** — otherwise the next `turn_start` re-emits the stale `state.model` and the UI reverts mid-turn.
- **Brace structure in long `if/else if` chains** — `_handleResponse` in `live.js` is a long chain. A missing `}` at the right indentation cascades: the `else if` at the wrong level closes the wrong block, `_handleResponse` never closes, and the IIFE's `})()` hits a SyntaxError that prevents `window.OMP_DATA` from ever being set. Always re-check the structure when inserting a new branch.
- **Frameless window relies on DWM** — `tauri.conf.json` sets `decorations: false`. `platform.css` strips the prototype's outer padding/shadow/border under `.tauri-native` so the WebView is the window. CSS uses `color-mix(in oklab, …)` which requires WebView2 ≥ 101 (Win11 default).
- **Strict CSP, no asset protocol, no shell plugin** — `tauri.conf.json` defines a tight CSP (`default-src 'self'`, `script-src 'self' 'unsafe-inline' 'unsafe-eval'`, etc.) and disables the asset protocol entirely. Don't add CDN tags or `convertFileSrc()` calls without revisiting both. The `tauri-plugin-shell` dep was deliberately removed because nothing used it.
- **Thinking levels are RPC-driven** — UI never invents level names. Cycling = `cycle_thinking_level` RPC; the response carries the new `level` value (`off | minimal | low | medium | high | xhigh`). Setting a specific level = `set_thinking_level`. Don't add UI-side fallback strings like `"auto"` or `"extended"` — they're not valid `ThinkingLevel` values and the RPC silently ignores them.
- **No CDN dependencies** — React/ReactDOM/Babel/marked/hljs are all vendored. Don't introduce CDN script tags; the app must work offline.

## CI / release

- `.github/workflows/ci.yml` — `cargo check --locked` from `src-tauri/` on win/linux/mac for any change to `src-tauri/**`, `src/**`, or the workflow itself. No JS lint/test step.
- `.github/workflows/release.yml` — bundles via `tauri build` (not exercised by `npm run dev`).

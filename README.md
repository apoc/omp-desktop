# omp-desktop

A Tauri 2 desktop shell for [oh-my-pi](https://github.com/can1357/oh-my-pi) (`omp`).
Wraps the `omp --mode rpc` coding agent as a managed child process and serves the
React UI as a connected, live interface — no browser, no Electron, ~8 MB binary.

![screenshot placeholder](docs/screenshot.png)

---

## Architecture

```
┌─────────────────────────────────────────────────────┐
│  Tauri WebView  (src/)                              │
│                                                     │
│  app-live.jsx ──► OMP_BRIDGE ──► live.js            │
│       │                │                            │
│  React state    RPC event handlers                  │
│  (messages,     (turn, message, tool,               │
│   model, ctx,    extension_ui, sparkline)           │
│   kanban…)             │                            │
│                  adapter.js (pure transforms)       │
└────────────────────────┬────────────────────────────┘
                         │  Tauri IPC (invoke / events)
┌────────────────────────▼────────────────────────────┐
│  Rust  (src-tauri/src/)                             │
│                                                     │
│  AgentBridge                                        │
│    spawn  omp --mode rpc                            │
│    stdin  ◄── send_command (JSON lines)             │
│    stdout ──► agent://line events (JSON lines)      │
│    kill   on drop / stop_agent / hot-reload         │
└────────────────────────┬────────────────────────────┘
                         │  stdin / stdout pipes
┌────────────────────────▼────────────────────────────┐
│  omp  (oh-my-pi coding agent)                       │
│    JSON-line RPC protocol                           │
│    streams AgentSessionEvents to stdout             │
└─────────────────────────────────────────────────────┘
```

---

## Requirements

| Tool | Version |
|------|---------|
| [Rust](https://rustup.rs/) | stable (1.77+) |
| [Node.js](https://nodejs.org/) | 18+ |
| [Tauri CLI](https://tauri.app/start/prerequisites/) | 2.x (`npm install`) |
| [oh-my-pi](https://github.com/can1357/oh-my-pi) | 14.8+ (`omp` in PATH) |

`omp` must be reachable as `omp` on your `PATH`. On Windows it is typically
installed at `%LOCALAPPDATA%\omp\omp.exe` and added to PATH by the installer.

---

## Getting Started

```bash
# Clone
git clone https://github.com/yourname/omp-desktop
cd omp-desktop

# Install Tauri CLI (dev dependency only)
npm install

# Dev mode — hot-reloads frontend, rebuilds Rust on backend changes
npm run dev

# Production build
npm run build
```

Dev mode auto-opens the WebView DevTools in debug builds.

---

## Project Structure

```
omp-desktop/
├── src/                        # Frontend (served by Tauri asset server)
│   ├── index.html              # Entry point — loads scripts in order
│   ├── app-live.jsx            # React root; wires OMP_BRIDGE to all state
│   ├── live.js                 # Tauri IPC bridge + OMP_BRIDGE + OMP_DATA
│   ├── adapter.js              # Pure RPC→UI data transforms (no side effects)
│   ├── model-names.js          # Model ID → display name lookup table
│   ├── platform.css            # Tauri-native overrides (no padding/shadow/radius)
│   ├── react.development.js    # React 18 (local, no CDN)
│   ├── react-dom.development.js
│   ├── babel.min.js            # @babel/standalone for JSX transform
│   └── design/                 # Live-wired UI components (modified from prototype)
│       ├── ui.jsx              # Icon, Sparkline, TokenGauge, ActivityRadar, TOOL_META
│       ├── chat.jsx            # ChatView, UserBubble, AssistantBubble, ToolCard
│       ├── chrome.jsx          # WindowChrome, TabBar, StatusBar, AmbientRail, Minimap
│       ├── composer.jsx        # Composer (textarea), CommandBridge (⌘K palette)
│       ├── panels.jsx          # PlanKanban (review / running / done)
│       ├── tweaks-panel.jsx    # Tweaks shell + controls (theme, density, layout)
│       ├── layout.css          # Full layout system
│       └── styles.css          # Visual tokens and component styles
│
├── src-tauri/                  # Rust backend
│   ├── src/
│   │   ├── main.rs             # Binary entry point
│   │   ├── lib.rs              # Tauri setup, command registration
│   │   └── agent.rs            # AgentBridge: process lifecycle + IPC
│   ├── Cargo.toml
│   ├── tauri.conf.json         # Window config (decorations: false, withGlobalTauri)
│   └── capabilities/
│       └── default.json        # Tauri capability grants
│
├── docs/
│   └── plans/                  # Design documents
├── test-rpc.mjs                # Dev utility: probe omp RPC directly (Node/Bun)
├── .gitattributes
├── .gitignore
└── package.json
```

---

## RPC Protocol

The frontend communicates with `omp` exclusively through the Tauri IPC bridge.
`live.js` sends JSON commands via `invoke("send_command", { json })` and receives
`agent://line` events emitted by the Rust stdout reader.

### Commands sent (stdin → omp)

| Command | When |
|---------|------|
| `get_state` | On `ready`, after each `turn_end` |
| `get_messages` | On `ready` |
| `get_available_models` | On `ready` |
| `prompt` | User sends a message |
| `abort` | User clicks abort |
| `set_model` | User picks a model in ⌘K bridge |
| `cycle_model` | User clicks `/model` command |
| `set_thinking_level` | User cycles thinking in composer |
| `compact` | User runs `/compact` |
| `export_html` | User runs `/export` |
| `get_session_stats` | After each `turn_end` |
| `extension_ui_response` | Auto-cancel for interactive UI requests |

### Events received (stdout → frontend)

| Event | Handler |
|-------|---------|
| `ready` | Bootstraps initial data fetches |
| `turn_start` / `turn_end` | Streaming state, TPS calculation, cost accumulation |
| `message_start` | Creates user/assistant bubbles; stamps model name |
| `message_update` | Updates streaming bubble from accumulated content |
| `message_end` | Finalises bubble (`streaming: false`) |
| `tool_execution_start` | Creates running tool card |
| `tool_execution_end` | Finalises tool card with result/diff/output |
| `extension_ui_request` | Interactive types auto-cancelled; others ignored |
| `agent_start` / `agent_end` | Re-fetches session state |

---

## Key Design Decisions

**`omp --mode rpc` not `omp --rpc`** — `--rpc` is not a valid flag; omp falls through to
interactive TUI mode and outputs ANSI escape codes instead of JSON. Confirmed from source.

**Blank line = skip, not EOF** — The Rust stdout reader originally used `_ => break` for
both empty lines and IO errors; one blank line from omp killed the reader thread silently.
Now `Ok("") => continue`, `Err(_) => break`.

**`AgentBridge` kills child on drop** — Stores `Child` alongside stdin. `drop`, `stop_inner`,
and the beginning of `start` all call `child.kill() + child.wait()` so hot-reloads and
tab closes leave no orphaned `omp` processes.

**Event delegation for window controls** — `WindowChrome` is painted by React after
`DOMContentLoaded`. `querySelector` at that point finds nothing. All window control
clicks are caught by a single delegated listener on `document`.

**`set_model` response must be handled** — Without it, `state.model` stays stale. The next
`turn_start` calls `notify()` which pushes the old model back to React, reverting the
display mid-turn. The response is now handled and calls `notify()` immediately.

**Model list above commands in ⌘K bridge** — With 8 command rows, the model section was
below `max-height: 60vh` and invisible without scrolling. Models now render first.

---

## Tauri Commands

| Command | Signature | Description |
|---------|-----------|-------------|
| `send_command` | `(json: String) → Result<()>` | Write a JSON line to omp stdin |
| `stop_agent` | `() → ()` | Kill the omp child process |
| `open_project` | `() → Result<Option<String>>` | Native folder picker dialog |

---

## Frontend State Flow

```
omp stdout
  └─► agent://line Tauri event
        └─► handleLine(rawLine)
              ├─► _handleResponse(resp)   — RPC responses
              │     ├── get_state         → _applyRpcState() → notify()
              │     ├── get_available_models → state.models → notify()
              │     ├── set_model         → state.model + current flags → notify()
              │     └── cycle_model       → state.model + thinkingLevel → notify()
              └─► _handleEvent(ev)        — AgentSessionEvents
                    ├── turn_start/end    → isStreaming, TPS, cost
                    ├── message_*         → streamingBubble lifecycle
                    ├── tool_execution_*  → tool cards
                    └── extension_ui_request → auto-cancel interactive

notify()
  ├─► subscribers (OMP_BRIDGE.onUpdate callbacks)
  │     └─► React setState calls in app-live.jsx
  └─► window.OMP_DATA sync (for components reading globals directly)
```

---

## Tweaks

Open the Tweaks panel (the floating panel in the bottom-right) to adjust:

| Setting | Options |
|---------|---------|
| Theme | aurora · phosphor · daylight |
| Density | cozy · compact · dense |
| Accent colour | 6 presets + custom |
| Mono chat font | toggle |
| Layout | rail · split · focus |

---

## Development Notes

**`test-rpc.mjs`** — Standalone Bun/Node script that spawns `omp --mode rpc` directly
and exercises the protocol. Useful for verifying RPC behaviour without the full UI.

**No CDN dependencies** — React 18, ReactDOM, and Babel standalone are bundled locally
under `src/`. The app works fully offline.

**`src/design/`** — Modified copy of the original `design/` prototype. The original
`design/` directory is excluded from the repo (`.gitignore`); `src/design/` is committed
and is the authoritative source. Do not regenerate from `design/` — that would overwrite
the live-wiring changes.

**Windows 11 target** — Uses `color-mix(in oklab, …)` which requires WebView2 ≥ 101
(Windows 11 default). The frameless window (`decorations: false`) relies on DWM for
corner rounding.

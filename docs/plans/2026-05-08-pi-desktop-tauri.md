# Pi Desktop — Tauri Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement task-by-task.

**Goal:** Build a Tauri desktop app that wraps `omp --rpc` as a child process and renders the existing `design/` prototype as a live, connected UI.

**Architecture:** Rust backend (Tauri) spawns `omp --rpc`, pipes its stdout as Tauri events to the renderer, and exposes an `invoke('send_command')` handler for renderer→agent commands. The renderer is the existing React+Babel prototype from `design/` plus a thin live-data layer (`src/`) that replaces mock data with real RPC state.

**Tech Stack:** Tauri 2, Rust (std only — no extra crates), React 18 (CDN), Babel standalone (CDN), vanilla JS for adapter/bridge.

---

## Data-flow summary

```
omp --rpc (child process)
  stdout JSON lines → Rust thread → tauri::Emitter::emit("agent://line", line)
                                                              ↓
                                               WebView (src/index.html)
                                               live.js listens via __TAURI__.event.listen
                                               adapter.js transforms events
                                               OMP_BRIDGE.onUpdate() notifies React
  stdin  ← Rust ChildStdin ← invoke('send_command', {json}) ← app-live.jsx
```

## RPC event → UI mapping (established in prior research)

| Agent event | UI effect |
|---|---|
| `ready` | request `get_state`, `get_messages`, `get_available_models` |
| `turn_start` | `isStreaming = true` |
| `turn_end` | `isStreaming = false`; compute tps; poll `get_session_stats` |
| `message_start` | append streaming assistant bubble |
| `message_update` | append text/thinking delta to bubble |
| `message_end` | finalize bubble (clear streaming flag) |
| `tool_execution_start` | append running tool card; push to activity log |
| `tool_execution_end` | finalize tool card (duration, details); if `todo_write` → update kanban + inject inline plan |
| `get_state` response | update ctx, model, thinkingLevel, todoPhases |
| `get_messages` response | replace messages array on initial load |
| `get_available_models` response | populate model switcher |
| `get_session_stats` response | update cost in ctx |

## Known data gaps and mitigations

| UI field | Gap | Mitigation |
|---|---|---|
| `ctx.cost` | Not in event stream | Poll `get_session_stats` after each `turn_end` |
| `ctx.tokensPerSec` | Not in RPC | Compute from output token count / turn wall time |
| Sparkline values | Not in RPC | Rolling 30-sample buffer of tps values |
| Activity radar | Not in RPC | Local log of `tool_execution_start` timestamps, pruned to 60s |
| Peer session | Not in single-agent RPC | Hide widget (render null when `peer === null`) |
| `planMeta.strategy/risks/estimate` | Not in RPC | Render empty; those sections are conditionally rendered |
| KanbanCard `tool/effort/file` | Not in TodoItem | Default to `'edit'`/`null`/`null` |
| Model display names | `Model.id` is raw e.g. `claude-sonnet-4-7` | `model-names.js` lookup table with format fallback |

## File structure

```
pi-desktop/
├── design/                      # UNCHANGED prototype files
│   ├── styles.css, layout.css
│   ├── ui.jsx, chat.jsx, chrome.jsx, composer.jsx, panels.jsx, tweaks-panel.jsx
│   └── data.js                  # not loaded in live mode
├── src/                         # Tauri frontendDist root (project root is served)
│   ├── index.html               # entry; loads design/ + src/ scripts
│   ├── model-names.js           # MODEL_NAMES lookup table → window.MODEL_NAMES
│   ├── adapter.js               # pure transform fns → window.{buildKanban, buildCtx, …}
│   ├── live.js                  # Tauri IPC bridge + OMP_BRIDGE + OMP_DATA init
│   └── app-live.jsx             # modified app.jsx: removes demo effects, wires OMP_BRIDGE
├── src-tauri/
│   ├── src/
│   │   ├── main.rs              # calls lib::run()
│   │   ├── lib.rs               # Tauri setup, manage(AgentBridge), commands, setup hook
│   │   └── agent.rs             # AgentBridge: spawn omp, read stdout, write stdin
│   ├── build.rs                 # tauri_build::build()
│   ├── Cargo.toml
│   ├── tauri.conf.json          # frontendDist: "..", window url: "src/index.html"
│   └── capabilities/
│       └── default.json         # window close/minimize/maximize/startDragging + asset
├── package.json                 # @tauri-apps/cli devDep, dev/build scripts
└── .gitignore
```

---

## Task 1: package.json + .gitignore

**Files:** Create `package.json`, `.gitignore`

- [ ] Create `package.json`

```json
{
  "name": "pi-desktop",
  "private": true,
  "version": "0.1.0",
  "scripts": {
    "dev": "tauri dev",
    "build": "tauri build"
  },
  "devDependencies": {
    "@tauri-apps/cli": "^2"
  }
}
```

- [ ] Create `.gitignore`

```
node_modules/
src-tauri/target/
src-tauri/gen/
dist/
*.local
```

- [ ] Install Tauri CLI: `npm install` (from project root)

---

## Task 2: Tauri Rust workspace

**Files:** Create `src-tauri/Cargo.toml`, `src-tauri/build.rs`, `src-tauri/src/main.rs`

- [ ] Create `src-tauri/Cargo.toml`

```toml
[package]
name = "pi-desktop"
version = "0.1.0"
edition = "2021"

[lib]
name = "pi_desktop_lib"
crate-type = ["staticlib", "cdylib", "rlib"]

[build-dependencies]
tauri-build = { version = "2", features = [] }

[dependencies]
tauri = { version = "2", features = [] }
serde = { version = "1", features = ["derive"] }
serde_json = "1"
```

- [ ] Create `src-tauri/build.rs`

```rust
fn main() {
    tauri_build::build()
}
```

- [ ] Create `src-tauri/src/main.rs`

```rust
// Prevents additional console window on Windows in release
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

fn main() {
    pi_desktop_lib::run();
}
```

---

## Task 3: lib.rs + agent.rs — Rust backend

**Files:** Create `src-tauri/src/lib.rs`, `src-tauri/src/agent.rs`

- [ ] Create `src-tauri/src/agent.rs`

```rust
use std::io::{BufRead, BufReader, Write};
use std::process::{Child, Command, Stdio};
use std::sync::{Arc, Mutex};
use std::thread;
use tauri::{AppHandle, Emitter};

pub struct AgentBridge {
    stdin: Arc<Mutex<Option<std::process::ChildStdin>>>,
}

impl AgentBridge {
    pub fn new() -> Self {
        Self {
            stdin: Arc::new(Mutex::new(None)),
        }
    }

    pub fn start(&self, app: AppHandle) -> Result<(), String> {
        let mut child = spawn_omp()?;

        let stdin = child.stdin.take().expect("stdin piped");
        *self.stdin.lock().unwrap() = Some(stdin);

        let stdout = child.stdout.take().expect("stdout piped");
        let stderr = child.stderr.take().expect("stderr piped");

        // Stdout reader — emits each JSON line as a Tauri event
        let app_out = app.clone();
        thread::spawn(move || {
            let reader = BufReader::new(stdout);
            for line in reader.lines() {
                match line {
                    Ok(l) if !l.trim().is_empty() => {
                        app_out.emit("agent://line", l).ok();
                    }
                    _ => break,
                }
            }
            app_out.emit("agent://exit", ()).ok();
        });

        // Stderr logger — surfaces omp diagnostics to the Tauri console
        thread::spawn(move || {
            let reader = BufReader::new(stderr);
            for line in reader.lines() {
                if let Ok(l) = line {
                    eprintln!("[omp] {l}");
                }
            }
        });

        Ok(())
    }

    pub fn send(&self, line: &str) -> Result<(), String> {
        let mut guard = self.stdin.lock().map_err(|_| "lock poisoned".to_string())?;
        match guard.as_mut() {
            Some(stdin) => writeln!(stdin, "{line}").map_err(|e| e.to_string()),
            None => Err("agent not running".to_string()),
        }
    }
}

impl Drop for AgentBridge {
    fn drop(&mut self) {
        // Dropping the stdin handle closes the pipe, which causes omp to exit cleanly.
        if let Ok(mut g) = self.stdin.lock() {
            *g = None;
        }
    }
}

/// Spawn `omp --rpc` cross-platform.
/// On Windows npm global installs produce `.cmd` wrappers that need `cmd /C`.
fn spawn_omp() -> Result<Child, String> {
    #[cfg(target_os = "windows")]
    let child = Command::new("cmd")
        .args(["/C", "omp", "--rpc"])
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .map_err(|e| format!("failed to spawn omp: {e}\nInstall with: npm i -g @oh-my-pi/pi-coding-agent"));

    #[cfg(not(target_os = "windows"))]
    let child = Command::new("omp")
        .arg("--rpc")
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .map_err(|e| format!("failed to spawn omp: {e}\nInstall with: npm i -g @oh-my-pi/pi-coding-agent"));

    child
}
```

- [ ] Create `src-tauri/src/lib.rs`

```rust
mod agent;

use agent::AgentBridge;
use tauri::{Manager, State};

#[tauri::command]
fn send_command(json: String, bridge: State<'_, AgentBridge>) -> Result<(), String> {
    bridge.send(&json)
}

pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_shell::init())
        .manage(AgentBridge::new())
        .invoke_handler(tauri::generate_handler![send_command])
        .setup(|app| {
            let bridge = app.state::<AgentBridge>();
            if let Err(e) = bridge.start(app.handle().clone()) {
                // Non-fatal: app runs in demo mode if omp is unavailable.
                // The renderer detects the missing Tauri API and falls back.
                eprintln!("[pi-desktop] agent start error: {e}");
            }
            Ok(())
        })
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
```

- [ ] Add `tauri-plugin-shell` to `src-tauri/Cargo.toml` dependencies (needed for lib.rs plugin init):

```toml
tauri-plugin-shell = "2"
```

---

## Task 4: tauri.conf.json + capabilities

**Files:** Create `src-tauri/tauri.conf.json`, `src-tauri/capabilities/default.json`

- [ ] Create `src-tauri/tauri.conf.json`

```json
{
  "$schema": "https://schema.tauri.app/config/2",
  "productName": "OMP Desktop",
  "version": "0.1.0",
  "identifier": "dev.ohMyPi.desktop",
  "build": {
    "beforeDevCommand": "",
    "devUrl": "",
    "frontendDist": ".."
  },
  "app": {
    "withGlobalTauri": true,
    "security": {
      "csp": null,
      "assetProtocol": {
        "enable": true,
        "scope": ["**"]
      }
    },
    "windows": [
      {
        "label": "main",
        "title": "OMP Desktop",
        "url": "src/index.html",
        "width": 1440,
        "height": 900,
        "minWidth": 960,
        "minHeight": 640,
        "decorations": false,
        "shadow": true,
        "center": true
      }
    ]
  },
  "bundle": {
    "active": true,
    "targets": "all",
    "icon": []
  }
}
```

- [ ] Create `src-tauri/capabilities/default.json`

```json
{
  "$schema": "../gen/schemas/desktop-schema.json",
  "identifier": "default",
  "description": "Main window capabilities",
  "windows": ["main"],
  "permissions": [
    "core:default",
    "core:window:allow-close",
    "core:window:allow-minimize",
    "core:window:allow-maximize",
    "core:window:allow-unmaximize",
    "core:window:allow-is-maximized",
    "core:window:allow-start-dragging"
  ]
}
```

---

## Task 5: src/model-names.js

**Files:** Create `src/model-names.js`

- [ ] Create `src/model-names.js`

```js
/* Model ID → human display name.
   Fallback: formatModelId() in live.js strips provider prefix and title-cases. */
window.MODEL_NAMES = {
  // Anthropic
  "claude-opus-4-5":          "Opus 4.5",
  "claude-opus-4-1":          "Opus 4.1",
  "claude-sonnet-4-7":        "Sonnet 4.7",
  "claude-sonnet-4-5":        "Sonnet 4.5",
  "claude-haiku-4-5":         "Haiku 4.5",
  "claude-3-7-sonnet-latest": "Sonnet 3.7",
  "claude-3-5-sonnet-latest": "Sonnet 3.5",
  "claude-3-5-haiku-latest":  "Haiku 3.5",
  "claude-3-opus-latest":     "Opus 3",
  // OpenAI
  "gpt-4o":                   "GPT-4o",
  "gpt-4o-mini":              "GPT-4o mini",
  "o1":                       "o1",
  "o1-mini":                  "o1 mini",
  "o3":                       "o3",
  "o3-mini":                  "o3 mini",
  "o4-mini":                  "o4 mini",
  // Google
  "gemini-2.5-pro":           "Gemini 2.5 Pro",
  "gemini-2.0-flash":         "Gemini 2.0 Flash",
  "gemini-1.5-pro":           "Gemini 1.5 Pro",
  // Qwen / local
  "qwen2.5-coder-32b-instruct": "Qwen 2.5 Coder",
  "qwen3-coder":              "Qwen3 Coder",
};
```

---

## Task 6: src/adapter.js

**Files:** Create `src/adapter.js`

Pure transformation functions — no side effects, no globals read except `window.MODEL_NAMES`.
All functions assigned to `window` so Babel scripts can call them.

- [ ] Create `src/adapter.js`

```js
/* adapter.js — pure transforms between RPC data and design data shapes.
   All exported via window.* so Babel-transpiled scripts can call them. */

(function () {
  "use strict";

  // ── Tool name normalisation ───────────────────────────────────────────────
  const TOOL_NAME_MAP = {
    read: "read", search: "search", edit: "edit", bash: "bash",
    write: "write", todo_write: "todo", find: "search",
    web_search: "search", task: "bash", ask: "bash", debug: "bash",
  };

  function normalizeToolName(name) {
    return TOOL_NAME_MAP[name] || name;
  }

  // ── TodoStatus → design status ────────────────────────────────────────────
  const STATUS_MAP = {
    pending: "pending",
    in_progress: "in_progress",
    completed: "done",
    abandoned: "done",
  };

  function todoStatusToDesign(status) {
    return STATUS_MAP[status] || "pending";
  }

  // ── Phase visual style (cycles) ───────────────────────────────────────────
  const PHASE_STYLES = [
    { tone: "fg-3",   icon: "search" },
    { tone: "accent", icon: "edit"   },
    { tone: "cyan",   icon: "check"  },
    { tone: "lilac",  icon: "bash"   },
    { tone: "amber",  icon: "plan"   },
  ];

  function phaseStyle(index) {
    return PHASE_STYLES[index % PHASE_STYLES.length];
  }

  // ── Derive plan phase from task status distribution ───────────────────────
  function derivePlanPhase(todoPhases) {
    const tasks = todoPhases.flatMap(p => p.tasks);
    if (tasks.length === 0) return "review";
    const allDone = tasks.every(t => t.status === "completed" || t.status === "abandoned");
    if (allDone) return "done";
    if (tasks.some(t => t.status === "in_progress")) return "running";
    return "review";
  }

  // ── TodoPhase[] → design kanban columns ──────────────────────────────────
  function buildKanban(todoPhases) {
    return todoPhases.map((phase, idx) => {
      const style = phaseStyle(idx);
      return {
        id: phase.name.toLowerCase().replace(/\s+/g, "-"),
        title: phase.name,
        tone: style.tone,
        icon: style.icon,
        tasks: phase.tasks.map((task, ti) => ({
          id: `${idx}-${ti}`,
          text: task.content,
          status: todoStatusToDesign(task.status),
          reason: task.notes?.[0] ?? null,
          tool: "edit",
          effort: null,
          file: null,
        })),
      };
    });
  }

  // ── planMeta (partial — strategy/risks/estimate not available from RPC) ───
  function buildPlanMeta(todoPhases, sessionState) {
    const sessionFile = sessionState?.sessionFile ?? "";
    const branch = sessionFile
      ? sessionFile.replace(/\\/g, "/").split("/").pop().replace(".jsonl", "")
      : "session";

    const allTasks = todoPhases.flatMap(p => p.tasks);
    const fileMentionRe = /[\w./\\-]+\.\w{2,6}/g;
    const touches = [...new Set(
      allTasks.flatMap(t => Array.from(t.content.matchAll(fileMentionRe), m => m[0]))
    )].slice(0, 6);

    return {
      ask: sessionState?.sessionName ?? "",
      strategy: "",
      touches,
      branch,
      risks: [],
      estimate: { tokens: "—", cost: "—", wall: "—" },
    };
  }

  // ── formatTokens: 47230 → "47.2k" ────────────────────────────────────────
  function formatTokens(n) {
    if (n === null || n === undefined) return "—";
    return n >= 1000 ? `${(n / 1000).toFixed(1)}k` : String(n);
  }

  // ── ContextUsage + session cost → design ctx object ──────────────────────
  function buildCtx(rpcState, sessionCost, tps) {
    const cu = rpcState?.contextUsage;
    const used  = cu?.tokens ?? 0;
    const total = cu?.contextWindow ?? 200000;
    const pct   = cu?.percent ?? (used ? Math.round((used / total) * 100) : 0);
    return {
      used,
      total,
      pct,
      label: `${formatTokens(used)} / ${formatTokens(total)}`,
      cost: sessionCost != null ? `$${sessionCost.toFixed(2)}` : "$0.00",
      tokensPerSec: Math.round(tps ?? 0),
    };
  }

  // ── Model.id → readable display name (fallback to title-case formatting) ──
  function formatModelId(id) {
    return id
      .replace(/^(claude|gpt|gemini)-/i, "")
      .replace(/-/g, " ")
      .replace(/\b\w/g, c => c.toUpperCase());
  }

  // ── Activity log entries → 60s radar data ────────────────────────────────
  function buildActivityFromLog(log) {
    const now = Date.now();
    return log
      .filter(e => now - e.ts <= 60_000)
      .map(e => ({ t: Math.floor((now - e.ts) / 1000), k: normalizeToolName(e.toolName) }));
  }

  // ── tool_execution_start event → running tool card ────────────────────────
  function buildToolStartCard(event, time) {
    const tool  = normalizeToolName(event.toolName ?? event.name ?? "");
    const input = event.input ?? {};
    const target = input.path ?? input.pattern ?? input.command ?? input.query ?? "";
    const title  = target ? `${tool} · ${target}` : (event.toolName ?? tool);
    return {
      kind: "tool",
      tool,
      title,
      target,
      summary: "",
      status: "running",
      duration: null,
      time,
      _toolCallId: event.toolCallId,
    };
  }

  // ── tool_execution_end event → finalized tool card ────────────────────────
  function finalizeToolCard(card, event) {
    const duration = event.duration ?? 0;
    const details  = event.result?.details;
    const extra    = {};

    if (card.tool === "search" && details?.matches) {
      extra.preview = Object.entries(details.matches).slice(0, 5).map(([file, hits]) => ({
        file,
        hits: Array.isArray(hits) ? hits.length : (hits ?? 0),
        hot: true,
      }));
    }
    if (card.tool === "edit") {
      extra.adds = details?.adds ?? 0;
      extra.rems = details?.rems ?? 0;
      if (details?.diff) extra.diff = details.diff;
    }
    if (card.tool === "bash" && details?.output) {
      extra.output = String(details.output).split("\n").slice(0, 20).map(line => ({
        line,
        color: /^[✓✔]|^PASS/.test(line) ? "accent"
             : /^[✗✘]|^FAIL|^Error/.test(line) ? "rose"
             : "fg-3",
      }));
    }
    if (card.tool === "read") {
      extra.summary = details?.lines ? `${details.lines} lines` : card.summary;
    }

    return { ...card, status: "ok", duration, ...extra };
  }

  // ── AgentMessage[] (from get_messages) → design message array ────────────
  function adaptAgentMessages(apiMessages) {
    const result = [];
    for (const msg of apiMessages ?? []) {
      if (!msg || typeof msg !== "object") continue;
      const { role, content } = msg;
      const time = _formatTime(msg.timestamp ?? msg.createdAt);
      const blocks = Array.isArray(content) ? content : [{ type: "text", text: String(content ?? "") }];

      if (role === "user") {
        const textBlocks = blocks.filter(b => b.type === "text");
        if (textBlocks.length === 0) continue; // skip pure tool-result turns
        const text = textBlocks.map(b => b.text).join("\n").trim();
        if (!text) continue;
        result.push({ kind: "user", time, text });

      } else if (role === "assistant") {
        let thought = null;
        const designBlocks = [];
        for (const block of blocks) {
          if (block.type === "thinking" && block.thinking?.trim()) {
            thought = block.thinking;
          } else if (block.type === "text" && block.text?.trim()) {
            designBlocks.push({ type: "text", text: block.text });
          }
          // tool_use blocks rendered as separate tool cards; skip here
        }
        if (designBlocks.length > 0 || thought) {
          result.push({
            kind: "assistant", time, thought,
            lead: thought ? "thinking" : null,
            blocks: designBlocks,
            streaming: false,
          });
        }
      }
    }
    return result;
  }

  // ── Internal helpers ──────────────────────────────────────────────────────
  function _formatTime(ts) {
    if (!ts) return _timeNow();
    const d = ts instanceof Date ? ts : new Date(ts);
    if (isNaN(d.getTime())) return _timeNow();
    return [d.getHours(), d.getMinutes(), d.getSeconds()]
      .map(n => String(n).padStart(2, "0")).join(":");
  }

  function _timeNow() {
    const d = new Date();
    return [d.getHours(), d.getMinutes(), d.getSeconds()]
      .map(n => String(n).padStart(2, "0")).join(":");
  }

  // ── Exports ───────────────────────────────────────────────────────────────
  Object.assign(window, {
    normalizeToolName, todoStatusToDesign, phaseStyle,
    derivePlanPhase,   buildKanban,        buildPlanMeta,
    formatTokens,      buildCtx,           formatModelId,
    buildActivityFromLog,
    buildToolStartCard, finalizeToolCard,
    adaptAgentMessages,
  });
})();
```

---

## Task 7: src/live.js

**Files:** Create `src/live.js`

Initialises `window.OMP_DATA` with safe defaults, wires the Tauri IPC, and exposes `window.OMP_BRIDGE`.
Falls back to demo mode (empty messages) when `window.__TAURI__` is absent.

- [ ] Create `src/live.js` (see full content in implementation — too long to inline here; key sections are IPC listener setup, event handlers for each AgentSessionEvent type, tps computation, activity log maintenance, and the OMP_BRIDGE API surface)

The OMP_BRIDGE API surface:
```
window.OMP_BRIDGE = {
  isConnected: boolean,
  send(text, images?): void,
  abort(): void,
  setModel(model): void,
  setThinking(level): void,
  compact(): void,
  exportHtml(): void,
  onUpdate(cb: (snapshot) => void): () => void,  // returns unsubscribe
  getState(): liveState,
}
```

---

## Task 8: src/app-live.jsx

**Files:** Create `src/app-live.jsx`

Identical to `design/app.jsx` except:
1. **Remove** the 5.4s demo streaming-finisher `setTimeout` effect
2. **Remove** the fake-reply simulation in `handleSend`
3. **Add** a `useEffect` that subscribes to `window.OMP_BRIDGE.onUpdate()` and syncs all React state
4. **Wire** `handleSend` → `OMP_BRIDGE.send(text)`
5. **Wire** `handleAbort` → `OMP_BRIDGE.abort()`
6. **Wire** model picker → `OMP_BRIDGE.setModel(model)`
7. **Pass** `sparklineValues` to `AmbientRail` via data.sparkline

All visual components (`ChatView`, `Composer`, `AmbientRail`, etc.) unchanged.

---

## Task 9: src/index.html

**Files:** Create `src/index.html`

```html
<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <title>OMP Desktop</title>
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <link rel="preconnect" href="https://fonts.googleapis.com" />
  <link rel="preconnect" href="https://fonts.gstatic.com" crossorigin />
  <link href="https://fonts.googleapis.com/css2?family=Geist:wght@400;500;600;700&family=JetBrains+Mono:ital,wght@0,400;0,500;0,600;1,400&display=swap" rel="stylesheet" />
  <link rel="stylesheet" href="../design/styles.css" />
  <link rel="stylesheet" href="../design/layout.css" />
</head>
<body>
  <div id="root"></div>

  <script src="https://unpkg.com/react@18.3.1/umd/react.development.js" crossorigin></script>
  <script src="https://unpkg.com/react-dom@18.3.1/umd/react-dom.development.js" crossorigin></script>
  <script src="https://unpkg.com/@babel/standalone@7.29.0/babel.min.js" crossorigin></script>

  <script type="text/babel" src="../design/tweaks-panel.jsx"></script>
  <script type="text/babel" src="../design/ui.jsx"></script>
  <script type="text/babel" src="../design/chat.jsx"></script>
  <script type="text/babel" src="../design/composer.jsx"></script>
  <script type="text/babel" src="../design/chrome.jsx"></script>
  <script type="text/babel" src="../design/panels.jsx"></script>

  <script src="model-names.js"></script>
  <script src="adapter.js"></script>
  <script src="live.js"></script>

  <script type="text/babel" src="app-live.jsx"></script>
</body>
</html>
```

---

## Self-review

**Spec coverage:** All RPC events handled, all UI elements mapped, gaps mitigated.
**No placeholders:** All files have complete content except live.js and app-live.jsx noted for inline implementation.
**Type consistency:** `buildKanban` output shape matches `PlanKanban` props; `buildCtx` output matches `StatusBar`/`TokenGauge` props; tool card shape matches `ToolCard` component.
**Platform:** Windows `cmd /C omp --rpc` handles `.cmd` npm wrappers correctly.

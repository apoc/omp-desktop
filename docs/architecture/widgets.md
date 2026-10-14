# Rail widget plugins

User-facing contract (config, approval, output schema, limits): `docs/widgets.md`. This file covers the internals.

A plugin is an external process listed in the user's `<app config>/widgets.json`. **Rust owns everything that decides whether, when and what runs:**

- config loading and approvals,
- trigger scheduling,
- spawning, the concurrency cap and killing.

The frontend does two things only:

- **Reports view state**: the active session, rail and window visibility, and hidden card ids.
- **Renders**: parses stdout with `OMP_WIDGETS.parseOutput` and shows the cards.

It never sends a path, a command, a trigger or a context to Rust: only plugin ids and that view state.

## Modules

| File | Purpose |
|---|---|
| `src-tauri/src/widgets/config.rs` | load/validate `widgets.json` → `WidgetConfig { plugins: Vec<PluginEntry>, errors }`; `PluginEntry::matches(project, remote)` (directory-prefix path match, backslash normalised, `/` root special case, remote substring), `PluginEntry::wants(Trigger)` (`Manual` always, `Interval` iff `interval_ms`, else `triggers`) |
| `src-tauri/src/widgets/schedule.rs` | **pure** scheduler state machine: `Scheduler::handle(Event, now_ms) -> Vec<Action>`, `next_deadline()`; no threads, IO or clock |
| `src-tauri/src/widgets/trust.rs` | `fingerprint(&PluginEntry)` and `ApprovalStore` (`<app config>/widget-approvals.json`) |
| `src-tauri/src/widgets/host.rs` | `WidgetHost` (Tauri managed state): scheduler thread, run registry, worker threads, event emits |
| `src-tauri/src/widgets/run.rs` | `run_plugin(entry, ctx, on_spawn) -> Outcome`: spawn, stdin context, timeout, stdout cap, process-tree kill |
| `src-tauri/src/widgets/context.rs` | `session_ctx(project)` (branch, password-free default remote; one repo discovery) and the bounded `PluginContext` |
| `src-tauri/src/widgets/redact.rs` | credential masking for error text, on top of the crate-level `redaction.rs` shared with `agent/reader.rs` |
| `src/app/widgets.js` | pure: `parseOutput`, `insertText`, `safeUrl`, `tweakKey`, `relativeTime`, `appendToDraft`, and the run bookkeeping `runKey`, `mergeRun`, `parsedLast`, `cardRun` (`test-widgets.mjs`) |
| `src/app/use-widgets.jsx` | thin hook: snapshot + run map from events, sends view state, memoised parse per (key, `last.at`) |
| `src/design/widgets/` | `WidgetCard`, `WidgetApprovalCard`, `WidgetErrorCard`, `WidgetBoundary`, block renderers |

## Data flow

```
widgets.json ──load (startup, widgets_reload)──▶ WidgetHost ──Event::Config──▶ Scheduler
start_session / stop_session ──session_started/closed──▶ WidgetHost ──SessionOpened/Closed──▶
reader.rs agent_end frame ──turn_ended──▶                   ──TurnEnd──▶
git_watcher HEAD change ──branch_changed──▶ (ctx refresh)   ──SessionOpened + Branch──▶
frontend widgets_set_view / widgets_refresh ──────────────▶ ──View / Manual──▶
                                            Actions ◀───────┘
Start → fingerprint check → worker thread → run_plugin → Event::Finished
Kill  → registry kill_tree      Changed/Removed → app.emit(widgets://run | widgets://removed)
```

- **Hooks into the rest of the app:**
  - `start_session` calls `session_started(sid, project)` after a successful start. The host computes the git context on its own thread, not the IPC thread.
  - `stop_session` calls `session_closed`.
  - `agent/reader.rs` calls `turn_ended` on an `agent_end` frame. It reuses the frame it already parsed, so there is no extra parse. This fires for background tabs too: the reader sees every session.
  - The `git_watcher.rs` callback calls `branch_changed`. The host recomputes the context, then sends `SessionOpened` (ctx refresh) followed by `Branch`.
- **One scheduler thread**, created with a fallible `thread::Builder`. It owns the `Scheduler` and blocks on an `mpsc` inbox with `recv_timeout(next_deadline - now)`. A timeout feeds `Event::Tick`.
- **`now_ms` is epoch ms** (`SystemTime`), so `at`/`lastOkAt` are directly renderable. All arithmetic saturates, so clock skew never panics.
- **Start action.**
  - The host recomputes the fingerprint first. On a mismatch, it spawns nothing and feeds `Finished` with `"plugin changed since it was approved — approve it again"`. It then re-sends `Event::Config` with the plugin unapproved and emits `widgets://config`.
  - Otherwise it spawns a worker thread for the run (fallible `Builder`; if that fails, it feeds `Finished` with an error).
  - The worker calls `run_plugin`. Its `on_spawn` callback registers the run's `Arc<ProcessSupervisor>` in the registry. The worker removes the entry when the run returns, then sends `Finished`.
- **Run registry.** `Mutex<HashMap<RunKey, Arc<ProcessSupervisor>>>`. The lock is held only to insert, remove or loop over kills, never across a blocking run.
- **Kill action.** `kill_tree()` on the registered supervisor.
- **`kill_all()`** kills every registered supervisor synchronously and does not depend on the scheduler thread. It is called:
  - on the updater relaunch path (which skips `Drop`) and on `RunEvent::Exit`, both through `crate::kill_child_processes`: `AgentBridge::shutdown_all` runs first, `BrowserManager::shutdown_all` second, then widget plugins are killed,
  - from `Drop`.
- **Config source of truth.** The config is read once at startup and again on `widgets_reload`, never per run. The config path is `Option<PathBuf>`: `None` when `app_config_dir()` fails. There is no temp-dir fallback; the snapshot's `fatal` says why, and nothing runs.

## Scheduler (`schedule.rs`)

Pure, deterministic and fully unit-tested. The host translates the world into `Event`s and executes the returned `Action`s:

- `Start { key, seq, session, trigger }`
- `Kill { key }`
- `Changed { key }`, which the host emits as `widgets://run`
- `Removed { key }`, which the host emits as `widgets://removed`

### Keys and run state

- **`RunKey { scope_key, plugin_id }`.** `scope_key` is the session id for `scope: "tab"`, or `GLOBAL_KEY = "__global__"` for `scope: "global"`. A global run uses the *active* session's context and needs an active session.
- **`RunState`:**
  - `phase`: `Idle | Waiting | Running`;
  - `seq`, incremented per start;
  - `trigger` of the run in flight, or of the last finished run;
  - `queued`: at most one coalesced follow-up;
  - `last`: `Finished { at, outcome }`;
  - `last_ok_at`.
- **Indexes.** Runs are indexed by key in a `HashMap`. Waiting keys are a FIFO `VecDeque`; an entry whose run is no longer `Waiting` is skipped when popped. Dirty triggers are per session → plugin. No loop is quadratic.

### Rules

- **Runnable(p, s)** requires all of:
  - `enabled`, and `approved` (the current fingerprint);
  - `id ∉ view.hidden`, and `view.rail_visible`;
  - session `s` is known;
  - `p.matches(ctx.project, ctx.remote)`.

  An unknown or closed session runs nothing.
- **Start.**
  - One run per key. A start on a Waiting/Running key only sets `queued`. Priority: an `Interval` never overwrites a queued non-interval trigger; otherwise the latest wins.
  - Otherwise `seq += 1`. The phase becomes `Running` while fewer than `MAX_CONCURRENT_RUNS = 4` run, else `Waiting`.
  - `last` is kept, so the card shows it dimmed.
- **Finished.**
  - Ignored if the key is unknown, `seq` is stale, or the phase is not `Running`.
  - Otherwise it stores `last` and `last_ok_at`, and sets the phase to `Idle`.
  - The FIFO head is promoted.
  - Then the queued follow-up starts if it is still *allowed*: Runnable now, its session still open, and for `Interval` the window visible and (Global ∨ session is active).
- **Activate.** The active session changes, or something makes plugins newly runnable for it: rail visibility, `hidden`, config or approval.
  - Only the **newly runnable** plugins start. Toggling or approving one card never re-runs the others.
  - For a newly active session:
    - tab plugins that want `Activate` start with `Activate`;
    - other tab plugins with a dirty trigger start with that trigger;
    - global plugins start only when they have no result, or (with `interval_ms`) the last finish is older than the interval, or they have no `interval_ms`.
  - Tab interval timers are re-armed.
- **TurnEnd / Branch for session S.**
  - If S is active and the rail is visible: every Runnable plugin that wants the trigger starts (tab key S; global key `__global__`).
  - Otherwise the trigger is recorded as **dirty** for (S, tab plugin). It is flushed once on S's next activation.
  - Branch events are deduplicated against the last branch seen for S. The first one only records the branch.
- **Manual.** Needs an active session and a Runnable plugin; the trigger list is ignored.
- **Interval.**
  - Each plugin with `interval_ms` has a `next_due`.
  - On `Tick` at or after `next_due`, the plugin starts if the window and rail are visible and it is Runnable. `next_due` is re-armed to `now + interval` either way.
  - Tab timers belong to the active session; global timers survive tab switches.
  - When the window or rail becomes visible again, every interval plugin whose last finish is older than its interval (or that never ran) runs once and is re-armed. A Waiting/Running run counts as fresh.
  - A change to interval, match, scope, enabled or approval rebuilds the plugin's timer.
- **SessionClosed.** Kills every Running/Waiting key of the session and emits `Removed` for its run states. It drops the session's dirty set, branch memory, context and timers. If the session was active, nothing is active until a session the view names is open: `view.session` is kept, so a profile switch, which respawns the tab under the same id without the frontend re-sending its view, makes the reopened session active again (with an `activate` run). Global keys are unaffected.
- **Config.** Plugins that were removed, or whose approval was revoked, get Kill + Removed for all their keys. A scope change removes the old keys. Other field changes keep the results. Then only the newly runnable plugins activate.
- **View with window or rail hidden.** No new starts. Running runs finish normally, and their non-interval follow-ups still need Runnable, which a hidden rail fails.

## IPC

Commands (in `generate_handler!`). Blocking work goes through `spawn_blocking` or the host thread. The boundary type is `Result<T, String>`.

| Command | Args | Returns |
|---|---|---|
| `widgets_state` | — | `WidgetsSnapshot` |
| `widgets_reload` | — | `WidgetsSnapshot` (also emitted as `widgets://config`) |
| `widgets_approve` | `pluginId: string, fingerprint: string` | `Result<WidgetsSnapshot, String>`; `Err` if the id is unknown or the fingerprint is not the current one (stale approval card) |
| `widgets_set_view` | `view: { sessionId: string\|null, railVisible: boolean, windowVisible: boolean, hidden: string[] }` | `()`. An empty or over-long (>128 bytes) id becomes `null`. A well-formed id of a session that has not started yet is kept and becomes active once that session opens (the tab's first view can arrive before its `start_session` hook). `hidden` keeps at most 64 ids matching `[a-z0-9-]{1,32}`; others are dropped. |
| `widgets_refresh` | `pluginId: string` | `()` (`Event::Manual`) |

Events (global, via `app.emit`):

| Event | Payload |
|---|---|
| `widgets://config` | the config part of `WidgetsSnapshot` (no `active`, no `runs`) |
| `widgets://run` | `RunView` |
| `widgets://removed` | `{ key, pluginId }` |
| `widgets://active` | `{ sessionId, applicable }`, emitted when the active session's applicable plugin set changes |

Shapes (camelCase):

```ts
WidgetsSnapshot = { configPath: string|null, fatal: string|null, errors: string[],
                    plugins: PluginView[], runs: RunView[],
                    active: { sessionId: string|null, applicable: string[] } }
PluginView = { id, title, scope: "tab"|"global", enabled: boolean,
               approval: "approved"|"pending"|"changed",
               command: string[], fingerprint: string }
RunView    = { key: string /* session id or "__global__" */, pluginId: string, seq: number,
               phase: "idle"|"waiting"|"running",
               last: null | { at: number, stdout: string|null, error: string|null, durationMs: number },
               lastOkAt: number|null }
```

- **`approval: "changed"`** means the plugin was approved under another fingerprint.
- **`active.applicable`** lists the ids that apply to the active session: enabled, and `match` fits its project/remote.

Frontend handling:

- **Rail order:** `fatal` + config error cards, then all approval cards, then result cards; each group in config order.
- **Approval cards** render for every enabled plugin whose approval is not `approved`, regardless of `match`, unless its `widget:plugin:<id>` tweak is off.
- **Result cards** render per id in `active.applicable` (idle until the first run). The run shown is the one keyed by the active session id, or `__global__` for global plugins.
- **Event ordering.** `use-widgets.jsx` fetches `widgets_state` on mount and merges events by `seq`, so a `widgets://run` that arrives before the fetch resolves is not lost.
- **`live.js` exposes** `widgetsState`, `widgetsReload`, `widgetsApprove`, `widgetsSetView`, `widgetsRefresh` and `onWidgetsEvent`. In browser mode (no `__TAURI__`) the snapshot calls return `{}`; `applySnapshot` defaults every missing field.

## Trust

- **Fingerprint.** `fingerprint(entry)` is the hex SHA-256 over:
  - `"omp-widget-v1\0"`;
  - each argv element, NUL-terminated;
  - for every element that is an absolute path to a regular file: its length and contents, streamed in chunks. A file over 8 MiB contributes `len + mtime` instead.
- **`ApprovalStore`.** `{ "version": 1, "approved": { "<id>": "<fingerprint>" } }`, written with `json_store::write_atomic`. `approve` re-reads the file and writes only the approved id into it, so an entry the user deleted to revoke stays deleted even before a reload (memory keeps it until `reload`); a file that exists but is unreadable, malformed or of another version approves nothing on `reload` and makes `approve` fail instead of being overwritten.
- **Recheck before every spawn.** The fingerprint is recomputed in the worker, before `run_plugin`.

**Threat model.** Approval is enforced in Rust. The webview initiates approving (`widgets_approve(pluginId, fingerprint)`), just as it answers tool approvals:

- **Compromised webview.** It could approve a plugin, but it can already send prompts and answer tool approvals, so this adds no new power.
- **What approval defends against.** Changes to a plugin's `command` or script made outside the desktop UI, e.g. the agent writing `widgets.json` or a widget script under write-mode approval.
- **What it does not defend against.** `widget-approvals.json` is a user file like `approval-rules/`. Anything with arbitrary user-file write access can edit it, as it can edit `~/.bashrc`. The rest of an entry (`match`, `triggers`, `intervalMs`, `timeoutMs`, `scope`, `title`, `enabled`) is not fingerprinted and takes effect on reload without a new approval.

## Runner (`run.rs`)

- **Spawn.**
  - argv comes from the config, with no shell.
  - The working directory is the project, or the home dir (`config::home_dir`) when there is none; never a temp dir.
  - The child gets `apply_child_path`, then a `PATH` with empty and relative entries removed.
  - On Windows it starts with `CREATE_NO_WINDOW` (`agent::spawn::CREATE_NO_WINDOW`).
- **Context.** Written as `OMP_WIDGET_*` env vars plus one stdin JSON line, then stdin is closed. Every field except `project` is limited to 2048 bytes: one env string over 128 KiB fails `spawn` with E2BIG on Linux.
- **Supervision.** `Arc<ProcessSupervisor>` (process group / Job Object). On timeout or stdout overflow (256 KiB), the whole tree is killed. When the direct child exits, the tree is also killed, so a background holder of the pipes cannot turn a success into a timeout; stderr is still collected.
- **Outcome.**
  - stdout is returned only if it is UTF-8 and parses as JSON (`IgnoredAny`). Otherwise the outcome is the error `stdout is not JSON: <redacted ≤120 char preview>`.
  - Exit ≠ 0 gives `exit <status>: <redacted 300-char tail>`.
  - A failed spawn gives `could not start <argv0>: <io error>`.
  - All plugin text that becomes UI error text is redacted in Rust. JS builds no preview of its own.
- **Never panics.**

## Invariants

- **Approval before every spawn.** No code path may start a plugin without a fingerprint check against `ApprovalStore` immediately before spawning.
- **Triggers and scheduling live in Rust.** No timers, trigger filtering, matching or run queues in React or `live.js`. The frontend only reports view state and renders.
- **The frontend sends only ids and view state** (`pluginId`, `fingerprint`, `sessionId`, visibility, hidden ids). Never a path, a command, a trigger or a plugin context.
- **`kill_all` sits beside `AgentBridge::shutdown_all`** in `crate::kill_child_processes`, which both the updater relaunch path (which skips `Drop`) and `RunEvent::Exit` call. Shutdown stops agents, browsers, widget plugins and terminal shells, in that order.
- **The config is read only at startup and on `widgets_reload`.** A run never re-reads `widgets.json`.
- **Rail hidden ⇒ nothing starts.** Neither does a card whose `widget:plugin:<id>` tweak is false.

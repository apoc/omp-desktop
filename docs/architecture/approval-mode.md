# Tool approval mode

omp's `--approval-mode` is chosen in the desktop: a global default and an optional per-project override, under the toolbar ✓ button (**approvals** panel) and in Settings → Approvals, which render the same `design/approval-mode-section.jsx` (`ApprovalModeSection`; Settings through `design/settings/rows-approvals.jsx`, whose `approvalRules` row also shows the standing-rule count and opens the panel). The Rust side is `src-tauri/src/approval_mode.rs` (`ApprovalModeStore`, the three `approval_mode_*` commands); the webview side is `src/app/approval-mode.js` (`window.OMP_APPROVAL_MODE`, regression `test-approval-mode.mjs`), the bridge methods and `_respawnSession` in `live.js`, and `design/approval-rules-panel.jsx` / `design/toolbar.jsx` (toolbar button). Standing rules (`approval.rs` `RuleBook`) are a separate store and are unchanged by this.

## Modes

Same three values as omp (`docs/approval-mode.md` in the omp repo), kebab-case on the wire:

| Mode | Auto-approves | Prompts for | Panel label |
|---|---|---|---|
| `always-ask` | `read` | `write`, `exec` | always ask |
| `write` (default) | `read`, `write` | `exec` | write |
| `yolo` | `read`, `write`, `exec` | none | yolo (amber, warn glyph) |

- `yolo` also skips omp's own stop for critical bash patterns (`rm -rf /`, fork bombs, …): omp ignores a bare `override: true` in yolo. An explicit `prompt` or `deny` policy from `tools.approval` still applies in every mode.
- Subagents (`task`) run headless in yolo inside omp whatever the mode is; their prompts never reach the desktop.
- The desktop never spawns omp without the flag. omp's own default is `yolo`, so inheriting it would be silent.

## The flag is the only lever

- `spawn::omp_args` always pushes `mode.flag()` (`--approval-mode=always-ask|write|yolo`). The mode a tab runs is the one `start_session` resolved from the store for its folder, never a value the webview sent (`StartSessionArgs` keeps `deny_unknown_fields`).
- omp has no RPC for changing the mode of a running process. A change therefore means a new process.
- omp's `main.ts` applies the flag with `cfgToolsApprovalMode.override`: the flag beats `tools.approvalMode` in `~/.omp/agent/config.yml` (and the profile's), so a config file cannot move a desktop tab off the mode the desktop chose. `tools.approval` per-tool policies are honoured in every mode.
- The desktop does not pass `--yolo` or `--auto-approve`.

## Store (`approval-mode.json`)

`<app config>/approval-mode.json`:

```json
{ "version": 1, "default": "write", "projects": { "/abs/canonical/path": "yolo" } }
```

- Written only by `approval_mode_set_default` and `approval_mode_set_project`, through `json_store::update_strict` under the store's file lock; the cache is updated in the commit closure (as `set_shell` does for `terminal.json`).
- A missing file reads as the defaults (`write`, no overrides). A malformed file also reads as the defaults, is logged, and makes the store refuse writes (`… is unreadable: …`), the same policy as `program_setting.rs` (the terminal's and browser's program settings): the user's file is not overwritten.
- No app config folder: the mode lives in memory only.
- `approval_mode_set_project(projectRoot, mode)`: `projectRoot` must be an absolute path; `mode: null` removes the key ("default" in the panel). Unknown mode strings are refused at the command boundary (`Err`), so `"Write"` or `"auto"` never reach the file.
- Keys are the canonical folder string (`Path::canonicalize()`, falling back to the raw path, as `approval::project_key`). The tab's `entry.path` is already canonical (`external_open::canonical_folder`), so a symlinked folder and its target share one override.
- `ApprovalModeView` (camelCase): `{ "default": "write", "projects": { … } }`. The getter is a cache read; the two setters return the new view.

## Resolution

`start_session` calls `ApprovalModeStore::resolve(cwd)`: the project's override if the tab's folder has one, else `default`. It returns the mode string, which is what omp was spawned with. The frontend stores that return value as `sessionRegistry` `approvalMode` for the incarnation (`null` until the first spawn resolves). `StartSessionArgs` keeps `deny_unknown_fields`, so a mode in the request is refused.

The frontend's "what should run" is `OMP_APPROVAL_MODE.effectiveFor(view, path)`: the project row's value if set, else `default`. A null view or a tab without a path falls back as the pure module documents.

## Restart on change

`setApprovalModeDefault` / `setApprovalModeProject` store the returned view and call `_applyApprovalModes()`, which is `OMP_APPROVAL_MODE.restartPlan(view, sessions, { activeId })`:

- A tab is in the plan iff its `approvalMode` is a mode and differs from `effectiveFor(view, path)`.
- **The active tab** is judged by its live `runState`. Idle (`!isBusyRunState`, not `failed`), it restarts now; busy (`running`, `retrying`, `waiting-user`, `background`), it is left alone and re-planned at its next idle point: every applied `get_state` response (the `get_state` branch of `_handleResponse`) — the one its `agent_end` asks for and the one `_initFetch` sends on activation both pass through it.
- **Background tabs** (not `failed`) always attempt (#89): their state froze when they were left and cannot tell whether a turn started since (a phone, a queued prompt, a background job waking it). The JS plan never kills on its own judgement; Rust's tracker decides (below).
- **`failed`** tabs (omp process gone) are in neither list; their next start uses the new mode.
- A per-tab `_respawning` guard (generalised from `_profileSwitching`) keeps a second pass from respawning the same tab while one is in flight.
- A restart that does not reach its target (Rust spawned another mode, or the respawn failed) is recorded in `_modeRestartMissed` (id → target). The tab is not retried until the target changes, so a disagreement between the frontend and Rust cannot become a restart loop. A refused restart (below) is not a miss.

### Conditional stop (`ifIdle`)

Every approval restart, active tab included, is `_respawnSession(id, { profile, resume: sessionFile, ifIdle: true })`. Its first side effect is Rust's `stop_session_if_idle { sessionId }` (`AgentBridge::stop_session_if_idle`): under the bridge's sessions lock it reads the tracker entry, and refuses — touching nothing — while the session is busy, has an open ask or has background work (`{ stopped: false, busy: true }`); otherwise it does exactly what `stop_session` does (`{ stopped: true, busy: false }`). No tracker entry counts as idle. That closes the gap between the plan and the kill: a turn that started after the webview last heard of the tab is never killed. The accepted window — a frame the reader records right after the check — is documented next to the function.

- **Refused** (or the call failed): no dictation stop, no listener teardown, no snapshot deletion, no registry update. `_respawnSession` resolves to `{ ok: false, deferred: true }`, the tab is reported in `deferred`, and its change stays pending (the toolbar shows `running ⇢ target`).
- **Retried** when an applied `agent://attention` payload shows a pending tab idle (`busy` false, `asks` 0, `background` false; `_retryModesOnIdle`), and at the `get_state` hook as before. A refusal changes nothing in the tracker, so there is no retry loop.
- **Dictation** (amendment to D89-5): an active tab that is dictating (or stopping a dictation) is deferred without a stop call — the transcript lives in omp, and stopping it first would be a side effect of a restart Rust may still refuse. When the dictation ends (`notify` / `_dictationStop`'s settlement), `_retryModesAfterDictation` runs `_applyApprovalModes()` once if a change is pending; its flag is cleared before the retry and set only by a new deferral. A capture that ended with "send on stop" (its `dictationCompleted` entry has `send: true`) clears the flag without retrying: a restart then would refuse the dictated send. That send's turn picks the change up at its `agent_end` → `get_state`.
- While a restart of the tab on screen is in flight (from the conditional stop until the tab is re-activated), user sends are refused — `send`, `steer`, `followUp`, `goalStart` (`_tabRestarting`): no bubble, no command. The composer keeps the draft (a submit handler that returns `false` leaves it) and notes "omp is restarting in this tab". The note is derived from live state: the snapshot's `restartingTab` (and `OMP_BRIDGE.restartingTab()`, `_restartingTab`) names the tab on screen that is restarting — the active tab while it respawns, or the tab the respawn detached while the active slot is empty — and `_respawnSession` notifies whenever it changes. `app-live.jsx` records that tab on a refused submit and shows the note only while the composer is on it and it is still `restartingTab` (`TURN.restartNoteShown`); a change of `restartingTab` drops it (`TURN.restartNoteKept`), so it goes away when the restart ends, without a submit. The respawn's own `_initFetch` goes through `_send` and is not gated.

A profile switch and every other respawn keep the unconditional `stop_session`: they are the user's explicit choice for that tab.

`_respawnSession` is the body of the profile switch, generalised. Both paths stop the process (`stop_session` or `stop_session_if_idle`, never `close_tab`), so:

- The tab id, name, project folder and terminal shell survive. Neither stop touches the terminal (`terminal.md`).
- The conversation survives: the new process is `omp … --resume=<sessionFile>`. `start_session` validates the resume path against the profile's sessions directory (`saved_sessions::validate_resume`). A tab whose omp has not yet written its session file has no `sessionFile`, or one that does not exist yet (`validate_resume`: "resume path does not exist"); its restart falls back to a spawn without `--resume` (a fresh conversation). This is the only case where a mode restart starts fresh.
- A profile switch keeps its old behaviour: `branch: null` and `_freshConversationFields`, a fresh conversation. A mode restart keeps the registry entry as it is; only `processStartedAt` changes.
- The restarted process is a new omp process, so it writes the conversation to the prompt cache again (its system prompt differs), the same cold write the conversation tree shows for any new process (CHANGELOG 0.7.0).
- A failure shows the note "Approval mode change failed" (the profile path keeps "Profile switch failed").
- `setApprovalModeDefault` / `setApprovalModeProject` resolve to `{ ok, error?, restarted: [ids], deferred: [ids] }`. The panel's apply line reports those counts.

## Standing rules and yolo

- `RuleBook` rules are untouched. They still auto-answer any prompt omp sends (`reader.rs` `try_auto_approve`).
- In `yolo`, omp sends no tier prompts, so rules have nothing to answer. The panel's yolo blurb says so.
- `always-ask` keeps "Allow for this session" / "Always allow in this project" on prompts that still come.

## Toolbar button and panel

- The ✓ button (`ApprovalModeButton` in `design/toolbar.jsx`, on the toolbar's right before the bridge; `approvals.onOpen`, keymap `desktop.panel.rules`, label "Approvals") carries `title="approvals"` and a `.tb-mode` span with `OMP_APPROVAL_MODE.statusCell(view, entry)` for the active tab: `{ label, warn, pending }`. The span is a `.tb-end-label`, so it hides below a 900px window like the bridge's text; the glyph stays.
- `label` is the running mode's label. While it differs from the effective one it reads `running ⇢ effective` (muted), e.g. `write ⇢ yolo` on a busy tab; `warn` is `effective === "yolo"`, so the glyph turns amber as soon as yolo is the target.
- The panel's head is "approvals". Its `tool approval mode` section has a `this project` row (only when the active tab has a path; `default | always ask | write | yolo`), a `default for every project` row, the mode blurb (`.mode-note.warn` for yolo) and the apply line. `standing rules` follows with the unchanged list.

## Not covered

- The mode does not touch the terminal shell: it runs with the user's rights, outside omp's approvals (`terminal.md`).
- Rail widget plugins are not agent tool calls in any mode and go through their own approval (`widgets.md`).
- Changing the mode while a turn is running does not stop that turn; it applies when the tab next goes idle.

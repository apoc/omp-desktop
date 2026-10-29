/* live.js — Tauri IPC bridge + OMP_BRIDGE + OMP_DATA initialisation.
   Depends on: adapter.js (must load first).
   Exposes: window.OMP_DATA (for design components), window.OMP_BRIDGE (for app-live.jsx).

   Each tab owns one omp process (one session). Switching tabs switches the active
   session — state is re-fetched from omp on every activation.

   Two modes:
     Tauri mode  — window.__TAURI__ present → per-session omp processes via IPC
     Demo mode   — no Tauri → leaves OMP_DATA at empty defaults, no connection */

(function () {
  "use strict";
  const { timeNow } = window;
  const { LOCAL_COMMANDS, adaptAvailableCommands, mergeSlashCommands, isCommandInvocation, queuedFrame } = window.OMP_SLASH;
  const SUB = window.OMP_SUBAGENTS;
  const CONTEXT = window.OMP_AGENT_CONTEXT;
  const STITLE = window.OMP_SESSION_TITLE;
  const PREFS = window.OMP_SESSION_PREFS;
  const QUEUE = window.OMP_QUEUE;
  const ASK = window.OMP_ASK_DIALOG;
  const APPROVAL = window.OMP_APPROVAL;
  const AMODE = window.OMP_APPROVAL_MODE;
  const TURN = window.OMP_TURN_STATUS;
  const GOAL = window.OMP_GOAL;
  const TASKS = window.OMP_BACKGROUND_TASKS;
  const TASK_EVENTS = new Set(["subagent_lifecycle", "subagent_progress", "tool_execution_start", "tool_execution_update", "tool_execution_end", "message_end", "session_settled"]);
  const EXT = window.OMP_EXT_WIDGETS;
  const LIVE = window.OMP_LIVE_VOICE;
  const DICTATION = LIVE.DICTATION;
  const { tsOf, mergeTranscript } = window.OMP_TRANSCRIPT;

  // ── Safe defaults so design components never crash on missing fields ──────
  const DEFAULT_DATA = {
    projects: [],
    messages: [],
    kanban: [],
    planMeta: { ask: "", strategy: "", touches: [], branch: "main", risks: [], estimate: { tokens: "—", cost: "—", wall: "—" } },
    commands: LOCAL_COMMANDS,
    models: [],
    activity: [],
    ctx: { used: null, total: null, pct: null, status: "unavailable", modelKey: null, label: "— / —", cost: "$0.00", tokensPerSec: 0 },
    microcopy: {
      empty:        "Hand me a project. I'll set the table.",
      streamingTip: "Press ⎋ to interrupt — your cursor is in the room.",
      paletteTip:   "type / to give orders · ⌘K opens the bridge",
      planTip:      "describe what to build, or give feedback on the plan…",
      todoEmpty:    "no plan yet. think out loud below.",
      radarHint:    "agent has been busy — last 60 seconds",
    },
  };

  window.OMP_DATA = JSON.parse(JSON.stringify(DEFAULT_DATA));

  // ── Active session state ───────────────────────────────────────────────────
  // These are the "current session's" live variables. _resetSessionVars() wipes
  // them and _switchToSession() swaps them when the active tab changes.
  const state = {
    messages:       [],
    askRecovery:    null,
    isStreaming:    false,
    model:          null,
    thinkingLevel:  null,
    ctx:            { ...DEFAULT_DATA.ctx },
    kanban:         [],
    planMeta:       { ...DEFAULT_DATA.planMeta },
    models:         [],
    commands:       LOCAL_COMMANDS,
    activity:       [],
    sparkline:      Array(30).fill(0),
    projects:       [],
    rpcState:       null,
    sessionCost:    null,
    currentTps:     0,
    exitReason:     null,   // non-empty agent://exit reason for the last run — drives the "failed" run state
    // omp reports background work (an async bash/task/eval job) that will
    // wake the agent after it yielded: set by every get_state's
    // `hasPendingAsyncWork` (agent_end always asks for one), cleared by
    // `session_settled`. Drives the "background" run state.
    asyncPending:   false,
    // `_trimMessages` cut the transcript's head (see the get_messages merge).
    trimmed:        false,
    // Subagent manager (src/app/subagents.js). Terminal agents are kept here
    // for the life of the session — omp's own registry forgets them.
    subagents:           SUB.emptySubagents(),
    backgroundTasks:     TASKS.empty(),
    agentContext:        CONTEXT.empty(),
    contextPolicy:       null,
    // agentId → { status, messages, nextByte, error } from get_subagent_messages.
    // Ephemeral: dropped on tab switch (not snapshotted) and refetched on demand.
    subagentTranscripts: {},
    // omp's steer / follow-up queue (app/message-queue.js), replaced by
    // every `queue_update` and `get_state` — never edited locally.
    queue:          QUEUE.EMPTY_QUEUE,
    // Steers / follow-ups sent but not yet acknowledged ("sending" rows).
    queueSending:   [],
    // omp's goal mode (app/goal.js): `{ known, goal }` from `get_state.goal`,
    // `goal_updated` frames and `goal` command responses.
    goal:           GOAL.UNKNOWN,
    // omp extension status lines and text widgets (app/extension-widgets.js,
    // #52). Not reset by `/new`, branch or fork (omp's TUI keeps them too);
    // gone with the process (`_endDeadProcessState`).
    extWidgets:     EXT.EMPTY,
    liveVoice:      LIVE.EMPTY,
    dictation:      DICTATION.EMPTY,
  };

  // Cancels in-flight reads and sends when the tab's conversation is replaced.
  let sessionContext = {};
  let streamingBubble = null;
  let activeToolCards = new Map();    // toolCallId → message index
  const ASK_FLUSH_MS = 150;         // upper bound on how long an ask may stay buffered
  // Ask bubbles (and auto-approval rows) awaiting a flush into
  // state.messages — see _queueAskBubble.
  let pendingAskBubbles    = [];    // FIFO of buffered ask messages
  let pendingAskFlushTimer = null;  // armed while the queue is non-empty
  let tpsSamples      = Array(30).fill(0);
  let turnStartTime   = null;
  let activityLog     = [];           // [{ts, toolName}], pruned to 60s
  let lastSeq         = 0;   // highest journal seq processed for the active session — see _dispatchEnvelope
  let lastTurnOk      = true; // last assistant message_end was not error/aborted — a failed first exchange must not spend the one-shot
  let _replayBuffer   = null; // null = live dispatch; [] = buffering during a replay (see _switchToSession)
  // Journal seq the active tab's extension snapshot reflects (`extension_ui_state`
  // after a dropped replay): replayed and buffered setStatus / setWidget
  // frames at or below it are already in `state.extWidgets`. 0 = none.
  let extSnapshotSeq  = 0;
  // The user's `abort` is in flight — set by `abort()`, cleared by its
  // id-less response. omp pauses an active goal on abort, and that pause is
  // labelled as the user's stop (app/goal.js `fromFrame`).
  let userAbortInFlight = false;
  let _msgSeq = 0;  // monotonic counter — stable React keys for message bubbles
  // Whether the manager is inspecting an agent — decides the RPC subagent
  // subscription level ("events" vs "progress"). Mirrors the UI (set only by
  // setSubagentInspecting); _switchToSession downgrades the process being
  // left but leaves the flag alone, so _initFetch applies it to the next one.
  let subagentInspecting = false;
  let _transcriptReq = 0; // monotonic token: only the latest load per agent may write

  function _agentContextSync() {
    if (!sessionContext.contextSync?.current()) {
      sessionContext.contextSync?.dispose();
      const owner = sessionContext, gen = _switchGen, id = activeSessionId;
      const revision = owner.contextRevision || 0;
      owner.contextSync = window.OMP_AGENT_CONTEXT_SYNC.create({
        request: _sendWithResponse, get: () => state.agentContext,
        set: next => { state.agentContext = next; }, changed: notify,
        subagents: () => state.subagents,
        current: () => sessionContext === owner && _switchGen === gen && activeSessionId === id && _switchAwayFrom == null && (owner.contextRevision || 0) === revision,
      });
    }
    return sessionContext.contextSync;
  }

  function _contextPolicyController() {
    if (!activeSessionId) throw new Error("Open a conversation to edit its profile policy.");
    if (!sessionContext.policyController?.current()) {
      sessionContext.policyController?.dispose();
      const owner = sessionContext, gen = _switchGen, id = activeSessionId;
      const current = () => sessionContext === owner && _switchGen === gen && activeSessionId === id && _switchAwayFrom == null;
      const client = window.OMP_CONTEXT_POLICY.create({
        request: _sendWithResponse, current,
        profileId: sessionRegistry.get(id)?.profile || window.DEFAULT_PROFILE_ID,
        changed: next => { state.contextPolicy = next; notify(); },
      });
      owner.policyController = { ...client, current };
    }
    return sessionContext.policyController;
  }

  // ── Minimap / message-history trim ───────────────────────────────────────
  const MINIMAP_COLS = 13;
  const MINIMAP_MAX  = MINIMAP_COLS * MINIMAP_COLS; // 169 — one full 13×13 grid

  // ── Session registry ───────────────────────────────────────────────────────
  // Tracks all open tabs. The tab list in the UI is derived from this.
  // { id, name, path, color, branch, profile }
  //
  // `profile` is the omp profile id the tab's process was spawned under
  // ("default" = omp's own ~/.omp/agent tree, spawned with no --profile
  // flag). It is per-tab: one omp process per tab means two tabs can run
  // under different profiles simultaneously, so changing a tab's profile
  // respawns only that tab (see switchSessionProfile).
  const sessionRegistry = new Map();
  const sessionSnapshots = new Map(); // id -> saved state + volatile vars
  const respawnVoice = new Map(); // same-conversation voice awaiting a fresh process activation
  // Fresh launches wait here until their project/branch setup is confirmed.
  // Queue rather than replace: OS opens and widget insertions await their own tab.
  const conversationSetups = [];
  let _lastSetupId = 0;
  const gitListeners = new Map();  // session_id → Tauri unlisten fn for git://branch/{id}
  // Prompt history — one list per tab, newest-first, in memory only. Never
  // persisted to disk/localStorage: filled as the user sends (_recordPrompt)
  // and backfilled from the transcript whenever get_messages arrives (tab
  // switch, resume from history) — see the get_messages handler below.
  const promptHistories = new Map(); // session id → string[]
  let promptHistoryLimit = window.OMP_PROMPT_HISTORY.DEFAULT_LIMIT;
  // Static prefix INTENT_FRAMING (app/constants.js) wraps plan-mode intents
  // in — recovers the as-typed prompt from a framed transcript entry so
  // recall shows what the user actually typed, not the wrapper.
  const FRAMING_PREFIX = window.INTENT_FRAMING("");
  // Shared by both prompt-history normalization sites (the transcript
  // backfill below and _recordPrompt further down) — hoisted into one
  // object so they can't drift apart the way _recordPrompt's own missing
  // normalization once did.
  const PROMPT_NORMALIZE = { framingPrefix: FRAMING_PREFIX, skip: [window.APPROVAL_PROMPT] };
  // Session ids with an omp respawn in flight (`_respawnSession`: a profile
  // switch or an approval-mode restart).
  const _respawning = new Set();
  const _closingVoiceTabs = new Set();
  // Tool approval mode (app/approval-mode.js): the `{ default, projects }`
  // view from Rust (`approval_mode_get`, replaced by every set's response),
  // null until the boot fetch lands. App-wide like `profiles`.
  let approvalModes = null;
  // id → the mode a restart of that tab asked for and did not get (Rust
  // spawned something else, or the respawn failed). `_applyApprovalModes`
  // leaves such a tab alone until the target changes, so a frontend/Rust
  // disagreement can never become a restart loop.
  const _modeRestartMissed = new Map();
  // Session ids whose cached `session_status` startup error has already been
  // filed into the transcript. The backend keeps that entry until the id's
  // next successful spawn, but `_switchToSession` asks on *every* activation,
  // so without this the same death is re-reported each time the user
  // switches back. Cleared on respawn (see `_spawnSession`), which is also
  // when the backend clears its own entry.
  const _notedStartupErrors = new Set();

  // ── Profiles ───────────────────────────────────────────────────────────────
  // Mirror of the Rust-side profile list (src-tauri/src/profiles.rs), refreshed
  // on startup and after every create/rename so the selector can render names
  // for the ids stored on each tab.
  const { DEFAULT_PROFILE_ID } = window; // app/constants.js
  let profiles = [{ id: DEFAULT_PROFILE_ID, name: DEFAULT_PROFILE_ID }];
  // The ticked default: which profile a launch (and a tab opened with no tab
  // to inherit from) starts in. App-wide and persisted, unlike a tab's own
  // profile - `_resetSessionVars` must never touch it.
  let startupProfileId = DEFAULT_PROFILE_ID;
  // Profile the next tab opens under while *no* tab is open — picked in the
  // profile menu at the empty workspace (otherwise the active tab's own
  // profile governs). Session-only: persisting it is the startup default's
  // job. Dropped as soon as a tab is active, so closing the last tab falls
  // back to the startup default as before.
  let _noTabProfileId = null;
  // Notes filed while no tab is open (a failed "Open with"): there is no
  // transcript to hold them, and `_resetSessionVars` would drop them from
  // `state.messages`. The empty workspace shows them; the next tab that
  // activates receives them as notes, so none is lost unseen.
  let workspaceNotes = [];
  // Recently opened project folders (the project sidebar's `recent`
  // section), always for the active tab's profile: `_recentsProfile` is the
  // profile the list was fetched for, so `_syncRecentsProfile` can tell when
  // a tab switch, a closed last tab or a new startup default moved the
  // active profile and the list is stale. App-wide like `profiles`.
  let recentProjects = [];
  let _recentsProfile = null;

  // Settings → Session / Agent (#37, app/session-prefs.js): app-wide prefs,
  // read from the stored tweaks at load so the boot restore sees
  // `restoreTabs` before React mounts; `setSessionPrefs` keeps them current.
  let sessionPrefs = PREFS.fromTweaks(window.OMP_TWEAKS_STORE.read(), window.TWEAK_DEFAULTS);
  // The busy-close confirmation on screen (`PREFS.tabCloseConfirm` /
  // `quitConfirm` shape), or null; `_closeConfirmAnswer` settles it.
  let closeConfirm = null;
  let _closeConfirmAnswer = null;
  // Last armed state handed to Rust's close guard (null = none sent yet),
  // and whether a confirmed quit is closing the window: the guard then
  // stays disarmed, or a notify would re-arm it under the closing window.
  let _closeGuardSent = null;
  let _quitting = false;

  let activeSessionId  = null;
  let activeListeners  = [];          // unlisten functions for current session

  // ── Open-tab layout (issue #17) ───────────────────────────────────────────
  // Kept equal to the open tabs in `open-tabs.json` (src-tauri/src/open_tabs.rs)
  // so the next launch reopens them; see docs/architecture/reopening-tabs.md.
  // Disarmed until the startup restore settled (`_restoreOpenTabs`).
  // `_layoutKey` is the JSON of the last layout queued (or adopted at
  // startup); `_layoutPending` the newest one not yet handed to a write —
  // one write runs at a time and only the newest layout is written next.
  let _layoutArmed   = false;
  let _layoutKey     = null;
  let _layoutPending = null;
  let _layoutWriting = false;
  // Last `session-<ms>` id handed out: two tabs started within one
  // millisecond (a restore spawns back to back) must still differ.
  let _lastSessionMs = 0;

  // ── ID-keyed response correlation ─────────────────────────────────────────
  // Used by _sendWithResponse to correlate commands that need a typed reply.
  const _pendingResponses = new Map(); // id → { resolve, reject }
  let _liveGen = 0;
  let _liveStartPending = null;
  let _liveStopPending = null;
  let _liveMutePending = null;
  let _dictationGen = 0;
  let _dictationStartPending = null;
  let _dictationStopPending = null;
  // Completed captures wait here until the mounted composer consumes them;
  // React may coalesce snapshots across a tab switch or several captures.
  let _dictationCompleted = [];
  let _nextCmdId = 1;
  // Timeout for a short interactive command a user is waiting on.
  const QUICK_CMD_TIMEOUT_MS = 15000;

  /**
   * Send a command and return a Promise that resolves with the response data
   * or rejects with an Error on failure. Uses the RPC id field for correlation.
   * @param {object}  cmd         Command body (type + args, no id).
   * @param {number}  [timeout]   Ms to wait before rejecting (0 = no timeout).
   */
  function _sendWithResponse(cmd, timeout = 120000, idPrefix = "d", apply = null) {
    let handedOff = Promise.resolve(false);
    let commandId = null;
    const response = new Promise((resolve, reject) => {
      if (!window.__TAURI__ || !activeSessionId) {
        reject(new Error("Not connected"));
        return;
      }
      const id = commandId = `${idPrefix}${_nextCmdId++}`;
      let timer;
      if (timeout > 0) {
        timer = setTimeout(() => {
          _pendingResponses.delete(id);
          const err = new Error(`Command '${cmd.type}' timed out after ${timeout}ms`);
          err.timedOut = true; // the response may still be owed (journal replay)
          reject(err);
        }, timeout);
      }
      _pendingResponses.set(id, {
        resolve(data) { clearTimeout(timer); apply?.(data); resolve(data); },
        reject(err)   { clearTimeout(timer); reject(err);   },
      });
      // A failed hand-off (the tab's process is gone) never produces a
      // response; reject now instead of waiting out the timeout. Still
      // logged, since several callers swallow rejections.
      handedOff = _invokeSend({ ...cmd, id }).then(() => true, e => {
        _logSendError(e);
        _pendingResponses.get(id)?.reject(e instanceof Error ? e : new Error(String(e)));
        _pendingResponses.delete(id);
        return false;
      });
    });
    response.handedOff = handedOff;
    // Voice teardown cancels commands that can no longer receive a reply
    // after a tab switch or process exit; other commands retain their timeout.
    response.cancel = reason => {
      const handler = _pendingResponses.get(commandId);
      if (!handler) return;
      _pendingResponses.delete(commandId);
      handler.reject(new Error(reason));
    };
    return response;
  }

  // ── Subscriber system ─────────────────────────────────────────────────────
  const subscribers = new Set();

  // Keep open questions and the latest row of cancellation outcomes even
  // when parallel work makes the transcript idle. The cap remains soft
  // when more than a screenful of callbacks are still open.
  function _trimMessages() {
    if (state.isStreaming || state.messages.length <= MINIMAP_MAX) return;
    let remaining = Math.ceil((state.messages.length - MINIMAP_MAX) / MINIMAP_COLS) * MINIMAP_COLS;
    const kept = [];
    const indices = new Map();
    const recentClosures = new Set();
    for (let i = state.messages.length - 1; i >= 0 && recentClosures.size < MINIMAP_COLS; i--) {
      if (state.messages[i].kind === "ask" && state.messages[i].cancelled) recentClosures.add(i);
    }
    for (let i = 0; i < state.messages.length; i++) {
      const m = state.messages[i];
      if (remaining > 0 && !(m.kind === "ask" && !m.answered && !m.cancelled) && !recentClosures.has(i)) {
        remaining--;
      } else {
        indices.set(i, kept.length);
        kept.push(m);
      }
    }
    if (kept.length === state.messages.length) return;
    state.messages = kept;
    state.trimmed = true;
    for (const [id, idx] of activeToolCards) {
      if (indices.has(idx)) activeToolCards.set(id, indices.get(idx));
      else activeToolCards.delete(id);
    }
  }

  // Memo for a session's run state (`TURN.runStateOf`, app/turn-status.js),
  // keyed on the messages array's identity.
  //
  // _buildSnapshot runs runStateOf for EVERY open tab on every notify() —
  // i.e. on every RPC line — so without this the cost is
  // O(tabs x messages) per streaming delta. Keying on identity is sound
  // precisely because no code path mutates state.messages in place: every
  // writer replaces the array (see _pushAssistantNote), so a stale entry is
  // unreachable (proven with an eval-kernel cell: 21/21 cases, including
  // the same array replayed under changing isStreaming/exitReason, which a
  // naive key-on-array-only memo gets wrong — `asyncPending` is part of
  // the key for the same reason).
  // A backgrounded tab's array is frozen for as long as it
  // stays backgrounded, so those tabs become a map lookup; only the active
  // tab, whose array is replaced as it streams, still scans — and that scan
  // is bounded by MINIMAP_MAX. A WeakMap means a closed tab's cached entry
  // is collected with its messages.
  const _runStateMemo = new WeakMap();
  // Shared so a never-activated tab keys the memo stably instead of
  // allocating a fresh (always-missing) array on every notify.
  const _EMPTY_SESSION_FIELDS = Object.freeze({
    isStreaming: false, exitReason: null, asyncPending: false, messages: Object.freeze([]),
  });
  function runStateCached(fields) {
    const { messages, isStreaming, exitReason, asyncPending } = fields;
    const hit = _runStateMemo.get(messages);
    if (hit && hit.isStreaming === isStreaming && hit.exitReason === exitReason && hit.asyncPending === asyncPending) {
      return hit.value;
    }
    const value = TURN.runStateOf(fields);
    _runStateMemo.set(messages, { isStreaming, exitReason, asyncPending, value });
    return value;
  }

  function _buildSnapshot() {
    return {
      messages:        state.messages,
      isStreaming:     state.isStreaming,
      asyncPending:    state.asyncPending,
      model:           state.model,
      thinkingLevel:   state.thinkingLevel,
      ctx:             state.ctx,
      kanban:          state.kanban,
      planMeta:        state.planMeta,
      models:          state.models,
      activity:        state.activity,
      sparkline:       state.sparkline,
      subagents:           state.subagents,
      backgroundTasks:     state.backgroundTasks,
      agentContext:        state.agentContext,
      contextPolicy:       state.contextPolicy,
      subagentTranscripts: state.subagentTranscripts,
      queue:           state.queue,
      queueSending:    state.queueSending,
      goal:            state.goal,
      extWidgets:      state.extWidgets,
      liveVoice:       state.liveVoice,
      dictation:       state.dictation,
      dictationCompleted: _dictationCompleted,
      // Tab list — derived from session registry, not per-session state.
      // runState: active tab reads live state; background tabs read their
      // cached snapshot (never activated yet = "idle" defaults).
      sessions:        _sessionsView(),
      activeSessionId,
      // Active tab's prompt history only — never persisted, see promptHistories above.
      promptHistory:   promptHistories.get(activeSessionId) ?? [],
      profiles,
      startupProfileId,
      approvalModes,
      noTabProfileId:  _noTabProfile(),
      recentProjects,
      workspaceNotes,
      closeConfirm,
      conversationSetup: conversationSetups[0]?.view ?? null,
    };
  }

  // Snapshot `sessions[]`: the registry entries plus each tab's run state.
  // Active tab reads live state; background tabs read their cached snapshot
  // (never activated yet = "idle" defaults).
  function _sessionsView() {
    return [...sessionRegistry.values()].map(s => ({
      ...s,
      runState: runStateCached(
        s.id === activeSessionId
          ? state
          : sessionSnapshots.get(s.id) ?? _EMPTY_SESSION_FIELDS
      ),
    }));
  }

  // Invoke a Tauri command, returning `fallback` when there's no Tauri
  // runtime (browser-only dev mode) or the command throws. Every
  // fire-and-get-a-value bridge method below funnels through here so the
  // guard/try/catch/console.error shape exists once instead of per method.
  async function _invokeSafe(cmd, args, fallback = undefined) {
    if (!window.__TAURI__) return fallback;
    try {
      return await window.__TAURI__.core.invoke(cmd, args);
    } catch (err) {
      console.error(`[live] ${cmd} error:`, err);
      return fallback;
    }
  }

  // Like `_invokeSafe`, but surfaces the backend's rejection reason instead
  // of swallowing it: resolves to `{ok: true, value}` or `{ok: false, error}`
  // (an error string meant for display).
  async function _invokeResult(cmd, args) {
    if (!window.__TAURI__) return { ok: false, error: "not connected" };
    try {
      return { ok: true, value: await window.__TAURI__.core.invoke(cmd, args) };
    } catch (err) {
      return { ok: false, error: String(err?.message ?? err) };
    }
  }

  // Git browser reads: `cmd` for the active tab's project folder, as
  // `_invokeResult`'s `{ok, value | error}`; null with no project open.
  async function _gitBrowserInvoke(cmd, args) {
    const path = _activeProjectPath();
    if (!path) return null;
    return _invokeResult(cmd, { path, ...args });
  }

  // Rail widgets: the `WidgetsSnapshot` `cmd` returns, or an empty one that
  // carries the rejection as `fatal` (browser mode: empty, no fatal).
  // app/use-widgets.jsx's applySnapshot defaults every missing field.
  async function _widgetsSnapshot(cmd) {
    if (!window.__TAURI__) return {};
    const r = await _invokeResult(cmd, {});
    return r.ok ? r.value : { fatal: r.error };
  }

  // What the user typed for a `/skill:` call, from its `skill-prompt`
  // message's details (omp's `buildSkillPromptMessage`): `prompt` is the
  // draft as sent, else the invocation is rebuilt from name and args.
  function _skillPromptText(details) {
    if (typeof details?.prompt === "string" && details.prompt) return details.prompt;
    const args = typeof details?.args === "string" && details.args ? ` ${details.args}` : "";
    return `/skill:${details?.name ?? ""}${args}`;
  }

  // Build an ask bubble. The `extension_ui_request` methods it is built for
  // differ only in `method` and a few method-specific fields; the defaults below
  // (`options`/`answered`/`cancelled`/`answer`) are exactly what runStateOf
  // and _resolveAsk depend on, so they live here rather than being restated
  // — and silently drifting — per branch. One drift is deliberately
  // normalized away: a missing `title` now yields "" for every method,
  // where previously only `input` did that and the other three left it
  // undefined. Proven with an eval-kernel cell (6/6 cases: each branch's
  // original literal reproduced field-for-field).
  function _askMessage(method, ev, extra) {
    return {
      kind: "ask",
      method,
      id: ev.id,
      // The tab whose process asked: frames are dispatched only for the
      // active tab (see `_switchToSession`), and a tool approval's grant
      // names this session with the request id (`approveAndRemember`).
      sessionId: activeSessionId,
      time: timeNow(),
      title: ev.title ?? "",
      options: [],
      answered: false,
      cancelled: false,
      answer: null,
      ...extra,
    };
  }

  // Buffer an ask bubble instead of pushing it straight into
  // `state.messages`: omp's `select` (a tool approval) and its ask dialog
  // request both reach stdout just BEFORE the `tool_execution_start` of the
  // tool they belong to, so pushing on arrival puts the prompt above its own
  // tool card. tool_execution_start flushes the queue, giving the
  // [tool_card, ask_bubble] order.
  //
  // Two properties this has to keep, both learned from a wedged session:
  //   1. It is a QUEUE, not a single slot. A turn with parallel tool calls
  //      emits one select per gated tool before any of them start; a single
  //      slot kept only the last, and every dropped prompt is an ask omp is
  //      still blocked on — its tool card sits at "running" forever and the
  //      tab looks frozen with no way to unblock it.
  //   2. The flush is guaranteed, not conditional. Selects that arrive after
  //      the turn's last tool_execution_start have nothing left to flush
  //      against, so ASK_FLUSH_MS bounds how long a prompt may stay
  //      invisible. Cosmetic ordering is best-effort; liveness is not.
  //
  function _queueAskBubble(msg) {
    pendingAskBubbles.push(msg);
    if (pendingAskFlushTimer === null) {
      pendingAskFlushTimer = setTimeout(() => {
        pendingAskFlushTimer = null;
        if (_flushAskBubbles()) notify();
      }, ASK_FLUSH_MS);
    }
  }

  // Append every buffered ask bubble, oldest first. Returns whether anything
  // moved so callers know if they owe a notify().
  function _flushAskBubbles() {
    if (pendingAskBubbles.length === 0) return false;
    state.messages = [...state.messages, ...pendingAskBubbles];
    pendingAskBubbles = [];
    _disarmAskFlush();
    return true;
  }

  function _disarmAskFlush() {
    if (pendingAskFlushTimer !== null) {
      clearTimeout(pendingAskFlushTimer);
      pendingAskFlushTimer = null;
    }
  }

  function _rememberSettledAsk(owner, id) {
    const settled = owner.askSettled ??= new Set();
    settled.add(id);
    if (settled.size > 512) settled.delete(settled.values().next().value);
  }

  // The journal can evict a request while its callback still waits. Rust's
  // process-local snapshot carries the surviving requests at replay head.
  // Apply it after the ring and before buffered later live frames.
  function _reconcilePendingRequests(replay) {
    if (sessionContext.processEnded || !Array.isArray(replay.pendingRequests)) return;
    const requests = [];
    for (const entry of replay.pendingRequests) {
      try {
        const frame = JSON.parse(entry.text);
        if (frame?.type === "extension_ui_request" && typeof frame.id === "string" &&
            ["ask", "select", "input", "editor", "confirm"].includes(frame.method)) requests.push(frame);
      } catch (_) {}
    }
    const ids = new Set(requests.map(frame => frame.id));
    if (replay.pendingRequestsComplete === true) {
      const close = m => {
        if (m.kind !== "ask" || m.recovery || m.answered || m.cancelled || ids.has(m.id)) return m;
        if (m.sending) return { ...m, noLongerPending: true };
        _rememberSettledAsk(sessionContext, m.id);
        return { ...m, cancelled: true, closeReason: "no-longer-pending" };
      };
      state.messages = state.messages.map(close);
      pendingAskBubbles = pendingAskBubbles.map(close);
    }
    for (const frame of requests) {
      if (sessionContext.askSettled?.has(frame.id) ||
          state.messages.some(m => m.kind === "ask" && m.id === frame.id) ||
          pendingAskBubbles.some(m => m.kind === "ask" && m.id === frame.id)) continue;
      _dispatchFrame(frame);
    }
    if (replay.dropped && replay.pendingRequestsComplete === false && !sessionContext.askReplayWarning) {
      sessionContext.askReplayWarning = true;
      _pushAssistantNote("**Some questions may not have been recovered:** the background event journal and pending-request snapshot were incomplete.");
    }
    _flushAskBubbles();
    notify();
  }

  // Settle a pending ask bubble: apply `patch` to the first unanswered,
  // uncancelled bubble with this id and publish. Returns whether one
  // matched. The re-answer guard (a bubble already answered or cancelled is
  // left alone) is the subtle part — it lives here once, for the user's
  // answers (_resolveAsk) and omp's own `cancel` alike.
  function _settleAsk(id, patch) {
    let settled = false;
    state.messages = state.messages.map(m => {
      if (m.kind === "ask" && m.id === id && !m.answered && !m.cancelled) {
        settled = true;
        return { ...m, ...patch };
      }
      return m;
    });
    if (settled) {
      _rememberSettledAsk(sessionContext, id);
      notify();
    }
    return settled;
  }

  // Both ordinary replies and approval grants keep the callback open while
  // their owning process's write is in flight.
  function _beginAskSend(msg) {
    if (msg.sending || msg.sessionId !== activeSessionId || !window.__TAURI__ ||
        sessionContext.processEnded || _respawning.has(activeSessionId) || _switchAwayFrom === activeSessionId) return null;
    const id = msg.id;
    const origin = activeSessionId, owner = sessionContext, token = {};
    state.messages = state.messages.map(m => m === msg ? { ...m, sending: token, sendError: null } : m);
    notify();
    const finish = (fields, failed = false) => {
      const update = messages => messages.map(m => {
        if (m.kind !== "ask" || m.id !== id || m.sending !== token || m.answered || m.cancelled) return m;
        if (failed && m.noLongerPending) {
          return { ...m, cancelled: true, closeReason: "no-longer-pending", sending: null };
        }
        return { ...m, ...fields, sending: null };
      });
      const snapshot = sessionSnapshots.get(origin);
      if (snapshot?.sessionContext === owner) snapshot.messages = update(snapshot.messages);
      if (activeSessionId === origin && sessionContext === owner) {
        state.messages = update(state.messages);
        notify();
      }
    };
    return { origin, owner, finish };
  }

  // An IPC write is not an acknowledgement from omp, but a rejected write
  // certainly did not deliver the answer. Keep the question open until the
  // write succeeds; a token prevents duplicate sends and stale completions.
  async function _resolveAsk(id, patch, payload) {
    const msg = state.messages.find(m => m.kind === "ask" && m.id === id && !m.answered && !m.cancelled);
    if (!msg) return false;
    if (msg.recovery) return _resolveRecoveredAsk(msg, patch, payload);
    const send = _beginAskSend(msg);
    if (!send) return false;
    const { origin, owner, finish } = send;
    try {
      await window.__TAURI__.core.invoke("send_command", {
        sessionId: origin, json: JSON.stringify({ type: "extension_ui_response", id, ...payload }),
      });
      _rememberSettledAsk(owner, id);
      finish(patch);
      return true;
    } catch (error) {
      _logSendError(error);
      finish({ sendError: String(error?.message ?? error) }, true);
      return false;
    }
  }

  // A restart ended the tool invocation: only a new user reply can continue
  // the conversation. Never send the old request id to the new process.
  async function _resolveRecoveredAsk(msg, patch, payload) {
    if (msg.recoverySending || msg.sessionId !== activeSessionId || state.isStreaming) return false;
    const recovery = window.OMP_ASK_RECOVERY;
    const origin = activeSessionId;
    if (payload.cancelled) {
      try {
        recovery.dismiss(msg.recovery.file, msg.recovery.callIds);
        return _settleAsk(msg.id, patch);
      } catch (error) {
        state.messages = state.messages.map(m => m === msg ? { ...m, recoveryError: String(error.message ?? error) } : m);
        notify();
        return false;
      }
    }
    const text = recovery.reply(msg.questions, payload.answers);
    if (!text) return false;
    const token = {};
    state.messages = state.messages.map(m => m === msg ? { ...m, recoverySending: token, recoveryError: null } : m);
    notify();
    const finish = fields => {
      const current = activeSessionId === origin;
      const target = current ? state : sessionSnapshots.get(origin);
      if (!target) return;
      target.messages = target.messages.map(m => m.id === msg.id && m.recoverySending === token
        ? { ...m, ...fields, recoverySending: null } : m);
      if (current) notify();
    };
    try {
      _disarmAutoRename(text);
      _recordPrompt(text);
      await _sendWithResponse({ type: "prompt", message: text });
      finish(patch);
      return true;
    } catch (error) {
      finish({ recoveryError: String(error.message ?? error) });
      return false;
    }
  }

  // State and history RPC replies may arrive in either order. Keep only the
  // small parsed batch in the per-tab snapshot, not another full transcript.
  function _syncRecoveredAsks() {
    if (!state.rpcState) return false;
    if (state.isStreaming) { state.askRecovery = null; return false; }
    const restored = state.askRecovery;
    const messages = state.messages.filter(m => !m.recovery || m.answered || m.recoverySending || m.id === restored?.id);
    const isLive = m => m.kind === "ask" && !m.recovery && !m.answered && !m.cancelled;
    const liveAsk = messages.some(isLive) || pendingAskBubbles.some(isLive);
    if (restored && !liveAsk && !messages.some(m => m.id === restored.id)) {
      messages.push({
        ..._askMessage("ask", restored, { questions: restored.questions, answers: null, timeout: null }),
        recovery: restored.recovery,
      });
    } else if (messages.length === state.messages.length) return false;
    state.messages = messages;
    return true;
  }

  // Append a synthetic assistant note (process exited, startup failed,
  // a workspace notice) and publish it.
  //
  // Owns two invariants that were previously restated at each call site and
  // got them wrong at two of three:
  //   1. `state.messages` is REPLACED, never mutated in place — subscribers
  //      diff by array identity, so a `.push()` renders nothing.
  //   2. The body goes in `blocks`, not `text` — AssistantBubble reads
  //      `msg.blocks` with no `text` fallback, so a bare `text` field is a
  //      silently empty bubble.
  // Any future note site calls this rather than re-deriving the shape.
  // Proven with an eval-kernel cell (3/3 cases: array identity changes,
  // body lands in `blocks` with no `text` field, note is completed).
  // A note carries no `ts` (no omp message stands behind it), so the
  // get_messages merge keeps it in place (app/transcript-merge.js).
  function _pushAssistantNote(text) {
    state.messages = [...state.messages, _assistantBubble({
      blocks: [{ type: "text", text }],
      completed: true,
    })];
  }

  // A finished assistant bubble the desktop builds itself, with `fields` on top.
  function _assistantBubble(fields) {
    return {
      kind: "assistant", time: timeNow(), model: state.model?.name ?? null,
      blocks: [], thought: null, lead: null, streaming: false,
      ...fields,
    };
  }

  // Show a run's final failure (`make(previous)` builds it, app/turn-status.js)
  // on the bubble its failed message created: the one with the failed
  // message's `ts` when the caller knows it — even one still marked
  // streaming because its message_end was lost — else the last bubble of an
  // omp message (it has a `ts`; notes do not), unless a user turn omp
  // accepted came after it (a prompt it refused, which never got a `ts`,
  // starts no run). An earlier hidden `pendingFailure` belongs to an
  // attempt omp retried.
  // When no bubble stands for that message (frames lost to a replay gap),
  // the failure gets a bubble of its own, tied to the message by `ts`.
  function _showFailure(make, ts = null) {
    const msgs = state.messages;
    let idx = ts == null ? -1 : msgs.findLastIndex(m => m.kind === "assistant" && m.ts === ts);
    const byTs = idx !== -1;
    if (!byTs) {
      for (let i = msgs.length - 1; i >= 0; i--) {
        if (msgs[i].kind === "user" && msgs[i].ts != null) break;
        if (msgs[i].kind === "assistant" && msgs[i].ts != null && !msgs[i].streaming && !msgs[i].superseded) { idx = i; break; }
      }
    }
    const target = idx === -1 ? null : msgs[idx];
    if (target && (byTs || target.pendingFailure || target.failure)) {
      const { pendingFailure, ...rest } = target;
      const next = [...msgs];
      next[idx] = { ...rest, streaming: false, failure: make(target.failure ?? pendingFailure ?? null) };
      state.messages = next;
      if (streamingBubble && streamingBubble.ts === target.ts) streamingBubble = null;
    } else {
      state.messages = [...msgs, _assistantBubble({ ts, failure: make(null) })];
    }
  }

  /** Pure: the assistant-note text for a non-empty `agent://exit` reason.
   *
   *  The generic form is just the reason, but one case needs instructions
   *  instead of a diagnosis. `omp --mode rpc-ui` refuses to start when the
   *  profile it was pointed at has no usable model and exits non-zero before
   *  emitting a frame, leaving a tab with no agent to answer `/login` or
   *  `get_login_providers` — so the in-app login flow cannot bootstrap that
   *  profile, and omp's interactive TUI (which runs its onboarding picker
   *  instead of exiting) is the way through.
   *
   *  A *freshly created* profile no longer reaches this: `create_profile`
   *  seeds a keyless-provider `models.yml` precisely so it boots and can be
   *  logged into from the app (see `clear_profile_bootstrap` below). What
   *  survives is a profile whose seed was already cleared by a login that
   *  has since been revoked or expired, one whose credentials were removed
   *  out of band, or a hand-managed profile tree.
   *  Proven with an eval-kernel cell (6/6 cases: plain reason passes
   *  through, no-models reason on a named profile names the --profile flag,
   *  on the built-in profile omits it, an absent profile omits it, the match
   *  is case-insensitive, and omp's own wording is retained for support).
   *  @param {string}  reason    trimmed `agent://exit` payload
   *  @param {string=} profileId the tab's profile, if any */
  function _exitNote(reason, profileId) {
    if (!/no models available/i.test(reason)) {
      return `**Agent process exited:** ${reason}`;
    }
    const flag = profileId && profileId !== DEFAULT_PROFILE_ID ? ` --profile ${profileId}` : "";
    return [
      "**This profile has no model credentials yet.**",
      "",
      "omp's RPC mode refuses to start without a usable model, so this tab has no agent —"
        + " which is also why `/login` and the provider list do nothing here.",
      "",
      "Log in once from a terminal, then reopen the tab:",
      "",
      "```",
      `omp${flag}`,
      "```",
      "",
      `omp reported: ${reason}`,
    ].join("\n");
  }

  function notify() {
    _trimMessages();
    // Stamp stable IDs on any message that doesn't have one yet (new pushes,
    // restored sessions, or messages from get_messages). O(N) but N ≤ 169 and
    // is a no-op for already-stamped entries — essentially free.
    for (const m of state.messages) {
      if (!m._id) m._id = ++_msgSeq;
    }
    const snap = _buildSnapshot();
    subscribers.forEach(cb => cb(snap));
    _syncCloseGuard(snap.sessions);
    // Keep OMP_DATA in sync for design components that read it directly
    window.OMP_DATA.messages  = state.messages;
    window.OMP_DATA.models    = state.models;
    window.OMP_DATA.commands  = state.commands;
    window.OMP_DATA.kanban    = state.kanban;
    window.OMP_DATA.planMeta  = state.planMeta;
    window.OMP_DATA.ctx       = state.ctx;
    window.OMP_DATA.activity  = state.activity;

    _persistLayout();
  }

  function _layoutNow() {
    return window.OMP_PROJECT_NAV.tabLayout([...sessionRegistry.values()].filter(s => !s.preparing), activeSessionId);
  }

  /** Write the open-tab layout if it changed since the last one (see
   *  `_layoutArmed`). Hooked into `notify`, which every registry,
   *  conversation and active-tab change already goes through; the layout is
   *  a few short strings per tab, so building its key each time is cheap.
   *  Latest wins: layouts superseded while a write runs (cycling through
   *  tabs) are never written. A failed write is logged (`_invokeSafe`) and
   *  not retried until the layout changes again — retrying on every
   *  `notify` would spin on a broken disk. */
  function _persistLayout() {
    if (!_layoutArmed) return;
    const layout = _layoutNow();
    const key = JSON.stringify(layout);
    if (key === _layoutKey) return;
    _layoutKey = key;
    _layoutPending = layout;
    if (!_layoutWriting) void _flushLayout();
  }

  async function _flushLayout() {
    _layoutWriting = true;
    while (_layoutPending) {
      const layout = _layoutPending;
      _layoutPending = null;
      await _invokeSafe("open_tabs_save", { layout });
    }
    _layoutWriting = false;
  }

  // The active tab's omp process is gone (the exit listener, or a startup
  // death found by session_status). A dead process sends no terminal frames
  // and answers no get_subagents: end its live agents here (outcome
  // unknown) or they tick forever. Its queue died with it, no send to it
  // will be acknowledged, and its background jobs died with it too.
  function _endDeadProcessState() {
    sessionContext.processEnded = true;
    state.subagents = SUB.mergeSnapshots(state.subagents, []);
    state.backgroundTasks = TASKS.markDead(state.backgroundTasks);
    state.queue = QUEUE.EMPTY_QUEUE;
    state.queueSending = [];
    state.asyncPending = false;
    state.messages = TURN.retryCleared(state.messages);
    _flushAskBubbles();
    state.messages = state.messages.map(m => m.kind === "ask" && !m.recovery && !m.answered && !m.cancelled
      ? { ...m, cancelled: true, closedByOmp: true, closeReason: "process-exited", sending: null } : m);
    // Its extensions died with it; the backend's copy ended with the entry.
    _cancelLiveRequests();
    state.liveVoice = LIVE.apply(state.liveVoice, { type: "process_exit", error: state.exitReason });
    if (state.dictation.active) _finishDictation({ type: "process_exit", error: state.exitReason || "The omp process ended during voice to text" });
    _cancelDictationRequests();
    state.extWidgets = EXT.EMPTY;
  }

  // Reset all per-session volatile state (called before loading a new session)
  function _resetSessionVars(keepVoice = false) {
    sessionContext.contextSync?.dispose();
    sessionContext.policyController?.dispose();
    Object.assign(state, {
      messages:      [],
      askRecovery:   null,
      isStreaming:   false,
      model:         null,
      thinkingLevel: null,
      ctx:           { ...DEFAULT_DATA.ctx },
      kanban:        [],
      planMeta:      { ...DEFAULT_DATA.planMeta },
      models:        [],
      commands:      LOCAL_COMMANDS,
      activity:      [],
      sparkline:     Array(30).fill(0),
      projects:      [],
      rpcState:      null,
      sessionCost:   null,
      currentTps:    0,
      exitReason:    null,
      asyncPending:  false,
      trimmed:       false,
      subagents:           SUB.emptySubagents(),
      backgroundTasks:     TASKS.empty(),
      agentContext:        CONTEXT.empty(),
      contextPolicy:       null,
      subagentTranscripts: {},
      queue:         QUEUE.EMPTY_QUEUE,
      queueSending:  [],
      goal:          GOAL.UNKNOWN,
      extWidgets:    EXT.EMPTY,
      liveVoice:     keepVoice ? state.liveVoice : LIVE.EMPTY,
      dictation:     keepVoice ? state.dictation : DICTATION.EMPTY,
    });
    sessionContext = {};
    streamingBubble = null;
    lastTurnOk  = true;
    pendingAskBubbles = [];
    _disarmAskFlush();
    activeToolCards = new Map();
    tpsSamples      = Array(30).fill(0);
    turnStartTime   = null;
    activityLog     = [];
    lastSeq         = 0;
    extSnapshotSeq  = 0;
    userAbortInFlight = false;
  }

  // ── Session snapshot helpers ──────────────────────────────────────────────
  function _saveCurrentSession() {
    if (!activeSessionId) return;
    sessionContext.policyController?.dispose();
    // Buffered asks belong to the session being left — flush them into its
    // messages so the snapshot carries them. Leaving them in the queue would
    // either lose them or leak them into the next session's transcript.
    _flushAskBubbles();
    sessionSnapshots.set(activeSessionId, {
      // state fields
      messages:      state.messages,
      askRecovery:   state.askRecovery,
      isStreaming:   state.isStreaming,
      model:         state.model,
      thinkingLevel: state.thinkingLevel,
      ctx:           { ...state.ctx },
      kanban:        state.kanban,
      planMeta:      state.planMeta,
      models:        state.models,
      commands:      state.commands,
      activity:      state.activity,
      sparkline:     [...state.sparkline],
      rpcState:      state.rpcState,
      sessionCost:   state.sessionCost,
      currentTps:    state.currentTps,
      exitReason:    state.exitReason,
      asyncPending:  state.asyncPending,
      trimmed:       state.trimmed,
      // Last-turn outcome for the auto-rename gate (see _applyRpcState):
      // survives tab switches so a snapshot-restored session does not
      // forget a failed first exchange and re-arm the one-shot.
      lastTurnOk,
      subagents:     state.subagents,
      backgroundTasks: state.backgroundTasks,
      agentContext:  state.agentContext,
      contextPolicy: state.contextPolicy,
      queue:         state.queue,
      queueSending:  state.queueSending,
      goal:          state.goal,
      extWidgets:    state.extWidgets,
      liveVoice:     state.liveVoice,
      dictation:     state.dictation,
      // volatile vars
      sessionContext,
      streamingBubble,
      activeToolCards: new Map(activeToolCards),
      tpsSamples:    [...tpsSamples],
      turnStartTime,
      activityLog:   [...activityLog],
      lastSeq,
      // An abort whose pause frame and response are still in the tab's
      // journal: the replay on the way back labels the pause and clears it.
      userAbortInFlight,
    });
  }

  function _restoreSession(id) {
    const snap = sessionSnapshots.get(id);
    if (!snap) return false;
    Object.assign(state, {
      messages:      snap.messages,
      askRecovery:   snap.askRecovery ?? null,
      isStreaming:   snap.isStreaming,
      model:         snap.model,
      thinkingLevel: snap.thinkingLevel,
      ctx:           snap.ctx,
      kanban:        snap.kanban,
      planMeta:      snap.planMeta,
      models:        snap.models,
      commands:      snap.commands ?? LOCAL_COMMANDS,
      activity:      snap.activity,
      sparkline:     snap.sparkline,
      rpcState:      snap.rpcState,
      sessionCost:   snap.sessionCost,
      currentTps:    snap.currentTps,
      exitReason:    snap.exitReason ?? null,
      asyncPending:  snap.asyncPending ?? false,
      trimmed:       snap.trimmed ?? false,
      subagents:     snap.subagents ?? SUB.emptySubagents(),
      backgroundTasks: snap.backgroundTasks ?? TASKS.empty(),
      agentContext:  snap.agentContext ?? CONTEXT.empty(),
      contextPolicy: snap.contextPolicy ? { ...snap.contextPolicy, loading: false, saving: false } : null,
      subagentTranscripts: {},
      queue:         snap.queue ?? QUEUE.EMPTY_QUEUE,
      queueSending:  snap.queueSending ?? [],
      goal:          snap.goal ?? GOAL.UNKNOWN,
      extWidgets:    snap.extWidgets ?? EXT.EMPTY,
      liveVoice:     snap.liveVoice ?? LIVE.EMPTY,
      dictation:     snap.dictation ?? DICTATION.EMPTY,
    });
    sessionContext = snap.sessionContext ?? {};
    streamingBubble = snap.streamingBubble;
    activeToolCards = snap.activeToolCards;
    tpsSamples      = snap.tpsSamples;
    turnStartTime   = snap.turnStartTime;
    activityLog     = snap.activityLog;
    lastSeq         = snap.lastSeq ?? 0;
    userAbortInFlight = snap.userAbortInFlight ?? false;
    lastTurnOk      = snap.lastTurnOk ?? true;
    return true;
  }

  // ── Session switching ─────────────────────────────────────────────────────
  // Generation counter guards against overlapping switches: _switchToSession
  // is async with multiple await points and writes shared module state
  // (_replayBuffer, lastSeq, activeSessionId, activeListeners). Without this,
  // fast tab switches (A→B→C) can interleave at their awaits and let a
  // later-resolving call for an earlier click overwrite state for the
  // now-current session, permanently corrupting its lastSeq cursor so future
  // live events are dropped as stale duplicates. Proven with an eval-kernel
  // cell (2/2 cases: unguarded stale call clobbers the current session's
  // state after a newer switch already took over; guarded stale call detects
  // the generation mismatch and bails without touching shared state).
  let _switchGen = 0;
  // Keep the old listener alive while stopping its microphone. Separate
  // intent from activation generation so rapid tab clicks share that stop.
  let _switchIntent = 0;
  let _switchAwayFrom = null;
  let _switchPromise = Promise.resolve();
  async function _switchToSession(id) {
    if (!window.__TAURI__) return;
    let done;
    const p = new Promise(resolve => { done = resolve; });
    _switchPromise = p;
    const intent = ++_switchIntent;
    const previous = activeSessionId;
    _switchAwayFrom = previous !== id ? previous : null;
    try {
    if (previous && previous !== id && state.liveVoice.active) {
      const stopped = await _livePause();
      if (_switchIntent !== intent || activeSessionId !== previous) return;
      // A failed stop might still be recording. Do not background that tab.
      if (!stopped.ok && state.liveVoice.active) return;
    }
    if (previous && previous !== id && (state.dictation.active || _dictationStopPending)) {
      const stopped = await _dictationStop();
      if (_switchIntent !== intent || activeSessionId !== previous) return;
      if (!stopped.ok && state.dictation.active) return;
    }
    if (_switchIntent !== intent || !sessionRegistry.has(id)) return;
    const myGen = ++_switchGen;

    // Snapshot current session so we can restore it when switching back
    _saveCurrentSession();
    // The inspected agent belongs to the tab being left: drop that process
    // back to "progress" while activeSessionId still addresses it.
    if (subagentInspecting) {
      _send({ type: "set_subagent_subscription", level: SUB.subscriptionLevelFor({ inspecting: false }) });
    }

    // Tear down old listeners
    for (const ul of activeListeners) { try { await ul(); } catch (_) {} }
    if (_switchGen !== myGen) return; // superseded by a newer switch
    activeListeners = [];
    _chunkAcc = null; // drop any partial chunk run from the previous session

    activeSessionId = id;
    _noTabProfileId = null;
    _syncRecentsProfile();

    // Restore cached snapshot (preserves streaming messages) or start fresh
    if (!_restoreSession(id)) {
      _resetSessionVars();
    }
    if (respawnVoice.has(id)) {
      state.liveVoice = respawnVoice.get(id);
      respawnVoice.delete(id);
    }
    if (workspaceNotes.length > 0) {
      for (const note of workspaceNotes) _pushAssistantNote(note);
      workspaceNotes = [];
    }

    // Arm event buffering before attaching the live listener so a line that
    // arrives between listener-attach and the replay fetch below is queued
    // (never lost, never double-processed) — drained once replay is applied.
    _replayBuffer = [];
    extSnapshotSeq = 0;

    // Each callback checks it still belongs to this activation: an unlisten
    // only settles after an IPC round-trip, and until it does a superseded
    // activation's listener would dispatch its session's frames — a tool
    // approval among them — into whichever tab is active now. A dropped
    // line is not lost: `lastSeq` stays behind it, so the next activation
    // of `id` replays it from the journal. `_detachActiveSession` (no new
    // generation) clears `activeSessionId`, so that check covers it; the
    // same check follows every await below, so a detached activation stops
    // too instead of replaying into the detached state. Proven with an
    // eval-kernel cell that loads this file into a stubbed-Tauri VM (tabs
    // A→B→C with B's unlisten held: before, B's approval prompt surfaced in
    // C with no binding; after, it is dropped and C shows none).
    const current = () => _switchGen === myGen && activeSessionId === id;
    const { listen } = window.__TAURI__.event;
    const ulLine = await listen(`agent://line/${id}`, ev => { if (current()) handleLine(ev.payload); });
    if (!current()) {
      // Superseded while this call's own listener was still being attached —
      // it was never stored into activeListeners, so nothing else will ever
      // tear it down. Without this it keeps dispatching the abandoned
      // session's stdout lines into whichever tab is now active and
      // corrupts that tab's lastSeq cursor.
      try { await ulLine(); } catch (_) {}
      return;
    }
    const ulExit = await listen(`agent://exit/${id}`, ev => {
      if (!current()) return;
      const reason = (ev?.payload && String(ev.payload).trim()) || "";
      console.warn(`[live] session '${id}' omp process exited${reason ? ": " + reason : ""}`);
      state.isStreaming = false;
      state.exitReason = reason || null;
      if (reason) {
        _pushAssistantNote(_exitNote(reason, sessionRegistry.get(id)?.profile));
      }
      _endDeadProcessState();
      notify();
    });
    if (!current()) {
      // Same leak as above, but both listeners for this call exist and
      // haven't been committed to activeListeners yet.
      try { await ulLine(); } catch (_) {}
      try { await ulExit(); } catch (_) {}
      return;
    }
    activeListeners = [ulLine, ulExit];

    // Catch up on events the journal captured while this tab had no live
    // listener attached (backgrounded tab switch) — recovers live asks,
    // approvals and streaming state that persisted messages cannot rebuild.
    // The journal is a bounded in-memory ring (AgentBridge::replay_events):
    // a `dropped` reply means earlier events were evicted. Saved messages
    // and completed tool cards still come from the history fetch below.
    try {
      const replay = await window.__TAURI__.core.invoke("replay_events", { sessionId: id, afterSeq: lastSeq });
      if (!current()) return; // superseded by a newer switch, or detached
      if (replay.dropped) {
        console.warn(`[live] session '${id}' replay desynced — recovered ${replay.events.length} event(s); earlier ones fell outside the journal window`);
      }
      // Extension status lines / widgets: the evicted lines may have set or
      // cleared some. The backend applied every frame and names the last one
      // (`seq`); its copy replaces ours before the replay runs, and the
      // setStatus / setWidget handler skips frames at or below that seq, so
      // only newer ones apply on top — the backend's own result. Fetched
      // before dispatching, so a newer tab switch during the await saves
      // this tab with its old `lastSeq` and the next visit fetches again.
      if (replay.dropped) {
        const ext = await _invokeSafe("extension_ui_state", { sessionId: id }, null);
        if (!current()) return; // superseded by a newer switch, or detached
        if (ext) {
          state.extWidgets = EXT.fromSnapshot(ext);
          extSnapshotSeq = Number.isInteger(ext.seq) ? ext.seq : 0;
        }
      }
      if (replay.backgroundTasks) _dispatchEnvelope(replay.backgroundTasks);
      for (const ev of replay.events) _dispatchEnvelope(ev);
      _reconcilePendingRequests(replay);
      // A pending auto-`/rename` whose outcome note fell out of the ring
      // will never be swallowed, and nothing else would release the flag:
      // refinements would stay blocked for good. The replayed events above
      // had their chance to swallow it; if the note is in fact still to
      // come (generation outlasting 256 lines of output), the cost is one
      // plumbing line in the transcript.
      if (replay.dropped && sessionRegistry.get(id)?.autoRenameInFlight) {
        sessionRegistry.set(id, { ...sessionRegistry.get(id), autoRenameInFlight: false });
      }
      // Same for an abort: its response may be among the evicted events.
      if (replay.dropped) userAbortInFlight = false;
    } catch (e) {
      if (!current()) return; // superseded by a newer switch, or detached
      console.warn(`[live] replay_events failed for '${id}':`, e);
      // The backend no longer has the session: its process ended while the
      // tab was in the background, with no exit listener attached and no
      // reason worth caching (a clean exit, a crash after startup).
      if (/not found/.test(String(e))) _endDeadProcessState();
    }
    if (!current()) return; // superseded by a newer switch, or detached

    // Drain live events buffered while the replay fetch was in flight,
    // de-duplicated against lastSeq inside _dispatchEnvelope.
    const buffered = _replayBuffer;
    _replayBuffer = null;
    for (const envelope of buffered) _dispatchEnvelope(envelope);

    // Surface any cached startup error for this session. A background tab
    // (or a respawn) can fail before any listener is attached, so a spawn
    // failure (e.g. omp not on PATH) — or a child that died during startup,
    // whose reason `reader.rs` records in `last_errors` for exactly this
    // reason — would otherwise be invisible. session_status returns the
    // cached error synchronously — no event timing race.
    try {
      const startupError = await window.__TAURI__.core.invoke("session_status", { sessionId: id });
      if (!current()) return; // superseded by a newer switch, or detached
      // Same renderer as the `agent://exit` path: this is the *same* backend
      // string (the reader writes `last_errors` and emits the event with one
      // value), and every background tab reaches the
      // failure only through here — the event fires with no listener
      // attached. Rendering it raw would drop the profile-aware login
      // instructions in precisely the cases the note was written for.
      //
      // Surfaced at most once per incarnation: the cached entry outlives the
      // dead child until the next spawn, and `_switchToSession` runs on
      // *every* activation, so without this the same failure is re-filed
      // into the transcript each time the user switches away and back.
      if (startupError && !_notedStartupErrors.has(id)) {
        _notedStartupErrors.add(id);
        console.warn(`[live] session '${id}' startup error: ${startupError}`);
        _pushAssistantNote(_exitNote(startupError, sessionRegistry.get(id)?.profile));
        _endDeadProcessState(); // died in the background — see the exit listener
      }
    } catch (e) {
      console.warn(`[live] session_status query failed:`, e);
    }
    if (!current()) return; // superseded by a newer switch, or detached

    // Re-fetch to pick up events missed while not listening.
    // get_messages handler merges completed turns with the cached streaming bubble.
    _initFetch();
    notify();
    } finally {
      if (_switchIntent === intent) _switchAwayFrom = null;
      done();
    }
  }

  // ── v2 lossless transport: rpc_chunk reassembly ──────────────────────────
  // After negotiate_protocol v2, omp emits oversized stdout objects (e.g. the
  // ~2 MiB get_available_models response) as an uninterrupted sequence of
  // rpc_chunk frames. Each carries a base64 segment of the original UTF-8 JSON.
  const MAX_REASSEMBLED_FRAME = 64 * 1024 * 1024; // matches ready.maxReassembledFrameBytes

  /** Decode base64 (rpc_chunk segments, terminal output) to its bytes. */
  function _b64Bytes(b64) {
    const bin = atob(b64);
    const bytes = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
    return bytes;
  }

  // Pure: validate a complete set of rpc_chunk frames for one chunkId and
  // return the parsed JSON object. Throws on any inconsistency.
  function reassembleRpcChunks(frames) {
    if (!Array.isArray(frames) || frames.length === 0) throw new Error("rpc_chunk: empty frame set");
    const { chunkId, count, byteLength } = frames[0];
    if (!Number.isInteger(count) || count < 1) throw new Error("rpc_chunk: bad count");
    if (frames.length !== count) throw new Error(`rpc_chunk: expected ${count} frames, got ${frames.length}`);
    if (!Number.isInteger(byteLength) || byteLength < 0 || byteLength > MAX_REASSEMBLED_FRAME)
      throw new Error("rpc_chunk: byteLength out of range");
    const parts = new Array(count);
    for (const f of frames) {
      if (f.chunkId !== chunkId)   throw new Error("rpc_chunk: chunkId mismatch");
      if (f.count !== count)       throw new Error("rpc_chunk: count mismatch");
      if (f.byteLength !== byteLength) throw new Error("rpc_chunk: byteLength mismatch");
      if (!Number.isInteger(f.index) || f.index < 0 || f.index >= count) throw new Error("rpc_chunk: index out of range");
      if (parts[f.index] !== undefined) throw new Error("rpc_chunk: duplicate index");
      parts[f.index] = _b64Bytes(f.data);
    }
    let total = 0;
    for (const p of parts) total += p.length;
    if (total !== byteLength) throw new Error(`rpc_chunk: byte length mismatch (${total} != ${byteLength})`);
    const merged = new Uint8Array(total);
    let off = 0;
    for (const p of parts) { merged.set(p, off); off += p.length; }
    const text = new TextDecoder("utf-8", { fatal: true }).decode(merged);
    return JSON.parse(text);
  }
  window.reassembleRpcChunks = reassembleRpcChunks;

  // Stateful accumulator for the in-flight chunk sequence. Chunks arrive as an
  // uninterrupted run; a chunkId change mid-run means the prior run was dropped.
  let _chunkAcc = null; // { chunkId, count, frames: [] }

  function _ingestChunk(frame) {
    if (!_chunkAcc || _chunkAcc.chunkId !== frame.chunkId) {
      if (_chunkAcc) console.warn(`[live] rpc_chunk '${_chunkAcc.chunkId}' interrupted by '${frame.chunkId}'`);
      _chunkAcc = { chunkId: frame.chunkId, count: frame.count, frames: [] };
    }
    _chunkAcc.frames.push(frame);
    if (_chunkAcc.frames.length < _chunkAcc.count) return null;
    const frames = _chunkAcc.frames;
    _chunkAcc = null;
    try {
      return reassembleRpcChunks(frames);
    } catch (e) {
      console.error(`[live] rpc_chunk reassembly failed: ${e.message}`);
      return null;
    }
  }

  /** Spawn omp for session `id` under `profile` and wire its git-branch
   *  watcher. Split out of `_startProjectSession` because a profile switch
   *  respawns an *existing* tab's process under the same session id — the
   *  tab, its name and its project path all survive; only the child process
   *  (and therefore its auth/history tree) is replaced.
   *
   *  The launch boundary and actual-folder adoption are covered by
   *  tests/test-conversation-workspace-bridge.mjs. */
  async function _spawnSession(id, cwd, { resume = null, profile, workspace = null }) {
    const started = await window.__TAURI__.core.invoke("start_session", {
      args: { sessionId: id, cwd: cwd ?? "", resume, profile, ...(workspace ? { workspace } : {}) },
    });
    const actualCwd = started.path;
    if (typeof actualCwd !== "string") throw new Error("Agent startup did not return its working folder");
    // A fresh incarnation owns this id now, and `start_session` cleared the
    // backend's cached error for it — so a *new* startup failure must be
    // reportable again. Cleared after the spawn resolved, so a spawn that
    // threw leaves the previous reason still deduped.
    _notedStartupErrors.delete(id);
    // The conversation tree needs to know which cache touches this process
    // could have made: a new process rebuilds its system prompt (recalled
    // memories change it), so earlier processes' cache is not reusable.
    // Every spawn funnels through here (new tab, resume, launch restore,
    // profile respawn); branch/fork/`new_session` keep the process and so
    // leave it alone. Read the entry afresh: it may have changed during the await.
    // Rust returns the actual prepared folder and the mode resolved for it.
    // All folder consumers, including the watcher below, use that binding.
    const spawned = sessionRegistry.get(id);
    if (spawned) {
      const binding = started.workspace ?? spawned.workspace ?? null;
      const sourceName = _tabNameFor(binding?.projectPath || actualCwd, "new session");
      const defaultName = _tabNameFor(cwd, "new session");
      sessionRegistry.set(id, {
        ...spawned, path: actualCwd, preparing: false, processStartedAt: Date.now(),
        workspace: binding,
        name: spawned.preparing && spawned.name === defaultName ? sourceName : spawned.name,
        approvalMode: AMODE.isMode(started.approvalMode) ? started.approvalMode : null,
      });
    }
    // Git: read initial branch and arm the HEAD watcher (fire-and-forget errors)
    if (actualCwd) {
      const branch = await window.__TAURI__.core
        .invoke("start_git_watch", { sessionId: id, path: actualCwd })
        .catch(() => null);
      const entry = sessionRegistry.get(id);
      if (entry) sessionRegistry.set(id, { ...entry, branch: branch ?? null });
      // Live updates: re-emitted by Rust whenever .git/HEAD changes
      const { listen } = window.__TAURI__.event;
      const unlisten = await listen(`git://branch/${id}`, ev => {
        const e = sessionRegistry.get(id);
        if (e) sessionRegistry.set(id, { ...e, branch: ev.payload });
        notify();
      });
      // A racing respawn of this same id (profile switch) may have resolved
      // its own `listen` after `_killSessionProcess` ran `_dropGitListener`,
      // re-inserting a handle. Overwriting it blind would orphan that
      // listener beyond the reach of every teardown path.
      _dropGitListener(id);
      gitListeners.set(id, unlisten);
    }
    return actualCwd;
  }

  /** Drop a session's git-branch listener, if it has one. Every teardown
   *  path (tab close, profile respawn) must do this or the stale listener
   *  keeps writing branch updates for a dead process into the registry. */
  function _dropGitListener(id) {
    const unlisten = gitListeners.get(id);
    if (unlisten) { unlisten(); gitListeners.delete(id); }
  }

  /** Kill a session's omp process and everything bound to it (git watcher,
   *  cached snapshot) for a respawn (`_respawnSession`); the tab and its
   *  terminal shell stay (a tab ends only through `_closeTab`). The registry
   *  entry is left to the caller.
   *
   *  Returns a promise for the `stop_session` round-trip, which a
   *  respawn MUST await: `stop_session`'s backend body does an
   *  unconditional `sessions.remove(id)`, so if it were still queued when
   *  `start_session` installed the fresh incarnation under the same id, it
   *  would reap the *new* process instead of the dead one. */
  function _killSessionProcess(id) {
    if (id === activeSessionId) {
      _cancelLiveRequests();
      state.liveVoice = LIVE.EMPTY;
      _cancelDictationRequests();
      state.dictation = DICTATION.EMPTY;
    }
    let stopped = Promise.resolve();
    if (window.__TAURI__) {
      stopped = window.__TAURI__.core.invoke("stop_session", { sessionId: id }).catch(() => {});
      window.__TAURI__.core.invoke("stop_git_watch", { sessionId: id }).catch(() => {});
    }
    _dropGitListener(id);
    sessionSnapshots.delete(id);
    return stopped;
  }

  /** End a tab for good in Rust (`close_tab`: its omp process, browser, git
   *  watcher, widget state and terminal shell) and drop its JS-side bindings.
   *  Every path that removes a tab from `sessionRegistry` goes through here;
   *  a respawn uses `_killSessionProcess`, which keeps the browser and shell. */
  function _closeTab(id) {
    if (id === activeSessionId) {
      _cancelLiveRequests();
      state.liveVoice = LIVE.EMPTY;
      _cancelDictationRequests();
      state.dictation = DICTATION.EMPTY;
    }
    _dictationCompleted = _dictationCompleted.filter(item => item.sessionId !== id);
    const closed = _invokeSafe("close_tab", { sessionId: id });
    _dropGitListener(id);
    respawnVoice.delete(id);
    sessionSnapshots.delete(id);
    return closed;
  }

  /** Listen to a Tauri event (the terminal's streams). Returns
   *  `{ stop, ready }`: `stop` is valid at once (a call before the async
   *  `listen` settled unlistens when it does);
   *  `ready` resolves once the listener is registered (or failed), so a
   *  caller can query state knowing no later event is missed. */
  function _listen(event, handler) {
    if (!window.__TAURI__) return { stop: () => {}, ready: Promise.resolve() };
    let unlisten = null;
    let stopped = false;
    // A stopped handler never runs, even for an event delivered before the
    // async `listen` settled.
    const ready = window.__TAURI__.event.listen(event, ev => { if (!stopped) handler(ev.payload); }).then(
      off => { if (stopped) off(); else unlisten = off; },
      err => console.error(`[live] listen ${event} failed:`, err),
    );
    return {
      stop: () => {
        stopped = true;
        if (unlisten) { unlisten(); unlisten = null; }
      },
      ready,
    };
  }

  /** Detach the active session's listeners and clear all per-session state,
   *  leaving no active session. Must run before re-activating a respawned
   *  session: `_switchToSession` snapshots whatever is active first, which
   *  would otherwise cache the dead process's transcript under its id. */
  async function _detachActiveSession() {
    // Clear the shared state synchronously, then unlisten from a local copy.
    // These awaits are IPC round-trips; a tab click landing inside them would
    // otherwise find `activeSessionId` still naming the tab being torn down,
    // so `_saveCurrentSession` would re-cache the dead process's transcript
    // and `lastSeq` under its id - and the interleaved switch's own
    // `activeSessionId`/`activeListeners` writes would be clobbered when this
    // call resumes.
    ++_switchIntent;
    _switchAwayFrom = null;
    _cancelLiveRequests();
    const listeners = activeListeners;
    activeListeners = [];
    activeSessionId = null;
    _resetSessionVars();
    for (const ul of listeners) { try { await ul(); } catch (_) {} }
  }

  /** Tab label for a project folder: its last path segment, else
   *  `fallback`. The same `basename` `OMP_PROJECT_NAV.tabLabel` compares
   *  against, so a fresh tab never shows its own folder as a prefix (#46). */
  function _tabNameFor(cwd, fallback) {
    return cwd ? window.OMP_PROJECT_NAV.basename(cwd) : fallback;
  }

  /** Registry fields for a fresh conversation on an existing tab. The
   *  previous transcript is gone, so the label falls back to the folder
   *  (or `new session` when the tab has no folder — never the previous
   *  conversation's generated title) and auto-rename starts over.
   *  `sessionFile` is cleared too: `resumeSession` matches on it, and
   *  would otherwise focus this tab for a conversation it no longer runs.
   *  Shared by in-process `new_session` and a profile switch's respawn. */
  function _freshConversationFields(entry) {
    return {
      name: _tabNameFor(window.OMP_PROJECT_NAV.projectPath(entry), "new session"),
      sessionFile: null,
      autoRenameArmed: true,
      autoRenameInFlight: false,
      autoRenameAttempt: null,
      autoRenameTurns: 0,
      autoRenameLeft: 0,
      autoRenameSessionId: null,
    };
  }

  /** Replace tab `id`'s omp process under the same id. Shared by a profile
   *  switch (`fresh: true`: a new conversation under `profile`) and an
   *  approval-mode restart (`resume: <the tab's sessionFile>`: the same
   *  conversation continues, under the mode Rust now resolves for the
   *  folder). The tab's id, name, folder and terminal shell survive.
   *  Resolves to `{ok}` or `{ok: false, error}` on every path so a caller
   *  can render a refusal (a respawn already in flight, a failed respawn)
   *  instead of dropping it silently.
   *
   *  The dictation-before-restart ordering is covered by the fake IPC bridge
   *  in test-live-voice.mjs; the remaining ordering relies on the comments
   *  at each await and the pure profile/approval-mode decisions. */
  async function _respawnSession(id, { profile, resume = null, fresh = false }) {
    if (!window.__TAURI__) return { ok: false, error: "not connected" };
    const entry = sessionRegistry.get(id);
    if (!entry) return { ok: false, error: "unknown tab" };
    const what = fresh ? "Profile switch" : "Approval mode change";
    // Re-entrancy: this call spans two awaits, and a second respawn of the
    // same tab would read `wasActive` as false (call 1 already nulled the
    // active slot), so it would never re-activate or `_initFetch` the
    // process it spawned - leaving the tab attached to a live child whose
    // opening envelopes were all dropped as `seq <= lastSeq` against the
    // previous incarnation's journal.
    if (_respawning.has(id)) {
      return { ok: false, error: "omp is already restarting in this tab" };
    }
    _respawning.add(id);
    try {
      if (id === activeSessionId && (state.dictation.active || _dictationStopPending)) {
        const stopped = await _dictationStop();
        if (!stopped.ok && state.dictation.active) return stopped;
        if (!sessionRegistry.has(id)) return { ok: false, error: "tab closed" };
      }
      // Only a resumed coding conversation can retain its tab-local voice
      // history. Killing the process itself closes its native transport.
      let savedVoice = !fresh && resume ? (id === activeSessionId ? state.liveVoice : sessionSnapshots.get(id)?.liveVoice) : null;
      if (savedVoice?.active) {
        savedVoice = LIVE.apply(LIVE.apply(savedVoice, { type: "stop" }), { type: "stop_success", paused: true });
      }
      // Awaited: `stop_session` must have removed the old incarnation from
      // the backend's session map before `_spawnSession` installs the new
      // one under the same id, or the late remove would reap the fresh
      // process. See `_killSessionProcess`.
      await _killSessionProcess(id);
      // The tab may have been closed inside that round-trip: `closeSession`
      // has no `_respawning` guard, so it can `sessionRegistry.delete`
      // this id while we are waiting. Writing an entry back below would
      // then *resurrect* the deleted tab — and the
      // `!sessionRegistry.has(id)` check after the spawn (which exists for
      // the very same hazard one window later) would find the resurrected
      // entry, skip its cleanup, and leave a live omp child bound to a tab
      // the user closed. `_killSessionProcess` above already released the
      // process and the git watcher, so bailing here leaks nothing.
      if (!sessionRegistry.has(id)) {
        return { ok: false, error: "tab closed" };
      }
      // Both re-read *after* that round-trip, never before it. It is a real
      // IPC gap and `_respawning` only blocks re-entry for this id, so
      // a click on another tab can run `_switchToSession(other)` inside it —
      // whose first act is `_saveCurrentSession()`, and `activeSessionId` is
      // still this id at that moment. That both moves the active slot (so a
      // `wasActive` captured earlier is stale and would detach the tab the
      // user just picked) and re-creates the very snapshot
      // `_killSessionProcess` just deleted.
      const wasActive = id === activeSessionId;
      const current = sessionRegistry.get(id);
      // No process runs this tab until the spawn resolves, and a failed
      // spawn leaves none: no running approval mode either (`_spawnSession`
      // sets the new one).
      sessionRegistry.set(id, fresh
        // Fresh conversation: folder label and a new auto-rename, same as
        // `new_session` (`_freshConversationFields`). The killed process
        // will not deliver an in-flight `/rename` note.
        ? { ...current, profile, branch: null, approvalMode: null, ..._freshConversationFields(current) }
        // Same conversation: name, file and auto-rename budget carry over;
        // only an in-flight `/rename` dies with the process (its note can
        // never arrive, so the flag would block every later refresh).
        : { ...current, approvalMode: null, autoRenameInFlight: false });
      if (wasActive) await _detachActiveSession();
      // After the detach, which nulls `activeSessionId` synchronously — so no
      // later `_saveCurrentSession` can re-add it. A resurrected snapshot
      // would restore the dead incarnation's `lastSeq`, and the respawned
      // child's journal restarts at seq 1, so `_dispatchEnvelope` would drop
      // every envelope it ever emits as `seq <= lastSeq`.
      sessionSnapshots.delete(id);
      notify();

      // A respawn failure (profile deleted under us, omp not on PATH) must
      // not strand the tab: `_detachActiveSession` already nulled
      // `activeSessionId` and reset per-session state, so without
      // re-activating here the UI keeps rendering an active tab whose
      // `_send` calls go to `sessionId: null`.
      let spawnError = null;
      try {
        await _spawnSession(id, entry.path, { profile, resume });
      } catch (e) {
        spawnError = e?.message ?? String(e);
      }
      // omp writes a conversation's file lazily, with its first assistant
      // message, so a tab that has not had a reply yet names a file that
      // does not exist and `validate_resume` refuses it. Nothing on disk
      // means nothing to continue: start the tab's omp without `--resume`
      // rather than leave it with no process. (Rejected before anything is
      // spawned or registered, so the second `start_session` starts clean.)
      if (spawnError && resume && spawnError.includes("resume path does not exist") && sessionRegistry.has(id)) {
        sessionRegistry.set(id, { ...sessionRegistry.get(id), sessionFile: null });
        savedVoice = null;
        spawnError = null;
        try {
          await _spawnSession(id, entry.path, { profile, resume: null });
        } catch (e) {
          spawnError = e?.message ?? String(e);
        }
      }
      if (spawnError) console.error(`[live] ${what} respawn failed:`, spawnError);

      // The tab may have been closed during the spawn. `closeSession` ran
      // its whole teardown against a session whose respawn was still in
      // flight, so everything below would wire the closed tab back up
      // *behind* that teardown: a phantom active tab, a leaked
      // `git://branch/{id}` listener, a `start_git_watch` issued after the
      // matching `stop_git_watch`, and `_send` routed to an orphaned child
      // no teardown path can reach. Undo our own spawn instead.
      if (!sessionRegistry.has(id)) {
        _closeTab(id);
        // `closeSession` saw `activeSessionId === null` (this respawn had
        // already detached) so it never handed focus on. Do it here, or the
        // app sits with tabs rendered and `_send` routed at `null`.
        const survivors = [...sessionRegistry.keys()];
        if (activeSessionId === null && survivors.length > 0) {
          await _switchToSession(survivors[survivors.length - 1]);
        } else {
          notify();
        }
        return spawnError ? { ok: false, error: spawnError } : { ok: true };
      }
      if (savedVoice) {
        if (id === activeSessionId) state.liveVoice = savedVoice;
        else if (sessionSnapshots.has(id)) sessionSnapshots.set(id, { ...sessionSnapshots.get(id), liveVoice: savedVoice });
        else respawnVoice.set(id, savedVoice);
      }
      // The folder is now open under `profile`, so it belongs in that
      // profile's recents (a mode restart keeps the profile: nothing new).
      if (fresh && !spawnError && entry.path) void _touchRecent(entry.workspace?.projectPath || entry.path, profile);

      if (wasActive && activeSessionId === null) {
        // Reclaim focus only if nothing else took the active slot while the
        // spawn was in flight - the user can click another tab during those
        // awaits, and `_switchGen` can't guard this call because it is the
        // newer one.
        await _switchToSession(id);
        // After re-activation, never before: `_switchToSession` runs
        // `_resetSessionVars()`, which would wipe the note. And re-checked
        // *after* the await, not before: `_switchToSession` spans two
        // `listen` calls plus two round-trips, and a tab click inside them
        // bumps `_switchGen` so this call bails and leaves the other tab
        // active - `_pushAssistantNote` would then file this failure in
        // that tab's transcript, stickily. When we lose the slot, the
        // reason is still cached by `start_session` and surfaces as
        // "Agent failed to start" when the tab is next selected.
        //
        // Gated on the backend having cached nothing, because the two
        // failure classes report through different paths and would
        // otherwise double up: a real spawn failure (omp not on PATH, exec
        // error) IS cached, so the `_switchToSession` above already pushed
        // "Agent failed to start" with this same text. A refused profile or
        // resume value is rejected before the bridge spawns anything, so
        // nothing is cached and this note is the only report there is.
        const cached = spawnError && activeSessionId === id
          ? await _invokeSafe("session_status", { sessionId: id }, null)
          : null;
        if (spawnError && activeSessionId === id && !cached) {
          _pushAssistantNote(`**${what} failed:** ${spawnError}`);
        }
      }
      notify();
      return spawnError ? { ok: false, error: spawnError } : { ok: true };
    } finally {
      _respawning.delete(id);
    }
  }

  /** Bring every open tab's omp onto the approval mode its folder now
   *  resolves to (`OMP_APPROVAL_MODE.restartPlan` over the snapshot's
   *  `sessions`): idle tabs restart now, with `--resume` so the
   *  conversation continues; busy ones are left running and picked up at
   *  their next idle point — the active tab's next applied `get_state`
   *  (the one its `agent_end` asks for, or the one `_initFetch` sends when
   *  it is activated; see the `get_state` branch of `_handleResponse`).
   *  Resolves to `{ restarted, deferred }` tab ids (`restarted`: respawns
   *  that succeeded).
   *
   *  Side-effectful (respawns through `_respawnSession`), so not
   *  unit-tested directly; which tab restarts when is the pure
   *  `restartPlan`, proven in tests/test-approval-mode.mjs. */
  async function _applyApprovalModes() {
    // No view yet: the frontend cannot know what Rust resolves, and a
    // guess would restart a tab Rust spawned with a project override.
    if (!approvalModes) return { restarted: [], deferred: [] };
    const sessions = _sessionsView().filter(s => !s.preparing);
    const { now, later } = AMODE.restartPlan(approvalModes, sessions);
    const byId = new Map(sessions.map(s => [s.id, s]));
    const todo = now.filter(id => {
      if (_respawning.has(id)) return false; // its spawn resolves the mode afresh
      const target = AMODE.effectiveFor(approvalModes, byId.get(id).path || null);
      return _modeRestartMissed.get(id) !== target;
    });
    const results = await Promise.all(todo.map(async id => {
      const entry = sessionRegistry.get(id);
      const target = AMODE.effectiveFor(approvalModes, entry?.path || null);
      const r = entry
        ? await _respawnSession(id, { profile: entry.profile, resume: entry.sessionFile || null })
        : { ok: false };
      const reached = r.ok && sessionRegistry.get(id)?.approvalMode === target;
      if (reached) _modeRestartMissed.delete(id);
      else if (sessionRegistry.has(id)) {
        _modeRestartMissed.set(id, target);
        console.warn(`[live] approval mode restart of '${id}' did not reach '${target}'`, r.error ?? "");
      }
      return reached ? id : null;
    }));
    return { restarted: results.filter(Boolean), deferred: later };
  }

  /** Store a set command's view, notify, and apply it to the open tabs.
   *  Resolves to `{ ok, error?, restarted, deferred }`. */
  async function _setApprovalModes(cmd, args) {
    const r = await _invokeResult(cmd, args);
    if (!r.ok) return { ok: false, error: r.error, restarted: [], deferred: [] };
    approvalModes = r.value;
    notify();
    const { restarted, deferred } = await _applyApprovalModes();
    return { ok: true, restarted, deferred };
  }

  /** Re-read the approval-mode view from Rust (boot, panel open). Keeps the
   *  last good view when the read fails. */
  async function _refreshApprovalModes() {
    const view = await _invokeSafe("approval_mode_get", {}, null);
    if (view) {
      approvalModes = view;
      notify();
    }
    return approvalModes;
  }


  /** A user-typed `/rename` supersedes our pending automatic one (omp bumps
   *  `titleRevision`, so the backgrounded auto-generation silently drops —
   *  its note can never arrive). Clearing the in-flight flag on send keeps
   *  the note-swallow gate exact: without it, the user's own `Session
   *  renamed to X.` confirmation would be swallowed. The `abort` response
   *  releases a cancelled generation on its own; this remains the backstop
   *  when the user renames before that response, or when generation was
   *  cancelled without an RPC abort. Also disarms the one-shot if it has
   *  not fired yet: a `/rename` during the first turn lands before the
   *  auto-send, and a confirming `get_state` can still see an empty
   *  `sessionName` and fire our own `/rename`, which supersedes the user's.
   *  Matched on the command name alone (`STITLE.isManualRename`), not on
   *  `isCommandInvocation`: that one tokenises up to whitespace, so it
   *  misses `/rename:Title`, which omp still runs as a rename. */
  function _disarmAutoRename(text) {
    if (!activeSessionId) return;
    const entry = sessionRegistry.get(activeSessionId);
    if (!entry) return;
    // No-op unless a manual title still has something to retire: the
    // one-shot (armed, not yet sent), an in-flight auto-rename whose note
    // swallow must be released, or refinement budget.
    if (!entry.autoRenameArmed && !entry.autoRenameInFlight && !(entry.autoRenameLeft > 0)) return;
    if (!STITLE.isManualRename(text)) return;
    // A manual rename wins permanently: cancel the one-shot, release any
    // pending note swallow, and zero the refinement budget, so a later
    // automatic refresh can never overwrite the title the user typed.
    sessionRegistry.set(activeSessionId, {
      ...entry, autoRenameArmed: false, autoRenameInFlight: false, autoRenameLeft: 0,
    });
  }

  /** Release a background `/rename` that `abort` just cancelled. The
   *  response arrives only after `session.abort()` returns, and stdout is
   *  ordered, so any note written before the cancel has already been
   *  swallowed and none can follow. Clearing on the send would race a note
   *  already on the wire and leak it into the transcript. Runs for a
   *  failed abort too: `abort()` cancels title generation first thing in
   *  its `try`, so anything that throws after it has already cancelled.
   *  If nothing has titled the session yet, re-arm the one-shot and
   *  re-fetch so the next idle snapshot retries; a title that did land
   *  keeps its spent budget. */
  function _releaseAutoRenameAfterAbort() {
    if (!activeSessionId || !sessionRegistry.has(activeSessionId)) return;
    const entry = sessionRegistry.get(activeSessionId);
    if (!entry.autoRenameInFlight) return;
    const untitledLabel = _tabNameFor(window.OMP_PROJECT_NAV.projectPath(entry), "new session");
    const rearm = STITLE.shouldRearmAfterAbort(state.rpcState, entry.name, untitledLabel);
    sessionRegistry.set(activeSessionId, {
      ...entry,
      autoRenameInFlight: false,
      ...(rearm ? { autoRenameArmed: true, autoRenameAttempt: null } : {}),
    });
    if (rearm) _send({ type: "get_state" });
  }

  // Keep the first title eligible until it actually lands. The attempt token
  // both prevents retries on repeated idle snapshots and owns a failed IPC
  // hand-off, which may settle after a tab switch or a fresh conversation.
  function _sendAutoRename(entry, refinement) {
    const id = activeSessionId;
    const attempt = {};
    sessionRegistry.set(id, {
      ...entry, autoRenameAttempt: attempt, autoRenameInFlight: true,
      autoRenameLeft: refinement ? entry.autoRenameLeft - 1 : STITLE.REFINE_MAX,
      autoRenameTurns: 0,
    });
    _send({ type: "prompt", message: "/rename" }).then(sent => {
      const current = sessionRegistry.get(id);
      if (!sent && current?.autoRenameAttempt === attempt && current.autoRenameInFlight) {
        sessionRegistry.set(id, { ...current, autoRenameInFlight: false });
      }
    });
  }

  /** Spawn omp for `cwd` (optionally resuming a saved session), register the
   *  tab, wire the git-branch watcher, and activate it. Shared by
   *  `openSession` (new project tab), `resumeSession` (resume from disk) and
   *  the startup restore (`_restoreOpenTabs`) so the git-watch/listener
   *  wiring only lives in one place. The restore opts out of the two side
   *  effects meant for a user's open: `activate: false` leaves the tab in
   *  the background (its frames are journaled until it is activated), and
   *  `remember: false` leaves the recent-projects order alone — reopening
   *  what was already open is not a new use of the folder. A resumed
   *  conversation is styled cyan and, unnamed, falls back to "resumed"
   *  rather than "new session" when it has no folder.
   *
   *  This function is side-effectful (Tauri IPC invoke, event listeners) and
   *  not unit-tested directly; its one pure decision (the `tabName`
   *  derivation) now lives in, and is proven by, `_tabNameFor`. */
  async function _startProjectSession(cwd, {
    resume = null, name = null, profile, activate = true, remember = true,
    workspace = null, workspaceBinding = null,
  }) {
    _lastSessionMs = Math.max(Date.now(), _lastSessionMs + 1);
    const id = `session-${_lastSessionMs}`;
    const tabName = name || _tabNameFor(workspaceBinding?.projectPath || cwd, resume ? "resumed" : "new session");
    const color = resume ? "var(--cyan)" : "var(--lilac)";
    // Register in tab list before starting omp so the tab shows immediately.
    // Register with null branch — chip hidden until git resolves.
    sessionRegistry.set(id, {
      id, name: tabName, path: cwd ?? "", color, branch: null, profile,
      preparing: true, workspace: workspaceBinding,
      // The approval mode `start_session` spawned this tab's current omp
      // with (set by `_spawnSession`); null while no process runs it.
      approvalMode: null,
      // The conversation's `.jsonl`, same form as `SavedSession.path`: known
      // up front for a resume, filled in from `get_state` otherwise (see
      // `_applyRpcState`). `resumeSession` matches on it to focus instead of
      // spawning a duplicate.
      sessionFile: resume ?? null,
      // Auto-naming also covers resumed conversations with no saved title.
      // Observing a title retires the initial request; a resumed named tab
      // has no refinement budget, since its title may have been manual.
      // `attempt` owns the IPC hand-off and gates another initial request
      // until a successful terminal turn. `inFlight` lasts until the outcome
      // note, so delayed confirmations never become transcript bubbles.
      // A successful initial title gets REFINE_MAX refreshes, spaced by
      // REFINE_EVERY_TURNS. The native session id binds that budget; an
      // in-process switch retires it (`STITLE.isRenameStateStale`).
      autoRenameArmed: true,
      autoRenameInFlight: false,
      autoRenameAttempt: null,
      autoRenameTurns: 0,
      autoRenameLeft: 0,
      autoRenameSessionId: null,
    });
    try {
      await _spawnSession(id, cwd, { resume, profile, workspace });
    } catch (e) {
      // A dangling/unlisted profile (inherited from another tab, deleted by
      // a second window, or a hand-edited profiles.json) makes the
      // backend's store.resolve() reject before anything spawns. Without
      // this, the registration above stays in the tab bar forever with no
      // process and no way to activate it — undo it so the failure looks
      // like "the open never happened" instead of a ghost tab, and rethrow
      // so openSession/resumeSession keep their "resolves to id, rejects
      // on failure" contract for the caller to handle.
      //
      // `close_tab` releases more than the registration, because
      // `_spawnSession` has two failure points: `start_session` itself (it
      // already registered the tab's terminal slot; no omp spawned) and the
      // `listen("git://branch/{id}")` that follows it, by which point a live
      // child is installed in the backend's session map and
      // `start_git_watch` is armed. Deleting only the registration there
      // would strand both — with no tab, nothing ever ends this id again.
      _closeTab(id);
      sessionRegistry.delete(id);
      notify();
      throw e;
    }
    // Only a folder that actually spawned is remembered.
    const opened = sessionRegistry.get(id);
    const recentPath = opened?.workspace?.projectPath || opened?.path;
    if (recentPath && remember) void _touchRecent(recentPath, profile);
    if (activate) await _switchToSession(id);
    else notify(); // tab list changed
    return id;
  }

  /** Tell the user an open failed, where they are looking: the active tab,
   *  or the empty workspace when none is open. `_startProjectSession` has
   *  already rolled the tab back. The note has no `ts` (omp holds no turn
   *  for it), so the next `get_messages` merge keeps it in place. */
  function _reportOpenFailure(e) {
    const note = `**Could not open project:** ${String(e?.message ?? e)}`;
    if (activeSessionId) _pushAssistantNote(note);
    else workspaceNotes = [...workspaceNotes, note];
    notify();
  }

  /** `_startProjectSession` for an open the user asked for (`+`, a recent
   *  project, a saved conversation): a refused spawn — an omp below the
   *  version floor, omp missing from PATH, a dangling profile — is reported
   *  before the rejection reaches app-live.jsx, whose handlers only log it. */
  async function _openReported(cwd, opts) {
    try {
      return await _startProjectSession(cwd, opts);
    } catch (e) {
      _reportOpenFailure(e);
      throw e;
    }
  }

  /** Recover display-only worktree metadata without preparing a new checkout.
   *  Missing original folders keep their persisted identity; cwd never changes. */
  async function _recoverWorkspaceBinding(path, profile, known = null) {
    if (!path) return known;
    const preview = await _invokeResult("conversation_workspace_inspect", { path, profile });
    const info = preview.ok && preview.value;
    if (!info?.projectPath || !info.path ||
        window.OMP_PROJECT_NAV.normPath(info.projectPath) === window.OMP_PROJECT_NAV.normPath(info.path)) return known;
    return {
      projectPath: info.projectPath, baseRef: known?.baseRef ?? null,
      baseCommit: known?.baseCommit ?? null, worktree: true,
    };
  }

  /** Queue a fresh launch without starting an agent. The requesting UI/OS/widget
   *  waits for its own successful tab id, or null when the user cancels. */
  function _requestConversationSetup(path, profile, configure = false) {
    if (!window.__TAURI__) return Promise.reject(new Error("not connected"));
    return new Promise(resolve => {
      conversationSetups.push({
        view: { id: `setup-${++_lastSetupId}`, path, profile, ...(configure ? { configure: true } : {}) }, resolve, busy: false,
      });
      notify();
    });
  }

  // ── OS folder-open requests ───────────────────────────────────────────────
  // "Open with OMP Desktop" on a folder in Finder, Explorer or a Linux file
  // manager. Each platform hands the request to the Rust side through its
  // own channel (macOS run-loop event, argv, single-instance forward - see
  // src-tauri/src/external_open.rs), where it lands in a queue and is
  // announced with an `open://project` event.
  //
  // The queue, not the event payload, is the source of truth: a cold start
  // delivers the request before this file has even run, and
  // `take_pending_open_projects` empties the queue, so the startup drain and
  // the event handler are the same idempotent call.

  /** Turn one queued folder into a project tab. Side-effectful (spawns omp,
   *  switches the active tab). */
  async function _openExternalProject(path) {
    try {
      await _requestConversationSetup(path, _activeProfileId());
    } catch (e) {
      // `_startProjectSession` already rolled the tab back, so the only
      // thing left is telling the user: the OS has no UI to report into and
      // silently ignoring a double-clicked folder looks like a hang.
      console.error(`[live] folder open failed for '${path}':`, e);
      _reportOpenFailure(e);
    }
  }

  let _externalOpenDraining = false;
  // Set when an event is dropped by the guard below: the in-flight drain may
  // already have taken its (then-empty) snapshot of the queue, so it owes
  // one more `take` before it is allowed to stop.
  let _externalOpenWake = false;

  /** Drain the backend queue, opening a tab per folder.
   *
   *  Serialised: `_startProjectSession` switches the active session, so two
   *  concurrent drains would interleave two activations. A coalesced event
   *  is recorded rather than dropped, because the lossy window is *not*
   *  synchronous: Rust empties the queue when `take_pending` releases its
   *  mutex, but the guard only clears once the IPC response is back in JS,
   *  and an `open://project` travelling the event channel can overtake that
   *  response. Without the flag the folder queued in between would sit in
   *  `OpenProjectState` until an unrelated open - the user's "Open with"
   *  reading as a no-op. */
  async function _drainExternalOpens() {
    if (_externalOpenDraining) {
      _externalOpenWake = true;
      return;
    }
    _externalOpenDraining = true;
    try {
      do {
        // Cleared before the take, so an event arriving during it is kept.
        _externalOpenWake = false;
        // `null` fallback, not `[]`: a failed round-trip must not read as
        // an empty queue. The folders stay queued in Rust instead of being
        // silently marked done. Nothing to retry into - the command itself
        // is infallible, so only a dead IPC channel lands here - but a
        // later event still drains them if the app is alive.
        const paths = await _invokeSafe("take_pending_open_projects", undefined, null);
        if (!paths) return;
        for (const path of paths) {
          // `take_pending` already handed the whole batch over, so one
          // failed open must not abandon the rest of it - nor the re-take
          // this loop promises.
          try {
            await _openExternalProject(path);
          } catch (e) {
            console.error(`[live] folder open aborted for '${path}':`, e);
          }
        }
        // A non-empty batch may have been joined by later requests.
        if (paths.length > 0) _externalOpenWake = true;
      } while (_externalOpenWake);
    } finally {
      _externalOpenDraining = false;
    }
  }

  /** Listen for `open://project`, then drain what the OS queued before the
   *  webview existed. Listener first: an event landing during that first
   *  drain is coalesced by the guard and picked up by the drain's own loop,
   *  whereas arming it afterwards would strand the request. */
  async function _setupExternalOpens() {
    try {
      await window.__TAURI__.event.listen("open://project", () => {
        void _drainExternalOpens();
      });
    } catch (e) {
      console.error("[live] failed to listen for folder-open requests:", e);
    }
    void _drainExternalOpens();
  }

  /** Reopen the tabs that were open when the app last ran (issue #17), in
   *  their saved order and profiles, then arm `_persistLayout`.
   *
   *  Activation is decided after each spawn (several IPC round-trips)
   *  against the then-active tab, so a tab the user opened or picked
   *  meanwhile keeps the focus. Tabs that fail to reopen are reported, not
   *  retried; when the tabs are exactly what the restore produced, arming
   *  adopts the layout as already written, so the file keeps them until the
   *  first real change (#34). Details: docs/architecture/reopening-tabs.md. */
  async function _restoreOpenTabs() {
    const notes = [];
    const restored = []; // ids this restore registered, in order
    let autoActive = null; // the restored tab this restore activated
    try {
      // Settings → Session "Reopen tabs" off: open nothing and leave the
      // file as it is. The arming below adopts the empty layout as
      // written, so open-tabs.json is first rewritten at the first real
      // tab change, and normal persistence goes on from there.
      if (!sessionPrefs.restoreTabs) return;
      const saved = await _invokeSafe("open_tabs_load", undefined, null);
      if (!saved) return;
      if (saved.skipped.length > 0) {
        notes.push(
          "**Could not reopen tabs whose folder no longer exists:**\n\n" +
          saved.skipped.map(p => `- \`${p}\``).join("\n"),
        );
      }
      const tabs = window.OMP_PROJECT_NAV.normalizeWorkspaces(saved.tabs);
      for (const [i, stored] of tabs.entries()) {
        let tab = stored;
        if (stored.workspace?.worktree) {
          const binding = await _recoverWorkspaceBinding(stored.path, stored.profile, stored.workspace);
          if (binding !== stored.workspace) {
            const generated = stored.name === _tabNameFor(stored.path, "") ||
              stored.name === _tabNameFor(stored.workspace.projectPath, "");
            tab = { ...stored, workspace: binding,
              ...(generated ? { name: _tabNameFor(binding.projectPath, "new session") } : {}) };
          }
        }
        const { cwd, ...opts } = window.OMP_PROJECT_NAV.restoreSpec(tab);
        let id;
        try {
          id = await _startProjectSession(cwd, { ...opts, activate: false, remember: false });
        } catch (e) {
          console.error(`[live] reopening tab '${cwd}' failed:`, e);
          notes.push(`**Could not reopen ${tab.name || cwd || "a tab"}:** ${String(e?.message ?? e)}`);
          continue;
        }
        restored.push(id);
        if (activeSessionId === null || (i === saved.active && activeSessionId === autoActive)) {
          // The bridge entry point: it skips a tab closed or respawning
          // since the spawn resolved. Guarded so a failed switch cannot
          // abort the loop and leave the rest of the saved tabs unopened.
          try {
            await window.OMP_BRIDGE.activateSession(id);
          } catch (e) {
            console.error(`[live] activating restored tab '${id}' failed:`, e);
          }
          if (activeSessionId === id) autoActive = id;
        }
      }
    } finally {
      if (notes.length > 0) {
        // The active tab's first `get_messages` may still be in flight; its
        // merge keeps these notes (they have no `ts`).
        if (activeSessionId) for (const note of notes) _pushAssistantNote(note);
        else workspaceNotes = [...workspaceNotes, ...notes];
      }
      const untouched = activeSessionId === autoActive
        && [...sessionRegistry.keys()].join("\n") === restored.join("\n");
      _layoutKey = untouched ? JSON.stringify(_layoutNow()) : null;
      _layoutArmed = true;
      notify();
    }
  }

  // ── RPC line handler ──────────────────────────────────────────────────────
  // `agent://line/{id}` payloads and `replay_events` results share one shape:
  // `{seq, text}` — `seq` is the event's position in the backend's bounded
  // per-session journal, `text` is the raw (already credential-redacted)
  // RPC line. Routed through the same _dispatchEnvelope so live and
  // replayed events can't diverge in behaviour.
  function handleLine(envelope) {
    if (!envelope || typeof envelope.text !== "string") return;
    if (_replayBuffer) {
      // A tab switch is mid-replay — queue instead of dispatching so a live
      // line can never race ahead of (or duplicate) the replay fetch below.
      _replayBuffer.push(envelope);
      return;
    }
    _dispatchEnvelope(envelope);
  }

  // De-duplicates against `lastSeq` (an event already delivered via replay
  // or a prior live line is skipped) then parses and dispatches `text`.
  // `seq` is only advanced forward — an out-of-order or unnumbered
  // (`typeof seq !== "number"`) envelope is still dispatched, just doesn't
  // move the cursor. The gate/buffer/drain interplay with handleLine
  // (arm → buffer during replay → replay applies → drain skips overlap as
  // duplicates) is side-effectful end-to-end but its pure decision logic
  // was proven with an eval-kernel cell (11/11 cases: in-order dispatch,
  // exact-seq duplicate skip, buffer-during-replay, drain-dedupes-overlap,
  // unnumbered envelope passthrough, gap tolerance) during this feature's
  // implementation — see the "P1 event journal" PR.
  function _dispatchEnvelope(envelope) {
    if (typeof envelope.seq === "number") {
      if (envelope.seq <= lastSeq) return;
      lastSeq = envelope.seq;
    }
    let obj;
    try { obj = JSON.parse(envelope.text); } catch { return; }
    if (!obj || typeof obj !== "object") return;

    if (obj.type === "rpc_chunk") {
      obj = _ingestChunk(obj);
      if (!obj) return; // sequence incomplete or reassembly failed
    }

    _dispatchFrame(obj);
  }

  function _dispatchFrame(obj) {
    const { type } = obj;

    if (type === "ready") {
      console.log(`[live] ready from session '${activeSessionId}'`);
      _initFetch();
      return;
    }

    if (type === "response") { _handleResponse(obj); return; }

    _handleEvent(obj);
  }

  // Both the model-context refresh and the raw saved branch feed the same
  // identity-based merge. Never replace the transcript positionally.
  function _applyMessages(messages) {
    state.backgroundTasks = TASKS.mergeMessages(state.backgroundTasks, messages);
    const completed = window.adaptAgentMessages(messages);
    const merged = mergeTranscript(state.messages, completed, { trimmed: state.trimmed });
    activeToolCards = new Map();
    for (let i = 0; i < merged.length; i++) {
      const m = merged[i];
      if (m.kind === "tool" && m.status === "running" && m._toolCallId) {
        activeToolCards.set(m._toolCallId, i);
      }
    }
    // A persisted assistant message ended while its end frame was lost.
    const streamingTs = streamingBubble?.ts;
    if (streamingTs != null && messages.some(m => m?.role === "assistant" && m.timestamp === streamingTs)) {
      streamingBubble = null;
    }
    state.messages = streamingBubble ? [...merged, streamingBubble] : merged;
    if (activeSessionId) {
      const prior = window.OMP_PROMPT_HISTORY.promptsFromMessages(merged, PROMPT_NORMALIZE);
      promptHistories.set(activeSessionId, window.OMP_PROMPT_HISTORY.mergeOlder(
        promptHistories.get(activeSessionId) ?? [], prior, promptHistoryLimit,
      ));
    }
    notify();
  }

  // ── RPC response handler ──────────────────────────────────────────────────
  function _handleResponse(resp) {
    // `branch` / `fork` moved the process onto a new file whether or not a
    // caller still waits (it may have timed out, or the response is replayed
    // after a tab switch), so the transcript follows here, before the
    // id-correlated early return.
    if ((resp.command === "branch" || resp.command === "fork") && resp.success && !resp.data?.cancelled) {
      _resetForNewFile();
    }
    // ID-keyed correlation — resolve or reject the waiting _sendWithResponse call.
    if (resp.id && _pendingResponses.has(resp.id)) {
      const handler = _pendingResponses.get(resp.id);
      _pendingResponses.delete(resp.id);
      if (resp.success) {
        handler.resolve(resp.data ?? null);
      } else {
        handler.reject(new Error(resp.error ?? `Command '${resp.command}' failed`));
      }
      return;
    }
    // A cancelled or timed-out contextual history request must not be
    // treated as the ordinary, uncorrelated transcript refresh on replay.
    if (resp.command === "get_messages" && typeof resp.id === "string" && resp.id.startsWith("live-history-")) return;
    if (resp.command === "get_state" && typeof resp.id === "string" && resp.id.startsWith("context-state-")) return;
    // Compact — handle success and failure both (must come before early-return below)
    if (resp.command === "compact") {
      let idx = -1;
      for (let i = state.messages.length - 1; i >= 0; i--) {
        if (state.messages[i].kind === "compact" && state.messages[i].status === "pending") { idx = i; break; }
      }
      if (idx !== -1) {
        const d = resp.data ?? {};
        const update = resp.success
          ? { status: "done", shortSummary: d.shortSummary || null, summary: d.summary || null, tokensBefore: d.tokensBefore }
          : { status: "error" };
        state.messages = state.messages.map((m, i) => i === idx ? { ...m, ...update } : m);
      }
      _invalidateContext(null, false);
      _send({ type: "get_state" });
      void _agentContextSync().loadMain().catch(() => {});
      notify();
      return;
    }
    // Before the success gate: a failed abort has cancelled title
    // generation all the same (see `_releaseAutoRenameAfterAbort`), and
    // without this its in-flight flag would never be released.
    if (resp.command === "abort") {
      // Emitted only after session.abort() returns, and abort() sends no
      // id, so this uncorrelated response is the release point.
      _releaseAutoRenameAfterAbort();
      userAbortInFlight = false;
      return;
    }
    if (!resp.success) {
      if (resp.command === "set_model" || resp.command === "cycle_model") _send({ type: "get_state" });
      return;
    }
    const { command, data } = resp;

    if (command === "get_state") {
      _applyRpcState(data);
      if (_syncRecoveredAsks()) notify();
      // The approval-mode idle hook: the active tab's run state is current
      // now, so a mode change it was too busy for applies here. Every
      // get_state counts (a busy one simply defers again), which covers both
      // idle points — the get_state its `agent_end` asks for and the one
      // `_initFetch` sends when it is activated — without per-request
      // bookkeeping that an out-of-order response could defeat.
      void _applyApprovalModes();

    } else if (command === "get_messages") {
      _applyMessages(data.messages ?? []);

    } else if (command === "get_available_models") {
      state.models = (data.models ?? []).map(m => ({
        id:       m.id,
        name:     m.name ?? window.MODEL_NAMES?.[m.id] ?? window.formatModelId(m.id),
        provider: m.provider,
        note:     m.provider,
        latency:  0,
        current:  state.rpcState?.model?.id === m.id,
      }));
      notify();
      console.log(`[live] models loaded (${state.models.length}) for session '${activeSessionId}'`);

    } else if (command === "get_available_commands") {
      _applyCommands(data.commands);
      console.log(`[live] commands loaded (${state.commands.length}) for session '${activeSessionId}'`);

    } else if (command === "set_model") {
      if (data) {
        state.model  = _buildModelEntry(data);
        state.models = state.models.map(m => ({ ...m, current: m.id === data.id }));
        _invalidateContext(data);
        _send({ type: "get_state" });
        void _agentContextSync().loadMain().catch(() => {});
        notify();
      }

    } else if (command === "cycle_model") {
      if (data?.model) {
        // A re-clamped thinking level arrives as `thinking_level_changed`.
        state.model  = _buildModelEntry(data.model);
        state.models = state.models.map(m => ({ ...m, current: m.id === data.model.id }));
        _invalidateContext(data.model);
        _send({ type: "get_state" });
        void _agentContextSync().loadMain().catch(() => {});
        notify();
      }

    } else if (command === "cycle_thinking_level") {
      // data is { level: Effort } | null. null means thinking not supported
      // by the current model — omp leaves the level unchanged in that case.
      if (data?.level != null) {
        state.thinkingLevel = data.level;
        notify();
      }

    } else if (command === "new_session") {
      // Fresh conversation in this process. `_resetSessionVars` only clears
      // the live transcript; the registry still holds the previous
      // incarnation's generated title and rename budget, and `_applyRpcState`
      // will not clear a name when the new session is untitled. Same reset
      // as a profile respawn — otherwise `/new` keeps the old title and
      // never re-arms, and leftover budget retitles the new transcript.
      _reloadConversation(_freshConversationFields);

    } else if (command === "get_session_stats") {
      // SessionStats — no display action needed
    }
  }

  function _buildModelEntry(m) {
    return {
      id:       m.id,
      name:     m.name ?? window.MODEL_NAMES?.[m.id] ?? window.formatModelId(m.id),
      provider: m.provider,
      note:     m.provider,
      latency:  0,
      current:  true,
    };
  }

  // Local desktop entries always win; RPC entries (builtin/skill/extension/
  // custom/file) fill in around them, deduped by name+alias. Shared by the
  // get_available_commands response and the available_commands_update
  // push — same shape, same merge.
  function _applyCommands(raw) {
    const visible = (Array.isArray(raw) ? raw : []).filter(command => !window.OMP_CONTEXT_POLICY?.privateCommand(command.name));
    state.commands = mergeSlashCommands(LOCAL_COMMANDS, adaptAvailableCommands(visible));
    state.agentContext = CONTEXT.catalog(state.agentContext, raw);
    notify();
  }

  // ── AgentSessionEvent handler ─────────────────────────────────────────────
  function _handleEvent(ev) {
    const { type } = ev;
    if (type === "extension_ui_request" && ev.method === "notify" && typeof ev.message === "string" && ev.message.startsWith("OMP_DESKTOP_BACKGROUND_TASKS:")) {
      if (sessionContext.processEnded) return;
      try {
        state.backgroundTasks = TASKS.mergeSnapshot(state.backgroundTasks, JSON.parse(ev.message.slice("OMP_DESKTOP_BACKGROUND_TASKS:".length)));
      } catch (error) {
        console.warn("[live] invalid native background-task snapshot:", error.message);
      }
      notify();
      return;
    }
    if (window.OMP_CONTEXT_POLICY?.privateFrame(ev)) {
      sessionContext.policyController?.observe(ev);
      return;
    }
    sessionContext.policyController?.observe(ev);
    const now  = Date.now();
    const time = timeNow();
    if (TASK_EVENTS.has(type)) {
      state.backgroundTasks = TASKS.applyFrame(state.backgroundTasks, ev, now, lastSeq);
      notify();
    }
    if (type === "live_phase" || type === "live_levels" || type === "live_transcript" || type === "live_end") {
      const before = state.liveVoice;
      // The new controller emits connecting before its own transcripts.
      // Discard queued frames from an older call while fetching history or
      // before that marker; native frames do not carry a call id.
      if (_liveStartPending && !_liveStartPending.acceptFrames) {
        if (!_liveStartPending.request || type !== "live_phase" || ev.phase !== "connecting") return;
        _liveStartPending.acceptFrames = true;
      }
      const next = LIVE.apply(before, ev);
      if (next !== before) {
        state.liveVoice = next;
        if (before.active && !next.active) _cancelLiveRequests(next.error || "Live voice ended");
        notify();
      }
      return;
    }
    if (type === "dictation_state" || type === "dictation_transcript" || type === "dictation_end") {
      if (type === "dictation_end") _finishDictation(ev);
      else _dictationUpdate(ev);
      return;
    }

    // Subagent frames (only emitted once _initFetch subscribed this process).
    if (type === "subagent_lifecycle" || type === "subagent_progress" || type === "subagent_event") {
      // At "events" most frames are token deltas the manager ignores — only
      // re-render when the reducer actually produced new state.
      const next = SUB.applySubagentFrame(state.subagents, ev, now);
      if (next !== state.subagents) {
        state.subagents = next;
        _agentContextSync().observe(ev);
        notify();
      }
      return;
    }
    _agentContextSync().observe(ev);

    if (type === "auto_compaction_start" || type === "auto_compaction_end") {
      _invalidateContext(null, type === "auto_compaction_start");
      if (type === "auto_compaction_end") {
        _send({ type: "get_state" });
        void _agentContextSync().loadMain().catch(() => {});
      }
      return;
    }
    if (type === "model_changed") {
      _invalidateContext();
      _send({ type: "get_state" });
      void _agentContextSync().loadMain().catch(() => {});
      return;
    }

    if (type === "available_commands_update") {
      _applyCommands(ev.commands);
      return;
    }

    // Goal mode (app/goal.js): omp reports every change, accounting
    // included; a change of a goal the tab already knew also goes into the
    // transcript as a goal row (live-only, kept by the get_messages merge).
    if (type === "goal_updated") {
      const { state: next, row } = GOAL.fromFrame(state.goal, ev, { stopping: userAbortInFlight });
      if (next === state.goal && !row) return;
      state.goal = next;
      if (row) state.messages = [...state.messages, { ...row, time }];
      notify();
      return;
    }

    // omp's whole steer / follow-up queue (app/message-queue.js); the strip
    // above the composer renders exactly this.
    if (type === "queue_update") {
      const next = QUEUE.fromSnapshot(ev, state.queue);
      if (next !== state.queue) { state.queue = next; notify(); }
      return;
    }

    // omp reports every change of the applied thinking level: a pick in the
    // composer's menu (the only confirmation `set_thinking_level` gets, and
    // omp may clamp the pick), a cycle, a typed `/effort <level>`, a model switch
    // re-clamping the level, `auto` resolving per turn. The effective
    // level, like get_state's.
    if (type === "thinking_level_changed") {
      const level = _effectiveThinking(ev.thinkingLevel);
      if (level !== state.thinkingLevel) {
        state.thinkingLevel = level;
        notify();
      }
      return;
    }

    // A builtin slash command sent as a plain prompt (e.g. picking `/jobs`
    // from the merged palette) runs locally inside omp — no turn, no
    // agent_end, and the `prompt` response itself carries nothing. Its only
    // output channel is this frame; without handling it, the command looks
    // like it did nothing.
    if (type === "command_output") {
      // Our automatic `/rename` prints its outcome as a builtin note; that
      // is plumbing, not conversation, so swallow it — but only while our
      // own rename is in flight. A superseded auto-rename stays silent on
      // omp's side (titleRevision) and `_disarmAutoRename` clears the flag
      // when the user types their own `/rename`, so the only note that can
      // match here is the automatic one's. A backgrounded `/rename`'s note
      // lands whenever its generation finishes — possibly turns later, with
      // unrelated `get_state` round-trips in between — so the in-flight
      // flag, not frame ordering, is what gates the swallow. The get_state
      // path must not clear it on a title (a stale snapshot still carries
      // the old one). The full list of releases is next to the send, in
      // `_applyRpcState`.
      const entry = activeSessionId ? sessionRegistry.get(activeSessionId) : null;
      // The rename action's own confirmation (#32): the tab label already
      // says it. One pending note per in-flight `renameSession`, matched
      // exactly, so a typed `/rename`'s note and every refusal or error
      // still reach the transcript.
      const rest = STITLE.dropPendingNote(entry?.renameNotes, ev.text);
      if (rest) {
        sessionRegistry.set(activeSessionId, { ...entry, renameNotes: rest });
        return;
      }
      if (entry && entry.autoRenameInFlight && STITLE.isAutoRenameNote(ev.text)) {
        sessionRegistry.set(activeSessionId, { ...entry, autoRenameInFlight: false });
        return;
      }
      _pushAssistantNote(ev.text);
      notify();
      return;
    }

    // Same local-only-command path: a config-changing builtin (/model,
    // /effort) or a title-changing one (/rename) mutates session state
    // outside the normal turn lifecycle, with no set_model/cycle_model
    // response to key off. Re-fetch rather than duplicate _applyRpcState's
    // model/thinkingLevel/sessionName derivation here.
    if (type === "config_update" || type === "session_info_update") {
      if (type === "config_update") {
        _invalidateContext();
        void _agentContextSync().loadMain().catch(() => {});
      }
      // `session_info_update` carries the title omp just set (our automatic
      // `/rename`, or a manual one) — apply it to the tab right away so the
      // rename lands even if the confirming get_state races a tab switch.
      // `config_update` carries no title; both still re-fetch below.
      if (type === "session_info_update" && activeSessionId && sessionRegistry.has(activeSessionId)) {
        const title = STITLE.sessionTitleFromEvent(ev);
        if (title) {
          // Restart the refinement counter at every title write — our
          // initial, a refinement, or a manual rename alike. The budget
          // itself belongs to the send sites (granted on the initial send,
          // decremented per refinement, zeroed on a manual `/rename`), so
          // this handler retires the initial request and resets the odometer.
          const e = sessionRegistry.get(activeSessionId);
          sessionRegistry.set(activeSessionId, { ...e, name: title, autoRenameArmed: false, autoRenameTurns: 0 });
          notify();
        }
      }
      _send({ type: "get_state" });
      return;
    }

    if (type === "extension_ui_request") {
      // Neither a late replay nor a buffered frame can revive a settled
      // callback, especially after this process has exited.
      if (["ask", "select", "input", "editor", "confirm"].includes(ev.method) &&
          (sessionContext.processEnded || sessionContext.askSettled?.has(ev.id))) return;
      // URL to open in the system browser (e.g. OAuth auth page).
      if (ev.method === "open_url") {
        // window.open() is a no-op here (no on_new_window handler is
        // registered, so wry denies it) rather than opening the system
        // browser. Use the open_url_external Rust command (open crate →
        // ShellExecuteExW on Windows) so OAuth URLs open in the user's
        // actual browser.
        if (window.__TAURI__) {
          window.__TAURI__.core.invoke("open_url_external", { url: ev.url }).catch(e => {
            console.error("[live] open_url_external failed:", e);
          });
        } else {
          window.open(ev.url, "_blank");
        }
        if (ev.instructions) {
          state.messages = [
            ...state.messages,
            {
              kind: "assistant", time: timeNow(),
              model: state.model?.name ?? null,
              blocks: [{ type: "text", text: ev.instructions }],
              thought: null, lead: null, streaming: false, completed: true,
            },
          ];
          notify();
        }
        return;
      }
      // Single-line text prompt (e.g. OAuth manual-code flows). Pushed
      // directly rather than buffered like `select` below — a generic
      // input() from extension code gates no tool call, so there is no
      // tool card to order it against and nothing to gain from the delay.
      // Wire shape: request carries {title, placeholder}, response is
      // {value: <text>} or {cancelled: true}.
      if (ev.method === "input") {
        state.messages = [...state.messages, _askMessage("input", ev, {
          placeholder: ev.placeholder ?? "Enter value…",
        })];
        notify();
        return;
      }
      // Agent asks the user to pick from a list: every tool-approval prompt
      // ("Allow tool: X", options ["Approve","Deny"]) and extension pickers
      // like /review's. The ask tool uses the `ask` dialog below instead.
      // Buffered rather than pushed immediately; see _queueAskBubble.
      if (ev.method === "select") {
        _queueAskBubble(_askMessage("select", ev, { options: ev.options ?? [] }));
        return;
      }
      // omp's ask dialog (enabled per process in _initFetch): every question
      // of one ask tool call, answered with `answers` (OMP_BRIDGE.
      // answerAskDialog; rules in app/ask-dialog.js). omp writes it from
      // inside the running ask tool, yet it reaches stdout before that
      // tool's tool_execution_start (seen live), so it is buffered like a
      // select. An unsupported shape fails the tool rather than impersonating
      // a user cancellation, which would abort the whole turn.
      if (ev.method === "ask") {
        state.askRecovery = null;
        sessionContext.askRecoveryRequest = null;
        state.messages = state.messages.filter(m => !m.recovery || m.answered || m.recoverySending);
        const questions = ASK.parseQuestions(ev.questions);
        if (!questions) {
          _pushAssistantNote("**Unsupported ask question:** Desktop could not display this request. The ask tool will fail instead of cancelling your turn.");
          const owner = sessionContext, origin = activeSessionId;
          _send({ type: "extension_ui_response", id: ev.id }).then(sent => {
            if (sent) _rememberSettledAsk(owner, ev.id);
            if (!sent && activeSessionId === origin && sessionContext === owner) {
              _pushAssistantNote("**Ask response not sent:** The unsupported question could not be reported to omp.");
            }
          });
          return;
        }
        _queueAskBubble(_askMessage("ask", ev, { questions, timeout: ev.timeout ?? null, answers: null }));
        return;
      }
      // Yes/No confirmation dialog. Pushed directly — see the `input`
      // comment above for why (no guaranteed tool_execution_start
      // pairing). Wire shape confirmed against the installed omp binary:
      // request carries {title, message}, response is {confirmed: bool}
      // (not {value} — see OMP_BRIDGE.answerConfirm).
      if (ev.method === "confirm") {
        state.messages = [...state.messages, _askMessage("confirm", ev, {
          message: ev.message ?? "",
        })];
        notify();
        return;
      }
      // Multi-line text editor dialog. Pushed directly — see the `input`
      // comment above for why. Wire shape confirmed against the installed
      // omp binary: request carries {title, prefill}, response is
      // {value: <text>} (same shape as select/input) or {cancelled: true}.
      if (ev.method === "editor") {
        state.messages = [...state.messages, _askMessage("editor", ev, {
          prefill: ev.prefill ?? "",
        })];
        notify();
        return;
      }
      // Agent cancelled a pending UI request (e.g. turn aborted while waiting for input).
      if (ev.method === "cancel") {
        // Keep even a pre-flush cancellation visible; don't affect its peers.
        const queued = pendingAskBubbles.findIndex(m => m.kind === "ask" && m.id === ev.targetId);
        if (queued !== -1) {
          _rememberSettledAsk(sessionContext, ev.targetId);
          pendingAskBubbles[queued] = { ...pendingAskBubbles[queued], cancelled: true, closedByOmp: true, closeReason: "omp", sending: null };
          _flushAskBubbles();
          notify();
          return;
        }
        // The wire does not distinguish timeout from an aborted signal.
        _settleAsk(ev.targetId, { cancelled: true, closedByOmp: true, closeReason: "omp", sending: null });
        return;
      }
      // An extension's status line or text widget (#52): kept per tab, shown
      // in the rail. Fire-and-forget like `notify`, `setTitle` and
      // `set_editor_text`, which the desktop does not show: omp waits for no
      // reply to any of them, so none is sent.
      if (ev.method === "setStatus" || ev.method === "setWidget") {
        // Already in the snapshot a dropped replay loaded (see
        // `extSnapshotSeq`); `lastSeq` is this frame's journal seq here.
        if (lastSeq <= extSnapshotSeq) return;
        const next = EXT.apply(state.extWidgets, ev);
        if (next !== state.extWidgets) {
          state.extWidgets = next;
          notify();
        }
        return;
      }
      if (EXT.isFireAndForget(ev.method)) return;
      // Any other/future method we have no UI for — cancel so the server
      // never hangs waiting on a response we can't produce.
      _send({ type: "extension_ui_response", id: ev.id, cancelled: true });
      return;
    }

    // ── Turn lifecycle ────────────────────────────────────────────────────────
    if (type === "turn_start") {
      turnStartTime = now;
      state.isStreaming = true;
      // A turn while omp waited to retry: the next attempt is in flight.
      state.messages = TURN.retryAttempting(state.messages, now);
      notify();
      return;
    }

    if (type === "turn_end") {
      state.isStreaming = false;
      streamingBubble = null;
      const usage = ev.message?.usage;
      if (turnStartTime) {
        const elapsed   = (now - turnStartTime) / 1000;
        const outTokens = usage?.output ?? 0;
        if (elapsed > 0 && outTokens > 0) {
          const tps = outTokens / elapsed;
          tpsSamples.push(Math.round(tps));
          tpsSamples.shift();
          state.currentTps = tps;
          state.sparkline  = [...tpsSamples];
        }
      }
      if (usage?.cost?.total) {
        state.sessionCost = (state.sessionCost ?? 0) + usage.cost.total;
        _refreshCtx();
      }
      _send({ type: "get_session_stats" });
      _send({ type: "get_state" });
      notify();
      return;
    }

    // ── Message lifecycle ─────────────────────────────────────────────────────
    if (type === "message_start") {
      const msg  = ev.message;
      const role = msg?.role;
      // omp's message timestamp: the get_messages merge after a tab switch
      // matches this entry to its persisted copy by it (`mergeTranscript`).
      const ts   = tsOf(msg);

      // A `/skill:` call reaches the model as a `skill-prompt` custom
      // message whose text is the whole skill file; what the user typed is
      // in `details.prompt`, which omp's own transcript shows too.
      // get_messages never returns custom messages, so that bubble has no
      // persisted copy and the merge keeps it as is.
      const skill = role === "custom" && msg.customType === "skill-prompt" && msg.attribution === "user";
      if (role === "user" || skill) {
        state.askRecovery = null;
        sessionContext.askRecoveryRequest = null;
        state.messages = state.messages.map(m => m.recovery && !m.answered && !m.cancelled && !m.recoverySending
          ? { ...m, cancelled: true, closedByOmp: true } : m);
        const blocks = Array.isArray(msg.content) ? msg.content : [{ type: "text", text: String(msg.content ?? "") }];
        const { text: typed, images } = window.adaptUserContent(blocks);
        const text = skill ? _skillPromptText(msg.details) : typed;
        if (text || images.length > 0) {
          // `send` shows its prompt right away, so its echo finds that
          // bubble at the tail and ties it to omp's message. Steers and
          // follow-ups only appear here, when omp hands them to the model:
          // tagged `echo`, so the scroll pin (app/scroll-pin.js) does not
          // pull a reader down to them, and so two identical steers
          // delivered back to back both show.
          const last = state.messages[state.messages.length - 1];
          if (last?.kind === "user" && !last.echo && last.ts == null && last.text === text) {
            state.messages = [...state.messages.slice(0, -1), { ...last, ts }];
          } else {
            state.messages = [...state.messages, { kind: "user", time, ts, text, images, echo: true }];
          }
          notify();
        }
      } else if (role === "custom") {
        // A background job's result (`async-result`) is what wakes the agent
        // after it yielded: name the job above the reply it triggers. omp's
        // hidden goal-continuation prompt likewise starts a turn nobody
        // typed: mark it above the reply.
        const jobs = TURN.finishedJobsOf(msg);
        if (jobs) {
          state.messages = [...state.messages, ...jobs.map(job => ({ kind: "job", time, ...job }))];
          notify();
        } else {
          const row = GOAL.continuationRow(msg);
          if (row) {
            state.messages = [...state.messages, { ...row, time }];
            notify();
          }
        }
      } else if (role === "assistant") {
        streamingBubble = {
          kind: "assistant", time, ts,
          thought: null, lead: null,
          blocks: [{ type: "text", text: "" }],
          streaming: true,
          model: state.model?.name ?? "–",
        };
        state.messages = [...state.messages, streamingBubble];
        notify();
      }
      return;
    }

    if (type === "message_update") {
      if (!streamingBubble) return;
      const msg = ev.message;
      if (!msg) return;

      const blocks = Array.isArray(msg.content) ? msg.content : [];
      let thought = null;
      const designBlocks = [];
      for (const block of blocks) {
        if (block.type === "thinking" && block.thinking?.trim()) thought = block.thinking;
        else if (block.type === "text" && block.text) designBlocks.push({ type: "text", text: block.text });
      }

      streamingBubble.thought = thought;
      streamingBubble.lead    = thought ? "thinking" : null;
      streamingBubble.blocks  = designBlocks.length > 0 ? designBlocks : [{ type: "text", text: "" }];
      // The message this bubble shows: after frames were lost, a bubble left
      // streaming can receive the next message's updates (see get_messages).
      if (msg.role === "assistant") streamingBubble.ts = tsOf(msg) ?? streamingBubble.ts;

      const updated = { ...streamingBubble, blocks: [...streamingBubble.blocks] };
      // Find by streaming flag — indexOf fails after the first update because
      // each update replaces the entry with a new copy; ask bubbles may also
      // sit after the streaming bubble in state.messages.
      const uidx = state.messages.findLastIndex(m => m.streaming === true);
      if (uidx !== -1) {
        const msgs = [...state.messages];
        msgs[uidx] = updated;
        state.messages = msgs;
      } else {
        state.messages = [...state.messages.slice(0, -1), updated];
      }
      notify();
      return;
    }

    if (type === "message_end") {
      const msg = ev.message;
      // Auto-rename gate input: an assistant turn ending in error/aborted
      // still lands in omp's messageCount, so the gate needs the outcome,
      // not just the count.
      const answered = msg?.role === "assistant" && !TURN.failedStop(msg);
      if (msg?.role === "assistant") lastTurnOk = answered;
      const usage = msg?.usage;
      const tokens = usage ? ((usage.input ?? 0) + (usage.output ?? 0)) : null;
      // Only an assistant message ends the streaming bubble: when frames were
      // lost, a tool result's, a steer's or a job's message_end can arrive
      // while a stale bubble is still open, and must neither fill nor re-tag
      // it (the get_messages merge sorts that bubble out by its `ts`).
      if (streamingBubble && msg?.role === "assistant") {
        const blocks = Array.isArray(msg.content) ? msg.content : [];
        const thought = blocks.find(b => b.type === "thinking")?.thinking ?? streamingBubble.thought;
        const designBlocks = blocks.filter(b => b.type === "text" && b.text?.trim()).map(b => ({ type: "text", text: b.text }));
        // Find by streaming flag — extension_ui_request.select may have pushed
        // an ask bubble after the streaming bubble before message_end arrives.
        // A failed request is not shown yet (`pendingFailure`): omp may
        // still retry it. `_showFailure` shows it once the agent yields.
        const pendingFailure = TURN.failureOf(msg);
        const completed = {
          ...streamingBubble,
          streaming: false, thought,
          lead:   thought ? "thinking" : null,
          blocks: designBlocks.length > 0 ? designBlocks : streamingBubble.blocks,
          tokens,
          tokensIn:  usage?.input  ?? null,
          tokensOut: usage?.output ?? null,
          ts:        tsOf(msg) ?? streamingBubble.ts,
          ...(pendingFailure ? { pendingFailure } : {}),
          // omp may retry a stream that stalled or dropped (`retryStarted`).
          ...(msg.stopReason === "aborted" ? { aborted: true } : {}),
        };
        const eidx = state.messages.findLastIndex(m => m.streaming === true);
        if (eidx !== -1) {
          const msgs = [...state.messages];
          msgs[eidx] = completed;
          state.messages = msgs;
        } else {
          state.messages = [...state.messages.slice(0, -1), completed];
        }
        streamingBubble = null;
      } else if (streamingBubble && !msg) {
        const completed2 = { ...streamingBubble, streaming: false, tokens };
        const eidx2 = state.messages.findLastIndex(m => m.streaming === true);
        if (eidx2 !== -1) {
          const msgs = [...state.messages];
          msgs[eidx2] = completed2;
          state.messages = msgs;
        } else {
          state.messages = [...state.messages.slice(0, -1), completed2];
        }
        streamingBubble = null;
      }
      // A retried request answered: the retries are over even if more turns
      // follow in this run (app/turn-status.js `retryFinished`). By omp's
      // rule only output counts: after an empty stop omp keeps retrying.
      if (TURN.producedOutput(msg)) {
        state.messages = TURN.retryFinished(state.messages, msg, tsOf(msg));
      }
      notify();
      return;
    }

    // ── Tool execution ────────────────────────────────────────────────────────
    if (type === "tool_execution_start") {
      const card = window.buildToolStartCard(ev, time);
      const idx  = state.messages.length;
      activeToolCards.set(ev.toolCallId, idx);
      state.messages = [...state.messages, card];
      // Flush buffered asks AFTER the tool card so chat order is
      // [tool_card, ask_bubble] — omp emits select before tool_execution_start.
      // notify() below covers the flush.
      _flushAskBubbles();

      activityLog.push({ ts: now, toolName: ev.toolName ?? "" });
      const cutoff = now - 60_000;
      while (activityLog.length && activityLog[0].ts < cutoff) activityLog.shift();
      state.activity = window.buildActivityFromLog(activityLog);
      notify();
      return;
    }

    if (type === "tool_execution_update") {
      const idx = activeToolCards.get(ev.toolCallId);
      if (idx !== undefined) {
        const card = state.messages[idx];
        if (card?.kind === "tool") {
          const updated = window.updateToolCard(card, ev);
          const msgs = [...state.messages];
          msgs[idx] = updated;
          state.messages = msgs;
          notify();
        }
      }
      return;
    }

    if (type === "tool_execution_end") {
      const idx = activeToolCards.get(ev.toolCallId);
      if (idx !== undefined) {
        const card = state.messages[idx];
        if (card?.kind === "tool") {
          const updated = window.finalizeToolCard(card, ev);
          const msgs    = [...state.messages];
          msgs[idx]     = updated;
          state.messages = msgs;
          activeToolCards.delete(ev.toolCallId);
          if (ev.toolName === "todo_write") {
            const phases = ev.result?.details?.phases ?? ev.result?.phases ?? [];
            if (phases.length > 0) {
              state.kanban   = window.buildKanban(phases);
              state.planMeta = window.buildPlanMeta(phases, state.rpcState);
              _injectInlinePlan(phases);
            }
          }
        }
        notify();
      }
      return;
    }

    // Rust-side auto-approval (see approval::RuleBook / reader::try_auto_approve)
    // answered an "Allow tool: X" prompt directly on omp's stdin and never
    // forwarded the original ask — this row, with the prompt's detail lines
    // (command, path, …), is the only trace of it the human sees (#42). The
    // prompt arrived just before its tool's `tool_execution_start`, so it
    // goes through the ask queue for the same [tool_card, row] order; the
    // queue's flush publishes it.
    if (type === "desktop_auto_approval") {
      _queueAskBubble(APPROVAL.autoApprovalRow(ev, timeNow()));
      return;
    }

    // ── Turn outcome (app/turn-status.js) ───────────────────────────────────
    // omp retries a failed request by itself (auto-retry): one retry row per
    // run, from the first `auto_retry_start` to the run's final `agent_end`.
    if (type === "auto_retry_start") {
      state.messages = TURN.retryStarted(state.messages, ev, now);
      notify();
      return;
    }
    if (type === "auto_retry_end") {
      const next = TURN.retryEnded(state.messages, ev);
      if (next !== state.messages) { state.messages = next; notify(); }
      return;
    }

    // `prompt_result` closes an accepted prompt once the agent yielded, after
    // that run's `agent_end`. Only a failed agent turn matters here: the
    // frame adds omp's cleaned error text and its `retryable` verdict to the
    // failure `agent_end` just showed. Not id-correlated — an ordinary
    // prompt is sent without one.
    if (type === "prompt_result") {
      if (ev.agentInvoked === true && ev.status === "error") {
        _showFailure(prev => TURN.withPromptError(prev, ev.error));
        notify();
      }
      return;
    }

    // Nothing can wake the session any more: no run, nothing queued, and no
    // background job left whose result would start one.
    if (type === "session_settled") {
      if (state.asyncPending) {
        state.asyncPending = false;
        notify();
      }
      return;
    }

    if (type === "agent_start" || type === "agent_end") {
      // Terminal turns since the last title write/attempt. An initial retry
      // needs a successful one; refinements keep their existing cadence.
      // Scheduling pauses and our `/rename` builtin never count.
      if (STITLE.countsAsRefineTurn(ev) && activeSessionId && sessionRegistry.has(activeSessionId)) {
        const e = sessionRegistry.get(activeSessionId);
        if (!e.autoRenameArmed || lastTurnOk) {
          sessionRegistry.set(activeSessionId, { ...e, autoRenameTurns: (e.autoRenameTurns ?? 0) + 1 });
        }
      }
      if (type === "agent_end") {
        // A yield is the run's final outcome — omp's own retries are behind it.
        // (Background work left behind reaches `asyncPending` through the
        // get_state below, which notifies anyway.)
        if (TURN.isYield(ev)) {
          const messages = Array.isArray(ev.messages) ? ev.messages : [];
          const last = messages.findLast(m => m?.role === "assistant");
          // A retry row still here means the retries did not recover: the
          // row goes, the final attempt says how they ended (and is shown
          // again if a retry had hidden it).
          const before = state.messages;
          state.messages = TURN.retryYielded(before, last ?? null, tsOf(last));
          const failure = TURN.failureOf(last);
          if (failure) _showFailure(() => failure, tsOf(last));
          if (failure || state.messages !== before) notify();
        }
      }
      _send({ type: "get_state" });
    }
  }

  function _injectInlinePlan(phases) {
    const idx = [...state.messages].reverse().findIndex(m => m.kind === "assistant");
    if (idx === -1) return;
    const realIdx = state.messages.length - 1 - idx;
    const msg     = state.messages[realIdx];
    if (msg.blocks?.some(b => b.type === "plan")) return;
    const planBlock = {
      type: "plan", title: "Plan",
      phases: phases.map(ph => ({
        id: ph.name, label: ph.name,
        tasks: ph.tasks.map((t, i) => ({
          id: `${ph.name}-${i}`, text: t.content,
          status: (t.status === "completed" || t.status === "abandoned") ? "done" : t.status,
        })),
      })),
    };
    const msgs    = [...state.messages];
    msgs[realIdx] = { ...msg, blocks: [...(msg.blocks ?? []), planBlock] };
    state.messages = msgs;
  }

  // The effective thinking level as get_state and `thinking_level_changed`
  // report it. Unset (a model without thinking, say) reads as off, as in
  // omp's own UI.
  function _effectiveThinking(level) {
    return level ?? "off";
  }

  function _applyRpcState(rpcState) {
    if (!rpcState) return;
    state.rpcState      = rpcState;
    state.agentContext = CONTEXT.rpc(state.agentContext, rpcState);
    state.isStreaming   = rpcState.isStreaming ?? false;
    // Background work that will wake the agent (see `state.asyncPending`);
    // this is also how a tab activated mid-wait learns about it.
    state.asyncPending  = rpcState.hasPendingAsyncWork === true;
    state.backgroundTasks = TASKS.setPending(state.backgroundTasks, state.asyncPending);
    // If the turn completed while we were away (snapshot had streamingBubble
    // with streaming:true, but omp now says isStreaming:false), retire the
    // bubble immediately. The completed text arrives with get_messages; the
    // stale ghost is removed from state.messages here so the minimap doesn't
    // show a pulsating cell until get_messages lands.
    if (!state.isStreaming && streamingBubble) {
      streamingBubble = null;
      state.messages = state.messages.filter(m => !m.streaming);
    }
    state.thinkingLevel = _effectiveThinking(rpcState.thinkingLevel);
    // The queue as of this get_state; later `queue_update`s follow it in
    // the same stream, so the last one written wins.
    state.queue = QUEUE.fromSnapshot(rpcState.queuedMessages, state.queue);
    // `null` with no goal; absent from an omp that predates goal mode.
    state.goal = GOAL.fromSnapshot(state.goal, rpcState.goal ?? null);

    if (rpcState.model) {
      state.model = {
        id:       rpcState.model.id,
        name:     rpcState.model.name ?? window.MODEL_NAMES?.[rpcState.model.id] ?? window.formatModelId(rpcState.model.id),
        provider: rpcState.model.provider,
        note:     rpcState.model.provider,
        latency:  0,
        current:  true,
      };
    }
    if (rpcState.model && state.models.length > 0) {
      state.models = state.models.map(m => ({ ...m, current: m.id === rpcState.model.id }));
    }
    if (rpcState.todoPhases?.length > 0) {
      state.kanban   = window.buildKanban(rpcState.todoPhases);
      state.planMeta = window.buildPlanMeta(rpcState.todoPhases, rpcState);
    }

    // Only update the tab name if omp provides an explicit human-readable
    // sessionName. The sessionFile is a timestamp ID — leave the folder-based
    // name set at tab-open time intact when sessionName is absent.
    if (rpcState.sessionName && activeSessionId && sessionRegistry.has(activeSessionId)) {
      const entry = sessionRegistry.get(activeSessionId);
      sessionRegistry.set(activeSessionId, { ...entry, name: rpcState.sessionName, autoRenameArmed: false });
    }
    // Remember which conversation this tab runs, for `resumeSession`'s
    // focus-existing lookup. Re-read: the `sessionName` write above may have
    // replaced the entry.
    const current = activeSessionId ? sessionRegistry.get(activeSessionId) : null;
    if (rpcState.sessionFile && current && current.sessionFile !== rpcState.sessionFile) {
      sessionRegistry.set(activeSessionId, { ...current, sessionFile: rpcState.sessionFile });
    }

    // ── Auto-rename (src/app/session-title.js) ──────────────────────────
    // RPC-mode omp never titles a session, so after the first completed
    // exchange the app asks: send the bare `/rename` builtin, which
    // generates a title from the conversation, emits `session_info_update`
    // (applied above), then prints an outcome note (swallowed above while
    // in flight). The initial title remains armed until a title is observed.
    // A refusal or failed IPC may retry after another completed terminal turn,
    // never on repeated snapshots or while an earlier attempt is still running.
    // `lastTurnOk` keeps failed/aborted exchanges from triggering a request.
    // Once titled, the existing bounded refinement cadence applies: every
    // STITLE.REFINE_EVERY_TURNS terminal agent turns, at most REFINE_MAX times.
    // Nothing in this get_state path may clear in-flight on a title check.
    // A previous version cleared it on any confirming `sessionName` — a
    // race: the next turn's `agent_start` get_state answers with the OLD
    // title while our background generation runs, released the flag early,
    // and the note then reached the transcript. The flag is released by the
    // outcome note, by `_disarmAutoRename` (which also retires an armed
    // one-shot and the refinement budget), by a fresh conversation
    // (`new_session` / profile respawn), by the `abort` response
    // (`_releaseAutoRenameAfterAbort`) when generation is cancelled and no
    // note will arrive, by a replay that lost frames (`_switchToSession`),
    // and below when omp switched sessions in-process — keyed on
    // `sessionId`, which a stale snapshot cannot misreport, unlike a title.
    if (activeSessionId && sessionRegistry.has(activeSessionId)) {
      let entry = sessionRegistry.get(activeSessionId);
      // A budget that has no session binding yet (a fresh tab before its
      // first send, or `_resetForNewFile` after branch/fork, which mints a
      // new omp session id) binds to the session omp reports now; only a
      // *bound* id that later differs means an in-process switch.
      if (!entry.autoRenameSessionId && rpcState.sessionId &&
          (entry.autoRenameArmed || entry.autoRenameLeft > 0)) {
        entry = { ...entry, autoRenameSessionId: rpcState.sessionId };
        sessionRegistry.set(activeSessionId, entry);
      }
      if (STITLE.isRenameStateStale(rpcState, entry.autoRenameSessionId)) {
        // The conversation the budget was granted for is gone: retire
        // everything, as for a resume (its note cannot come; its title may
        // be manual).
        entry = {
          ...entry, autoRenameArmed: false, autoRenameInFlight: false,
          autoRenameAttempt: null, autoRenameLeft: 0, autoRenameTurns: 0, autoRenameSessionId: null,
        };
        sessionRegistry.set(activeSessionId, entry);
      }
      // Settings → Session "Name tabs automatically" off: neither the first
      // title nor a refresh is sent. Tabs stay armed, so turning it back on
      // titles the ones still untitled at their next settled turn.
      if (sessionPrefs.autoName && !entry.autoRenameInFlight &&
          (!entry.autoRenameAttempt || entry.autoRenameTurns > 0) &&
          STITLE.shouldAutoRename(rpcState, entry.autoRenameArmed, lastTurnOk)) {
        _sendAutoRename(entry, false);
      } else if (sessionPrefs.autoName && !entry.autoRenameArmed && !entry.autoRenameInFlight &&
                 STITLE.shouldRefineTitle(rpcState, entry.autoRenameTurns ?? 0,
                                          entry.autoRenameLeft ?? 0, lastTurnOk)) {
        // A failed refresh still spends its slot; only the initial title
        // remains eligible until it succeeds.
        _sendAutoRename(entry, true);
      }
    }

    _refreshCtx();
    notify();
  }

  function _refreshCtx() {
    state.ctx = window.buildCtx(state.rpcState, state.sessionCost, state.currentTps);
  }

  // A new model or compacted history invalidates every older accounting read.
  // Keep the new capacity when known, never an old model's usage percentage.
  function _invalidateContext(model = null, compacting = false) {
    sessionContext.contextRevision = (sessionContext.contextRevision || 0) + 1;
    const previousModel = state.rpcState?.model;
    const nextModel = model || (previousModel ? { ...previousModel, contextWindow: undefined } : null);
    state.rpcState = { ...state.rpcState, model: nextModel, contextUsage: undefined,
      contextRefreshing: true, isCompacting: compacting };
    _refreshCtx();
    notify();
  }

  function _requestState() {
    const owner = sessionContext, gen = _switchGen, id = activeSessionId;
    const revision = owner.contextRevision || 0;
    const request = owner.stateRequest = (owner.stateRequest || 0) + 1;
    const current = () => sessionContext === owner && _switchGen === gen && activeSessionId === id
      && _switchAwayFrom == null && (owner.contextRevision || 0) === revision && owner.stateRequest === request;
    // Apply inside response dispatch, not a promise microtask: a later frame
    // in the same journal replay must remain newer than this state snapshot.
    return _sendWithResponse({ type: "get_state" }, QUICK_CMD_TIMEOUT_MS, "context-state-", data => {
      if (!current()) return;
      _applyRpcState(data);
      if (_syncRecoveredAsks()) notify();
      void _applyApprovalModes();
    }).then(() => current(), error => {
        if (current()) {
          state.rpcState = { ...state.rpcState, contextUsage: undefined, contextRefreshing: false };
          _refreshCtx();
          notify();
          console.warn("[live] context state refresh failed:", error);
        }
        return false;
      });
  }

  function _initFetch() {
    // Negotiate protocol v2 first so oversized responses (get_available_models
    // is ~2 MiB, well past the v1 1 MiB frame cap) arrive as reassembled
    // rpc_chunk sequences instead of failing with a transport-limit error.
    // Await the negotiate response so v2 is active before the large fetches are
    // dispatched (stdin is processed in order, but this avoids any IPC-ordering
    // race). A v1 server or a repeat negotiate simply rejects — harmless.
    // A tab switch that starts while negotiate is in flight owns the
    // process from then on: this batch still addresses the tab being left
    // (activeSessionId moves only after the switch's awaits), and its
    // subscription line would undo the switch's downgrade of that process.
    const gen = _switchGen;
    const conversation = sessionContext;
    _sendWithResponse({ type: "negotiate_protocol", protocolVersion: 2 })
      .catch(() => {})
      .finally(() => {
        if (_switchGen !== gen || sessionContext !== conversation) return;
        // omp's ask dialog is off by default and per process: a respawned
        // process falls back to one `select` per question until told again.
        _sendWithResponse({ type: "set_ask_dialog", enabled: true })
          .catch(err => console.warn("[live] set_ask_dialog failed:", err));
        // Auto-retry retains its Desktop switch. Compaction is owned solely
        // by the native profile policy and explicit conversation overrides.
        if (!sessionPrefs.autoRetry) _send({ type: "set_auto_retry", enabled: false });
        _send({ type: "get_state" });
        _send({ type: "get_messages" });
        // The saved active branch retains tool calls/results and pre-compaction
        // turns that the model's get_messages context may omit.
        const file = sessionRegistry.get(activeSessionId)?.sessionFile;
        const request = _agentContextSync().loadMain();
        conversation.askRecoveryRequest = request;
        request.then(data => {
          if (!data || _switchGen !== gen || sessionContext !== conversation) return;
          const messages = window.OMP_TRANSCRIPT.messagesFromEntries(data);
          if (messages) _applyMessages(messages);
          if (conversation.askRecoveryRequest !== request) return;
          if (file && window.OMP_ASK_RECOVERY) {
            state.askRecovery = window.OMP_ASK_RECOVERY.fromEntries(data, file);
            if (_syncRecoveredAsks()) notify();
          }
        }).catch(error => console.warn("[live] native context refresh failed:", error));
        _send({ type: "get_available_models" });
        _send({ type: "get_available_commands" });
        // Subscription level is per process and survives tab switches, but a
        // respawned process starts at "off" — so (re)assert it every time.
        _send({ type: "set_subagent_subscription", level: SUB.subscriptionLevelFor({ inspecting: subagentInspecting }) });
        const subagentsBefore = state.subagents;
        _sendWithResponse({ type: "get_subagents" }).then(data => {
          if (_switchGen !== gen || sessionContext !== conversation || sessionContext.processEnded) return;
          if (state.subagents !== subagentsBefore) return; // A newer lifecycle frame outranks this running-only snapshot.
          state.subagents = SUB.mergeSnapshots(state.subagents, data.subagents);
          state.backgroundTasks = TASKS.mergeSubagents(state.backgroundTasks, data.subagents);
          _agentContextSync().refreshAgents();
          notify();
        }).catch(error => console.warn("[live] subagent snapshot failed:", error));
      });
  }

  // ── Send a command to the active session's omp ────────────────────────────
  // Resolves to whether the IPC hand-off succeeded; fire-and-forget callers
  // ignore it (failures are logged here either way).
  function _send(cmd) {
    if (!window.__TAURI__ || !activeSessionId) return Promise.resolve(false);
    if (cmd.type === "get_state") return _requestState();
    return _invokeSend(cmd).then(() => true, e => { _logSendError(e); return false; });
  }

  // The `send_command` hand-off to the active tab, shared by `_send` and
  // `_sendWithResponse`; callers check the connection and handle failure.
  function _invokeSend(cmd) {
    return window.__TAURI__.core
      .invoke("send_command", { sessionId: activeSessionId, json: JSON.stringify(cmd) });
  }

  /** Send `cmd` to every open tab's omp, uncorrelated (no `id`: a response
   *  replayed into a tab later is ignored by `_handleResponse`). A tab
   *  whose process is gone or still starting misses it; its new process
   *  starts from omp's own config plus `_initFetch`'s "off" overrides. */
  function _sendToAll(cmd) {
    if (!window.__TAURI__) return;
    const json = JSON.stringify(cmd);
    // A warning, not `_invokeSafe`'s error: a tab missing it is expected.
    for (const sessionId of sessionRegistry.keys()) {
      window.__TAURI__.core.invoke("send_command", { sessionId, json })
        .catch(e => console.warn(`[live] ${cmd.type} for '${sessionId}' not sent:`, e));
    }
  }

  function _logSendError(e) { console.error("[live] send error:", e); }

  // Project path (cwd) of the active tab, or null for a pathless tab (a
  // resumed session with no recorded cwd) — used to scope project-level
  // approval rules and the git browser to the right repo.
  function _activeProjectPath() {
    const entry = sessionRegistry.get(activeSessionId);
    return entry?.path || null;
  }

  /** Pure decision: which profile id a tab's session should use, given its
   *  registry entry (or `undefined` if there is no active tab), the ticked
   *  startup default, and the current profile catalogue. Falls back to
   *  `startupId` whenever the entry's stored id isn't (or is no longer)
   *  listed: a second window's `delete_profile` (whose in-use guard passes
   *  there — it has no tab on the id) or a hand-edited profiles.json can
   *  unlist an id this window's tab still points at, and there is no
   *  tab-side revalidation once a profile is assigned at spawn. This is the
   *  single choke point that must never trust a stale id.
   *  Proven with an eval-kernel cell (4/4 cases: tab has a listed profile
   *  -> kept, tab has an unlisted profile -> falls back to startup, no tab
   *  at all -> startup, startup pointer is the built-in id). */
  function _resolveProfile(entry, startupId, profileList) {
    const id = entry?.profile;
    if (id && profileList.some(p => p.id === id)) return id;
    return startupId;
  }

  /** The active tab's omp profile id. Profile-scoped reads *and* new-tab
   *  spawns both use this, so they can never disagree: a new tab inherits the
   *  active tab's profile ("work" stays "work" when you open a second
   *  folder), and with no tab open there is nothing to inherit, so the
   *  empty workspace's pick, else the user's ticked default, applies to
   *  both. Two helpers with different fallbacks
   *  meant that after closing the last tab the history panel listed the
   *  built-in tree while the next `openSession` spawned into the ticked
   *  profile - and `resumeSession` must match whatever was listed. */
  function _activeProfileId() {
    return _resolveProfile(sessionRegistry.get(activeSessionId), _noTabProfile(), profiles);
  }

  /** Profile a tab opened now would get with no tab to inherit from: the
   *  empty workspace's pick while it is still listed, else the startup
   *  default. */
  function _noTabProfile() {
    return _noTabProfileId && profiles.some(p => p.id === _noTabProfileId)
      ? _noTabProfileId
      : startupProfileId;
  }

  /** Re-read the persisted profile list + default into `profiles` /
   *  `startupProfileId` and push a snapshot. Falls back to leaving the
   *  current values untouched when the command is unavailable (browser-only
   *  dev mode). */
  async function _refreshProfiles() {
    const res = await _invokeSafe("list_profiles", {}, null);
    const list = res?.profiles;
    if (Array.isArray(list) && list.length > 0) {
      profiles = list;
      // A pick that stopped resolving is dropped, not merely masked by
      // `_noTabProfile()`: re-listing the same id later (another window)
      // must not resurrect it without the user choosing it again.
      if (_noTabProfileId && !profiles.some(p => p.id === _noTabProfileId)) _noTabProfileId = null;
      // `startupId` is validated server-side against the same list, so it is
      // always one of these ids - no client-side reconciliation needed.
      if (res.startupId) startupProfileId = res.startupId;
      notify();
    }
    _syncRecentsProfile();
    return profiles;
  }

  /** Adopt a recent-projects list fetched for `profile` — unless the active
   *  profile moved on while the request was in flight (a stale answer would
   *  show another profile's folders), or the call failed (`null`).
   *
   *  The recents functions below are IPC glue over module state, with no
   *  fake `__TAURI__` harness in this repo to unit-test them against; the
   *  store's semantics are proven by `recent_projects.rs`'s tests and the
   *  focus-existing lookups by `test-project-nav.mjs`. */
  function _applyRecents(profile, list) {
    if (!Array.isArray(list) || profile !== _activeProfileId()) return;
    recentProjects = list;
    _recentsProfile = profile;
    notify();
  }

  // Recents IPC runs one call at a time, each applied before the next is
  // issued. The backend's `list` is unlocked and every command is its own
  // `spawn_blocking` task, so unordered calls could let a `list` read the
  // file before a `touch` wrote it and still resolve after it — the stale
  // list would win, and nothing refetches until the profile changes.
  let _recentsQueue = Promise.resolve();
  function _recentsCall(cmd, args) {
    const run = _recentsQueue.then(async () => {
      _applyRecents(args.profile, await _invokeSafe(cmd, args, null));
    });
    _recentsQueue = run.catch(() => {});
    return run;
  }

  function _refreshRecents() {
    return _recentsCall("recent_projects_list", { profile: _activeProfileId() });
  }

  /** Refetch the recent list when the active profile is no longer the one
   *  it was fetched for. Cheap to call on every activation. */
  function _syncRecentsProfile() {
    if (_activeProfileId() !== _recentsProfile) void _refreshRecents();
  }

  /** Record `path` as opened under `profile`. The backend canonicalises it
   *  and refuses a folder that no longer exists; `_invokeSafe` logs that. */
  function _touchRecent(path, profile) {
    if (!path) return Promise.resolve();
    return _recentsCall("recent_projects_touch", { path, profile });
  }

  /** Which open tabs (by name) are running under profile `id`, given a
   *  snapshot of the session registry's entries. Pure — deleteProfile calls
   *  this once before the delete round-trip and once after (against a
   *  possibly-changed registry) without duplicating the filter/join, and
   *  the two call sites can't drift on the singular/plural wording.
   *  Proven with an eval-kernel cell (5/5 cases: no tabs at all, one tab on
   *  the id, several tabs on the id, tabs only on other profiles, singular
   *  wording for a single tab). */
  function _profilesInUse(id, entries) {
    const names = entries.filter(s => s.profile === id).map(s => s.name);
    if (names.length === 0) return null;
    return `in use by ${names.length === 1 ? "tab" : "tabs"}: ${names.join(", ")}`;
  }

  // ── Window chrome (drag + controls) ──────────────────────────────────────
  function _setupWindowChrome() {
    if (!window.__TAURI__) return;
    const { getCurrentWindow } = window.__TAURI__.window;
    const win  = getCurrentWindow();
    const isWin = navigator.userAgent.includes("Windows") || navigator.platform.startsWith("Win");
    const isMac = navigator.platform.startsWith("Mac");
    const chromeControl = "a, button, input, select, textarea, [tabindex], .profile-pop, .chrome-lights, .win-controls";

    // Drag: delegate from document so it works regardless of React render timing.
    // startDragging() must be called synchronously within the mousedown handler.
    document.addEventListener("mousedown", e => {
      if (e.button !== 0 || !e.target.closest(".chrome") || (isMac && e.detail === 2)) return;
      // Interactive chrome content (the profile popover's text inputs, and
      // the popover itself for padding/hints/row clicks) must never start a
      // window drag — a mousedown there is a caret placement or a
      // drag-select, and starting an OS window move instead swallows it.
      // Any future interactive .chrome content needs the same exclusion.
      if (e.target.closest(chromeControl)) return;
      win.startDragging().catch(() => {});
    });
    if (isMac) {
      document.addEventListener("dblclick", async e => {
        if (e.button !== 0 || !e.target.closest(".chrome") || e.target.closest(chromeControl)) return;
        try {
          const action = await window.__TAURI__.core.invoke("window_titlebar_action");
          if (action === "minimize") await win.minimize();
          else if (action === "zoom") {
            if (await win.isMaximized()) await win.unmaximize();
            else await win.maximize();
          }
        } catch (error) {
          console.error("[live] native title-bar action failed:", error);
        }
      });
    }

    if (isWin) {
      document.addEventListener("click", e => {
        if (e.target.closest(".win-min"))        win.minimize();
        else if (e.target.closest(".win-max"))   win.isMaximized().then(m => m ? win.unmaximize() : win.maximize());
        else if (e.target.closest(".win-close")) void _requestQuit();
      });
    } else if (!isMac) {
      document.addEventListener("click", e => {
        const t = e.target.closest(".light");
        if (!t) return;
        if (t.classList.contains("red"))        void _requestQuit();
        else if (t.classList.contains("amber")) win.minimize();
        else if (t.classList.contains("green")) win.isMaximized().then(m => m ? win.unmaximize() : win.maximize());
      });
    }
  }

  // ── Busy-close confirmation (#37) ─────────────────────────────────────────
  // Settings → Session "Ask before closing a busy tab". Closing a tab
  // (`closeSessionGuarded`) or the window (our close button, or an OS close
  // Rust holds while the guard is armed and forwards as
  // `window://close-requested`) asks first while a tab is busy; the dialog
  // renders the snapshot's `closeConfirm`. Decisions: app/session-prefs.js.

  /** Arm Rust's close guard exactly while a close would need confirming;
   *  called on every notify, so it only sends a change. */
  function _syncCloseGuard(sessions) {
    if (_quitting) return;
    const armed = PREFS.closeGuardArmed(sessionPrefs, sessions);
    if (armed === _closeGuardSent) return;
    _closeGuardSent = armed;
    void _invokeSafe("set_close_guard", { armed });
  }

  /** Show `confirm` and resolve to the user's answer. A newer request
   *  replaces one still on screen, which then resolves to false. */
  function _askClose(confirm) {
    _closeConfirmAnswer?.(false);
    return new Promise(resolve => {
      _closeConfirmAnswer = ok => {
        _closeConfirmAnswer = null;
        closeConfirm = null;
        notify();
        resolve(ok);
      };
      closeConfirm = confirm;
      notify();
    });
  }

  /** Close the window — and with it the app, through Rust's usual exit
   *  path (`kill_child_processes`) — after confirming busy tabs. The guard
   *  is disarmed first, so Rust lets this close through. */
  async function _requestQuit() {
    if (_quitting || !window.__TAURI__) return;
    const confirm = PREFS.quitConfirm(sessionPrefs, _sessionsView());
    if (confirm && !(await _askClose(confirm))) return;
    if (_quitting) return; // a second request confirmed meanwhile
    _quitting = true;
    try {
      await window.__TAURI__.core.invoke("set_close_guard", { armed: false });
      _closeGuardSent = false;
      await window.__TAURI__.window.getCurrentWindow().close();
    } catch (e) {
      console.error("[live] closing the window failed:", e);
      _quitting = false;
      _closeGuardSent = null;
      _syncCloseGuard(_sessionsView());
    }
  }

  // Record a sent prompt into the active tab's in-memory history (issue
  // #16). Not slash-command-filtered — a `/plan …` or `/compact` the user
  // typed by hand is just as recallable as any other prompt. Normalized
  // with the same framingPrefix/skip the transcript backfill uses below
  // (get_messages handler) — without this, a plan-mode send would record
  // the whole INTENT_FRAMING wrapper instead of the typed intent, and
  // approve-plan's canned APPROVAL_PROMPT followUp would show up in
  // recall too; both would then also get backfilled a second time, in
  // their *stripped* form, the next time get_messages arrives.
  function _recordPrompt(text) {
    if (!activeSessionId) return;
    promptHistories.set(activeSessionId, window.OMP_PROMPT_HISTORY.record(
      promptHistories.get(activeSessionId) ?? [], text, promptHistoryLimit,
      PROMPT_NORMALIZE,
    ));
  }

  // ── Steer / follow-up sends (app/message-queue.js) ────────────────────────
  let _queueSendSeq = 0;

  /** Hand a steer (`kind` "steering") or follow-up ("followUp") to omp via
   *  `send`, the id-correlated RPC call. No transcript bubble: omp holds a
   *  follow-up until the agent would otherwise stop and a steer until the
   *  current tool batch ends, and may drop either from its queue (✕), so
   *  the message shows in the queue strip — first as a "sending" row until
   *  omp acknowledges it, then from omp's own queue — and joins the
   *  transcript as its `message_start` echo when the model gets it.
   *  A refusal files a note that carries the text, which has already left
   *  the composer. A timeout only drops the row: omp may still admit the
   *  message (an image being prepared), and its `queue_update` shows it.
   *
   *  Side-effectful end to end (IPC, both tab stores); the row and note
   *  shapes are pure and tested in test-message-queue.mjs. */
  function _sendQueued(kind, text, images, send) {
    const origin = activeSessionId;
    if (!origin) return Promise.resolve(false);
    const id = ++_queueSendSeq;
    _disarmAutoRename(text);
    _recordPrompt(text);
    state.queueSending = [...state.queueSending, QUEUE.sendingEntry(id, kind, text, images.length, state.queue, state.queueSending)];
    notify();
    // Resolves to whether the IPC hand-off succeeded; omp's RPC response is
    // processed asynchronously so a tab switch never stalls remote callers.
    const sent = send();
    sent.then(() => { _dropSending(origin, id); return true; }, e => {
      if (!e?.timedOut) {
        const reason = e?.message ?? String(e);
        // Responses are only dispatched for the active tab, so a refusal
        // reaching us for another one is a failed hand-off racing a switch.
        if (origin === activeSessionId) _pushAssistantNote(QUEUE.failureNote(kind, reason, text));
        else console.warn(`[live] ${kind} for '${origin}' not sent: ${reason}`);
      }
      _dropSending(origin, id);
      return Boolean(e?.timedOut);
    });
    return sent.handedOff ?? sent.then(() => true, () => false);
  }

  /** Remove a "sending" row from its tab, wherever that tab's state lives
   *  now: the live `state` if it is active, its snapshot otherwise — and
   *  both while a switch away from it is under way (the snapshot is taken
   *  before `activeSessionId` moves). */
  function _dropSending(sessionId, id) {
    const without = list => list.filter(s => s.id !== id);
    const snap = sessionSnapshots.get(sessionId);
    if (snap?.queueSending) snap.queueSending = without(snap.queueSending);
    if (sessionId === activeSessionId) {
      state.queueSending = without(state.queueSending);
      notify();
    }
  }

  /** The active tab's process runs another conversation in place: drop the
   *  live transcript, patch the registry entry with `fieldsOf(entry)` and
   *  refetch. `keepTurnOutcome` keeps `lastTurnOk`, which the reset would
   *  otherwise turn into a pass. Shared by `new_session` and branch/fork. */
  function _reloadConversation(fieldsOf, keepTurnOutcome = false) {
    const id = activeSessionId;
    if (id && sessionRegistry.has(id)) {
      const entry = sessionRegistry.get(id);
      sessionRegistry.set(id, { ...entry, ...fieldsOf(entry), conversationVersion: (entry.conversationVersion ?? 0) + 1 });
    }
    const turnOk = lastTurnOk;
    // The process keeps running its extensions, and omp sends no clear on a
    // session change: keep their status lines and widgets, as omp's TUI does.
    const extWidgets = state.extWidgets;
    // The same process can keep its recorder across a conversation change.
    // Stop it rather than silently dropping the only state that exposes it.
    if (state.liveVoice.active) void _liveStop();
    if (state.dictation.active) void _dictationStop();
    _resetSessionVars(true);
    state.liveVoice = LIVE.apply(state.liveVoice, { type: "forget" });
    if (id) respawnVoice.delete(id);
    state.extWidgets = extWidgets;
    if (keepTurnOutcome) lastTurnOk = turnOk;
    _initFetch();
    notify();
  }

  /** The active tab's process moved onto a new session file (`branch` /
   *  `fork`, from `_handleResponse`): reset and refetch as `new_session`
   *  does, but keep the tab's name and rename budget — the conversation is a
   *  copy. omp mints a new session id for the file, so the id the budget is
   *  bound to is dropped (rebound by the next `get_state`, see
   *  `_applyRpcState`) and a pending `/rename` note is released; its
   *  generation belongs to the old session. `sessionFile` is cleared for
   *  `get_state` to refill. The last turn's outcome is kept: the copy ends in
   *  an exchange the tab already ran, and the `lastTurnOk` gate keeps a
   *  branch/fork of a failed turn from spending the auto-rename. */
  function _resetForNewFile() {
    _reloadConversation(() => ({ sessionFile: null, autoRenameSessionId: null, autoRenameInFlight: false }), true);
  }

  /** `branch` / `fork` (`send` runs the RPC); `_handleResponse` has already
   *  moved the transcript (`_resetForNewFile`) by the time it resolves.
   *  Refused here while the tab streams (omp would run it, but the
   *  transcript is mid-turn); omp's own refusals (`session_busy`) arrive as
   *  the rejection's message. `text` is the branched prompt (empty for a fork). */
  async function _moveToNewFile(send) {
    if (state.isStreaming) return { ok: false, error: "Wait for the current turn to finish." };
    let data;
    try {
      data = await send();
    } catch (e) {
      return { ok: false, error: String(e?.message ?? e) };
    }
    if (data?.cancelled) return { ok: false, cancelled: true };
    return { ok: true, text: String(data?.text ?? "") };
  }

  /** `OMP_BRIDGE.send`: the user bubble at once, then `prompt`. A
   *  `streamingBehavior` tells omp what to do if a turn is running by the
   *  time the prompt arrives; idle, omp ignores it and runs the prompt. */
  function _sendPrompt(text, images, streamingBehavior, canSend) {
    state.messages = [...state.messages, { kind: "user", time: timeNow(), text, images: images ?? [] }];
    _disarmAutoRename(text);
    _recordPrompt(text);
    notify();
    if (canSend && !canSend()) return Promise.resolve(false);
    return _send({ type: "prompt", message: text, images: images ?? [], ...(streamingBehavior ? { streamingBehavior } : {}) });
  }

  /** A `goal` command's `{goal, state}` result applied to the active tab. */
  function _applyGoalResult(data) {
    const next = GOAL.fromSnapshot(state.goal, data?.state ?? null);
    if (next !== state.goal) { state.goal = next; notify(); }
  }

  /** `goal pause` / `resume` / `drop` on the active tab → `{ok}` or
   *  `{ok: false, error}`. The `goal_updated` frame omp sends first already
   *  moved the strip; the result is applied for a frame lost to a switch. */
  const GOAL_OPS = new Set(["pause", "resume", "drop"]);
  async function _goalOp(op) {
    if (!GOAL_OPS.has(op)) return { ok: false, error: `unknown goal operation: ${op}` };
    const origin = activeSessionId;
    try {
      const data = await _sendWithResponse({ type: "goal", op }, QUICK_CMD_TIMEOUT_MS);
      if (origin === activeSessionId) _applyGoalResult(data);
      return { ok: true };
    } catch (e) {
      return { ok: false, error: String(e?.message ?? e) };
    }
  }

  // Live voice responses are tied to the process and call that sent them.
  // Invalidate them on stop, terminal event, close, or process replacement.
  function _cancelLiveRequests(reason = "Live voice session ended") {
    ++_liveGen;
    for (const op of [_liveStartPending, _liveStopPending, _liveMutePending]) {
      op?.history?.cancel(reason);
      op?.request?.cancel(reason);
    }
    _liveStartPending = _liveStopPending = _liveMutePending = null;
  }

  function _voiceUpdate(event) {
    const next = LIVE.apply(state.liveVoice, event);
    if (next !== state.liveVoice) { state.liveVoice = next; notify(); }
  }

  function _liveStart() {
    if (!window.__TAURI__ || !activeSessionId || !sessionRegistry.has(activeSessionId)) return Promise.resolve({ ok: false, error: "Not connected" });
    if (_replayBuffer || _switchAwayFrom === activeSessionId || _respawning.has(activeSessionId) || _closingVoiceTabs.has(activeSessionId)) return Promise.resolve({ ok: false, error: "Tab is not ready" });
    if (state.dictation.active || _dictationStopPending) return Promise.resolve({ ok: false, error: "Voice to text is active" });
    if (state.liveVoice.active) {
      if (_liveStartPending && state.liveVoice.phase !== "stopping") return _liveStartPending.promise;
      return Promise.resolve({ ok: false, error: state.liveVoice.phase === "stopping" ? "Live voice is stopping" : "Live voice is already active" });
    }
    if (_liveStopPending) return Promise.resolve({ ok: false, error: "Live voice is stopping" });
    const id = activeSessionId, gen = ++_liveGen, wasPaused = state.liveVoice.paused;
    state.liveVoice = LIVE.apply(state.liveVoice, { type: "start" });
    const op = { history: null, request: null, promise: null, acceptFrames: false };
    _liveStartPending = op;
    op.promise = (async () => {
      try {
        // Fetch omp's raw conversation every time: the desktop transcript can
        // be trimmed or miss activity that happened while this tab was away.
        const data = await (op.history = _sendWithResponse({ type: "get_messages" }, QUICK_CMD_TIMEOUT_MS, "live-history-"));
        if (id !== activeSessionId || gen !== _liveGen || !state.liveVoice.active) return { ok: false, error: "Live voice session ended" };
        if (!Array.isArray(data?.messages)) throw new Error("Invalid conversation history response");
        const instructions = window.OMP_LIVE_CONTEXT.instructions({ messages: data.messages, voice: state.liveVoice.transcripts, project: sessionRegistry.get(id)?.path || "" });
        op.request = _sendWithResponse({ type: "live_start", instructions }, 0);
        await op.request;
        op.acceptFrames = true;
        if (id !== activeSessionId || gen !== _liveGen || !state.liveVoice.active) {
          return { ok: false, error: id === activeSessionId && state.liveVoice.error || "Live voice session ended" };
        }
        return { ok: true };
      } catch (e) {
        const error = String(e?.message ?? e);
        if (id === activeSessionId && gen === _liveGen) _voiceUpdate({ type: "start_failure", error, paused: wasPaused });
        return { ok: false, error: id === activeSessionId && state.liveVoice.error || error };
      } finally {
        if (_liveStartPending === op) _liveStartPending = null;
      }
    })();
    notify();
    return op.promise;
  }

  function _liveStop(paused = false) {
    if (_liveStopPending) return _liveStopPending.promise;
    if (!state.liveVoice.active) {
      if (!paused) _voiceUpdate({ type: "stop" });
      return Promise.resolve({ ok: true });
    }
    const id = activeSessionId;
    const gen = ++_liveGen;
    // Only a native start needs a stop, but wait for its IPC handoff to
    // prevent the stop overtaking it. A history fetch never opens audio.
    const starting = _liveStartPending;
    const startHandoff = starting?.request?.handedOff;
    starting?.history?.cancel("Live voice was stopped");
    starting?.request?.cancel("Live voice was stopped");
    _liveMutePending?.request.cancel("Live voice was stopped");
    state.liveVoice = LIVE.apply(state.liveVoice, { type: "stop" });
    const op = { request: null, promise: null };
    _liveStopPending = op;
    op.promise = (async () => {
      try {
        const sent = await (starting ? startHandoff || false : true);
        if (id !== activeSessionId || gen !== _liveGen) return { ok: false, error: "Live voice session ended" };
        if (sent) {
          op.request = _sendWithResponse({ type: "live_stop" }, QUICK_CMD_TIMEOUT_MS);
          await op.request;
        }
        if (id !== activeSessionId || gen !== _liveGen) return { ok: false, error: "Live voice session ended" };
        _voiceUpdate({ type: "stop_success", paused });
        return { ok: true };
      } catch (e) {
        const error = String(e?.message ?? e);
        if (id === activeSessionId && gen === _liveGen) _voiceUpdate({ type: "stop_failure", error });
        return { ok: false, error };
      } finally {
        if (_liveStopPending === op) _liveStopPending = null;
      }
    })();
    notify();
    return op.promise;
  }

  function _livePause() { return _liveStop(true); }

  function _liveMute(muted) {
    if (typeof muted !== "boolean") return Promise.resolve({ ok: false, error: "Mute requires a boolean" });
    if (!state.liveVoice.active || state.liveVoice.phase === "stopping") return Promise.resolve({ ok: false, error: "No live voice session is active" });
    if (_liveMutePending) {
      return _liveMutePending.muted === muted ? _liveMutePending.promise : Promise.resolve({ ok: false, error: "A mute change is already in progress" });
    }
    const id = activeSessionId;
    const gen = _liveGen;
    const request = _sendWithResponse({ type: "live_mute", muted }, QUICK_CMD_TIMEOUT_MS);
    const op = { request, muted, promise: null };
    _liveMutePending = op;
    op.promise = (async () => {
      try {
        const data = await request;
        if (id !== activeSessionId || gen !== _liveGen || !state.liveVoice.active) return { ok: false, error: "Live voice session ended" };
        _voiceUpdate({ type: "mute_success", muted: data?.muted });
        return { ok: true };
      } catch (e) {
        const error = String(e?.message ?? e);
        if (id === activeSessionId && gen === _liveGen) _voiceUpdate({ type: "mute_failure", error });
        return { ok: false, error };
      } finally {
        if (_liveMutePending === op) _liveMutePending = null;
      }
    })();
    return op.promise;
  }

  function _cancelDictationRequests(reason = "Voice to text ended") {
    ++_dictationGen;
    _dictationStartPending?.request?.cancel(reason);
    _dictationStopPending?.request?.cancel(reason);
    _dictationStartPending = _dictationStopPending = null;
  }

  function _dictationUpdate(event) {
    const next = DICTATION.apply(state.dictation, event);
    if (next !== state.dictation) { state.dictation = next; notify(); }
  }

  // Both the terminal event and the stop response can finish a capture.
  // Only the first transition queues text; replay and late replies are inert.
  function _finishDictation(event) {
    const before = state.dictation;
    const next = DICTATION.apply(before, event);
    if (next === before || next.active) return;
    state.dictation = next;
    if (next.text && sessionRegistry.has(activeSessionId)) {
      _dictationCompleted = [..._dictationCompleted, { sessionId: activeSessionId, captureId: before.captureId, text: next.text }];
    }
    _dictationStartPending?.request?.cancel(next.error || "Voice to text ended");
    notify();
  }

  function _dictationStart() {
    if (!window.__TAURI__ || !activeSessionId || !sessionRegistry.has(activeSessionId)) return Promise.resolve({ ok: false, error: "Not connected" });
    if (_replayBuffer || _switchAwayFrom === activeSessionId || _respawning.has(activeSessionId) || _closingVoiceTabs.has(activeSessionId)) return Promise.resolve({ ok: false, error: "Tab is not ready" });
    if (state.liveVoice.active || _liveStopPending) return Promise.resolve({ ok: false, error: "Live conversation is active" });
    if (state.dictation.active) {
      if (state.dictation.phase === "starting" && _dictationStartPending) return _dictationStartPending.promise;
      return Promise.resolve({ ok: false, error: "Voice to text is already active" });
    }
    if (_dictationStopPending) return Promise.resolve({ ok: false, error: "Voice to text is stopping" });
    const id = activeSessionId, gen = ++_dictationGen, captureId = `capture-${_nextCmdId++}`;
    state.dictation = DICTATION.apply(state.dictation, { type: "start", captureId });
    const request = _sendWithResponse({ type: "dictation_start", captureId }, 0);
    const op = { request, promise: null };
    _dictationStartPending = op;
    op.promise = (async () => {
      try {
        await request;
        if (id !== activeSessionId) return { ok: false, error: "Voice to text ended" };
        if (gen !== _dictationGen) return { ok: true };
        if (!state.dictation.active) return state.dictation.error ? { ok: false, error: state.dictation.error } : { ok: true };
        return { ok: true };
      } catch (e) {
        const error = String(e?.message ?? e);
        if (id === activeSessionId && gen !== _dictationGen) return { ok: true };
        if (id === activeSessionId && !state.dictation.active && !state.dictation.error) return { ok: true };
        if (id === activeSessionId && gen === _dictationGen && state.dictation.active) _finishDictation({ type: "start_failure", error });
        return { ok: false, error: id === activeSessionId && state.dictation.error || error };
      } finally {
        if (_dictationStartPending === op) _dictationStartPending = null;
      }
    })();
    notify();
    return op.promise;
  }

  function _dictationStop() {
    if (_dictationStopPending) return _dictationStopPending.promise;
    if (!state.dictation.active) return Promise.resolve({ ok: true });
    const id = activeSessionId, captureId = state.dictation.captureId, gen = ++_dictationGen;
    const startHandoff = _dictationStartPending?.request.handedOff;
    _dictationStartPending?.request.cancel("Voice to text was stopped");
    state.dictation = DICTATION.apply(state.dictation, { type: "stop" });
    const op = { request: null, promise: null };
    _dictationStopPending = op;
    op.promise = (async () => {
      try {
        const sent = startHandoff ? await startHandoff : true;
        if (id !== activeSessionId || gen !== _dictationGen) return { ok: false, error: "Voice to text ended" };
        if (!state.dictation.active) return { ok: true };
        const data = sent ? await (op.request = _sendWithResponse({ type: "dictation_stop" }, 120000)) : { text: state.dictation.text };
        if (id !== activeSessionId || gen !== _dictationGen) return { ok: false, error: "Voice to text ended" };
        if (state.dictation.active) {
          _finishDictation({ type: "dictation_end", captureId, text: typeof data?.text === "string" ? data.text : state.dictation.text,
            error: typeof data?.text === "string" ? null : "Invalid voice to text response" });
        }
        return { ok: true };
      } catch (e) {
        const error = String(e?.message ?? e);
        if (id === activeSessionId && gen === _dictationGen) {
          if (!state.dictation.active) return { ok: true };
          _dictationUpdate({ type: "stop_failure", error });
        }
        return { ok: false, error };
      } finally {
        if (_dictationStopPending === op) _dictationStopPending = null;
      }
    })();
    notify();
    return op.promise;
  }

  // Both read-only checkout views reject results for a replaced conversation.
  // Capture identity fields by value: registry entries can mutate during IPC.
  async function _readCheckout(sessionId, command) {
    const owner = sessionRegistry.get(sessionId);
    const { path, branch, profile, sessionFile, processStartedAt, conversationVersion } = owner || {};
    const current = () => {
      const entry = sessionRegistry.get(sessionId);
      return !!window.__TAURI__ && !!owner && !!entry && !entry.preparing &&
        !_respawning.has(sessionId) && entry.path === path && entry.branch === branch &&
        entry.profile === profile && entry.sessionFile === sessionFile &&
        entry.processStartedAt === processStartedAt && entry.conversationVersion === conversationVersion;
    };
    if (!current()) return null;
    const result = await window.__TAURI__.core.invoke(command, { sessionId });
    return current() ? result : null;
  }

  // ── OMP_BRIDGE public API ─────────────────────────────────────────────────
  window.OMP_BRIDGE = {
    get isConnected() {
      return !!window.__TAURI__ && !!activeSessionId;
    },
    get activeSessionId() {
      return activeSessionId;
    },
    waitForActivation() {
      return _switchPromise;
    },

    // Native realtime voice is independent of the persisted chat transcript.
    liveStart: _liveStart,
    liveResume: _liveStart,
    livePause: _livePause,
    liveStop: () => _liveStop(),
    liveMute: _liveMute,
    dictationStart: _dictationStart,
    stopActiveVoice() {
      return state.dictation.active || _dictationStopPending
        ? _dictationStop()
        : state.liveVoice.active || _liveStopPending
          ? _livePause()
          : Promise.resolve({ ok: true });
    },
    dictationStop: _dictationStop,
    ackDictation(captureIds) {
      const ids = new Set(captureIds);
      const remaining = _dictationCompleted.filter(
        (item) => !ids.has(item.captureId),
      );
      if (remaining.length !== _dictationCompleted.length) {
        _dictationCompleted = remaining;
        notify();
      }
    },

    // ── Messaging ────────────────────────────────────────────────────────────
    // The bubble shows at once; omp's echo (`message_start`) ties it to the
    // persisted message. A command omp runs locally sends no echo, so its
    // bubble keeps no `ts` and the get_messages merge leaves it in place.
    send(text, images) {
      return _sendPrompt(text, images);
    },
    // Monitoring is read-only. Only the selected, fully settled tab may
    // receive remediation; recheck here after the asynchronous GitHub read.
    prAutomationSnapshot(sessionId) {
      return _readCheckout(sessionId, "pr_automation_snapshot");
    },
    changesSnapshot(sessionId) {
      return _readCheckout(sessionId, "changes_snapshot");
    },
    // true = accepted, false = attempted but refused, null = not attempted.
    async prAutomationSend(sessionId, text, expected, canSend) {
      if (
        expected?.state !== "OPEN" ||
        !expected.url ||
        !expected.branch ||
        !expected.head ||
        typeof canSend !== "function"
      )
        return null;
      const context = sessionContext,
        switchGen = _switchGen;
      const branch = sessionRegistry.get(sessionId)?.branch;
      const current = () =>
        !!window.__TAURI__ &&
        sessionRegistry.has(sessionId) &&
        sessionId === activeSessionId &&
        !_replayBuffer &&
        _switchAwayFrom !== sessionId &&
        !_respawning.has(sessionId) &&
        sessionContext === context &&
        _switchGen === switchGen &&
        sessionRegistry.get(sessionId)?.branch === branch;
      const ready = () => {
        const entry = sessionRegistry.get(sessionId);
        return (
          canSend() &&
          current() &&
          !!entry?.path &&
          !userAbortInFlight &&
          !entry.autoRenameInFlight &&
          state.rpcState?.isSettled === true &&
          runStateCached(state) === "idle" &&
          !state.queueSending.length &&
          !(state.rpcState?.queuedMessageCount > 0) &&
          !state.queue.steering.length &&
          !state.queue.followUp.length &&
          !GOAL.isOpen(state.goal) &&
          !_sessionsView().some(
            (s) =>
              s.id !== sessionId &&
              s.path === entry.path &&
              TURN.isBusyRunState(s.runState),
          )
        );
      };
      if (!ready()) return null;
      // Re-read Rust's current branch/HEAD immediately before the handoff;
      // a displayed snapshot is not permission to fix a different revision.
      let latest;
      try {
        latest = await window.__TAURI__.core.invoke("pr_automation_snapshot", {
          sessionId,
        });
      } catch {
        return null;
      }
      if (
        !ready() ||
        latest?.state !== "OPEN" ||
        latest.url.toLowerCase() !== expected.url.toLowerCase() ||
        latest.branch !== expected.branch ||
        latest.head !== expected.head
      )
        return null;
      return _sendPrompt(text, undefined, undefined, ready);
    },
    // No id on purpose: a pending-id match returns before the command
    // switch, and the abort response is what releases a cancelled
    // auto-rename. See `_releaseAutoRenameAfterAbort`.
    abort() {
      userAbortInFlight = true;
      return _send({ type: "abort" });
    },
    /** Stops omp's automatic retries of the active tab's failed request.
     *  While omp waits between attempts `abort_retry` ends the run on the
     *  last failure and touches nothing else. An attempt already in flight
     *  is beyond it (measured: `abort_retry` is a no-op then and the retries
     *  go on), so that takes `abort`, as Esc does. Resolves to `{ok}` or
     *  `{ok: false, error}`. */
    async stopRetry() {
      const ri = TURN.retryIndex(state.messages);
      if (ri === -1) return { ok: true };
      if (state.messages[ri].phase !== "waiting") {
        this.abort();
        return { ok: true };
      }
      try {
        await _sendWithResponse({ type: "abort_retry" }, QUICK_CMD_TIMEOUT_MS);
        return { ok: true };
      } catch (e) {
        return { ok: false, error: String(e?.message ?? e) };
      }
    },
    // Both route a real slash command — or a skill invocation, even
    // mid-prompt (#30) — through `prompt` with the matching
    // `streamingBehavior` (`OMP_SLASH.queuedFrame`): omp's `steer` /
    // `follow_up` frames skip command and skill dispatch entirely. Browser
    // annotations merged into `text` never change its classification
    // (OMP_BROWSER.annotationText neutralises page data and comments).
    // See `_sendQueued` for how the message shows until omp delivers it.
    followUp(text, images) {
      const imgs = images ?? [];
      const isCmd = isCommandInvocation(state.commands, text);
      return _sendQueued("followUp", text, imgs, () =>
        _sendWithResponse(queuedFrame("followUp", text, imgs, isCmd)),
      );
    },
    steer(text, images) {
      const imgs = images ?? [];
      const isCmd = isCommandInvocation(state.commands, text);
      return _sendQueued("steering", text, imgs, () =>
        _sendWithResponse(queuedFrame("steer", text, imgs, isCmd)),
      );
    },
    /** ✕ / ✎ on a queue-strip row (`queue`: "steering" | "followUp"):
     *  `true` once omp removed the message, `false` when it was no longer
     *  pending — already delivered, or a steer the model already took,
     *  which stays listed until the transcript records it. Rejects only
     *  when the request itself fails. The row goes away with omp's next
     *  `queue_update`, never locally; omp removes the *first* match, and
     *  repeating the call would remove the next duplicate. The default
     *  (long) timeout: a reply held back by a tab switch is replayed on the
     *  way back, and ✎ only restores the text once it is seen. */
    async removeQueuedMessage(text, queue) {
      const data = await _sendWithResponse({
        type: "remove_queued_message",
        message: text,
        queue,
      });
      return data?.removed === true;
    },
    /** ↑ on a follow-up row: move it to the end of the steering queue.
     *  While idle (e.g. after an abort) omp starts a turn with it right
     *  away. Same result contract as `removeQueuedMessage`. */
    async promoteQueuedMessage(text) {
      const data = await _sendWithResponse({
        type: "promote_queued_message",
        message: text,
      });
      return data?.promoted === true;
    },
    /** ⚡ on a queue-strip row (#47): promote a follow-up to a steer, then
     *  the same id-less abort as Esc — omp resumes at once with its steering
     *  queue. No abort when the run already ended, while an abort is in
     *  flight (it would stop the resumed reply), or after a tab switch
     *  during the promote (`_switchGen`); the message then goes at the next
     *  step. Rationale and measured frame order:
     *  docs/architecture/message-queue.md. Same result contract as
     *  `removeQueuedMessage`. */
    async sendQueuedNow(text, queue) {
      const gen = _switchGen;
      if (queue === "followUp" && !(await this.promoteQueuedMessage(text)))
        return false;
      if (_switchGen === gen && state.isStreaming && !userAbortInFlight)
        this.abort();
      return true;
    },
    // ── Goal mode (app/goal.js) ──────────────────────────────────────────────
    /** Starts a goal on the active tab: what the composer sends in goal
     *  mode. `goal create` goes first, so the objective's turn already
     *  carries omp's goal context and goal tool. With auto-continue on
     *  (`goal.continuationModes` holds "rpc") omp then starts a goal turn
     *  by itself; otherwise the objective goes out as the first prompt, as
     *  omp's own `/goal` does — as a steer when a turn is running. Images
     *  ride with it; when omp already started on its own they are steered
     *  in rather than dropped. `prompt` is what that delivery carries
     *  (default: the objective) — the objective with the tab's browser
     *  annotations merged in; the goal itself stores only the typed
     *  `objective`. Resolves `{ok}` or `{ok: false, error}` (omp refuses in
     *  plan mode, with a paused goal…).
     *  A tab switch before the follow-up sends nothing to the other tab:
     *  both requests keep the default timeout, so a reply held back by the
     *  switch is replayed on the way back and the sequence goes on there.
     *  IPC end to end; the decisions are app/goal.js's (`ompStartedTurn`,
     *  test-goal.mjs), the sequence was live-tested against omp 18.6.0. */
    async goalStart(objective, tokenBudget, images, prompt) {
      const text = String(objective ?? "").trim();
      const imgs = images ?? [];
      if (!text) return { ok: false, error: "Describe the goal first." };
      const message = String(prompt ?? "").trim() || text;
      const origin = activeSessionId;
      if (!origin) return { ok: false, error: "Not connected" };
      const wasStreaming = state.isStreaming;
      try {
        const data = await _sendWithResponse({
          type: "goal",
          op: "create",
          objective: text,
          ...(tokenBudget ? { token_budget: tokenBudget } : {}),
        });
        if (origin === activeSessionId) _applyGoalResult(data);
      } catch (e) {
        // No answer is not a refusal: omp may still create the goal, whose
        // frame then shows it in the strip.
        if (e?.timedOut)
          return {
            ok: false,
            error:
              "omp has not answered yet; if the goal starts, it shows here.",
          };
        return { ok: false, error: String(e?.message ?? e) };
      }
      if (origin !== activeSessionId) return { ok: true };
      const bridge = window.OMP_BRIDGE;
      if (wasStreaming) {
        bridge.steer(message, imgs);
        return { ok: true };
      }
      let rpcState = null;
      try {
        rpcState = await _sendWithResponse({ type: "get_state" });
      } catch (e) {
        console.warn(
          "[live] get_state after goal create failed; sending the objective:",
          e,
        );
      }
      if (origin !== activeSessionId) return { ok: true };
      // Nothing started, but omp is not settled either (a background job or
      // queued follow-ups): a turn may begin any moment, so the objective
      // waits in the queue strip instead of as a bubble omp would echo again
      // later. It still goes out as a `prompt`, not a `steer`: only omp's
      // prompt path adds the goal-mode context (objective, budget, when to
      // call it complete) to the turn — an idle steer is drained without it.
      // A turn that started meanwhile takes it as a steer. Settled: the
      // first prompt, with the same `streamingBehavior` fallback. When omp
      // started on its own, the objective is already in the goal: only what
      // it does not carry (images, browser annotations) is steered in.
      if (GOAL.ompStartedTurn(rpcState)) {
        if (imgs.length > 0 || message !== text) bridge.steer(message, imgs);
      } else if (rpcState?.isSettled === false) {
        _sendQueued("steering", message, imgs, () =>
          _sendWithResponse({
            type: "prompt",
            message,
            images: imgs,
            streamingBehavior: "steer",
          }),
        );
      } else _sendPrompt(message, imgs, "steer");
      return { ok: true };
    },
    /** `pause` / `resume` / `drop` the active tab's goal. */
    goalOp(op) {
      return _goalOp(op);
    },
    /** Clears a completed goal's summary from the strip (local only). */
    goalDismiss() {
      const next = GOAL.dismiss(state.goal);
      if (next !== state.goal) {
        state.goal = next;
        notify();
      }
    },
    /** omp's auto-continue setting for `profile` (src-tauri goal_config.rs):
     *  `{ok, value}` (true / false) or `{ok: false, error}` with omp's
     *  reason. The profile is passed explicitly, as for `recentModels`:
     *  during a respawn's detach the active profile is not the tab's. */
    goalContinuation(profile) {
      return _invokeResult("goal_continuation_get", { profile });
    },
    /** Turns it on or off in omp's config for `profile`; running tabs of
     *  that profile pick it up without a restart. Same result shape, with
     *  the setting omp reports afterwards. */
    setGoalContinuation(profile, enabled) {
      return _invokeResult("goal_continuation_set", { profile, enabled });
    },
    /** Manual rename from the tab bar or sidebar (#32): omp's own
     *  `/rename <title>` builtin, so the name is stored as user-set and
     *  survives resume, and — exactly like a typed `/rename` — retires
     *  automatic titling for good. Sent as a plain `prompt`: omp runs a
     *  builtin before its streaming check, so this works mid-turn too.
     *  Unlike a typed one it leaves no trace in the transcript (no user
     *  bubble, no prompt-history entry, confirmation note swallowed); the
     *  tab label updates from `session_info_update`. A background tab is
     *  activated first, since only the active tab's frames are processed.
     *
     *  Not unit-tested as a whole: it is activation, IPC and registry
     *  side effects end to end. The pure parts are (`manualRename`,
     *  `dropPendingNote` in test-session-title.mjs); the rest was
     *  live-tested in the dev app — active and background tab, mid-turn,
     *  persistence across close + resume, a dead process. */
    async renameSession(id, rawTitle) {
      const rename = STITLE.manualRename(rawTitle);
      if (!rename || !sessionRegistry.has(id)) return;
      if (id !== activeSessionId) await window.OMP_BRIDGE.activateSession(id);
      if (id !== activeSessionId || !sessionRegistry.has(id)) {
        console.warn(
          `[live] rename of '${id}' dropped — the tab could not be activated`,
        );
        return;
      }
      _disarmAutoRename(rename.command);
      const entry = sessionRegistry.get(id);
      sessionRegistry.set(id, {
        ...entry,
        renameNotes: [...(entry.renameNotes ?? []), rename.note],
      });
      try {
        await _sendWithResponse(
          { type: "prompt", message: rename.command },
          QUICK_CMD_TIMEOUT_MS,
        );
      } catch (e) {
        if (activeSessionId === id) {
          _pushAssistantNote(`Rename failed: ${e?.message ?? e}`);
          notify();
        }
        // Keep the expectation: the user may have switched away right after
        // the send, and the frames then arrive through journal replay.
        if (e?.timedOut) return;
      }
      // omp prints the note before the response, so on a settled outcome it
      // has been swallowed already if it was printed at all: drop the
      // expectation so a later identical note is not eaten.
      const cur = sessionRegistry.get(id);
      const rest = STITLE.dropPendingNote(cur?.renameNotes, rename.note);
      if (rest) sessionRegistry.set(id, { ...cur, renameNotes: rest });
    },
    setModel(model) {
      _invalidateContext(model);
      _send({ type: "set_model", provider: model.provider, modelId: model.id });
    },
    /** Model keys (`provider/modelId`) `profile` used most recently, newest
     *  first: omp's own MRU table in its `agent.db` (#11), so switches made
     *  in the terminal UI count too. `[]` when unreadable or when `profile`
     *  is no longer listed. The picker passes the profile it tags the
     *  result with: `_activeProfileId()` falls back to the startup profile
     *  while `activeSessionId` is null (a profile respawn's detach), which
     *  would read one profile's list under another's tag. */
    recentModels(profile = _activeProfileId()) {
      return _invokeSafe("model_usage_list", { profile }, []);
    },
    cycleModel() {
      _send({ type: "cycle_model" });
    },
    cycleThinking() {
      _send({ type: "cycle_thinking_level" });
    },
    /** The thinking levels the active tab's model supports, `off` first:
     *  omp's own list, which leaves out its `auto` selector. */
    async thinkingLevels() {
      const data = await _sendWithResponse(
        { type: "get_available_thinking_levels" },
        QUICK_CMD_TIMEOUT_MS,
      );
      return Array.isArray(data?.levels)
        ? data.levels.filter((l) => typeof l === "string")
        : [];
    },
    /** Applies a level from `thinkingLevels()` to the active tab. The
     *  response carries nothing; the level omp applied (it may clamp the
     *  pick) arrives before it, as `thinking_level_changed`. */
    setThinkingLevel(level) {
      return _sendWithResponse(
        { type: "set_thinking_level", level },
        QUICK_CMD_TIMEOUT_MS,
      );
    },
    compact() {
      _invalidateContext(null, true);
      const id = "cmpct-" + _nextCmdId++;
      state.messages = [
        ...state.messages,
        { kind: "compact", status: "pending", id, time: timeNow() },
      ];
      notify();
      _send({ type: "compact", id });
    },
    newSession() {
      _send({ type: "new_session" });
    },
    exportHtml() {
      _send({ type: "export_html" });
    },
    refreshModels() {
      _initFetch();
    },

    // ── Subagent manager ──────────────────────────────────────────────────────

    /** Raise the active process to the "events" subscription while an agent
     *  is inspected (its live stream), back to "progress" otherwise. */
    setSubagentInspecting(on) {
      const next = !!on;
      if (next === subagentInspecting) return;
      subagentInspecting = next;
      _send({
        type: "set_subagent_subscription",
        level: SUB.subscriptionLevelFor({ inspecting: next }),
      });
    },

    /** Fetch (or tail, from the cached byte offset) one agent's persisted
     *  transcript into state.subagentTranscripts[agentId]. Each load carries
     *  a token; a result only lands if its entry is still the one it
     *  created — a tab switch, `new_session` or respawn empties the map, and
     *  a newer load replaces the entry, so stale answers (or timeouts) drop. */
    async loadSubagentTranscript(agentId) {
      const prev = state.subagentTranscripts[agentId];
      if (!activeSessionId || prev?.status === "loading") return;
      const req = ++_transcriptReq;
      const keep = {
        messages: prev?.messages ?? [],
        nextByte: prev?.nextByte ?? 0,
      };
      state.subagentTranscripts = {
        ...state.subagentTranscripts,
        [agentId]: { ...keep, status: "loading", error: null, req },
      };
      notify();
      let entry;
      try {
        const data = await _sendWithResponse({
          type: "get_subagent_messages",
          subagentId: agentId,
          fromByte: keep.nextByte,
        });
        entry = SUB.mergeTranscript(prev ? keep : undefined, data ?? {});
      } catch (e) {
        entry = { ...keep, status: "error", error: String(e?.message ?? e) };
      }
      if (state.subagentTranscripts[agentId]?.req !== req) return;
      state.subagentTranscripts = {
        ...state.subagentTranscripts,
        [agentId]: entry,
      };
      notify();
    },

    /** The inspector's message box: send a running subagent a message as
     *  its user. omp holds the reply until the agent accepted it (queued
     *  into its turn, or a new turn started) and runs slash commands and
     *  prompt templates inside the agent. Rejects with omp's reason
     *  (`Subagent not running: …`, `Subagent refused the message: …`).
     *  The message itself joins the agent's event stream on delivery
     *  (`summarizeEvent`'s `user` line). */
    async steerSubagent(agentId, text) {
      await _sendWithResponse({
        type: "steer_subagent",
        subagentId: agentId,
        message: text,
      });
    },
    /** Hard-stop a running subagent: the parent gets an aborted result for
     *  it and its own turn goes on. `false` when it was no longer running,
     *  so a repeat is harmless; the record ends with omp's `aborted`
     *  lifecycle frame, never locally. */
    async cancelSubagent(agentId) {
      const data = await _sendWithResponse({
        type: "cancel_subagent",
        subagentId: agentId,
      });
      return data?.cancelled === true;
    },

    // ── Login ─────────────────────────────────────────────────────────────────

    /** Returns the list of OAuth providers and their current auth status. */
    getLoginProviders() {
      return _sendWithResponse({ type: "get_login_providers" });
    },

    /**
     * Trigger OAuth login for a provider.
     * Resolves when login completes (omp opens the auth URL via open_url event).
     * Rejects on failure.
     *
     * On success the tab's profile finally has real credentials, so the
     * bootstrap `models.yml` `create_profile` seeded — the one that marks a
     * provider keyless purely so omp's RPC mode would start at all — has
     * done its job and is dropped. Best-effort: a failed login leaves the
     * profile able to boot and try again, the backend no-ops unless the file
     * is still byte-identical to the seed, and for the built-in profile
     * (never seeded) entirely.
     *
     * The profile is read from the registry entry and captured *before* the
     * await, for two reasons. `_activeProfileId()` is the wrong question: it
     * falls back to the ticked startup default for an id no longer in the
     * catalogue, which is right for "where should a new tab go" and wrong for
     * "whose seed may be dropped" — a second window's `delete_profile` passes
     * its own in-use guard and staleness here would then delete an
     * untouched, still-unauthenticated profile's seed, leaving it unable to
     * boot. And OAuth can take up to 300 s, so reading either value
     * afterwards would describe whatever tab the user has since selected
     * rather than the process that was just authenticated.
     *
     * Side-effectful (IPC plus a filesystem mutation in the backend), so not
     * unit-tested directly; there is no fake `__TAURI__` harness in this repo.
     * @param {string} providerId
     */
    async login(providerId) {
      const seededProfile = sessionRegistry.get(activeSessionId)?.profile;
      const res = await _sendWithResponse(
        { type: "login", providerId },
        300000,
      );
      if (seededProfile) {
        await _invokeSafe(
          "clear_profile_bootstrap",
          { id: seededProfile },
          null,
        );
      }
      return res;
    },

    /**
     * Respond to a pending select/input/editor bubble. Only an open request
     * from this tab's current process may be sent; duplicate clicks are
     * suppressed while the pipe write is in flight. Success settles the
     * bubble, while a rejected write leaves it open with an error.
     * @param {string} id     The extension_ui_request id.
     * @param {string} value  The chosen option text, or the typed text of an
     *                        input/editor prompt.
     */
    answerAsk(id, value) {
      return _resolveAsk(id, { answered: true, answer: value }, { value });
    },

    /**
     * Answer omp's ask dialog (extension_ui_request method=ask) with the
     * `answers` OMP_ASK_DIALOG.answers built — one per question, in request
     * order. Same re-answer guard as `answerAsk`; the settled bubble keeps
     * them for its summary.
     * @param {string} id
     * @param {Array<{id: string, selectedOptions: string[], customInput?: string}>} answers
     */
    answerAskDialog(id, answers) {
      return _resolveAsk(id, { answered: true, answers }, { answers });
    },

    /**
     * Respond to a pending confirm dialog (extension_ui_request
     * method=confirm). Wire shape differs from `answerAsk`: the runtime
     * expects `{confirmed: bool}`, not `{value}` — confirmed against the
     * installed omp binary's own request/response construction. Same
     * re-answer-proof guard as `answerAsk`. Request/response wire shapes
     * for all four methods (select/confirm/editor/input) proven with an
     * eval-kernel cell (9/9 cases).
     * @param {string}  id
     * @param {boolean} confirmed
     */
    answerConfirm(id, confirmed) {
      return _resolveAsk(
        id,
        { answered: true, answer: confirmed ? "Confirm" : "Deny" },
        { confirmed },
      );
    },

    /**
     * User-initiated decline of a pending ask (the Cancel button on an
     * `input`/`editor` prompt or the ask dialog) — distinct from the runtime's own
     * `extension_ui_request.cancel` event, but resolved the same way on
     * both the local message (marked `cancelled`) and the wire
     * (`{cancelled: true}`). Same re-answer-proof guard as `answerAsk`.
     * @param {string} id
     */
    cancelAsk(id) {
      return _resolveAsk(id, { cancelled: true }, { cancelled: true });
    },

    /**
     * Push a system-generated assistant message into the session message log.
     * Writes to state.messages (not just React state) so it survives subsequent
     * notify() calls from live event processing (e.g. model registry refresh).
     * @param {string} text  Markdown text.
     */
    addAssistantMessage(text) {
      state.messages = [
        ...state.messages,
        {
          kind: "assistant",
          time: timeNow(),
          model: state.model?.name ?? null,
          blocks: [{ type: "text", text }],
          thought: null,
          lead: null,
          streaming: false,
          completed: true,
        },
      ];
      notify();
    },

    // ── Tool-approval rules ──────────────────────────────────────────────────
    // Backed by src-tauri/src/approval.rs::RuleBook. A rule only ever
    // auto-answers "Approve" for an exact "Allow tool: X" prompt shape —
    // see the module doc comment there. Session scope is in-memory (dies
    // with the tab's omp process); project scope persists to disk keyed by
    // a hash of the project path — for a grant, the folder of the process
    // that asked; list and revoke use the active tab's.

    /** Answer this process's open approval and grant its tool in one call.
     *  Keep it pending while Rust writes; a native cancel or process exit
     *  wins over any late completion. Never fall back to a plain approval
     *  when the grant call rejects. */
    async approveAndRemember(prompt, scope) {
      const sessionId = prompt?.sessionId;
      if (!sessionId || sessionId !== activeSessionId || !prompt.id) return;
      const msg = state.messages.find(m => m.kind === "ask" && m.id === prompt.id &&
        !m.recovery && !m.answered && !m.cancelled);
      if (!msg) return;
      const send = _beginAskSend(msg);
      if (!send) return;
      const res = await _invokeResult("approval_approve_and_grant", {
        sessionId, requestId: prompt.id, scope,
      });
      if (!res.ok) {
        send.finish({ sendError: `Approve and remember failed: ${res.error}` }, true);
        return;
      }
      _rememberSettledAsk(send.owner, prompt.id);
      send.finish({
        answered: true, answer: "Approve",
        sendError: res.value ? `Approved, but the rule was not saved: ${res.value}` : null,
      });
    },

    /** Revoke a previously granted rule. No-op if it wasn't granted. */
    async revokeApprovalRule(tool, scope) {
      if (!activeSessionId) return;
      await _invokeSafe("approval_rules_revoke", {
        sessionId: activeSessionId,
        projectRoot: _activeProjectPath(),
        tool,
        scope,
      });
    },

    /** List rules currently in effect for the active session/project. */
    async listApprovalRules() {
      if (!activeSessionId) return [];
      const rules = await _invokeSafe(
        "approval_rules_list",
        {
          sessionId: activeSessionId,
          projectRoot: _activeProjectPath(),
        },
        [],
      );
      return rules || [];
    },

    // ── Git browser + working-tree actions (active tab's project) ───────────
    // Reads are src-tauri/src/git_browser/ (gix, bounded server-side — see
    // that module for the caps); stage/discard are workspace.rs. The reads
    // resolve to `{ok: true, value}` or `{ok: false, error}` so the overlay
    // can show why (e.g. not a git repository); no project → null.

    /** Tree with git status marks, repo/branch info: `StatusView`. */
    gitBrowserStatus() {
      return _gitBrowserInvoke("git_browser_status", {});
    },

    /** One working-tree file with its change against HEAD inline: `FileView`.
     *  `relPath` may be absolute inside the project (an edit card's target). */
    gitBrowserFile(relPath) {
      return _gitBrowserInvoke("git_browser_file", { relPath });
    },

    /** Commit graph of every ref plus the working-tree row: `LogView`. */
    gitBrowserLog() {
      return _gitBrowserInvoke("git_browser_log", {});
    },

    /** One commit and the files it touched: `CommitView`. */
    gitBrowserCommit(sha) {
      return _gitBrowserInvoke("git_browser_commit", { sha });
    },

    /** A file as of commit `sha` with that commit's change inline: `FileView`. */
    gitBrowserCommitFile(sha, relPath) {
      return _gitBrowserInvoke("git_browser_commit_file", { sha, relPath });
    },

    /** A file of the active tab's project for the preview (issue #39):
     *  `FilePreview` from src-tauri/src/project_file.rs, as `{ok, value |
     *  error}`; null with no tab. Rust takes the folder from the tab, so only
     *  the tab id and the path cross. `path` may be absolute inside it. */
    readProjectFile(path) {
      if (!activeSessionId) return Promise.resolve(null);
      return _invokeResult("project_file_read", {
        sessionId: activeSessionId,
        path,
      });
    },

    /** Read only a skill in this process's native catalog; never an agent prompt. */
    readContextSkill(agentId, name) {
      if (!activeSessionId) return Promise.resolve({ ok: false, error: "No tab is open." });
      return _invokeResult("agent_context_read_skill", { sessionId: activeSessionId, agentId, name });
    },
    readContextPolicy() {
      return _contextPolicyController().load();
    },
    setContextPolicy(input) {
      return _contextPolicyController().apply(input);
    },

    /** Stage a file's changes (`git add`). */
    async workspaceAccept(relPath) {
      const path = _activeProjectPath();
      if (!path) return;
      await _invokeSafe("workspace_accept", { path, relPath });
    },

    /** Discard a file's working-tree changes (deletes it if untracked —
     *  see workspace.rs::reject's doc comment for the destructive case). */
    async workspaceReject(relPath) {
      const path = _activeProjectPath();
      if (!path) return;
      await _invokeSafe("workspace_reject", { path, relPath });
    },

    // ── Rail widget plugins (src-tauri/src/widgets/, docs/widgets.md) ─────
    // Rust owns config, approval, triggers and scheduling; the webview only
    // reports its view and renders snapshots and events. These are thin
    // invoke/listen wrappers, too side-effectful to test here: the behaviour
    // behind them is covered by the Rust widget tests and the live test.
    /** `WidgetsSnapshot`; a rejected invoke is surfaced as `fatal`, browser
     *  mode (no Tauri) gets an empty one. */
    async widgetsState() {
      return _widgetsSnapshot("widgets_state");
    },
    /** Re-read widgets.json (the only time it is read besides startup). */
    async widgetsReload() {
      return _widgetsSnapshot("widgets_reload");
    },
    /** Approve `pluginId` at the exact `fingerprint` its approval card
     *  showed. `{ok: true, value: snapshot}` or `{ok: false, error}` (stale
     *  card: the command or script changed since it was rendered). */
    widgetsApprove(pluginId, fingerprint) {
      return _invokeResult("widgets_approve", { pluginId, fingerprint });
    },
    /** `{ sessionId, railVisible, windowVisible, hidden }` — what the
     *  scheduler may run for; sent by app/use-widgets.jsx on change only. */
    async widgetsSetView(view) {
      await _invokeSafe("widgets_set_view", { view });
    },
    /** Manual run of one plugin for the active tab (card refresh button). */
    async widgetsRefresh(pluginId) {
      await _invokeSafe("widgets_refresh", { pluginId });
    },
    /** Listen to the `widgets://` events; `handler(kind, payload)` with
     *  kind "config" (snapshot), "run" (RunView), "removed" ({key,
     *  pluginId}) or "active" ({sessionId, applicable}). Resolves once every
     *  listener is attached — fetch `widgetsState()` after that so no event
     *  falls between the two — to an unlisten for all of them. */
    async onWidgetsEvent(handler) {
      if (!window.__TAURI__) return () => {};
      const unlistens = await Promise.all(
        ["config", "run", "removed", "active"].map((kind) =>
          window.__TAURI__.event
            .listen(`widgets://${kind}`, (ev) => handler(kind, ev.payload))
            .catch((err) => {
              console.error(`[live] widgets://${kind} listener failed:`, err);
              return null;
            }),
        ),
      );
      return () => {
        for (const u of unlistens) u?.();
      };
    },

    // ── Phone remote access ──────────────────────────────────────────────
    // Quiet IPC: missing optional remote commands must not log per publish.
    // Reads return data/null; mutations return {ok, value | error}.
    async remoteStatus() {
      const r = await _invokeResult("remote_status");
      return r.ok ? r.value : null;
    },
    async remoteInterfaces() {
      const r = await _invokeResult("remote_interfaces");
      return r.ok ? r.value : null;
    },
    remoteApply(settings) {
      return _invokeResult("remote_apply_settings", { settings });
    },
    remotePairStart() {
      return _invokeResult("remote_pair_start");
    },
    remotePairCancel() {
      return _invokeResult("remote_pair_cancel");
    },
    remoteDeviceRename(id, name) {
      return _invokeResult("remote_device_rename", { id, name });
    },
    remoteDeviceRevoke(id) {
      return _invokeResult("remote_device_revoke", { id });
    },
    remoteRegenerateCert() {
      return _invokeResult("remote_regenerate_cert");
    },
    remotePushTest() {
      return _invokeResult("remote_push_test");
    },
    async remoteDefaultContact() {
      const r = await _invokeResult("remote_default_contact");
      return r.ok ? r.value : null;
    },
    remotePublish(payload) {
      return _invokeResult("remote_publish", { payload });
    },
    remoteActionResult(reqId, ok, error) {
      return _invokeResult("remote_action_result", { reqId, ok, error });
    },
    remoteReady(ready) {
      return _invokeResult("remote_ready", { ready });
    },
    /** Resolves to an unlisten; callbacks receive payloads only. */
    async onRemoteEvent(kind, cb) {
      if (!window.__TAURI__ || !["watch", "action", "status"].includes(kind))
        return () => {};
      try {
        return await window.__TAURI__.event.listen(`remote://${kind}`, (ev) =>
          cb(ev.payload),
        );
      } catch {
        return () => {};
      }
    },

    // ── Terminal (src-tauri/src/terminal/, one shell per tab) ────────────────
    // IPC glue only: Rust owns the tab's shell, its folder, the shell setting
    // and the output ring (docs/architecture/terminal.md). No fake
    // `__TAURI__` harness exists to unit-test this against (see the note at
    // `login`); the backend's own tests cover the commands and events, the
    // view state lives in app/terminal.js (test-terminal.mjs).

    /** Start the tab's shell (Rust picks the folder and the shell) at `cols`
     *  x `rows`; a live or starting shell is returned as is. Resolves
     *  `{ ok: true, status }` (Rust's `TerminalStatus`) or `{ ok: false, error }`. */
    async terminalOpen(sessionId, cols, rows) {
      const res = await _invokeResult("terminal_open", {
        sessionId,
        cols,
        rows,
      });
      return res.ok ? { ok: true, status: res.value } : res;
    },

    /** The tab's shell as Rust sees it — `{ instance, shell, state,
     *  exitCode }` — or `null` when none was started (or no Tauri). */
    terminalStatus(sessionId) {
      return _invokeSafe("terminal_status", { sessionId }, null);
    },

    /** Output of the tab's shell held by Rust after `afterSeq` (0 = all):
     *  `{ instance, bytes, headSeq, dropped }`, or `null` without a shell.
     *  `instance` is the current one even when `instance` asked for an older
     *  shell (then everything is replayed). */
    async terminalReplay(sessionId, instance, afterSeq) {
      const r = await _invokeSafe(
        "terminal_replay",
        { sessionId, instance, afterSeq },
        null,
      );
      if (!r) return null;
      return {
        instance: r.instance,
        bytes: _b64Bytes(r.b64),
        headSeq: r.headSeq,
        dropped: r.dropped,
      };
    },

    /** `n` bytes of `instance`'s output were rendered (flow control). */
    terminalAck(sessionId, instance, n) {
      return _invokeSafe("terminal_ack", { sessionId, instance, bytes: n });
    },

    /** Send keystrokes (a string, as xterm's `onData` emits it) to the shell. */
    terminalWrite(sessionId, data) {
      return _invokeSafe("terminal_write", { sessionId, data });
    },

    terminalResize(sessionId, cols, rows) {
      return _invokeSafe("terminal_resize", { sessionId, cols, rows });
    },

    /** Shell output: `cb({ instance, seq, bytes })` per chunk, bytes as the
     *  pty produced them (feed straight to `Terminal.write`, which
     *  reassembles split UTF-8). Returns `{ stop, ready }`. */
    onTerminalData(sessionId, cb) {
      return _listen(`terminal://data/${sessionId}`, (p) =>
        cb({ instance: p.instance, seq: p.seq, bytes: _b64Bytes(p.b64) }),
      );
    },

    /** A shell exited: `cb({ instance, code })`, `code` null when a signal
     *  killed it. Returns `{ stop, ready }`. */
    onTerminalExit(sessionId, cb) {
      return _listen(`terminal://exit/${sessionId}`, (p) =>
        cb({ instance: p.instance, code: p.code ?? null }),
      );
    },

    /** The saved shell setting: `{ shell, defaultShell, shells }` (`shell`
     *  "" = the default, `defaultShell` = what that runs, `shells` = the
     *  installed `{ name, path }` the menu offers); `null` without Tauri or
     *  when Rust refused. */
    terminalSettings() {
      return _invokeSafe("terminal_settings", {}, null);
    },

    /** Save the shell for new terminals ("" = default). Rust validates and
     *  persists it: `{ ok: true, settings }` or `{ ok: false, error }`. */
    async setTerminalShell(shell) {
      const res = await _invokeResult("terminal_set_shell", {
        shell: typeof shell === "string" ? shell : "",
      });
      return res.ok ? { ok: true, settings: res.value } : res;
    },

    /** "other…": Rust opens the native file dialog and stores the program
     *  picked. `{ ok: true, settings }` (`settings` null = cancelled) or
     *  `{ ok: false, error }`. */
    async pickTerminalShell() {
      const res = await _invokeResult("terminal_pick_shell", {});
      return res.ok ? { ok: true, settings: res.value ?? null } : res;
    },

    /** The saved Chromium setting for the browser panel: `{ path,
     *  automatic, installed, error }` (`path` "" = automatic, `automatic` =
     *  what auto-detection finds now, `installed` = the browsers the menu
     *  offers, `error` = why the stored path no longer works); `null`
     *  without Tauri or when Rust refused. Rust reads it at each launch. */
    browserSettings() {
      return _invokeSafe("browser_settings", {}, null);
    },

    /** Save the Chromium path ("" = automatic). Rust validates and persists
     *  it: `{ ok: true, settings }` or `{ ok: false, error }`. */
    async browserSetPath(path) {
      const res = await _invokeResult("browser_set_path", {
        path: typeof path === "string" ? path : "",
      });
      return res.ok ? { ok: true, settings: res.value } : res;
    },

    /** "other…": Rust opens the native file dialog and stores the browser
     *  picked. `{ ok: true, settings }` (`settings` null = cancelled) or
     *  `{ ok: false, error }`. */
    async browserPickPath() {
      const res = await _invokeResult("browser_pick_path", {});
      return res.ok ? { ok: true, settings: res.value ?? null } : res;
    },

    // ── Browser panel (src-tauri/src/browser/commands.rs) ──────────────────
    // IPC glue only: Rust owns Chromium, the views, the screencast's flow
    // control and the annotation overlay (docs/architecture/browser.md).
    // No fake `__TAURI__` harness exists to unit-test this against (see the
    // note at `login`); the backend's own tests cover the commands and the
    // channel messages (src-tauri/src/browser/view/tests.rs,
    // annotate/tests.rs), and tests/test-browser-runtime.mjs runs the
    // consumers (app/use-browser.jsx, app/browser-screen.js) against a stub
    // of these methods.
    // Sizes are CSS pixels (integers); `dpr` scales the screencast.
    /** `onMessage` gets everything the view reports during this open, in
     *  order, over one channel (docs/architecture/browser.md): a frame as an
     *  `ArrayBuffer` (OMP_BROWSER.parseFrame), else `{ type, value }` with
     *  type `state` | `tabs` | `pick`. It is attached before the open is
     *  sent, so the backend's first `state` (during the open) arrives too;
     *  a later open (restart) replaces the channel. */
    browserOpenPanel(sid, width, height, dpr, onMessage) {
      const events = window.__TAURI__
        ? new window.__TAURI__.core.Channel()
        : null;
      if (events) events.onmessage = onMessage;
      return _invokeSafe("browser_open_panel", {
        sessionId: sid,
        width,
        height,
        dpr,
        events,
      });
    },
    /** Stops the screencast; Chromium stays. Best effort: after the tab's
     *  release there is no browser left to close, which is not an error. */
    browserClosePanel(sid) {
      return _invokeResult("browser_close_panel", { sessionId: sid });
    },
    browserResize(sid, width, height, dpr) {
      return _invokeSafe("browser_resize", {
        sessionId: sid,
        width,
        height,
        dpr,
      });
    },
    /** `{ok}` | `{ok: false, error}` — a refused load (connection refused …)
     *  is the user's page, not a bridge fault, so nothing is logged. */
    browserNavigate(sid, url) {
      return _invokeResult("browser_navigate", { sessionId: sid, url });
    },
    browserHistory(sid, delta) {
      return _invokeSafe("browser_history", { sessionId: sid, delta });
    },
    browserTabNew(sid) {
      return _invokeSafe("browser_tab_new", { sessionId: sid });
    },
    browserTabClose(sid, targetId) {
      return _invokeSafe("browser_tab_close", { sessionId: sid, targetId });
    },
    browserTabActivate(sid, targetId) {
      return _invokeSafe("browser_tab_activate", { sessionId: sid, targetId });
    },
    /** Pointer / wheel / key event for the page (`InputEvent`, see
     *  app/browser.js), sent at event rate: `{ok}` | `{ok: false, error}`.
     *  The backend refuses while no page is shown; the panel decides what
     *  to log (app/use-browser.jsx). */
    browserInput(sid, event) {
      return _invokeResult("browser_input", { sessionId: sid, event });
    },
    /** Frame `seq` of the panel channel was painted or dropped as
     *  superseded: Rust sends the next one (one frame in flight per view).
     *  Quiet — the panel closing is not a fault, and Rust's own timeout
     *  covers a lost ack. */
    browserFrameAck(sid, seq) {
      return _invokeResult("browser_frame_ack", { sessionId: sid, seq });
    },
    browserAnnotate(sid, on) {
      return _invokeSafe("browser_annotate", { sessionId: sid, on });
    },
    /** Scrolls the current page so the picked document `rect`
     *  (absolute page CSS px) is visible, regardless of subsequent scrolls.
     *  Quiet on purpose: the chip click is a convenience, and a refused
     *  scroll (the panel closed, the page moved) is not a bridge fault. */
    browserScrollTo(sid, rect) {
      return _invokeResult("browser_scroll_to", { sessionId: sid, rect });
    },
    /** Area screenshot of `rect` (page CSS px): `{ok, value: {data, mimeType}}`
     *  with base64 `data`, or `{ok: false, error}`. */
    browserCapture(sid, rect) {
      return _invokeResult("browser_capture", { sessionId: sid, rect });
    },

    /** Usage statistics for the active tab's profile — see usage_stats in
     *  lib.rs / stats.rs::fetch. Unlike the workspace methods above, this
     *  is not scoped to the active tab's *project*, but it IS scoped to
     *  its *profile*: `omp stats` itself resolves against one profile
     *  per invocation (same as every other per-tab omp spawn), so a tab
     *  running under a named profile sees that profile's own usage, not
     *  a merge across every profile. Also not all-time — the installed
     *  omp CLI's `--json` path has no way to request more than a rolling
     *  last-24-hours window (see stats.rs's module doc).
     *  Uses `_invokeResult` (not `_invokeSafe`) because "no usage in the
     *  window yet" and "the backend call failed" (omp not on PATH, an
     *  omp build old enough to predate the `stats` subcommand, a sync
     *  error) need distinct panel messages — a swallowed rejection would
     *  look identical to a profile with genuinely zero recent usage. */
    async usageStats() {
      return _invokeResult("usage_stats", { profile: _activeProfileId() });
    },

    // ── Session management ───────────────────────────────────────────────────

    /** Open a new tab for the given project folder, under the *active tab's*
     *  profile: opening a second folder while working in "work" almost
     *  always means another work tab, and the selector makes switching it
     *  explicit. With no tab open there is nothing to inherit, so the ticked
     *  default profile applies. Returns the new session id, or rejects if
     *  the resolved profile no longer exists on the backend (unlisted by
     *  another window, or a hand-edited profiles.json) or omp refuses to
     *  start — no tab is left registered, and a note says why.
     *
     *  `profile` overrides the inherited one — "new conversation in this
     *  project" passes the project's own profile, which need not be the
     *  active tab's. Always spawns: `+`/`Ctrl+T` mean a *new* tab. */
    openSession(cwd, profile = _activeProfileId()) {
      return _requestConversationSetup(cwd, profile);
    },

    configureProjectWorkspace(path, profile = _activeProfileId()) {
      return _requestConversationSetup(path, profile, true);
    },

    inspectConversationWorkspace(path, profile = _activeProfileId()) {
      return _invokeResult("conversation_workspace_inspect", { path, profile });
    },

    conversationWorkspaceStatus(path) {
      return _invokeResult("conversation_workspace_status", { path });
    },

    setProjectWorkspaceDefaults(path, profile, { baseRef, worktree }) {
      return _invokeResult("conversation_workspace_defaults_set", {
        path,
        profile,
        baseRef,
        worktree,
      });
    },

    async startConversationSetup(requestId, workspace) {
      const request = conversationSetups[0];
      if (!request || request.view.id !== requestId)
        return { ok: false, error: "Conversation setup is no longer open" };
      if (request.view.configure)
        return {
          ok: false,
          error: "Save project defaults without starting a conversation",
        };
      if (request.busy)
        return { ok: false, error: "Conversation is already starting" };
      request.busy = true;
      try {
        const id = await _startProjectSession(request.view.path, {
          profile: request.view.profile,
          workspace,
        });
        conversationSetups.shift();
        request.resolve(id);
        notify();
        return { ok: true };
      } catch (error) {
        request.busy = false;
        return { ok: false, error: String(error?.message ?? error) };
      }
    },

    cancelConversationSetup(requestId) {
      const request = conversationSetups[0];
      if (!request || request.view.id !== requestId || request.busy)
        return false;
      conversationSetups.shift();
      request.resolve(null);
      notify();
      return true;
    },

    /** Open project folder `path` (a recent-projects row) under the active
     *  profile: focus an open tab on it when there is one — the active tab
     *  if it qualifies, else the newest — and spawn a tab only otherwise.
     *  Resolves to the tab id; rejects like `openSession` on a failed spawn.
     *  The lookup is `findProjectTab`, proven by `test-project-nav.mjs`. */
    async openProject(path) {
      const profile = _activeProfileId();
      const id = window.OMP_PROJECT_NAV.findProjectTab(
        [...sessionRegistry.values()],
        path,
        profile,
        activeSessionId,
      );
      if (id) {
        await window.OMP_BRIDGE.activateSession(id);
        return id;
      }
      return _requestConversationSetup(path, profile);
    },

    /** Drop `path` from the active profile's recent projects. */
    async forgetRecentProject(path) {
      await _recentsCall("recent_projects_remove", {
        path,
        profile: _activeProfileId(),
      });
    },

    /** Switch the active tab. Resets state and re-fetches from the session's omp. */
    async activateSession(id) {
      if (id === activeSessionId) return;
      if (!sessionRegistry.has(id)) return;
      // A respawn for this tab is still in flight (see `_respawnSession`):
      // the session doesn't exist on the backend yet (start_session hasn't
      // resolved), so listen/replay_events/get_state would all target an id
      // nothing is listening on. Drop the click — `_respawnSession`'s own
      // reclaim logic re-activates this tab once the respawn resolves (or,
      // if the user is on a different tab by then, it simply stays
      // backgrounded like any other tab). Chosen over relaxing the
      // `wasActive && activeSessionId === null` reclaim test, which would
      // let this call and the in-flight respawn's own reclaim both call
      // _switchToSession(id) for the same tab.
      if (_respawning.has(id)) {
        console.warn(
          `[live] ignoring activateSession('${id}') — respawn in flight`,
        );
        return;
      }
      await _switchToSession(id);
    },

    /** List saved sessions on disk for the active tab's profile
     *  (`~/.omp/agent/sessions`, or `~/.omp/profiles/<id>/agent/sessions`).
     *  Scoping to the tab's own profile is required, not cosmetic: a resume
     *  path is validated server-side against that profile's sessions root,
     *  so listing another profile's history here would offer entries this
     *  tab cannot resume. */
    async listSavedSessions(cwd = null) {
      const sessions = await _invokeSafe(
        "list_saved_sessions",
        {
          cwd: cwd || null,
          profile: _activeProfileId(),
        },
        [],
      );
      return sessions || [];
    },

    /** Return the full keybinding payload for the active tab's profile.
     *  Resolves to the `Payload` struct or `null` on error (network or
     *  corrupt overlay — the frontend falls back to omp + registry defaults). */
    async listKeybindings() {
      return _invokeSafe(
        "keybindings_list",
        { profile: _activeProfileId() },
        null,
      );
    },

    /** Bind `action` to `keys` in the desktop overlay. Resolves to
     *  `{ok:true, value: Payload}` or `{ok:false, error: string}`. */
    async setKeybinding(action, keys) {
      return _invokeResult("keybindings_set", {
        action,
        keys,
        profile: _activeProfileId(),
      });
    },

    /** Remove `action` from the desktop overlay (reset to omp/default).
     *  Resolves to `{ok:true, value: Payload}` or `{ok:false, error: string}`. */
    async resetKeybinding(action) {
      return _invokeResult("keybindings_reset", {
        action,
        profile: _activeProfileId(),
      });
    },

    /** Resume a saved session under the active tab's profile (the profile
     *  whose sessions directory the entry was listed from). A tab already
     *  running that conversation in this profile is focused instead of
     *  spawning a second process onto the same `.jsonl`. Returns the tab id,
     *  null if `session` doesn't reference a valid saved-session path, or
     *  rejects if the resolved profile no longer exists on the backend (see
     *  `openSession`). The lookup is `findConversationTab`, proven by
     *  `test-project-nav.mjs`. */
    async resumeSession(session) {
      if (!session || !session.path) return null;
      const profile = _activeProfileId();
      const open = window.OMP_PROJECT_NAV.findConversationTab(
        [...sessionRegistry.values()],
        session.path,
        profile,
      );
      if (open) {
        await window.OMP_BRIDGE.activateSession(open);
        return open;
      }
      const workspaceBinding = await _recoverWorkspaceBinding(
        session.cwd || "",
        profile,
      );
      // Metadata recovery yields, so another resume may have registered this file.
      const resumed = window.OMP_PROJECT_NAV.findConversationTab(
        [...sessionRegistry.values()],
        session.path,
        profile,
      );
      if (resumed) {
        await window.OMP_BRIDGE.activateSession(resumed);
        return resumed;
      }
      const generated =
        workspaceBinding?.worktree &&
        session.title === _tabNameFor(session.cwd, "");
      return _openReported(session.cwd || "", {
        resume: session.path,
        name: generated ? null : session.title,
        profile,
        workspaceBinding,
      });
    },

    // ── Conversation tree (prompt-cache navigator) ───────────────────────────

    /** The conversation family of `sessionFile` (`conversation_tree`, see
     *  src-tauri/src/conversation_tree/) under `profile`. Both come from the
     *  caller, so the request matches the key its result is tagged with —
     *  never `_activeProfileId()`, see `recentModels`. Resolves to
     *  `{ok: true, value}` or `{ok: false, error}`. */
    conversationTree(sessionFile, profile) {
      return _invokeResult("conversation_tree", { sessionFile, profile });
    },
    /** Re-ask a user prompt of this tab's file: omp copies the path before it
     *  into a new session file and the process moves there. Resolves to
     *  `{ok: true, text}` (the prompt, for the composer),
     *  `{ok: false, cancelled: true}` or `{ok: false, error}`. */
    branchAt(entryId) {
      return _moveToNewFile(() =>
        _sendWithResponse({ type: "branch", entryId }),
      );
    },
    /** Continue after a message (a turn's last reply): same move as
     *  `branchAt`, nothing to re-ask. omp refuses (`session_busy`) unless idle. */
    forkAt(entryId) {
      return _moveToNewFile(() => _sendWithResponse({ type: "fork", entryId }));
    },

    // ── Profiles ─────────────────────────────────────────────────────────────
    // One omp process per tab means the profile is a per-tab property: see
    // src-tauri/src/profiles.rs for the id/name split (ids are immutable and
    // name omp's data directory; names are free-form labels).

    /** Create a profile labelled `name` (id derivation and validation are
     *  server-side). Resolves to `{ok, value: {id, name}}` or `{ok: false, error}`. */
    async createProfile(name) {
      const res = await _invokeResult("create_profile", { name });
      if (res.ok) await _refreshProfiles();
      return res;
    },

    /** Rename a profile — label only; the id (omp's data directory) is
     *  immutable. Resolves to `{ok, value}` or `{ok: false, error}`. */
    async renameProfile(id, name) {
      const res = await _invokeResult("rename_profile", { id, name });
      if (res.ok) await _refreshProfiles();
      return res;
    },

    /** Unlist a profile (the backend leaves `~/.omp/profiles/<id>/` on disk
     *  and refuses the built-in one). Refused here while any open tab still
     *  runs under it: silently respawning that tab would drop its transcript
     *  unasked. Resolves to `{ok}` or `{ok: false, error}`. */
    async deleteProfile(id) {
      const reason = _profilesInUse(id, [...sessionRegistry.values()]);
      if (reason) return { ok: false, error: reason };
      const res = await _invokeResult("delete_profile", { id });
      if (!res.ok) return res;
      await _refreshProfiles();
      // Check-then-act: `openSession` can register a new tab under `id`
      // during the round-trip above (a tab opened with no tab to inherit
      // from takes `startupProfileId`, and the backend's own fallback of
      // the pointer to the built-in id is only mirrored into
      // `startupProfileId` by the `_refreshProfiles()` call just above —
      // before that resolved, `id` still looked like a valid destination).
      // The unlist already committed server-side either way, so this can
      // only warn, not undo it.
      const raced = _profilesInUse(id, [...sessionRegistry.values()]);
      if (raced)
        console.warn(
          `[live] deleteProfile('${id}') raced with a new tab: ${raced}`,
        );
      return res;
    },

    /** Tick a profile as the default: which profile the next launch — and any
     *  new tab opened with no tab to inherit from — starts in. Running tabs
     *  keep their own, since a profile is fixed at spawn. Resolves to `{ok}`
     *  or `{ok: false, error}`. */
    async setStartupProfile(id) {
      const res = await _invokeResult("set_startup_profile", { id });
      // Re-read rather than assuming: the backend re-validates the id under
      // its lock and may have fallen it back to the built-in profile.
      if (res.ok) await _refreshProfiles();
      return res;
    },

    /** With no tab open, choose the profile the next tab opens under (the
     *  profile menu's pick at the empty workspace; nothing to respawn).
     *  Not persisted — see `setStartupProfile` for that. Resolves to `{ok}`
     *  or `{ok: false, error}` like `switchSessionProfile`. */
    async selectNoTabProfile(id) {
      // Any registered tab, not just the active one: an open in flight has
      // registered its tab but not activated it yet, and has already chosen
      // its profile — acknowledging the pick would silently drop it.
      if (sessionRegistry.size > 0)
        return { ok: false, error: "a tab is open" };
      if (!profiles.some((p) => p.id === id))
        return { ok: false, error: `unknown profile '${id}'` };
      _noTabProfileId = id;
      _syncRecentsProfile();
      notify();
      return { ok: true };
    },

    /** Switch one tab to another profile. A profile is fixed at spawn, so the
     *  tab keeps its id/name/path but its omp process is replaced and its
     *  transcript dropped — it comes back as a fresh session. Resolves to
     *  `{ok}` or `{ok: false, error}` on every path so the menu can render a
     *  refusal (unlisted target profile, a respawn already in flight, a
     *  failed respawn) instead of dropping it silently. The respawn itself
     *  is `_respawnSession`. */
    async switchSessionProfile(id, profileId) {
      if (!window.__TAURI__) return { ok: false, error: "not connected" };
      const entry = sessionRegistry.get(id);
      if (!entry) return { ok: false, error: "unknown tab" };
      if (entry.profile === profileId) return { ok: true }; // already on this profile
      if (!profiles.some((p) => p.id === profileId)) {
        const error = `unknown profile '${profileId}'`;
        console.warn(`[live] ${error} — ignoring switch`);
        return { ok: false, error };
      }
      return _respawnSession(id, {
        profile: profileId,
        resume: null,
        fresh: true,
      });
    },

    // ── Tool approval mode (app/approval-mode.js, approval_mode.rs) ─────────

    /** Re-fetch the `{ default, projects }` view, store it in the snapshot
     *  (`approvalModes`) and resolve to it (null before any read worked). */
    approvalModes() {
      return _refreshApprovalModes();
    },
    /** Set the global default mode, then restart the open tabs it changes
     *  (idle now, busy at their next idle point). Resolves to
     *  `{ ok, error?, restarted: [ids], deferred: [ids] }`. */
    setApprovalModeDefault(mode) {
      return _setApprovalModes("approval_mode_set_default", { mode });
    },
    /** Set (`mode`) or remove (`null`) the override for project folder
     *  `path` (a tab's canonical `entry.path`); same result as above. */
    setApprovalModeProject(path, mode) {
      return _setApprovalModes("approval_mode_set_project", {
        projectRoot: path,
        mode: mode ?? null,
      });
    },

    /** Close a tab after stopping its microphone; a failed stop leaves the
     *  tab visible so the user can retry. */
    async closeSession(id) {
      if (!sessionRegistry.has(id) || _closingVoiceTabs.has(id)) return false;
      _closingVoiceTabs.add(id);
      try {
        if (
          id === activeSessionId &&
          (state.dictation.active ||
            _dictationStopPending ||
            state.liveVoice.active)
        ) {
          const stopped = await window.OMP_BRIDGE.stopActiveVoice();
          if (
            !stopped.ok &&
            id === activeSessionId &&
            (state.dictation.active || state.liveVoice.active)
          )
            return false;
          if (!sessionRegistry.has(id)) return false;
        }
        _closeTab(id);
        sessionRegistry.delete(id);
        promptHistories.delete(id);
        _modeRestartMissed.delete(id);
        if (id === activeSessionId) {
          const remaining = [...sessionRegistry.keys()];
          if (remaining.length > 0) {
            await _switchToSession(remaining[remaining.length - 1]);
          } else {
            // No sessions left — reset to empty state
            await _detachActiveSession();
            // No active tab: the active profile falls back to the startup one.
            _syncRecentsProfile();
            notify();
          }
        } else {
          notify(); // tab list changed
        }
        return true;
      } finally {
        _closingVoiceTabs.delete(id);
      }
    },

    /** `closeSession`, after asking when Settings → Session "Ask before
     *  closing a busy tab" is on and the tab's agent is busy. Resolves to
     *  whether the tab was closed. */
    async closeSessionGuarded(id) {
      const confirm = PREFS.tabCloseConfirm(sessionPrefs, _sessionsView(), id);
      if (confirm && !(await _askClose(confirm))) return false;
      if (!sessionRegistry.has(id)) return false; // closed meanwhile
      return window.OMP_BRIDGE.closeSession(id);
    },

    /** Answer the busy-close confirmation on screen (snapshot
     *  `closeConfirm`): `true` closes / quits, `false` keeps everything. */
    resolveCloseConfirm(ok) {
      _closeConfirmAnswer?.(ok === true);
    },

    /** Apply Settings → Session / Agent prefs (`restoreTabs`,
     *  `confirmBusyClose`, `autoName`, `autoRetry`; any
     *  subset, the rest kept). Idempotent: only a changed value acts.
     *  `restoreTabs` only matters at launch (read from the stored tweaks
     *  then) and `autoName` at each auto-title check, so neither sends
     *  anything here. */
    setSessionPrefs(values) {
      // fromTweaks keeps only PREFS.KEYS, so the whole tweaks object may come in.
      const next = PREFS.fromTweaks(
        { ...sessionPrefs, ...values },
        window.TWEAK_DEFAULTS,
      );
      const changed = PREFS.changedKeys(sessionPrefs, next);
      if (changed.length === 0) return;
      sessionPrefs = next;
      if (changed.includes("autoRetry"))
        _sendToAll({ type: "set_auto_retry", enabled: next.autoRetry });
      if (changed.includes("confirmBusyClose"))
        _syncCloseGuard(_sessionsView());
    },

    /** Put the tabs in `ids` order (#40): a drag in the tab bar, the group
     *  chip's list or the sidebar, or the keyboard move. Only a permutation
     *  of the open tabs is applied (`OMP_PROJECT_NAV.isReorderOf`, covered
     *  by test-project-nav.mjs) — a tab opened or closed since the caller's
     *  snapshot makes it a no-op (`false`), and the next drag starts from a
     *  fresh snapshot. Entries, the active tab and any in-flight respawn are
     *  untouched: they only ever `set` existing keys, which keeps the new
     *  position. `notify` persists the order (`open-tabs.json`). */
    reorderTabs(ids) {
      if (!window.OMP_PROJECT_NAV.isReorderOf(ids, [...sessionRegistry.keys()]))
        return false;
      const entries = ids.map((id) => [id, sessionRegistry.get(id)]);
      sessionRegistry.clear();
      for (const [id, entry] of entries) sessionRegistry.set(id, entry);
      notify();
      return true;
    },

    /** Open native folder picker and return the chosen (canonical) path, or
     *  null when cancelled or the pick is unusable (logged). */
    async pickFolder() {
      return _invokeSafe("open_project", undefined, null);
    },

    /** List project-relative file/dir paths matching `query`, for the
     *  composer's `@`-mention autocomplete. Scoped to the active tab's
     *  project path; returns [] for a pathless tab (no
     *  project root to search) or when the RPC throws. */
    async listFiles(query, limit = 30) {
      const cwd = _activeProjectPath();
      if (!cwd) return [];
      return _invokeSafe("list_project_files", { cwd, query, limit }, []);
    },

    // ── App updates (issue #19) — see src-tauri/src/updater.rs ─────────────
    // Thin IPC wrappers; the state machine is app/updater.js, driven by
    // app/use-updater.jsx. Not per-session, so nothing here touches `state`.

    /** Running app version (`tauri.conf.json`'s `version`), or null. Same
     *  IPC as `window.__TAURI__.app.getVersion()`. */
    appVersion() {
      return _invokeSafe("plugin:app|version", undefined, null);
    },

    /** `{ok: true, value}` — value is the UpdateInfo, or null when up to
     *  date — or `{ok: false, error}`. */
    checkForUpdate() {
      return _invokeResult("app_update_check");
    },

    /** Download, install and relaunch into the update the last check
     *  found, reporting `{downloaded, total}` to `onProgress` meanwhile.
     *  Windows: resolves only on failure (the installer takes over the
     *  process); elsewhere `{ok: true}` briefly precedes the restart.
     *  The listener lives exactly as long as the install — it is attached
     *  before the invoke, so no early chunk is missed. */
    async installUpdate(onProgress) {
      if (!window.__TAURI__) return { ok: false, error: "not connected" };
      const unlisten = await window.__TAURI__.event
        .listen("update://progress", (ev) => onProgress(ev.payload))
        .catch((err) => {
          console.error("[live] update progress listener failed:", err);
          return null;
        });
      try {
        return await _invokeResult("app_update_install");
      } finally {
        unlisten?.();
      }
    },

    /** Open an http(s) URL in the system browser (same allow-list as the
     *  webview's navigation guard — see `open_url_external`). */
    openExternalUrl(url) {
      return _invokeResult("open_url_external", { url });
    },

    /** Update the in-memory prompt-history cap (Settings → Composer,
     *  default OMP_PROMPT_HISTORY.DEFAULT_LIMIT). Trims every tab's list
     *  eagerly, not just on the next record/backfill — otherwise lowering
     *  the slider wouldn't affect the picker (open via Ctrl+Up) until the
     *  next prompt is sent, and a startup call landing before the first
     *  transcript backfill would silently miss trimming it too.
     *
     *  The trim decision itself has no Tauri dependency (it's plain Map
     *  iteration) and is covered directly by test-prompt-history.mjs via
     *  `OMP_PROMPT_HISTORY.trimAll` — only `notify()`'s side effect stays
     *  here, which this file has no harness to assert on. */
    setPromptHistoryLimit(n) {
      promptHistoryLimit = window.OMP_PROMPT_HISTORY.clampLimit(n);
      if (
        window.OMP_PROMPT_HISTORY.trimAll(promptHistories, promptHistoryLimit)
      )
        notify();
    },

    /** Subscribe to state snapshots. Returns an unsubscribe function. */
    onUpdate(cb) {
      subscribers.add(cb);
      cb(_buildSnapshot());
      return () => subscribers.delete(cb);
    },

    getState() {
      return state;
    },
  };

  // ── Connect to Tauri IPC ──────────────────────────────────────────────────
  if (window.__TAURI__) {
    document.documentElement.classList.add("tauri-native");
    if (navigator.platform.startsWith("Mac")) document.documentElement.classList.add("native-macos");

    // No tab at launch: `lib.rs::setup` spawns nothing. Load the persisted
    // profile list + ticked default first — with no tab to inherit from, it
    // decides the profile of the first tab and whose recent projects are
    // listed (`_refreshProfiles` syncs them).
    //
    // Then reopen the tabs of the previous run (`_restoreOpenTabs`), and
    // only after that drain OS folder-open requests: a cold-start "Open
    // with" is already queued in Rust, and opening it early would spawn
    // under the provisional built-in profile instead of the ticked startup
    // one — and it should end up the active tab, not be buried under the
    // restored ones. `.finally`, not `.then`: a failed list or restore must
    // not disable folder opens.
    // The approval-mode view, alongside: the status bar and the restart
    // plan read it, and spawns never wait for it (Rust resolves the mode).
    void _refreshApprovalModes();
    _refreshProfiles()
      .catch(e => console.error("[live] startup profile load failed:", e))
      // Tab ids are never reused across a webview reload: anything Rust still
      // holds now (omp children, shells) belongs to a previous document.
      .then(() => _invokeSafe("close_all_tabs", {}))
      .then(() => _restoreOpenTabs())
      .catch(e => console.error("[live] restoring the open tabs failed:", e))
      .finally(_setupExternalOpens);

    // Busy-close confirmation for an OS close Rust held (`_requestQuit`),
    // and the guard's real state: a reloaded webview may find it armed by
    // the previous document.
    window.__TAURI__.event.listen("window://close-requested", () => { void _requestQuit(); })
      .catch(e => console.error("[live] failed to listen for window close requests:", e));
    _syncCloseGuard(_sessionsView());

    if (document.readyState === "loading") {
      document.addEventListener("DOMContentLoaded", _setupWindowChrome);
    } else {
      _setupWindowChrome();
    }

    console.log("[live] Tauri multi-session mode active");
  } else {
    console.log("[live] Demo mode (no Tauri runtime)");
  }

})();

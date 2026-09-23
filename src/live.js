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
  const { LOCAL_COMMANDS, adaptAvailableCommands, mergeSlashCommands, isSlashCommand } = window.OMP_SLASH;

  // ── Safe defaults so design components never crash on missing fields ──────
  const DEFAULT_DATA = {
    projects: [],
    messages: [],
    kanban: [],
    planMeta: { ask: "", strategy: "", touches: [], branch: "main", risks: [], estimate: { tokens: "—", cost: "—", wall: "—" } },
    commands: LOCAL_COMMANDS,
    models: [],
    activity: [],
    ctx: { used: 0, total: 200000, pct: 0, label: "0 / 200k", cost: "$0.00", tokensPerSec: 0 },
    peer: null,
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
    exitReason:     null,   // non-empty agent://exit reason for the last run — drives runStateOf's "failed"
  };

  let streamingBubble = null;
  let activeToolCards = new Map();    // toolCallId → message index
  const ASK_FLUSH_MS = 150;         // upper bound on how long an ask may stay buffered
  // Ask bubbles awaiting a flush into state.messages — see _queueAskBubble.
  let pendingAskBubbles    = [];    // FIFO of buffered ask messages
  let pendingAskFlushTimer = null;  // armed while the queue is non-empty
  let tpsSamples      = Array(30).fill(0);
  let turnStartTime   = null;
  let activityLog     = [];           // [{ts, toolName}], pruned to 60s
  let lastSeq         = 0;   // highest journal seq processed for the active session — see _dispatchEnvelope
  let _replayBuffer   = null; // null = live dispatch; [] = buffering during a replay (see _switchToSession)
  let _msgSeq = 0;  // monotonic counter — stable React keys for message bubbles

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
  const gitListeners = new Map();  // session_id → Tauri unlisten fn for git://branch/{id}
  const _profileSwitching = new Set(); // session ids with a profile respawn in flight
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

  let activeSessionId  = null;
  let activeListeners  = [];          // unlisten functions for current session

  // ── ID-keyed response correlation ─────────────────────────────────────────
  // Used by _sendWithResponse to correlate commands that need a typed reply.
  const _pendingResponses = new Map(); // id → { resolve, reject }
  let _nextCmdId = 1;

  /**
   * Send a command and return a Promise that resolves with the response data
   * or rejects with an Error on failure. Uses the RPC id field for correlation.
   * @param {object}  cmd         Command body (type + args, no id).
   * @param {number}  [timeout]   Ms to wait before rejecting (0 = no timeout).
   */
  function _sendWithResponse(cmd, timeout = 120000) {
    return new Promise((resolve, reject) => {
      if (!window.__TAURI__ || !activeSessionId) {
        reject(new Error("Not connected"));
        return;
      }
      const id = `d${_nextCmdId++}`;
      let timer;
      if (timeout > 0) {
        timer = setTimeout(() => {
          _pendingResponses.delete(id);
          reject(new Error(`Command '${cmd.type}' timed out after ${timeout}ms`));
        }, timeout);
      }
      _pendingResponses.set(id, {
        resolve(data) { clearTimeout(timer); resolve(data); },
        reject(err)   { clearTimeout(timer); reject(err);   },
      });
      _send({ ...cmd, id });
    });
  }

  // ── Subscriber system ─────────────────────────────────────────────────────
  const subscribers = new Set();

  // Drop the oldest row of messages once the 13×13 grid is full and the
  // current turn is complete. Only called from notify() so the trim is
  // always reflected in the same snapshot that React receives.
  // Active tool-card indices are shifted so in-flight updates stay correct;
  // completed cards are already removed from the map and are unaffected.
  function _trimMessages() {
    if (state.isStreaming) return;                  // wait for clean turn boundary
    if (state.messages.length <= MINIMAP_MAX) return;
    const drop = MINIMAP_COLS;                      // evict one full row (13)
    state.messages = state.messages.slice(drop);
    for (const [id, idx] of activeToolCards) {
      const shifted = idx - drop;
      if (shifted < 0) activeToolCards.delete(id); // guard: possible on abort (no tool_execution_end)
      else activeToolCards.set(id, shifted);
    }
  }

  // ── Four-state run projection ────────────────────────────────────────────
  // Total function from a session's live/snapshot fields to one of four
  // user-facing states — the tab bar previously showed only a color dot, so
  // a backgrounded tab streaming, blocked on an unanswered ask, or crashed
  // was indistinguishable from an idle one. Order matters: a fatal exit
  // outranks everything (a process that died mid-turn is "failed" even with
  // a stale ask still open), and an unanswered ask outranks isStreaming —
  // every ask (select/confirm/input/editor) is emitted mid-turn and
  // isStreaming only clears on turn_end/exit/get_state, none of which fire
  // while the ask is open, so checking isStreaming first made "waiting-user"
  // unreachable in practice.
  // Pure — proven with an eval-kernel cell (4/4 cases: streaming+no-ask →
  // running, streaming+open-ask → waiting-user, streaming+answered-ask →
  // running, not-streaming+exitReason → failed) rather than a permanent test
  // file, per this file's existing convention for extracted decision logic
  // (_startProjectSession's tabName).
  function runStateOf({ isStreaming, exitReason, messages }) {
    if (exitReason) return "failed";
    const waitingUser = messages.some(m => m.kind === "ask" && !m.answered && !m.cancelled);
    if (waitingUser) return "waiting-user";
    if (isStreaming) return "running";
    return "idle";
  }

  // Memo for runStateOf, keyed on the messages array's identity.
  //
  // _buildSnapshot runs runStateOf for EVERY open tab on every notify() —
  // i.e. on every RPC line — so without this the cost is
  // O(tabs x messages) per streaming delta. Keying on identity is sound
  // precisely because no code path mutates state.messages in place: every
  // writer replaces the array (see _pushAssistantNote), so a stale entry is
  // unreachable (proven with an eval-kernel cell: 21/21 cases, including
  // the same array replayed under changing isStreaming/exitReason, which a
  // naive key-on-array-only memo gets wrong).
  // A backgrounded tab's array is frozen for as long as it
  // stays backgrounded, so those tabs become a map lookup; only the active
  // tab, whose array is replaced as it streams, still scans — and that scan
  // is bounded by MINIMAP_MAX. A WeakMap means a closed tab's cached entry
  // is collected with its messages.
  const _runStateMemo = new WeakMap();
  // Shared so a never-activated tab keys the memo stably instead of
  // allocating a fresh (always-missing) array on every notify.
  const _EMPTY_SESSION_FIELDS = Object.freeze({
    isStreaming: false, exitReason: null, messages: Object.freeze([]),
  });
  function runStateCached(fields) {
    const { messages, isStreaming, exitReason } = fields;
    const hit = _runStateMemo.get(messages);
    if (hit && hit.isStreaming === isStreaming && hit.exitReason === exitReason) {
      return hit.value;
    }
    const value = runStateOf(fields);
    _runStateMemo.set(messages, { isStreaming, exitReason, value });
    return value;
  }

  function _buildSnapshot() {
    return {
      messages:        state.messages,
      isStreaming:     state.isStreaming,
      model:           state.model,
      thinkingLevel:   state.thinkingLevel,
      ctx:             state.ctx,
      kanban:          state.kanban,
      planMeta:        state.planMeta,
      models:          state.models,
      activity:        state.activity,
      sparkline:       state.sparkline,
      // Tab list — derived from session registry, not per-session state.
      // runState: active tab reads live state; background tabs read their
      // cached snapshot (never activated yet = "idle" defaults).
      sessions:        [...sessionRegistry.values()].map(s => ({
        ...s,
        runState: runStateCached(
          s.id === activeSessionId
            ? { isStreaming: state.isStreaming, exitReason: state.exitReason, messages: state.messages }
            : sessionSnapshots.get(s.id) ?? _EMPTY_SESSION_FIELDS
        ),
      })),
      activeSessionId,
      profiles,
      startupProfileId,
    };
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

  // Build an ask bubble. The four `extension_ui_request` methods differ only
  // in `method` and one or two method-specific fields; the defaults below
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
  // `state.messages`: omp emits `extension_ui_request.select` just BEFORE
  // the `tool_execution_start` of the tool it gates, so pushing on arrival
  // puts the prompt above its own tool card. tool_execution_start flushes
  // the queue, giving the [tool_card, ask_bubble] order.
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
  // Proven end-to-end with an eval-kernel cell that loads this file into a
  // stubbed-Tauri VM context and feeds real event lines (5/5 cases: two
  // gated parallel tools both render — the single-slot version dropped the
  // first and wedged its tool card at "running"; selects arriving after the
  // last tool_execution_start still surface via ASK_FLUSH_MS; single-tool
  // [tool_card, ask] order unchanged; cancel-before-flush removes only its
  // own queue entry and the survivor still answers on the wire; a tab
  // switch mid-buffer keeps the ask in the originating session).
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

  // Resolve a pending ask bubble: apply `patch` to the first unanswered,
  // uncancelled bubble with this id, then send `payload` back to omp. The
  // re-answer guard (a bubble already answered or cancelled is left alone,
  // and nothing is sent) is the subtle part — it lives here once instead of
  // in each of answerAsk/answerConfirm/cancelAsk.
  // Proven with an eval-kernel cell (7/7 cases: patch applied, array
  // replaced, {value}/{confirmed}/{cancelled} payload shapes preserved
  // per caller, and re-answer + unknown-id both send nothing).
  function _resolveAsk(id, patch, payload) {
    let resolved = false;
    state.messages = state.messages.map(m => {
      if (m.kind === "ask" && m.id === id && !m.answered && !m.cancelled) {
        resolved = true;
        return { ...m, ...patch };
      }
      return m;
    });
    if (!resolved) return;
    notify();
    _send({ type: "extension_ui_response", id, ...payload });
  }

  // Append a synthetic assistant note (process exited, startup failed,
  // auto-approved-by-rule) and publish it.
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
  // `localOnly` (opt-in, existing call sites unaffected): the note has no
  // corresponding persisted turn on omp's side — get_messages's merge below
  // would otherwise treat it as an ordinary assistant entry and either drop
  // it or let a later real turn overwrite its slot on the next tab switch.
  function _pushAssistantNote(text, localOnly) {
    state.messages = [...state.messages, {
      kind: "assistant",
      time: timeNow(),
      model: state.model?.name ?? null,
      blocks: [{ type: "text", text }],
      thought: null, lead: null, streaming: false, completed: true,
      ...(localOnly ? { localOnly: true } : {}),
    }];
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

    // Keep OMP_DATA in sync for design components that read it directly
    window.OMP_DATA.messages  = state.messages;
    window.OMP_DATA.models    = state.models;
    window.OMP_DATA.commands  = state.commands;
    window.OMP_DATA.kanban    = state.kanban;
    window.OMP_DATA.planMeta  = state.planMeta;
    window.OMP_DATA.ctx       = state.ctx;
    window.OMP_DATA.activity  = state.activity;
  }

  // Reset all per-session volatile state (called before loading a new session)
  function _resetSessionVars() {
    Object.assign(state, {
      messages:      [],
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
    });
    streamingBubble = null;
    pendingAskBubbles = [];
    _disarmAskFlush();
    activeToolCards = new Map();
    tpsSamples      = Array(30).fill(0);
    turnStartTime   = null;
    activityLog     = [];
    lastSeq         = 0;
  }

  // ── Session snapshot helpers ──────────────────────────────────────────────
  function _saveCurrentSession() {
    if (!activeSessionId) return;
    // Buffered asks belong to the session being left — flush them into its
    // messages so the snapshot carries them. Leaving them in the queue would
    // either lose them or leak them into the next session's transcript.
    _flushAskBubbles();
    sessionSnapshots.set(activeSessionId, {
      // state fields
      messages:      state.messages,
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
      // volatile vars
      streamingBubble,
      activeToolCards: new Map(activeToolCards),
      tpsSamples:    [...tpsSamples],
      turnStartTime,
      activityLog:   [...activityLog],
      lastSeq,
    });
  }

  function _restoreSession(id) {
    const snap = sessionSnapshots.get(id);
    if (!snap) return false;
    Object.assign(state, {
      messages:      snap.messages,
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
    });
    streamingBubble = snap.streamingBubble;
    activeToolCards = snap.activeToolCards;
    tpsSamples      = snap.tpsSamples;
    turnStartTime   = snap.turnStartTime;
    activityLog     = snap.activityLog;
    lastSeq         = snap.lastSeq ?? 0;
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
  async function _switchToSession(id) {
    if (!window.__TAURI__) return;
    const myGen = ++_switchGen;

    // Snapshot current session so we can restore it when switching back
    _saveCurrentSession();

    // Tear down old listeners
    for (const ul of activeListeners) { try { await ul(); } catch (_) {} }
    if (_switchGen !== myGen) return; // superseded by a newer switch
    activeListeners = [];
    _chunkAcc = null; // drop any partial chunk run from the previous session

    activeSessionId = id;

    // Restore cached snapshot (preserves streaming messages) or start fresh
    if (!_restoreSession(id)) {
      _resetSessionVars();
    }

    // Arm event buffering before attaching the live listener so a line that
    // arrives between listener-attach and the replay fetch below is queued
    // (never lost, never double-processed) — drained once replay is applied.
    _replayBuffer = [];

    const { listen } = window.__TAURI__.event;
    const ulLine = await listen(`agent://line/${id}`, ev => handleLine(ev.payload));
    if (_switchGen !== myGen) {
      // Superseded while this call's own listener was still being attached —
      // it was never stored into activeListeners, so nothing else will ever
      // tear it down. Without this it keeps dispatching the abandoned
      // session's stdout lines into whichever tab is now active and
      // corrupts that tab's lastSeq cursor.
      try { await ulLine(); } catch (_) {}
      return;
    }
    const ulExit = await listen(`agent://exit/${id}`, ev => {
      const reason = (ev?.payload && String(ev.payload).trim()) || "";
      console.warn(`[live] session '${id}' omp process exited${reason ? ": " + reason : ""}`);
      state.isStreaming = false;
      state.exitReason = reason || null;
      if (reason) {
        _pushAssistantNote(_exitNote(reason, sessionRegistry.get(id)?.profile));
      }
      notify();
    });
    if (_switchGen !== myGen) {
      // Same leak as above, but both listeners for this call exist and
      // haven't been committed to activeListeners yet.
      try { await ulLine(); } catch (_) {}
      try { await ulExit(); } catch (_) {}
      return;
    }
    activeListeners = [ulLine, ulExit];

    // Catch up on events the journal captured while this tab had no live
    // listener attached (backgrounded tab switch) — recovers tool cards /
    // ask bubbles / streaming state that a text-only get_messages refetch
    // below cannot reconstruct. The journal is a bounded in-memory ring
    // (see AgentBridge::replay_events) — a `dropped` reply means some
    // events between `lastSeq` and the ring's window were evicted and are
    // gone for good; get_messages still recovers the persisted text below.
    try {
      const replay = await window.__TAURI__.core.invoke("replay_events", { sessionId: id, afterSeq: lastSeq });
      if (_switchGen !== myGen) return; // superseded by a newer switch
      if (replay.dropped) {
        console.warn(`[live] session '${id}' replay desynced — recovered ${replay.events.length} event(s); earlier ones fell outside the journal window`);
      }
      for (const ev of replay.events) _dispatchEnvelope(ev);
    } catch (e) {
      console.warn(`[live] replay_events failed for '${id}':`, e);
    }
    if (_switchGen !== myGen) return; // superseded by a newer switch

    // Drain live events buffered while the replay fetch was in flight,
    // de-duplicated against lastSeq inside _dispatchEnvelope.
    const buffered = _replayBuffer;
    _replayBuffer = null;
    for (const envelope of buffered) _dispatchEnvelope(envelope);

    // Surface any cached startup error for this session. Tauri starts
    // the default session in setup() before the frontend can attach
    // listeners, so a spawn failure (e.g. omp not on PATH) — or a child
    // that died during startup, whose reason `reader.rs` records in
    // `last_errors` for exactly this reason — would otherwise be
    // invisible. session_status returns the cached error synchronously —
    // no event timing race.
    try {
      const startupError = await window.__TAURI__.core.invoke("session_status", { sessionId: id });
      if (_switchGen !== myGen) return; // superseded by a newer switch
      // Same renderer as the `agent://exit` path: this is the *same* backend
      // string (the reader writes `last_errors` and emits the event with one
      // value), and the launch tab plus every background tab reach the
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
      }
    } catch (e) {
      console.warn(`[live] session_status query failed:`, e);
    }
    if (_switchGen !== myGen) return; // superseded by a newer switch

    // Re-fetch to pick up events missed while not listening.
    // get_messages handler merges completed turns with the cached streaming bubble.
    _initFetch();
    notify();
  }

  // ── v2 lossless transport: rpc_chunk reassembly ──────────────────────────
  // After negotiate_protocol v2, omp emits oversized stdout objects (e.g. the
  // ~2 MiB get_available_models response) as an uninterrupted sequence of
  // rpc_chunk frames. Each carries a base64 segment of the original UTF-8 JSON.
  const MAX_REASSEMBLED_FRAME = 64 * 1024 * 1024; // matches ready.maxReassembledFrameBytes

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
      const bin = atob(f.data);
      const bytes = new Uint8Array(bin.length);
      for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
      parts[f.index] = bytes;
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
   *  Side-effectful (Tauri IPC invoke, event listeners), so not unit-tested
   *  directly. */
  async function _spawnSession(id, cwd, { resume = null, profile }) {
    await window.__TAURI__.core.invoke("start_session", {
      args: { sessionId: id, cwd: cwd ?? "", resume, profile },
    });
    // A fresh incarnation owns this id now, and `start_session` cleared the
    // backend's cached error for it — so a *new* startup failure must be
    // reportable again. Cleared after the spawn resolved, so a spawn that
    // threw leaves the previous reason still deduped.
    _notedStartupErrors.delete(id);
    // Git: read initial branch and arm the HEAD watcher (fire-and-forget errors)
    if (cwd) {
      const branch = await window.__TAURI__.core
        .invoke("start_git_watch", { sessionId: id, path: cwd })
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
  }

  /** Drop a session's git-branch listener, if it has one. Every teardown
   *  path (tab close, profile respawn) must do this or the stale listener
   *  keeps writing branch updates for a dead process into the registry. */
  function _dropGitListener(id) {
    const unlisten = gitListeners.get(id);
    if (unlisten) { unlisten(); gitListeners.delete(id); }
  }

  /** Kill a session's omp process and everything bound to it (git watcher,
   *  cached snapshot). Shared by tab close and profile respawn so a new
   *  per-session resource only has to be released in one place. The
   *  registry entry is left to the caller.
   *
   *  Returns a promise for the `stop_session` round-trip. Tab close can
   *  ignore it (that id is never reused), but a profile respawn MUST await
   *  it: `stop_session`'s backend body does an unconditional
   *  `sessions.remove(id)`, so if it were still queued when
   *  `start_session` installed the fresh incarnation under the same id, it
   *  would reap the *new* process instead of the dead one. */
  function _killSessionProcess(id) {
    let stopped = Promise.resolve();
    if (window.__TAURI__) {
      stopped = window.__TAURI__.core.invoke("stop_session", { sessionId: id }).catch(() => {});
      window.__TAURI__.core.invoke("stop_git_watch", { sessionId: id }).catch(() => {});
    }
    _dropGitListener(id);
    sessionSnapshots.delete(id);
    return stopped;
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
    const listeners = activeListeners;
    activeListeners = [];
    activeSessionId = null;
    _resetSessionVars();
    for (const ul of listeners) { try { await ul(); } catch (_) {} }
  }

  /** Tab label for a project folder: its last path segment, else
   *  `fallback`. Pure — proven with an eval-kernel cell (10/10 cases,
   *  including the pre-existing trailing-slash quirk inherited from
   *  master's `openSession`) run during PR #4 review remediation. */
  function _tabNameFor(cwd, fallback) {
    return cwd ? cwd.replace(/\\/g, "/").split("/").pop() || cwd : fallback;
  }

  /** Spawn omp for `cwd` (optionally resuming a saved session), register the
   *  tab, wire the git-branch watcher, and activate it. Shared by
   *  `openSession` (new project tab) and `resumeSession` (resume from disk)
   *  so the git-watch/listener wiring only lives in one place.
   *
   *  This function is side-effectful (Tauri IPC invoke, event listeners) and
   *  not unit-tested directly; its one pure decision (the `tabName`
   *  derivation) now lives in, and is proven by, `_tabNameFor`. */
  async function _startProjectSession(cwd, {
    resume = null, name = null, color = "var(--lilac)", profile,
  }) {
    const id = `session-${Date.now()}`;
    const tabName = name || _tabNameFor(cwd, "new session");
    // Register in tab list before starting omp so the tab shows immediately.
    // Register with null branch — chip hidden until git resolves.
    sessionRegistry.set(id, { id, name: tabName, path: cwd ?? "", color, branch: null, profile });
    try {
      await _spawnSession(id, cwd, { resume, profile });
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
      // The kill releases more than the tab, because `_spawnSession` has two
      // failure points: `start_session` itself (nothing spawned, so the kill
      // is a no-op) and the `listen("git://branch/{id}")` that follows it,
      // by which point a live child is installed in the backend's session
      // map and `start_git_watch` is armed. Deleting only the registration
      // there would strand that child — with no tab, nothing ever calls
      // `stop_session` for this id again and it survives until app exit.
      _killSessionProcess(id);
      sessionRegistry.delete(id);
      notify();
      throw e;
    }
    // Activate
    await _switchToSession(id);
    return id;
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

  /** Pure: may the pathless launch tab be retired, now that an OS request
   *  has opened a real project tab?
   *
   *  Only the launch tab qualifies (any tab with a `path` was asked for),
   *  and only while it is untouched - a transcript means a prompt the user
   *  sent or a note about a failed spawn, neither of which is ours to
   *  discard. `snapshot` is the tab's cached state (`sessionSnapshots`),
   *  absent when it was never activated.
   *
   *  Proven with an eval-kernel cell (6/6 cases: no entry, project tab,
   *  empty launch tab, launch tab with a transcript, never-activated tab,
   *  snapshot without a messages array). */
  function _isRetirableLaunchTab(entry, snapshot) {
    if (!entry || entry.path) return false;
    return (snapshot?.messages?.length ?? 0) === 0;
  }

  /** Turn one queued folder into a project tab. Side-effectful (spawns omp,
   *  switches the active tab, may close the launch tab). */
  async function _openExternalProject(path) {
    let opened;
    try {
      opened = await _startProjectSession(path, { profile: _activeProfileId() });
    } catch (e) {
      // `_startProjectSession` already rolled the tab back, so the only
      // thing left is telling the user: the OS has no UI to report into and
      // silently ignoring a double-clicked folder looks like a hang.
      console.error(`[live] folder open failed for '${path}':`, e);
      _pushAssistantNote(`**Could not open project:** ${String(e?.message ?? e)}`);
      notify();
      return;
    }
    // The launch tab is a pathless session with nothing in it, so retire it
    // instead of leaving a stray tab beside the folder the user opened - on
    // a cold start it is the tab this request replaced, on a warm one an
    // untouched tab the project tab supersedes. Read after the open: the
    // snapshot only exists once `_switchToSession` left that tab.
    //
    // Gated on the new tab still being active, because a tab click landing
    // inside the open above bumps `_switchGen`, making our own
    // `_switchToSession` bail - and `activeSessionId` may then *be*
    // "default", whose snapshot this switch already emptied. Closing it
    // there would kill the tab the user just picked, mid-turn.
    if (activeSessionId === opened
        && _isRetirableLaunchTab(sessionRegistry.get("default"), sessionSnapshots.get("default"))) {
      await window.OMP_BRIDGE.closeSession("default");
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

  // ── RPC response handler ──────────────────────────────────────────────────
  function _handleResponse(resp) {
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
      notify();
      return;
    }
    if (!resp.success) return;
    const { command, data } = resp;

    if (command === "get_state") {
      _applyRpcState(data);

    } else if (command === "get_messages") {
      const completed = window.adaptAgentMessages(data.messages ?? []);
      // Tool/ask/compact cards exist only in live event state — omp never
      // persists them and get_messages never returns them. Walk the current
      // snapshot in order: preserve tool/ask/compact entries in-place and
      // replace each text entry (user/assistant) with the ground-truth copy
      // from `completed`. Any new turns that arrived while we were on another
      // tab (missed live events) are appended at the end. activeToolCards
      // indices are rebuilt so in-flight tool_execution_update events keep
      // landing on the right array slot.
      //
      // A still-`pendingEcho` bubble (queued follow-up/steer, see
      // OMP_BRIDGE.followUp/.steer) is also kept in place rather than
      // consuming a `pending` slot — omp hasn't persisted it yet, so
      // `completed` doesn't contain it; treating it as an ordinary text
      // entry here would misalign every slot after it (the next persisted
      // turn would be substituted into its place, and the last real turn
      // would then find nothing left and be dropped). Same reasoning for
      // `localOnly` (see _pushAssistantNote) — a command_output note has
      // no persisted turn either, ever, not just "not yet".
      const pending = [...completed];
      const merged = [];
      for (const m of state.messages) {
        if (m.streaming) continue; // streaming bubble handled separately below
        if (m.kind === "tool" || m.kind === "ask" || m.kind === "compact" || m.pendingEcho || m.localOnly) {
          merged.push(m);
        } else if (pending.length > 0) {
          merged.push(pending.shift());
        }
      }
      merged.push(...pending); // turns that completed while we were away
      // Rebuild activeToolCards — new entries may have been appended from pending
      activeToolCards = new Map();
      for (let i = 0; i < merged.length; i++) {
        const m = merged[i];
        if (m.kind === "tool" && m.status === "running" && m._toolCallId) {
          activeToolCards.set(m._toolCallId, i);
        }
      }
      state.messages = streamingBubble ? [...merged, streamingBubble] : merged;
      notify();

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
        notify();
      }

    } else if (command === "cycle_model") {
      if (data?.model) {
        state.model  = _buildModelEntry(data.model);
        if (data.thinkingLevel != null) state.thinkingLevel = data.thinkingLevel;
        state.models = state.models.map(m => ({ ...m, current: m.id === data.model.id }));
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
      // New session started — clear local state and re-fetch
      _resetSessionVars();
      _initFetch();
      notify();

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
    state.commands = mergeSlashCommands(LOCAL_COMMANDS, adaptAvailableCommands(raw));
    notify();
  }

  // ── AgentSessionEvent handler ─────────────────────────────────────────────
  function _handleEvent(ev) {
    const { type } = ev;
    const now  = Date.now();
    const time = timeNow();


    if (type === "available_commands_update") {
      _applyCommands(ev.commands);
      return;
    }

    // A builtin slash command sent as a plain prompt (e.g. picking `/jobs`
    // from the merged palette) runs locally inside omp — no turn, no
    // agent_end, and the `prompt` response itself carries nothing. Its only
    // output channel is this frame; without handling it, the command looks
    // like it did nothing.
    if (type === "command_output") {
      _pushAssistantNote(ev.text, true);
      notify();
      return;
    }

    // Same local-only-command path: a config-changing builtin (/model,
    // /thinking) or a title-changing one (/rename) mutates session state
    // outside the normal turn lifecycle, with no set_model/cycle_model
    // response to key off. Re-fetch rather than duplicate _applyRpcState's
    // model/thinkingLevel/sessionName derivation here.
    if (type === "config_update" || type === "session_info_update") {
      _send({ type: "get_state" });
      return;
    }

    if (type === "extension_ui_request") {
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
      // Agent asks the user to pick from a list — also the shape of every
      // tool-approval prompt ("Allow tool: X", options ["Approve","Deny"]).
      // Buffered rather than pushed immediately; see _queueAskBubble.
      if (ev.method === "select") {
        const OTHER_OPT = "Other (type your own)";
        _queueAskBubble(_askMessage("select", ev, {
          options: (ev.options ?? []).filter(o => o !== OTHER_OPT),
        }));
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
        // Cancelled before it was ever flushed — drop it from the queue and
        // leave the rest of the queue (and its timer) intact.
        const queued = pendingAskBubbles.findIndex(m => m.id === ev.targetId);
        if (queued !== -1) {
          pendingAskBubbles.splice(queued, 1);
          if (pendingAskBubbles.length === 0) _disarmAskFlush();
          return;
        }
        state.messages = state.messages.map(m =>
          m.kind === "ask" && m.id === ev.targetId && !m.answered
            ? { ...m, cancelled: true }
            : m
        );
        notify();
        return;
      }
      // Any other/future method we have no UI for — cancel so the server
      // never hangs waiting on a response we can't produce.
      _send({ type: "extension_ui_response", id: ev.id, cancelled: true });
      return;
    }

    // ── Turn lifecycle ────────────────────────────────────────────────────────
    if (type === "turn_start") {
      turnStartTime = now;
      state.isStreaming = true;
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

      if (role === "user") {
        const blocks = Array.isArray(msg.content) ? msg.content : [{ type: "text", text: String(msg.content ?? "") }];
        const { text, images } = window.adaptUserContent(blocks);
        if (text || images.length > 0) {
          // A follow-up's or steer's optimistic bubble (see OMP_BRIDGE.followUp
          // / .steer) is tagged `pendingEcho` and may no longer be the tail by
          // the time omp echoes it back — omp holds a follow-up until the agent
          // would otherwise stop, and defers a steer until the current turn's
          // tool batch finishes, so any tool card/assistant turn in between
          // appends after it. Reconcile against the oldest matching pending
          // bubble wherever it is instead of only checking the tail, or a
          // duplicate is appended.
          const pendingIdx = state.messages.findIndex(m => m.kind === "user" && m.pendingEcho && m.text === text);
          if (pendingIdx !== -1) {
            const next = state.messages.slice();
            next[pendingIdx] = { ...next[pendingIdx], pendingEcho: false };
            state.messages = next;
          } else {
            const last = state.messages[state.messages.length - 1];
            if (!(last?.kind === "user" && last.text === text)) {
              state.messages = [...state.messages, { kind: "user", time, text, images }];
            }
          }
          notify();
        }
      } else if (role === "assistant") {
        streamingBubble = {
          kind: "assistant", time,
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
      const usage = msg?.usage;
      const tokens = usage ? ((usage.input ?? 0) + (usage.output ?? 0)) : null;
      if (streamingBubble && msg) {
        const blocks = Array.isArray(msg.content) ? msg.content : [];
        const thought = blocks.find(b => b.type === "thinking")?.thinking ?? streamingBubble.thought;
        const designBlocks = blocks.filter(b => b.type === "text" && b.text?.trim()).map(b => ({ type: "text", text: b.text }));
        // Find by streaming flag — extension_ui_request.select may have pushed
        // an ask bubble after the streaming bubble before message_end arrives.
        const completed = {
          ...streamingBubble,
          streaming: false, thought,
          lead:   thought ? "thinking" : null,
          blocks: designBlocks.length > 0 ? designBlocks : streamingBubble.blocks,
          tokens,
          tokensIn:  usage?.input  ?? null,
          tokensOut: usage?.output ?? null,
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
      } else if (streamingBubble) {
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
    // forwarded the original ask — this synthetic note is the only trace of
    // it the human sees.
    if (type === "desktop_auto_approval") {
      _pushAssistantNote(`Auto-approved **${ev.tool}** via your approval rule.`);
      notify();
      return;
    }

    if (type === "agent_start" || type === "agent_end") {
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

  function _applyRpcState(rpcState) {
    if (!rpcState) return;
    state.rpcState      = rpcState;
    state.isStreaming   = rpcState.isStreaming ?? false;
    // If the turn completed while we were away (snapshot had streamingBubble
    // with streaming:true, but omp now says isStreaming:false), retire the
    // bubble immediately. The completed text arrives with get_messages; the
    // stale ghost is removed from state.messages here so the minimap doesn't
    // show a pulsating cell until get_messages lands.
    if (!state.isStreaming && streamingBubble) {
      streamingBubble = null;
      state.messages = state.messages.filter(m => !m.streaming);
    }
    state.thinkingLevel = rpcState.thinkingLevel ?? "auto";

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
      sessionRegistry.set(activeSessionId, { ...entry, name: rpcState.sessionName });
    }

    _refreshCtx();
    notify();
  }

  function _refreshCtx() {
    state.ctx = window.buildCtx(state.rpcState, state.sessionCost, state.currentTps);
  }

  function _initFetch() {
    // Negotiate protocol v2 first so oversized responses (get_available_models
    // is ~2 MiB, well past the v1 1 MiB frame cap) arrive as reassembled
    // rpc_chunk sequences instead of failing with a transport-limit error.
    // Await the negotiate response so v2 is active before the large fetches are
    // dispatched (stdin is processed in order, but this avoids any IPC-ordering
    // race). A v1 server or a repeat negotiate simply rejects — harmless.
    _sendWithResponse({ type: "negotiate_protocol", protocolVersion: 2 })
      .catch(() => {})
      .finally(() => {
        _send({ type: "get_state" });
        _send({ type: "get_messages" });
        _send({ type: "get_available_models" });
        _send({ type: "get_available_commands" });
      });
  }

  // ── Send a command to the active session's omp ────────────────────────────
  function _send(cmd) {
    if (!window.__TAURI__ || !activeSessionId) return;
    window.__TAURI__.core
      .invoke("send_command", { sessionId: activeSessionId, json: JSON.stringify(cmd) })
      .catch(e => console.error("[live] send error:", e));
  }

  // Project path (cwd) of the active tab, or null for the pathless
  // "default" session — used to scope project-level approval rules and
  // workspace status/diff to the right repo.
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
   *  folder), and with no tab open there is nothing to inherit, so the user's
   *  ticked default applies to both. Two helpers with different fallbacks
   *  meant that after closing the last tab the history panel listed the
   *  built-in tree while the next `openSession` spawned into the ticked
   *  profile - and `resumeSession` must match whatever was listed. */
  function _activeProfileId() {
    return _resolveProfile(sessionRegistry.get(activeSessionId), startupProfileId, profiles);
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
      // `startupId` is validated server-side against the same list, so it is
      // always one of these ids - no client-side reconciliation needed.
      if (res.startupId) startupProfileId = res.startupId;
      notify();
    }
    return profiles;
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

  /** Pure decision: should the launch tab be stamped with the resolved
   *  startup profile? Only when it is still on the built-in placeholder
   *  AND the resolved startup differs from it — the user may switch this
   *  tab's profile during the `_refreshProfiles()` round-trip below, and
   *  that choice is newer than the persisted default, so a tab that already
   *  moved off the placeholder (or no longer exists) must be left alone.
   *  Proven with an eval-kernel cell (4/4 cases: both built-in -> no stamp,
   *  startup differs from the built-in placeholder -> stamp, tab already
   *  switched away -> no stamp, tab missing (`undefined` entryProfile) ->
   *  no stamp). */
  function _shouldStampLaunchProfile(entryProfile, startupId) {
    return entryProfile === DEFAULT_PROFILE_ID && startupId !== DEFAULT_PROFILE_ID;
  }

  // ── Window chrome (drag + controls) ──────────────────────────────────────
  function _setupWindowChrome() {
    if (!window.__TAURI__) return;
    const { getCurrentWindow } = window.__TAURI__.window;
    const win  = getCurrentWindow();
    const isWin = navigator.userAgent.includes("Windows") || navigator.platform.startsWith("Win");

    // Drag: delegate from document so it works regardless of React render timing.
    // startDragging() must be called synchronously within the mousedown handler.
    document.addEventListener("mousedown", e => {
      if (!e.target.closest(".chrome")) return;
      // Interactive chrome content (the profile popover's text inputs, and
      // the popover itself for padding/hints/row clicks) must never start a
      // window drag — a mousedown there is a caret placement or a
      // drag-select, and starting an OS window move instead swallows it.
      // Any future interactive .chrome content needs the same exclusion.
      if (e.target.closest("button, input, textarea, .profile-pop, .chrome-lights, .win-controls")) return;
      win.startDragging().catch(() => {});
    });

    if (isWin) {
      document.addEventListener("click", e => {
        if (e.target.closest(".win-min"))        win.minimize();
        else if (e.target.closest(".win-max"))   win.isMaximized().then(m => m ? win.unmaximize() : win.maximize());
        else if (e.target.closest(".win-close")) win.close();
      });
    } else {
      document.addEventListener("click", e => {
        const t = e.target.closest(".light");
        if (!t) return;
        if (t.classList.contains("red"))        win.close();
        else if (t.classList.contains("amber")) win.minimize();
        else if (t.classList.contains("green")) win.isMaximized().then(m => m ? win.unmaximize() : win.maximize());
      });
    }
  }

  // ── OMP_BRIDGE public API ─────────────────────────────────────────────────
  window.OMP_BRIDGE = {
    get isConnected() { return !!window.__TAURI__ && !!activeSessionId; },

    // ── Messaging ────────────────────────────────────────────────────────────
    // A recognized command may resolve as `agentInvoked: false` — omp ran
    // it locally (its command_output note is already tagged `localOnly`,
    // see _pushAssistantNote) with no persisted turn of its own. This
    // bubble needs the same tag, or the next get_messages merge (tab
    // switch) gives its slot to a later, unrelated turn instead of keeping
    // it in place. Only tracked via the extra id-correlated round trip for
    // a recognized command — an ordinary prompt is the overwhelmingly
    // common case and stays a plain fire-and-forget send.
    send(text, images) {
      const userMsg = { kind: "user", time: timeNow(), text, images: images ?? [] };
      state.messages = [...state.messages, userMsg];
      notify();
      if (isSlashCommand(state.commands, text)) {
        _sendWithResponse({ type: "prompt", message: text, images: images ?? [] })
          .then((data) => {
            if (data?.agentInvoked === false) {
              userMsg.localOnly = true;
              notify();
            }
          })
          .catch(() => {}); // a real failure is already surfaced via the normal response/error path
      } else {
        _send({ type: "prompt", message: text, images: images ?? [] });
      }
    },
    abort()            { _send({ type: "abort" }); },
    // Both tagged `pendingEcho`: omp doesn't inject a follow-up until the
    // agent would otherwise stop, and defers a steer until the current
    // turn's tool batch finishes — so either bubble is usually no longer
    // the tail by the time its message_start echo arrives. The echo
    // handler reconciles by content match instead of assuming it's last.
    //
    // Both also route a real slash command through `prompt` with the
    // matching `streamingBehavior` instead of their own dedicated RPC
    // command: omp's `steer`/`follow_up` frames skip command dispatch
    // entirely (only `prompt` runs it), so a command sent mid-stream
    // through the dedicated frame would just reach the model as literal
    // text — this is the transport's problem, not something callers
    // (app-live.jsx) should each have to know and check for themselves.
    followUp(text, images) {
      const userMsg = { kind: "user", time: timeNow(), text, images: images ?? [], pendingEcho: true };
      state.messages = [...state.messages, userMsg];
      notify();
      if (isSlashCommand(state.commands, text)) {
        _send({ type: "prompt", message: text, images: images ?? [], streamingBehavior: "followUp" });
      } else {
        _send({ type: "follow_up", message: text, images: images ?? [] });
      }
    },
    steer(text, images) {
      const userMsg = { kind: "user", time: timeNow(), text, images: images ?? [], pendingEcho: true };
      state.messages = [...state.messages, userMsg];
      notify();
      if (isSlashCommand(state.commands, text)) {
        _send({ type: "prompt", message: text, images: images ?? [], streamingBehavior: "steer" });
      } else {
        _send({ type: "steer", message: text, images: images ?? [] });
      }
    },
    setModel(model)    { _send({ type: "set_model", provider: model.provider, modelId: model.id }); },
    cycleModel()       { _send({ type: "cycle_model" }); },
    cycleThinking()    { _send({ type: "cycle_thinking_level" }); },
    compact() {
      const id  = "cmpct-" + (_nextCmdId++);
      state.messages = [...state.messages, { kind: "compact", status: "pending", id, time: timeNow() }];
      notify();
      _send({ type: "compact", id });
    },
    newSession()       { _send({ type: "new_session" }); },
    exportHtml()       { _send({ type: "export_html" }); },
    refreshModels()    { _initFetch(); },

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
      const res = await _sendWithResponse({ type: "login", providerId }, 300000);
      if (seededProfile) {
        await _invokeSafe("clear_profile_bootstrap", { id: seededProfile }, null);
      }
      return res;
    },

    /**
     * Respond to a pending ask bubble (extension_ui_request method=select).
     * Marks the message as answered in state so it survives subsequent notify() calls,
     * then sends the extension_ui_response to omp — but only if a matching,
     * still-open ask message actually existed. Re-answer-proof: a second
     * call for an id that's already answered/cancelled (double-click race,
     * a stale button clicked after the runtime's own `cancel` event already
     * landed, or a message rehydrated post-answer from get_messages) is a
     * silent no-op instead of forwarding a second `extension_ui_response`
     * for a request omp has already resolved. Proven with an eval-kernel
     * cell (7/7 cases: normal send, double-click no-resend, answering a
     * cancelled ask, unknown id, rehydrated-already-answered message).
     * @param {string} id     The extension_ui_request id.
     * @param {string} value  The chosen option text or custom typed answer.
     */
    answerAsk(id, value) {
      _resolveAsk(id, { answered: true, answer: value }, { value });
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
      _resolveAsk(
        id,
        { answered: true, answer: confirmed ? "Confirm" : "Deny" },
        { confirmed },
      );
    },

    /**
     * User-initiated decline of a pending ask (e.g. the Cancel button on an
     * `input`/`editor` dialog) — distinct from the runtime's own
     * `extension_ui_request.cancel` event, but resolved the same way on
     * both the local message (marked `cancelled`) and the wire
     * (`{cancelled: true}`). Same re-answer-proof guard as `answerAsk`.
     * @param {string} id
     */
    cancelAsk(id) {
      _resolveAsk(id, { cancelled: true }, { cancelled: true });
    },

    /**
     * Push a system-generated assistant message into the session message log.
     * Writes to state.messages (not just React state) so it survives subsequent
     * notify() calls from live event processing (e.g. model registry refresh).
     * @param {string} text  Markdown text.
     */
    addAssistantMessage(text) {
      state.messages = [...state.messages, {
        kind: "assistant",
        time: timeNow(),
        model: state.model?.name ?? null,
        blocks: [{ type: "text", text }],
        thought: null, lead: null, streaming: false, completed: true,
      }];
      notify();
    },

    // ── Tool-approval rules ──────────────────────────────────────────────────
    // Backed by src-tauri/src/approval.rs::RuleBook. A rule only ever
    // auto-answers "Approve" for an exact "Allow tool: X" prompt shape —
    // see the module doc comment there. Session scope is in-memory (dies
    // with the tab's omp process); project scope persists to disk keyed by
    // a hash of the active tab's project path.

    /** Grant standing approval for `tool` in the active session/project.
     *  `scope` is `"session"` or `"project"`. */
    async grantApprovalRule(tool, scope) {
      if (!activeSessionId) return;
      await _invokeSafe("approval_rules_grant", {
        sessionId: activeSessionId, projectRoot: _activeProjectPath(), tool, scope,
      });
    },

    /** Revoke a previously granted rule. No-op if it wasn't granted. */
    async revokeApprovalRule(tool, scope) {
      if (!activeSessionId) return;
      await _invokeSafe("approval_rules_revoke", {
        sessionId: activeSessionId, projectRoot: _activeProjectPath(), tool, scope,
      });
    },

    /** List rules currently in effect for the active session/project. */
    async listApprovalRules() {
      if (!activeSessionId) return [];
      const rules = await _invokeSafe("approval_rules_list", {
        sessionId: activeSessionId, projectRoot: _activeProjectPath(),
      }, []);
      return rules || [];
    },

    // ── Workspace changes (git status/diff for the active tab's project) ────
    // Backed by src-tauri/src/workspace.rs. Bounded/capped server-side —
    // see that module's doc comments for the exact caps.

    /** Bounded `git status` for the active tab's project. */
    async workspaceStatus() {
      const path = _activeProjectPath();
      const empty = { files: [], truncated: false };
      if (!path) return empty;
      return _invokeSafe("workspace_status", { path }, empty);
    },

    /** Bounded diff of one file (relative to the project root) against HEAD. */
    async workspaceDiff(relPath) {
      const path = _activeProjectPath();
      if (!path) return null;
      return _invokeSafe("workspace_diff", { path, relPath }, null);
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

    /** Cross-session usage statistics (all projects/profiles) — see
     *  usage_stats in lib.rs / stats.rs::fetch. Unlike the workspace
     *  methods above, this is not scoped to the active tab's project. */
    async usageStats() {
      const empty = { overall: null, byModel: [], byFolder: [], byAgentType: [] };
      return _invokeSafe("usage_stats", {}, empty);
    },

    // ── Session management ───────────────────────────────────────────────────

    /** Open a new tab for the given project folder, under the *active tab's*
     *  profile: opening a second folder while working in "work" almost
     *  always means another work tab, and the selector makes switching it
     *  explicit. With no tab open there is nothing to inherit, so the ticked
     *  default profile applies. Returns the new session id, or rejects if
     *  the resolved profile no longer exists on the backend (unlisted by
     *  another window, or a hand-edited profiles.json) — no tab is left
     *  registered when that happens. */
    async openSession(cwd) {
      return _startProjectSession(cwd, { profile: _activeProfileId() });
    },

    /** Switch the active tab. Resets state and re-fetches from the session's omp. */
    async activateSession(id) {
      if (id === activeSessionId) return;
      if (!sessionRegistry.has(id)) return;
      // A profile respawn for this tab is still in flight (see
      // switchSessionProfile): the session doesn't exist on the backend yet
      // (start_session hasn't resolved), so listen/replay_events/get_state
      // would all target an id nothing is listening on. Drop the click —
      // switchSessionProfile's own reclaim logic re-activates this tab once
      // the respawn resolves (or, if the user is on a different tab by
      // then, it simply stays backgrounded like any other tab). Chosen over
      // relaxing the `wasActive && activeSessionId === null` reclaim test,
      // which would let this call and the in-flight respawn's own reclaim
      // both call _switchToSession(id) for the same tab.
      if (_profileSwitching.has(id)) {
        console.warn(`[live] ignoring activateSession('${id}') — profile respawn in flight`);
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
      const sessions = await _invokeSafe("list_saved_sessions", {
        cwd: cwd || null, profile: _activeProfileId(),
      }, []);
      return sessions || [];
    },

    /** Return the full keybinding payload for the active tab's profile.
     *  Resolves to the `Payload` struct or `null` on error (network or
     *  corrupt overlay — the frontend falls back to omp + registry defaults). */
    async listKeybindings() {
      return _invokeSafe("keybindings_list", { profile: _activeProfileId() }, null);
    },

    /** Bind `action` to `keys` in the desktop overlay. Resolves to
     *  `{ok:true, value: Payload}` or `{ok:false, error: string}`. */
    async setKeybinding(action, keys) {
      return _invokeResult("keybindings_set", { action, keys, profile: _activeProfileId() });
    },

    /** Remove `action` from the desktop overlay (reset to omp/default).
     *  Resolves to `{ok:true, value: Payload}` or `{ok:false, error: string}`. */
    async resetKeybinding(action) {
      return _invokeResult("keybindings_reset", { action, profile: _activeProfileId() });
    },

    /** Resume a saved session into a new tab, under the active tab's profile
     *  (the profile whose sessions directory the entry was listed from).
     *  Returns the new session id, null if `session` doesn't reference a
     *  valid saved-session path, or rejects if the resolved profile no
     *  longer exists on the backend (see `openSession`). */
    async resumeSession(session) {
      if (!session || !session.path) return null;
      const cwd = session.cwd || "";
      const name = session.title || _tabNameFor(cwd, "resumed");
      return _startProjectSession(cwd, {
        resume: session.path, name, color: "var(--cyan)", profile: _activeProfileId(),
      });
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
      if (raced) console.warn(`[live] deleteProfile('${id}') raced with a new tab: ${raced}`);
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

    /** Switch one tab to another profile. A profile is fixed at spawn, so the
     *  tab keeps its id/name/path but its omp process is replaced and its
     *  transcript dropped — it comes back as a fresh session. Resolves to
     *  `{ok}` or `{ok: false, error}` on every path so the menu can render a
     *  refusal (unlisted target profile, a respawn already in flight, a
     *  failed respawn) instead of dropping it silently.
     *
     *  Not unit-tested directly: every step is a Tauri IPC call or an event
     *  listener mutation and there is no fake `__TAURI__` harness in this
     *  repo. The pure decisions it leans on are extracted and proven
     *  separately (`_resolveProfile`, `_shouldStampLaunchProfile`); what
     *  remains is ordering, and the comments inside state why each await
     *  sits where it does. */
    async switchSessionProfile(id, profileId) {
      if (!window.__TAURI__) return { ok: false, error: "not connected" };
      const entry = sessionRegistry.get(id);
      if (!entry) return { ok: false, error: "unknown tab" };
      if (entry.profile === profileId) return { ok: true }; // already on this profile
      if (!profiles.some(p => p.id === profileId)) {
        const error = `unknown profile '${profileId}'`;
        console.warn(`[live] ${error} — ignoring switch`);
        return { ok: false, error };
      }
      // Re-entrancy: this call spans two awaits, and a second pick on the same
      // tab would read `wasActive` as false (call 1 already nulled the active
      // slot), so it would never re-activate or `_initFetch` the process it
      // spawned - leaving the tab attached to a live child whose opening
      // envelopes were all dropped as `seq <= lastSeq` against the previous
      // incarnation's journal.
      if (_profileSwitching.has(id)) {
        return { ok: false, error: "a profile switch is already in progress for this tab" };
      }
      _profileSwitching.add(id);
      try {
        // Awaited: `stop_session` must have removed the old incarnation from
        // the backend's session map before `_spawnSession` installs the new
        // one under the same id, or the late remove would reap the fresh
        // process. See `_killSessionProcess`.
        await _killSessionProcess(id);
        // The tab may have been closed inside that round-trip: `closeSession`
        // has no `_profileSwitching` guard, so it can `sessionRegistry.delete`
        // this id while we are waiting. Writing the captured `entry` back
        // below would then *resurrect* the deleted tab — and the
        // `!sessionRegistry.has(id)` check after the spawn (which exists for
        // the very same hazard one window later) would find the resurrected
        // entry, skip its cleanup, and leave a live omp child bound to a tab
        // the user closed. `_killSessionProcess` above already released the
        // process and the git watcher, so bailing here leaks nothing.
        if (!sessionRegistry.has(id)) {
          return { ok: false, error: "tab closed" };
        }
        // Both re-read *after* that round-trip, never before it. It is a real
        // IPC gap and `_profileSwitching` only blocks re-entry for this id, so
        // a click on another tab can run `_switchToSession(other)` inside it —
        // whose first act is `_saveCurrentSession()`, and `activeSessionId` is
        // still this id at that moment. That both moves the active slot (so a
        // `wasActive` captured earlier is stale and would detach the tab the
        // user just picked) and re-creates the very snapshot
        // `_killSessionProcess` just deleted.
        const wasActive = id === activeSessionId;
        sessionRegistry.set(id, { ...entry, profile: profileId, branch: null });
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
          await _spawnSession(id, entry.path, { profile: profileId });
        } catch (e) {
          spawnError = e?.message ?? String(e);
          console.error("[live] profile respawn failed:", e);
        }

        // The tab may have been closed during the spawn. `closeSession` ran
        // its whole teardown against a session whose respawn was still in
        // flight, so everything below would wire the closed tab back up
        // *behind* that teardown: a phantom active tab, a leaked
        // `git://branch/{id}` listener, a `start_git_watch` issued after the
        // matching `stop_git_watch`, and `_send` routed to an orphaned child
        // no teardown path can reach. Undo our own spawn instead.
        if (!sessionRegistry.has(id)) {
          _killSessionProcess(id);
          // `closeSession` saw `activeSessionId === null` (this switch had
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
          // "Agent failed to start" with this same text. A refused profile is
          // rejected by `store.resolve` before the bridge spawns anything, so
          // nothing is cached and this note is the only report there is.
          const cached = spawnError && activeSessionId === id
            ? await _invokeSafe("session_status", { sessionId: id }, null)
            : null;
          if (spawnError && activeSessionId === id && !cached) {
            _pushAssistantNote(`**Profile switch failed:** ${spawnError}`);
          }
        }
        notify();
        return spawnError ? { ok: false, error: spawnError } : { ok: true };
      } finally {
        _profileSwitching.delete(id);
      }
    },

    /** Close a tab and kill its omp process. */
    async closeSession(id) {
      _killSessionProcess(id);
      sessionRegistry.delete(id);
      if (id === activeSessionId) {
        const remaining = [...sessionRegistry.keys()];
        if (remaining.length > 0) {
          await _switchToSession(remaining[remaining.length - 1]);
        } else {
          // No sessions left — reset to empty state
          await _detachActiveSession();
          notify();
        }
      } else {
        notify(); // tab list changed
      }
    },

    /** Open native folder picker and return the chosen path (or null). */
    async pickFolder() {
      if (!window.__TAURI__) return null;
      return window.__TAURI__.core.invoke("open_project");
    },

    /** List project-relative file/dir paths matching `query`, for the
     *  composer's `@`-mention autocomplete. Scoped to the active tab's
     *  project path; returns [] for the pathless "default" session (no
     *  project root to search) or when the RPC throws. */
    async listFiles(query, limit = 30) {
      const cwd = _activeProjectPath();
      if (!cwd) return [];
      return _invokeSafe("list_project_files", { cwd, query, limit }, []);
    },

    /** Subscribe to state snapshots. Returns an unsubscribe function. */
    onUpdate(cb) {
      subscribers.add(cb);
      cb(_buildSnapshot());
      return () => subscribers.delete(cb);
    },

    getState() { return state; },
  };

  // ── Connect to Tauri IPC ──────────────────────────────────────────────────
  if (window.__TAURI__) {
    document.documentElement.classList.add("tauri-native");

    // Register the "default" session that lib.rs::setup already started.
    // `setup` spawns it under the *ticked* startup profile, which only
    // `profiles.json` knows - so the id here is provisional and corrected
    // below once the list arrives.
    sessionRegistry.set("default", {
      id: "default", name: "OMP Desktop", path: "", color: "var(--accent)", branch: null,
      profile: DEFAULT_PROFILE_ID,
    });

    // Load the persisted profile list + ticked default so the selector can
    // label tabs (fire-and-forget: it notifies once the list arrives), then
    // stamp the launch tab with the profile its process actually runs under.
    // Without this the chip would claim "default" while the child writes to
    // `~/.omp/profiles/work/agent`, and the history panel - which scopes its
    // query by the tab's profile - would query the wrong tree.
    const profilesReady = _refreshProfiles().then(() => {
      const entry = sessionRegistry.get("default");
      if (entry && _shouldStampLaunchProfile(entry.profile, startupProfileId)) {
        sessionRegistry.set("default", { ...entry, profile: startupProfileId });
        notify();
      }
    });

    // Activate it — registers listener + fetches initial state
    const launchReady = _switchToSession("default");

    // OS folder-open requests, drained only after both of the above: a
    // cold-start "Open with" is already queued in Rust, and opening it
    // early would race the launch tab's own activation (which the open may
    // then retire) and inherit the *provisional* built-in profile instead
    // of the ticked startup one.
    // `allSettled`, not `all`: neither failure may disable folder opens. It
    // also marks both promises handled, so a rejection that used to surface
    // as an unhandled one is only visible if logged here.
    Promise.allSettled([profilesReady, launchReady]).then(results => {
      for (const r of results) {
        if (r.status === "rejected") console.error("[live] startup step failed:", r.reason);
      }
      _setupExternalOpens();
    });

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

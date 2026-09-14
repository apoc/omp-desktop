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

  // ── Safe defaults so design components never crash on missing fields ──────
  const DEFAULT_DATA = {
    projects: [],
    messages: [],
    kanban: [],
    planMeta: { ask: "", strategy: "", touches: [], branch: "main", risks: [], estimate: { tokens: "—", cost: "—", wall: "—" } },
    commands: [
      { name: "plan",     hint: "draft a plan before writing code",   icon: "◇", group: "Mode"    },
      { name: "steer",    hint: "interrupt and redirect mid-tool",    icon: "↺", group: "Mode"    },
      { name: "compact",  hint: "compact context window",             icon: "▤", group: "Session" },
      { name: "new",      hint: "start a fresh session (history kept on disk)", icon: "↺", group: "Session" },
      { name: "history",  hint: "browse and resume saved sessions",   icon: "◷", group: "Session" },
      { name: "branch",   hint: "fork the session from current head", icon: "⑂", group: "Session" },
      { name: "model",    hint: "switch model",                       icon: "◉", group: "Agent"   },
      { name: "thinking", hint: "cycle thinking level",               icon: "✶", group: "Agent"   },
      { name: "login",    hint: "authenticate with a model provider",   icon: "⊙", group: "Agent"   },
      { name: "todo",     hint: "open the kanban surface",            icon: "▦", group: "View"    },
      { name: "export",   hint: "export this session to HTML",        icon: "⇪", group: "View"    },
    ],
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
  let pendingAskBubble = null;   // buffered until tool_execution_start so order is [tool_card, ask_bubble]
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
  // { id, name, path, color, branch }
  const sessionRegistry = new Map();
  const sessionSnapshots = new Map(); // id -> saved state + volatile vars
  const gitListeners = new Map();  // session_id → Tauri unlisten fn for git://branch/{id}

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
  function _pushAssistantNote(text) {
    state.messages = [...state.messages, {
      kind: "assistant",
      time: timeNow(),
      model: state.model?.name ?? null,
      blocks: [{ type: "text", text }],
      thought: null, lead: null, streaming: false, completed: true,
    }];
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
      activity:      [],
      sparkline:     Array(30).fill(0),
      projects:      [],
      rpcState:      null,
      sessionCost:   null,
      currentTps:    0,
      exitReason:    null,
    });
    streamingBubble = null;
    pendingAskBubble = null;
    activeToolCards = new Map();
    tpsSamples      = Array(30).fill(0);
    turnStartTime   = null;
    activityLog     = [];
    lastSeq         = 0;
  }

  // ── Session snapshot helpers ──────────────────────────────────────────────
  function _saveCurrentSession() {
    if (!activeSessionId) return;
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
        _pushAssistantNote(`**Agent process exited:** ${reason}`);
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
    // listeners, so a spawn failure (e.g. omp not on PATH) would
    // otherwise be invisible. session_status returns the cached error
    // synchronously — no event timing race.
    try {
      const startupError = await window.__TAURI__.core.invoke("session_status", { sessionId: id });
      if (_switchGen !== myGen) return; // superseded by a newer switch
      if (startupError) {
        console.warn(`[live] session '${id}' startup error: ${startupError}`);
        _pushAssistantNote(`**Agent failed to start:** ${startupError}`);
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

  /** Spawn omp for `cwd` (optionally resuming a saved session), register the
   *  tab, wire the git-branch watcher, and activate it. Shared by
   *  `openSession` (new project tab) and `resumeSession` (resume from disk)
   *  so the git-watch/listener wiring only lives in one place.
   *
   *  This function is side-effectful (Tauri IPC invoke, event listeners) and
   *  not unit-tested directly. The one pure decision it makes — deriving
   *  `tabName` from `cwd`/`name` — mirrors `resumeSession`'s name/cwd
   *  fallback and is covered by an eval-kernel proof cell (10/10 cases,
   *  including the pre-existing trailing-slash quirk inherited from
   *  master's `openSession`) run during PR #4 review remediation. */
  async function _startProjectSession(cwd, { resume = null, name = null, color = "var(--lilac)" } = {}) {
    const id = `session-${Date.now()}`;
    const tabName = name || (cwd ? cwd.replace(/\\/g, "/").split("/").pop() || cwd : "new session");
    // Register in tab list before starting omp so the tab shows immediately.
    // Register with null branch — chip hidden until git resolves.
    sessionRegistry.set(id, { id, name: tabName, path: cwd ?? "", color, branch: null });
    await window.__TAURI__.core.invoke("start_session", {
      sessionId: id, cwd: cwd ?? "", resume,
    });
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
      gitListeners.set(id, unlisten);
    }
    // Activate
    await _switchToSession(id);
    return id;
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
      const pending = [...completed];
      const merged = [];
      for (const m of state.messages) {
        if (m.streaming) continue; // streaming bubble handled separately below
        if (m.kind === "tool" || m.kind === "ask" || m.kind === "compact") {
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

  // ── AgentSessionEvent handler ─────────────────────────────────────────────
  function _handleEvent(ev) {
    const { type } = ev;
    const now  = Date.now();
    const time = timeNow();


    if (type === "extension_ui_request") {
      // URL to open in the system browser (e.g. OAuth auth page).
      if (ev.method === "open_url") {
        // In Tauri, window.open() creates a webview rather than opening the system
        // browser. Use the open_url_external Rust command (open crate → ShellExecute
        // on Windows) so OAuth URLs open in the user's actual browser.
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
      // directly rather than buffered like `select` below — unlike the ask
      // tool's select, a generic input() call from extension code has no
      // guaranteed following tool_execution_start to flush against, so
      // buffering it could leave the card permanently invisible. Wire
      // shape: request carries {title, placeholder}, response is
      // {value: <text>} or {cancelled: true}.
      if (ev.method === "input") {
        state.messages = [...state.messages, _askMessage("input", ev, {
          placeholder: ev.placeholder ?? "Enter value…",
        })];
        notify();
        return;
      }
      // Agent asks the user to pick from a list.
      // Buffered in pendingAskBubble instead of pushed immediately — omp emits
      // extension_ui_request.select BEFORE tool_execution_start, so pushing now
      // would place the ask bubble above the tool card. tool_execution_start
      // flushes it so the order is always [tool_card, ask_bubble].
      if (ev.method === "select") {
        const OTHER_OPT = "Other (type your own)";
        pendingAskBubble = _askMessage("select", ev, {
          options: (ev.options ?? []).filter(o => o !== OTHER_OPT),
        });
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
        // If the ask was cancelled before tool_execution_start flushed it, just drop it.
        if (pendingAskBubble && pendingAskBubble.id === ev.targetId) {
          pendingAskBubble = null;
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
        const blocks = Array.isArray(msg.content) ? msg.content : [];
        const text = blocks.filter(b => b.type === "text").map(b => b.text ?? "").join("\n").trim();
        if (text) {
          const last = state.messages[state.messages.length - 1];
          if (!(last?.kind === "user" && last.text === text)) {
            state.messages = [...state.messages, { kind: "user", time, text }];
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
      // Flush any pending ask bubble AFTER the tool card so chat order is
      // [tool_card, ask_bubble] — omp emits select before tool_execution_start.
      if (pendingAskBubble) {
        state.messages = [...state.messages, pendingAskBubble];
        pendingAskBubble = null;
      }

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
      if (e.target.closest("button, .chrome-lights, .win-controls")) return;
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
    send(text, images) {
      const userMsg = { kind: "user", time: timeNow(), text };
      state.messages = [...state.messages, userMsg];
      notify();
      _send({ type: "prompt", message: text, images: images ?? [] });
    },
    abort()            { _send({ type: "abort" }); },
    followUp(text)     { _send({ type: "follow_up", message: text }); },
    steer(text) {
      const userMsg = { kind: "user", time: timeNow(), text };
      state.messages = [...state.messages, userMsg];
      notify();
      _send({ type: "steer", message: text, images: [] });
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
     * @param {string} providerId
     */
    login(providerId) {
      return _sendWithResponse({ type: "login", providerId }, 300000);
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

    // ── Session management ───────────────────────────────────────────────────

    /** Open a new tab for the given project folder. Returns the new session id. */
    async openSession(cwd) {
      return _startProjectSession(cwd);
    },

    /** Switch the active tab. Resets state and re-fetches from the session's omp. */
    async activateSession(id) {
      if (id === activeSessionId) return;
      if (!sessionRegistry.has(id)) return;
      await _switchToSession(id);
    },

    /** List saved sessions on disk (~/.omp/agent/sessions). */
    async listSavedSessions(cwd = null) {
      const sessions = await _invokeSafe("list_saved_sessions", { cwd: cwd || null }, []);
      return sessions || [];
    },

    /** Resume a saved session into a new tab. Returns the new session id,
     *  or null if `session` doesn't reference a valid saved-session path. */
    async resumeSession(session) {
      if (!session || !session.path) return null;
      const cwd = session.cwd || "";
      const name = session.title || (cwd ? cwd.replace(/\\/g, "/").split("/").pop() || cwd : "resumed");
      return _startProjectSession(cwd, { resume: session.path, name, color: "var(--cyan)" });
    },

    /** Close a tab and kill its omp process. */
    async closeSession(id) {
      if (window.__TAURI__) {
        window.__TAURI__.core.invoke("stop_session",   { sessionId: id }).catch(() => {});
        window.__TAURI__.core.invoke("stop_git_watch", { sessionId: id }).catch(() => {});
      }
      const gitUnlisten = gitListeners.get(id);
      if (gitUnlisten) { gitUnlisten(); gitListeners.delete(id); }
      sessionRegistry.delete(id);
      sessionSnapshots.delete(id);
      if (id === activeSessionId) {
        const remaining = [...sessionRegistry.keys()];
        if (remaining.length > 0) {
          await _switchToSession(remaining[remaining.length - 1]);
        } else {
          // No sessions left — reset to empty state
          for (const ul of activeListeners) { try { await ul(); } catch (_) {} }
          activeListeners = [];
          activeSessionId = null;
          _resetSessionVars();
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

    // Register the "default" session that lib.rs::setup already started
    sessionRegistry.set("default", {
      id: "default", name: "OMP Desktop", path: "", color: "var(--accent)", branch: null,
    });

    // Activate it — registers listener + fetches initial state
    _switchToSession("default");

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

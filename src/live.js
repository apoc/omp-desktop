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
      { name: "branch",   hint: "fork the session from current head", icon: "⑂", group: "Session" },
      { name: "model",    hint: "switch model",                       icon: "◉", group: "Agent"   },
      { name: "thinking", hint: "cycle thinking level",               icon: "✶", group: "Agent"   },
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
    thinkingLevel:  "auto",
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
  };

  let streamingBubble = null;
  let activeToolCards = new Map();    // toolCallId → message index
  let tpsSamples      = Array(30).fill(0);
  let turnStartTime   = null;
  let activityLog     = [];           // [{ts, toolName}], pruned to 60s

  // ── Session registry ───────────────────────────────────────────────────────
  // Tracks all open tabs. The tab list in the UI is derived from this.
  // { id, name, path, color, branch }
  const sessionRegistry = new Map();
  const sessionSnapshots = new Map(); // id -> saved state + volatile vars

  let activeSessionId  = null;
  let activeListeners  = [];          // unlisten functions for current session

  // ── Subscriber system ─────────────────────────────────────────────────────
  const subscribers = new Set();

  function notify() {
    const snap = {
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
      // Tab list — derived from session registry, not per-session state
      sessions:        [...sessionRegistry.values()],
      activeSessionId,
    };
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
      thinkingLevel: "auto",
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
    });
    streamingBubble = null;
    activeToolCards = new Map();
    tpsSamples      = Array(30).fill(0);
    turnStartTime   = null;
    activityLog     = [];
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
      // volatile vars
      streamingBubble,
      activeToolCards: new Map(activeToolCards),
      tpsSamples:    [...tpsSamples],
      turnStartTime,
      activityLog:   [...activityLog],
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
    });
    streamingBubble = snap.streamingBubble;
    activeToolCards = snap.activeToolCards;
    tpsSamples      = snap.tpsSamples;
    turnStartTime   = snap.turnStartTime;
    activityLog     = snap.activityLog;
    return true;
  }

  // ── Session switching ─────────────────────────────────────────────────────
  async function _switchToSession(id) {
    if (!window.__TAURI__) return;

    // Snapshot current session so we can restore it when switching back
    _saveCurrentSession();

    // Tear down old listeners
    for (const ul of activeListeners) { try { await ul(); } catch (_) {} }
    activeListeners = [];

    activeSessionId = id;

    // Restore cached snapshot (preserves streaming messages) or start fresh
    if (!_restoreSession(id)) {
      _resetSessionVars();
    }

    const { listen } = window.__TAURI__.event;
    const ulLine = await listen(`agent://line/${id}`, ev => handleLine(ev.payload));
    const ulExit = await listen(`agent://exit/${id}`, () => {
      console.warn(`[live] session '${id}' omp process exited`);
      state.isStreaming = false;
      notify();
    });
    activeListeners = [ulLine, ulExit];

    // Re-fetch to pick up events missed while not listening.
    // get_messages handler merges completed turns with the cached streaming bubble.
    _initFetch();
    notify();
  }

  // ── RPC line handler ──────────────────────────────────────────────────────
  function handleLine(rawLine) {
    let obj;
    try { obj = JSON.parse(rawLine); } catch { return; }
    if (!obj || typeof obj !== "object") return;

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
    if (!resp.success) return;
    const { command, data } = resp;

    if (command === "get_state") {
      _applyRpcState(data);

    } else if (command === "get_messages") {
      const completed = window.adaptAgentMessages(data.messages ?? []);
      // Preserve any in-progress streaming bubble — omp doesn't persist
      // incomplete turns, so get_messages won't include it.
      state.messages = streamingBubble
        ? [...completed, streamingBubble]
        : completed;
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
    const time = _timeNow();

    if (type === "extension_ui_request") {
      const NEEDS_RESPONSE = ["select", "confirm", "input", "editor"];
      if (NEEDS_RESPONSE.includes(ev.method)) {
        _send({ type: "extension_ui_response", id: ev.id, cancelled: true });
      }
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
      state.messages = [...state.messages.slice(0, -1), updated];
      notify();
      return;
    }

    if (type === "message_end") {
      const msg = ev.message;
      if (streamingBubble && msg) {
        const blocks = Array.isArray(msg.content) ? msg.content : [];
        const thought = blocks.find(b => b.type === "thinking")?.thinking ?? streamingBubble.thought;
        const designBlocks = blocks.filter(b => b.type === "text" && b.text?.trim()).map(b => ({ type: "text", text: b.text }));
        state.messages = [...state.messages.slice(0, -1), {
          ...streamingBubble,
          streaming: false, thought,
          lead:   thought ? "thinking" : null,
          blocks: designBlocks.length > 0 ? designBlocks : streamingBubble.blocks,
        }];
        streamingBubble = null;
      } else if (streamingBubble) {
        state.messages = [...state.messages.slice(0, -1), { ...streamingBubble, streaming: false }];
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

      activityLog.push({ ts: now, toolName: ev.toolName ?? "" });
      const cutoff = now - 60_000;
      while (activityLog.length && activityLog[0].ts < cutoff) activityLog.shift();
      state.activity = window.buildActivityFromLog(activityLog);
      notify();
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
    _send({ type: "get_state" });
    _send({ type: "get_messages" });
    _send({ type: "get_available_models" });
  }

  // ── Send a command to the active session's omp ────────────────────────────
  function _send(cmd) {
    if (!window.__TAURI__ || !activeSessionId) return;
    window.__TAURI__.core
      .invoke("send_command", { sessionId: activeSessionId, json: JSON.stringify(cmd) })
      .catch(e => console.error("[live] send error:", e));
  }

  // ── Window chrome (drag + controls) ──────────────────────────────────────
  function _setupWindowChrome() {
    if (!window.__TAURI__) return;
    const { getCurrentWindow } = window.__TAURI__.window;
    const win  = getCurrentWindow();
    const isWin = navigator.userAgent.includes("Windows") || navigator.platform.startsWith("Win");

    const chrome = document.querySelector(".chrome");
    if (chrome) {
      chrome.addEventListener("mousedown", e => {
        if (e.target.closest("button, .chrome-lights, .win-controls")) return;
        win.startDragging().catch(() => {});
      });
    }

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
      const userMsg = { kind: "user", time: _timeNow(), text };
      state.messages = [...state.messages, userMsg];
      notify();
      _send({ type: "prompt", message: text, images: images ?? [] });
    },
    abort()            { _send({ type: "abort" }); },
    followUp(text)     { _send({ type: "follow_up", message: text }); },
    setModel(model)    { _send({ type: "set_model", provider: model.provider, modelId: model.id }); },
    cycleModel()       { _send({ type: "cycle_model" }); },
    setThinking(level) { _send({ type: "set_thinking_level", level }); },
    compact()          { _send({ type: "compact" }); },
    newSession()       { _send({ type: "new_session" }); },
    exportHtml()       { _send({ type: "export_html" }); },
    refreshModels()    { _initFetch(); },

    // ── Session management ───────────────────────────────────────────────────

    /** Open a new tab for the given project folder. Returns the new session id. */
    async openSession(cwd) {
      const id   = `session-${Date.now()}`;
      const name = cwd ? cwd.replace(/\\/g, "/").split("/").pop() || cwd : "new session";
      // Register in tab list before starting omp so the tab shows immediately
      sessionRegistry.set(id, { id, name, path: cwd ?? "", color: "var(--lilac)", branch: "main" });
      // Spawn omp for this project
      await window.__TAURI__.core.invoke("start_session", {
        sessionId: id, cwd: cwd ?? "",
      });
      // Activate
      await _switchToSession(id);
      return id;
    },

    /** Switch the active tab. Resets state and re-fetches from the session's omp. */
    async activateSession(id) {
      if (id === activeSessionId) return;
      if (!sessionRegistry.has(id)) return;
      await _switchToSession(id);
    },

    /** Close a tab and kill its omp process. */
    async closeSession(id) {
      if (window.__TAURI__) {
        window.__TAURI__.core.invoke("stop_session", { sessionId: id }).catch(() => {});
      }
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
      cb({
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
        sessions:        [...sessionRegistry.values()],
        activeSessionId,
      });
      return () => subscribers.delete(cb);
    },

    getState() { return state; },
  };

  // ── Connect to Tauri IPC ──────────────────────────────────────────────────
  if (window.__TAURI__) {
    document.documentElement.classList.add("tauri-native");

    // Register the "default" session that lib.rs::setup already started
    sessionRegistry.set("default", {
      id: "default", name: "OMP Desktop", path: "", color: "var(--accent)", branch: "main",
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

  // ── Helpers ───────────────────────────────────────────────────────────────
  function _timeNow() {
    const d = new Date();
    return [d.getHours(), d.getMinutes(), d.getSeconds()].map(n => String(n).padStart(2, "0")).join(":");
  }
})();

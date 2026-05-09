/* live.js — Tauri IPC bridge + OMP_BRIDGE + OMP_DATA initialisation.
   Depends on: adapter.js (must load first).
   Exposes: window.OMP_DATA (for design components), window.OMP_BRIDGE (for app-live.jsx).

   Two modes:
     Tauri mode  — window.__TAURI__ present → connects to omp via IPC events/invoke
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
      todoEmpty:    "no plan yet. think out loud below.",
      radarHint:    "agent has been busy — last 60 seconds",
    },
  };

  window.OMP_DATA = JSON.parse(JSON.stringify(DEFAULT_DATA));

  // ── Mutable live state ────────────────────────────────────────────────────
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
    projects:       [...DEFAULT_DATA.projects],
    // internal
    rpcState:       null,
    sessionCost:    null,
    currentTps:     0,
    firstProjectId: null,   // set once; read by app-live.jsx to auto-select tab
  };

  // Activity log: [{ts: number, toolName: string}], pruned to 60s
  const activityLog = [];
  // TPS state
  let turnStartTime = null;
  // Rolling TPS sample buffer (30 samples)
  const tpsSamples = Array(30).fill(0);

  // Streaming assistant message being built (mutated in place during message_update)
  let streamingBubble = null;
  // toolCallId → index in state.messages
  const activeToolCards = new Map();

  // ── Subscriber system ─────────────────────────────────────────────────────
  const subscribers = new Set();

  function notify() {
    const snap = {
      messages:      state.messages,
      isStreaming:   state.isStreaming,
      model:         state.model,
      thinkingLevel: state.thinkingLevel,
      ctx:           state.ctx,
      kanban:        state.kanban,
      planMeta:      state.planMeta,
      models:        state.models,
      activity:      state.activity,
      sparkline:     state.sparkline,
      projects:      state.projects,
      firstProjectId: state.firstProjectId,
    };
    subscribers.forEach(cb => cb(snap));

    // Keep OMP_DATA in sync for design components that read it directly
    // (CommandBridge reads window.OMP_DATA.commands / .models at render time)
    window.OMP_DATA.messages  = state.messages;
    window.OMP_DATA.models    = state.models;
    window.OMP_DATA.kanban    = state.kanban;
    window.OMP_DATA.planMeta  = state.planMeta;
    window.OMP_DATA.ctx       = state.ctx;
    window.OMP_DATA.activity  = state.activity;
    window.OMP_DATA.projects  = state.projects;
  }

  // ── RPC line handler ──────────────────────────────────────────────────────
  function handleLine(rawLine) {
    let obj;
    try { obj = JSON.parse(rawLine); } catch { return; }
    if (!obj || typeof obj !== "object") return;

    const { type } = obj;

    if (type === "ready") {
      // Agent is up — fetch initial data
      _send({ type: "get_state" });
      _send({ type: "get_messages" });
      _send({ type: "get_available_models" });
      return;
    }

    if (type === "response") { _handleResponse(obj); return; }

    // All other types are AgentSessionEvent
    _handleEvent(obj);
  }

  // ── RPC response handler ──────────────────────────────────────────────────
  function _handleResponse(resp) {
    if (!resp.success) return;
    const { command, data } = resp;

    if (command === "get_state") {
      _applyRpcState(data);

    } else if (command === "get_messages") {
      state.messages = window.adaptAgentMessages(data.messages ?? []);
      notify();

    } else if (command === "get_available_models") {
      state.models = (data.models ?? []).map(m => ({
        id: m.id,
        name: m.name ?? window.MODEL_NAMES?.[m.id] ?? window.formatModelId(m.id),
        provider: m.provider,
        note: m.provider,
        latency: 0,
        current: state.rpcState?.model?.id === m.id,
      }));
      notify();

    } else if (command === "set_model") {
      // data: Model — update immediately so next notify() doesn't revert
      // the optimistic display set by handlePickModel in app-live.jsx.
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

    } else if (command === "get_session_stats") {
      // SessionStats exposes tokens.{input,output,...} — no cost field.
      // Cost is accumulated from turn_end.message.usage.cost.total instead.
    }
  }

  // Build a UI model entry from an RPC Model object (pi-ai Model type).
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
  // Field names from the verified oh-my-pi source:
  //   message_start/update/end  → ev.message: AgentMessage  (role, content[])
  //   tool_execution_*          → ev.toolName, ev.toolCallId, ev.args, ev.intent
  //   turn_end                  → ev.message (final assistant message)
  function _handleEvent(ev) {
    const { type } = ev;
    const now  = Date.now();
    const time = _timeNow();

    // extension_ui_request: interactive methods (select/confirm/input/editor)
    // block omp until the host responds. Auto-cancel them. Non-interactive ones
    // (setWidget, setStatus, setTitle, notify, set_editor_text, cancel) need no response.
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
      // Hoist usage out of the if-block so cost accumulation can read it too.
      // usage.output = output tokens; usage.cost.total = USD cost per turn.
      const usage = ev.message?.usage;
      if (turnStartTime) {
        const elapsed = (now - turnStartTime) / 1000;
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
    // message_start fires for user, assistant, and toolResult messages.
    // We handle user messages here (agent confirms what we sent),
    // and start a streaming bubble for assistant messages.
    if (type === "message_start") {
      const msg = ev.message;
      const role = msg?.role;

      if (role === "user") {
        // Extract text from the user message content
        const blocks = Array.isArray(msg.content) ? msg.content : [];
        const text = blocks
          .filter(b => b.type === "text")
          .map(b => b.text ?? "")
          .join("\n")
          .trim();
        if (text) {
          // Dedup: skip if we already added this text optimistically from send()
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

    // message_update carries ev.message (full accumulated content so far).
    // Use it directly — no need to track deltas manually.
    if (type === "message_update") {
      if (!streamingBubble) return;
      const msg = ev.message;
      if (!msg) return;

      const blocks = Array.isArray(msg.content) ? msg.content : [];
      let thought = null;
      const designBlocks = [];

      for (const block of blocks) {
        if (block.type === "thinking" && block.thinking?.trim()) {
          thought = block.thinking;
        } else if (block.type === "text" && block.text) {
          designBlocks.push({ type: "text", text: block.text });
        }
      }

      streamingBubble.thought = thought;
      streamingBubble.lead    = thought ? "thinking" : null;
      streamingBubble.blocks  = designBlocks.length > 0
        ? designBlocks
        : [{ type: "text", text: "" }];

      const updated = { ...streamingBubble, blocks: [...streamingBubble.blocks] };
      state.messages = [...state.messages.slice(0, -1), updated];
      notify();
      return;
    }

    // message_end: ev.message is the final complete message.
    if (type === "message_end") {
      const msg = ev.message;
      if (streamingBubble && msg) {
        const blocks = Array.isArray(msg.content) ? msg.content : [];
        const thought = blocks.find(b => b.type === "thinking")?.thinking ?? streamingBubble.thought;
        const designBlocks = blocks
          .filter(b => b.type === "text" && b.text?.trim())
          .map(b => ({ type: "text", text: b.text }));
        const final = {
          ...streamingBubble,
          streaming: false,
          thought,
          lead: thought ? "thinking" : null,
          blocks: designBlocks.length > 0 ? designBlocks : streamingBubble.blocks,
        };
        state.messages = [...state.messages.slice(0, -1), final];
        streamingBubble = null;
      } else if (streamingBubble) {
        state.messages = [...state.messages.slice(0, -1),
          { ...streamingBubble, streaming: false }];
        streamingBubble = null;
      }
      notify();
      return;
    }

    // ── Tool execution ────────────────────────────────────────────────────────
    // Correct fields: ev.toolName, ev.toolCallId, ev.args, ev.intent
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

          // todo_write result: phases live in ev.result?.details?.phases
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

    // ── Misc ──────────────────────────────────────────────────────────────────
    if (type === "agent_start" || type === "agent_end") {
      _send({ type: "get_state" });
    }
  }

  // ── Inject inline plan block into the most recent assistant message ────────
  function _injectInlinePlan(phases) {
    const idx = [...state.messages].reverse().findIndex(m => m.kind === "assistant");
    if (idx === -1) return;
    const realIdx = state.messages.length - 1 - idx;
    const msg     = state.messages[realIdx];

    // Skip if it already has a plan block
    if (msg.blocks?.some(b => b.type === "plan")) return;

    const planBlock = {
      type: "plan",
      title: "Plan",
      phases: phases.map(ph => ({
        id: ph.name,
        label: ph.name,
        tasks: ph.tasks.map((t, i) => ({
          id: `${ph.name}-${i}`,
          text: t.content,
          status: t.status === "completed" ? "done"
                : t.status === "abandoned"  ? "done"
                : t.status,
        })),
      })),
    };

    const msgs    = [...state.messages];
    msgs[realIdx] = { ...msg, blocks: [...(msg.blocks ?? []), planBlock] };
    state.messages = msgs;
  }

  // ── Apply RpcSessionState snapshot ───────────────────────────────────────
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
    // Keep models list current-flags in sync with the active model.
    if (rpcState.model && state.models.length > 0) {
      state.models = state.models.map(m => ({ ...m, current: m.id === rpcState.model.id }));
    }


    if (rpcState.todoPhases?.length > 0) {
      state.kanban   = window.buildKanban(rpcState.todoPhases);
      state.planMeta = window.buildPlanMeta(rpcState.todoPhases, rpcState);
    }

    // Derive project name from session metadata
    const sessionName = rpcState.sessionName
      ?? rpcState.sessionFile?.replace(/\\/g, "/").split("/").pop()?.replace(".jsonl", "")
      ?? "session";
    state.projects = [{
      id: "p1", name: sessionName, path: "",
      color: "var(--accent)",
      branch: rpcState.sessionFile?.replace(/\\/g, "/").split("/").pop()?.replace(".jsonl", "") ?? "main",
    }];
    // Signal app-live.jsx to auto-select this tab on first load
    if (!state.firstProjectId) state.firstProjectId = "p1";

    _refreshCtx();
    notify();
  }

  function _refreshCtx() {
    state.ctx = window.buildCtx(state.rpcState, state.sessionCost, state.currentTps);
  }

  // ── Send a command to the agent ───────────────────────────────────────────
  function _send(cmd) {
    if (!window.__TAURI__) return;
    window.__TAURI__.core
      .invoke("send_command", { json: JSON.stringify(cmd) })
      .catch(e => console.error("[live] send error:", e));
  }

  // ── Window management (drag + platform controls) ──────────────────────────
  function _setupWindowChrome() {
    if (!window.__TAURI__) return;
    const { getCurrentWindow } = window.__TAURI__.window;
    const win = getCurrentWindow();
    const isWin = navigator.userAgent.includes("Windows") || navigator.platform.startsWith("Win");

    // Drag region: entire chrome except buttons
    const chrome = document.querySelector(".chrome");
    if (chrome) {
      chrome.addEventListener("mousedown", e => {
        if (e.target.closest("button, .chrome-lights, .win-controls")) return;
        win.startDragging().catch(() => {});
      });
    }

    if (isWin) {
      // Windows controls are rendered by React (WindowChrome). Use event
      // delegation so clicks work regardless of when React mounts the buttons.
      document.addEventListener("click", e => {
        if (e.target.closest(".win-min"))   { win.minimize(); }
        else if (e.target.closest(".win-max")) {
          win.isMaximized().then(m => m ? win.unmaximize() : win.maximize());
        }
        else if (e.target.closest(".win-close")) { win.close(); }
      });
    } else {
      // macOS: same delegation approach for traffic lights
      document.addEventListener("click", e => {
        const t = e.target.closest(".light");
        if (!t) return;
        if (t.classList.contains("red"))   win.close();
        else if (t.classList.contains("amber")) win.minimize();
        else if (t.classList.contains("green")) {
          win.isMaximized().then(m => m ? win.unmaximize() : win.maximize());
        }
      });
    }
  }

  // ── OMP_BRIDGE public API ─────────────────────────────────────────────────
  window.OMP_BRIDGE = {
    get isConnected() { return !!window.__TAURI__; },

    send(text, images) {
      // Optimistic: show user message immediately before agent confirms it.
      // message_start with role=user will dedup if this text arrives back.
      const userMsg = { kind: "user", time: _timeNow(), text };
      state.messages = [...state.messages, userMsg];
      notify();
      _send({ type: "prompt", message: text, images: images ?? [] });
    },
    abort() {
      _send({ type: "abort" });
    },
    setModel(model) {
      _send({ type: "set_model", provider: model.provider, modelId: model.id });
    },
    cycleModel() {
      _send({ type: "cycle_model" });
    },
    setThinking(level) {
      _send({ type: "set_thinking_level", level });
    },
    compact() {
      _send({ type: "compact" });
    },
    exportHtml() {
      _send({ type: "export_html" });
    },

    /** Subscribe to state snapshots. Returns an unsubscribe function. */
    onUpdate(cb) {
      subscribers.add(cb);
      // Fire immediately so component gets initial state synchronously
      cb({
        messages:      state.messages,
        isStreaming:   state.isStreaming,
        model:         state.model,
        thinkingLevel: state.thinkingLevel,
        ctx:           state.ctx,
        kanban:        state.kanban,
        planMeta:      state.planMeta,
        models:        state.models,
        activity:      state.activity,
        sparkline:     state.sparkline,
        projects:      state.projects,
      });
      return () => subscribers.delete(cb);
    },

    getState() { return state; },

    async openProject() {
      if (!window.__TAURI__) return null;
      return window.__TAURI__.core.invoke('open_project');
    },

    stopAgent() {
      if (!window.__TAURI__) return;
      window.__TAURI__.core.invoke('stop_agent').catch(() => {});
    },
  };

  // ── Connect to Tauri IPC ──────────────────────────────────────────────────
  if (window.__TAURI__) {
    // Mark <html> immediately so .tauri-native CSS overrides apply before
    // React's first paint — eliminates the "window in window" flash.
    document.documentElement.classList.add("tauri-native");
    const { listen } = window.__TAURI__.event;

    listen("agent://line", event => handleLine(event.payload));
    listen("agent://exit", ()    => {
      console.warn("[live] omp process exited");
      state.isStreaming = false;
      notify();
    });

    // Wire window chrome after DOM is ready
    if (document.readyState === "loading") {
      document.addEventListener("DOMContentLoaded", _setupWindowChrome);
    } else {
      _setupWindowChrome();
    }

    console.log("[live] Tauri mode active");
  } else {
    console.log("[live] Demo mode (no Tauri runtime)");
  }

  // ── Helpers ───────────────────────────────────────────────────────────────
  function _timeNow() {
    const d = new Date();
    return [d.getHours(), d.getMinutes(), d.getSeconds()]
      .map(n => String(n).padStart(2, "0")).join(":");
  }
})();

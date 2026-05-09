/* adapter.js — pure transforms between RPC data and design component data shapes.
   No side effects. All functions exported via window.* for Babel-transpiled scripts.
   Depends on: window.MODEL_NAMES (model-names.js loaded first). */

(function () {
  "use strict";

  // ── Tool name normalisation ───────────────────────────────────────────────
  // Maps omp tool names → design TOOL_META keys (ui.jsx)
  const TOOL_NAME_MAP = {
    read: "read", search: "search", edit: "edit", bash: "bash",
    write: "write", todo_write: "todo", find: "search",
    web_search: "search", task: "bash", ask: "bash",
    debug: "bash", lsp: "search", eval: "bash",
  };

  function normalizeToolName(name) {
    return TOOL_NAME_MAP[name] || name;
  }

  // ── TodoStatus → design status ────────────────────────────────────────────
  const STATUS_MAP = {
    pending: "pending",
    in_progress: "in_progress",
    completed: "done",
    abandoned: "done",  // rendered as strikethrough like done, per .kcard.ok CSS
  };

  function todoStatusToDesign(status) {
    return STATUS_MAP[status] || "pending";
  }

  // ── Phase visual style — cycles across a fixed palette by column index ────
  const PHASE_STYLES = [
    { tone: "fg-3",    icon: "search" },
    { tone: "accent",  icon: "edit"   },
    { tone: "cyan",    icon: "check"  },
    { tone: "lilac",   icon: "bash"   },
    { tone: "amber",   icon: "plan"   },
  ];

  function phaseStyle(index) {
    return PHASE_STYLES[index % PHASE_STYLES.length];
  }

  // ── Derive plan phase (review/running/done) from task status distribution ─
  function derivePlanPhase(todoPhases) {
    const tasks = todoPhases.flatMap(p => p.tasks);
    if (tasks.length === 0) return "review";
    const allDone = tasks.every(t => t.status === "completed" || t.status === "abandoned");
    if (allDone) return "done";
    if (tasks.some(t => t.status === "in_progress")) return "running";
    return "review";  // all pending → plan just written, not yet approved
  }

  // ── TodoPhase[] → design kanban column array ──────────────────────────────
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
          // tool/effort/file not available from RPC; defaults
          tool: "edit",
          effort: null,
          file: null,
        })),
      };
    });
  }

  // ── planMeta from RPC state ───────────────────────────────────────────────
  // strategy / risks / estimate are not available from RPC — those sections
  // are conditionally rendered in PlanKanban so empty values are safe.
  function buildPlanMeta(todoPhases, sessionState) {
    const sessionFile = sessionState?.sessionFile ?? "";
    const branch = sessionFile
      ? sessionFile.replace(/\\/g, "/").split("/").pop().replace(".jsonl", "")
      : "session";

    // Best-effort: extract file-like tokens from task content
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

  // ── Token count formatting ────────────────────────────────────────────────
  function formatTokens(n) {
    if (n === null || n === undefined) return "—";
    return n >= 1000 ? `${(n / 1000).toFixed(1)}k` : String(n);
  }

  // ── RPC state + cost + tps → design ctx object ────────────────────────────
  function buildCtx(rpcState, sessionCost, tps) {
    const cu    = rpcState?.contextUsage;
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

  // ── Model ID → display name fallback ──────────────────────────────────────
  function formatModelId(id) {
    return id
      .replace(/^(claude|gpt|gemini|deepseek)-/i, "")
      .replace(/-(?:latest|preview|\d{8})$/, "")
      .replace(/-/g, " ")
      .replace(/\b\w/g, c => c.toUpperCase());
  }

  // ── Activity log → 60s radar data ────────────────────────────────────────
  function buildActivityFromLog(log) {
    const now = Date.now();
    return log
      .filter(e => now - e.ts <= 60_000)
      .map(e => ({ t: Math.floor((now - e.ts) / 1000), k: normalizeToolName(e.toolName) }));
  }

  // ── tool_execution_start → running tool card ──────────────────────────────
  // Verified fields: ev.toolName, ev.toolCallId, ev.args (object), ev.intent
  function buildToolStartCard(event, time) {
    const tool = normalizeToolName(event.toolName ?? "");
    // args is a plain object; extract a display target from common arg names
    const args   = (typeof event.args === "object" && event.args !== null) ? event.args : {};
    const target = args.path ?? args.pattern ?? args.command ?? args.query
                ?? args.expression ?? args.url ?? "";
    // Use intent (one-line description written by the agent) when available
    const title = event.intent
      ?? (target ? `${event.toolName} · ${target}` : (event.toolName ?? tool));
    return {
      kind: "tool", tool, title,
      target: String(target),
      summary: "",
      status: "running",
      duration: null,
      time,
      _toolCallId: event.toolCallId,
    };
  }

  // ── tool_execution_end → finalized tool card ──────────────────────────────
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
        color: /^[✓✔]|^PASS|\bpassed\b/.test(line) ? "accent"
             : /^[✗✘]|^FAIL|^Error|\bfailed\b/.test(line) ? "rose"
             : "fg-3",
      }));
    }
    if (card.tool === "read") {
      extra.summary = details?.lines ? `${details.lines} lines` : card.summary;
    }

    return { ...card, status: "ok", duration, ...extra };
  }

  // ── AgentMessage[] (from get_messages) → design message array ─────────────
  // Skips pure tool-result turns; maps thinking blocks to thought field.
  function adaptAgentMessages(apiMessages) {
    const result = [];
    for (const msg of apiMessages ?? []) {
      if (!msg || typeof msg !== "object") continue;
      const { role, content } = msg;
      const time   = _formatTime(msg.timestamp ?? msg.createdAt);
      const blocks = Array.isArray(content) ? content : [{ type: "text", text: String(content ?? "") }];

      if (role === "user") {
        const textBlocks = blocks.filter(b => b.type === "text");
        if (textBlocks.length === 0) continue;  // skip pure tool-result turns
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
          // tool_use blocks already rendered as separate tool cards; skip here
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
    normalizeToolName,
    todoStatusToDesign,
    phaseStyle,
    derivePlanPhase,
    buildKanban,
    buildPlanMeta,
    formatTokens,
    buildCtx,
    formatModelId,
    buildActivityFromLog,
    buildToolStartCard,
    finalizeToolCard,
    adaptAgentMessages,
  });
})();

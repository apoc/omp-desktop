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
    web_search: "search", lsp: "search",
    eval: "eval", task: "task", quick_task: "task", debug: "debug", ask: "ask",
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


  // Merge a rolling snapshot (next) into the accumulated stream (prev).
  // recentOutput lines grow in-place while streaming, so the last matched
  // line is allowed to be a prefix of its next counterpart (startsWith),
  // not just an exact match. This handles both line-append and new-line cases.
  function _accumulateLines(prev, next) {
    if (!next.length) return prev;
    if (!prev.length) return next.slice();
    const maxK = Math.min(prev.length, next.length);
    for (let k = maxK; k > 0; k--) {
      let ok = true;
      for (let i = 0; i < k; i++) {
        const p = prev[prev.length - k + i];
        const n = next[i];
        // All lines except the last must match exactly.
        // The last compared pair allows p to be a prefix of n (streaming growth).
        const match = (i < k - 1) ? p === n : (p === n || n.startsWith(p));
        if (!match) { ok = false; break; }
      }
      // Replace the overlapping tail of prev with the full next snapshot.
      if (ok) return prev.slice(0, prev.length - k).concat(next);
    }
    return prev.concat(next);
  }
  // ── tool_execution_start → running tool card ──────────────────────────────
  // Verified fields: ev.toolName, ev.toolCallId, ev.args (object), ev.intent
  function buildToolStartCard(event, time) {
    const tool = normalizeToolName(event.toolName ?? "");
    // args is a plain object; extract a display target from common arg names
    const args   = (typeof event.args === "object" && event.args !== null) ? event.args : {};
    const target = args.path ?? args.pattern ?? args.command ?? args.query
                ?? args.expression ?? args.url
                ?? (tool === "eval" && args.input
                      ? (String(args.input).match(/={5}\s*(.*?)\s*={5}/)?.[1] ?? "")
                      : "")
                ?? "";
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
      _startMs: Date.now(),
    };
  }

  // ── tool_execution_end → finalized tool card ──────────────────────────────
  function finalizeToolCard(card, event) {
    const duration = card._startMs ? Date.now() - card._startMs : (event.duration ?? 0);
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
      // details.diff is a unified diff STRING (from Diff.structuredPatch in omp).
      // ScrubbableDiff expects { kind, line, text }[] — parse it here.
      const diffStr = details?.diff ?? details?.perFileResults?.[0]?.diff ?? "";
      if (diffStr) {
        const parsed = _parseUnifiedDiff(diffStr);
        extra.diff = parsed;
        extra.adds = parsed.filter(l => l.kind === "add").length;
        extra.rems = parsed.filter(l => l.kind === "rem").length;
      } else {
        extra.adds = 0;
        extra.rems = 0;
      }
      // Target path from args (richer than the generic target field)
      if (details?.perFileResults?.length > 0) {
        extra.target = details.perFileResults.map(r => r.path).join(", ");
      }
    }
    if (card.tool === "bash" && details?.output) {
      extra.output = String(details.output).split("\n").slice(0, 20).map(line => ({
        line,
        color: /^[✓✔]|^PASS|\bpassed\b/.test(line) ? "accent"
             : /^[✗✘]|^FAIL|^Error|\bfailed\b/.test(line) ? "rose"
             : "fg-3",
      }));
    }
    if (card.tool === "eval" && details?.cells) {
      extra.cells = details.cells.map(c => ({
        code: c.code ?? "",
        language: c.language ?? "js",
        output: c.output ?? "",
        status: c.status ?? "pending",
        title: c.title,
        durationMs: c.durationMs,
      }));
      extra.evalLanguage = details.language;
    }
    if (card.tool === "read") {
      extra.summary = details?.lines ? `${details.lines} lines` : card.summary;
    }
    if (card.tool === "task") {
      const progress = details?.progress ?? card.subagents ?? [];
      const results  = details?.results  ?? [];
      const byIdx    = new Map(results.map(r => [r.index, r]));
      // Build subagent list from progress (rich) or results-only (fallback)
      const base = progress.length > 0 ? progress : results.map((r, i) => ({
        index: r.index ?? i, id: r.id, agent: r.agent ?? "",
        status: "completed", task: r.task ?? "",
        lastIntent: null, currentTool: null,
        toolCount: 0, tokens: r.tokens ?? 0, durationMs: r.durationMs ?? 0,
        recentOutput: [], output: r.output ?? null, error: r.error ?? null,
      }));
      if (base.length > 0) {
        extra.subagents = base.map(p => {
          const r = byIdx.get(p.index);
          if (!r) return { ...p };
          const failed = r.error || r.exitCode !== 0 || r.aborted;
          // Append the final output lines to _stream so stream view stays complete.
          const finalLines = r.output ? r.output.split("\n") : [];
          return {
            ...p,
            status:    r.aborted ? "aborted" : failed ? "failed" : "completed",
            tokens:    r.tokens    ?? p.tokens    ?? 0,
            durationMs:r.durationMs ?? p.durationMs ?? 0,
            output:    r.output    ?? null,
            error:     r.error     ?? null,
            _stream:   _accumulateLines(p._stream ?? [], finalLines),
          };
        });
      }
    }

    return { ...card, status: "ok", duration, ...extra };
  }

  // ── tool_execution_update → partial card update (streaming) ─────────────────
  // Applies only the fields that stream in progressively (eval cells,
  // bash output tail). Status stays "running"; finalization is left to
  // finalizeToolCard on tool_execution_end.
  function updateToolCard(card, event) {
    // partialResult wraps { content, details } per the RPC protocol
    const pr      = event.partialResult ?? {};
    const details = pr.details;
    if (!details) return card;
    const extra = {};
    if (card.tool === "eval" && details.cells) {
      extra.cells = details.cells.map(c => ({
        code: c.code ?? "",
        language: c.language ?? "js",
        output: c.output ?? "",
        status: c.status ?? "running",
        title: c.title,
      }));
    }
    if (card.tool === "bash") {
      const text = pr.content?.[0]?.text ?? "";
      if (text) {
        extra.output = text.split("\n").slice(-20).map(line => ({
          line,
          color: /^[✓✔]|^PASS|\bpassed\b/.test(line) ? "accent"
               : /^[✗✘]|^FAIL|^Error|\bfailed\b/.test(line) ? "rose"
               : "fg-3",
        }));
      }
    }
    if (card.tool === "task" && details.progress?.length) {
      const existingByIdx = new Map((card.subagents ?? []).map(s => [s.index, s]));
      extra.subagents = details.progress.map(p => {
        const prev    = existingByIdx.get(p.index);
        const newLines = p.recentOutput ?? [];
        return {
          index:       p.index,
          id:          p.id,
          agent:       p.agent,
          status:      p.status,
          task:        p.task ?? "",
          lastIntent:  p.lastIntent ?? null,
          currentTool: p.currentTool ?? null,
          toolCount:   p.toolCount ?? 0,
          tokens:      p.tokens ?? 0,
          durationMs:  p.durationMs ?? 0,
          recentOutput: newLines,
          _stream:     _accumulateLines(prev?._stream ?? [], newLines),
          output:      null,
          error:       null,
        };
      });
    }
    return { ...card, ...extra };
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
          // omp's persisted AgentMessage may carry usage in either RPC shape
          // ({input, output}) or raw Anthropic shape ({input_tokens, output_tokens}).
          const u = msg.usage;
          const tokensIn  = u?.input  ?? u?.input_tokens  ?? null;
          const tokensOut = u?.output ?? u?.output_tokens ?? null;
          const tokens = (tokensIn != null || tokensOut != null) ? (tokensIn ?? 0) + (tokensOut ?? 0) : null;
          result.push({
            kind: "assistant", time, thought,
            lead: thought ? "thinking" : null,
            blocks: designBlocks,
            streaming: false,
            tokens, tokensIn, tokensOut,
          });
        }
      }
    }
    return result;
  }


  // ── Unified diff parser ───────────────────────────────────────────────────
  // Converts a unified diff string (from omp's Diff.structuredPatch) into the
  // { kind: "add"|"rem"|"ctx", line: number, text: string }[] array that
  // ScrubbableDiff expects.
  function _parseUnifiedDiff(diffStr) {
    const result = [];
    let newLine = 0;
    for (const raw of diffStr.split("\n")) {
      if (raw.startsWith("@@")) {
        // @@ -oldStart,oldCount +newStart,newCount @@
        const m = raw.match(/@@ [^\s]+ \+(\d+)/);
        if (m) newLine = parseInt(m[1], 10) - 1;
        continue;
      }
      // Skip file header lines (--- / +++)
      if (raw.startsWith("---") || raw.startsWith("+++")) continue;
      if (raw.startsWith("+")) {
        newLine++;
        result.push({ kind: "add", line: newLine, text: raw.slice(1) });
      } else if (raw.startsWith("-")) {
        result.push({ kind: "rem", line: newLine, text: raw.slice(1) });
      } else if (raw.startsWith(" ")) {
        newLine++;
        result.push({ kind: "ctx", line: newLine, text: raw.slice(1) });
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
    updateToolCard,
    adaptAgentMessages,
  });
})();

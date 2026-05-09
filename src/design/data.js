/* ═════════════════════════════════════════════════════════════════════
   Mock data for the prototype. Exposed on window.OMP_DATA.
   ═════════════════════════════════════════════════════════════════════ */
(function () {
  const projects = [
    { id: "p1", name: "kestrel-runtime",   path: "~/code/kestrel-runtime",   color: "var(--accent)",  branch: "feat/streaming-tools" },
    { id: "p2", name: "lattice-kit",       path: "~/code/lattice-kit",       color: "var(--cyan)",    branch: "main" },
    { id: "p3", name: "frostmoth-www",     path: "~/code/frostmoth-www",     color: "var(--magenta)", branch: "design/v3" },
    { id: "p4", name: "obsidian-mailer",   path: "~/code/obsidian-mailer",   color: "var(--lilac)",   branch: "fix/smtp-retry" },
  ];

  // ── A multi-tool agent run, played back across "events"
  const messages = [
    {
      kind: "user",
      time: "14:02:11",
      text: "the new streaming tool calls are landing twice in the timeline. plan a fix, then ship it. don't break the existing tests.",
    },
    {
      kind: "assistant",
      time: "14:02:13",
      lead: "thinking",
      thought: "Two writers racing the same id. Reducer probably appends on every delta — should be upsert-by-id.",
      blocks: [
        { type: "text", text: "Sketching a small plan first — three files, no API change. I'll keep `ToolCallState` shape stable so renderers don't blink." },
        {
          type: "plan",
          title: "Plan",
          phases: [
            { id: "scout",  label: "Scout",   tasks: [
              { id: "t1", text: "trace duplicate render path in `reducer.ts`",        status: "done" },
              { id: "t2", text: "confirm via `__streaming_tool_call` event log",      status: "done" },
            ]},
            { id: "patch",  label: "Patch",   tasks: [
              { id: "t3", text: "upsert tool calls by id in reducer",                  status: "in_progress" },
              { id: "t4", text: "drop `pendingToolCalls` (now redundant)",             status: "pending" },
              { id: "t5", text: "wire `tool_call_finalized` to flush state",           status: "pending" },
            ]},
            { id: "verify", label: "Verify",  tasks: [
              { id: "t6", text: "extend `reducer.test.ts` w/ duplicate-id case",       status: "pending" },
              { id: "t7", text: "manual sanity in long-run session",                   status: "pending" },
            ]},
          ],
        },
      ],
    },
    {
      kind: "tool",
      tool: "search",
      time: "14:02:15",
      title: "find · `tool_call` references",
      target: "src/session/reducer.ts",
      summary: "12 matches across 3 files",
      duration: 142,
      status: "ok",
      preview: [
        { file: "src/session/reducer.ts",   hits: 7, hot: true  },
        { file: "src/store/session.ts",     hits: 3, hot: false },
        { file: "src/components/ChatView/ChatView.tsx", hits: 2, hot: false },
      ],
    },
    {
      kind: "tool",
      tool: "read",
      time: "14:02:17",
      title: "read · reducer.ts L88-L142",
      target: "src/session/reducer.ts",
      summary: "55 lines",
      duration: 38,
      status: "ok",
    },
    {
      kind: "tool",
      tool: "edit",
      time: "14:02:21",
      title: "edit · upsert-by-id in `reducer.ts`",
      target: "src/session/reducer.ts",
      summary: "+14 −9",
      adds: 14, rems: 9,
      duration: 211,
      status: "ok",
      diff: [
        { line: 102, kind: "ctx", text: "    case \"tool_call_started\": {" },
        { line: 103, kind: "ctx", text: "      const id = ev.toolCallId;" },
        { line: 104, kind: "rem", text: "      next.activeToolCalls[id] = {" },
        { line: 105, kind: "rem", text: "        ...next.activeToolCalls[id]," },
        { line: 106, kind: "rem", text: "        kind: ev.tool, target: ev.target, status: \"running\"," },
        { line: 107, kind: "rem", text: "      };" },
        { line: 108, kind: "rem", text: "      next.pendingToolCalls.push(id);" },
        { line: 109, kind: "add", text: "      // upsert: same id never produces a duplicate render" },
        { line: 110, kind: "add", text: "      next.activeToolCalls[id] = upsertToolCall(" },
        { line: 111, kind: "add", text: "        next.activeToolCalls[id]," },
        { line: 112, kind: "add", text: "        { kind: ev.tool, target: ev.target, status: \"running\" }," },
        { line: 113, kind: "add", text: "      );" },
        { line: 114, kind: "ctx", text: "      return next;" },
        { line: 115, kind: "ctx", text: "    }" },
      ],
    },
    {
      kind: "assistant",
      time: "14:02:23",
      lead: null,
      blocks: [
        { type: "text", text: "Reducer is now id-stable. Running the focused test to confirm no regressions before I touch the store." },
      ],
    },
    {
      kind: "tool",
      tool: "bash",
      time: "14:02:24",
      title: "bash · `bun test reducer`",
      target: "src/session/reducer.test.ts",
      summary: "11 passed · 0 failed · 280ms",
      duration: 280,
      status: "ok",
      output: [
        { line: "$ bun test reducer", color: "fg-3" },
        { line: "✓ user message append", color: "accent" },
        { line: "✓ assistant streaming finalize", color: "accent" },
        { line: "✓ tool_call_started · upsert by id", color: "accent" },
        { line: "✓ tool_call_finalized · flushes state", color: "accent" },
        { line: "✓ context-window edge: 99% → compact trigger", color: "accent" },
        { line: "  — 11 passed (0 failed) in 280ms", color: "fg-3" },
      ],
    },
    {
      kind: "tool",
      tool: "edit",
      time: "14:02:27",
      title: "edit · drop `pendingToolCalls` in `store/session.ts`",
      target: "src/store/session.ts",
      summary: "+1 −5",
      adds: 1, rems: 5,
      duration: 92,
      status: "running",
    },
    {
      kind: "assistant",
      time: "14:02:29",
      lead: null,
      streaming: true,
      blocks: [
        { type: "text", text: "Cleaning up the now-redundant pending list and routing the finalize event straight to the active map. Keeping the public selector signature so" },
      ],
    },
  ];

  // ── Plan: agent's strategy, risks, the columns of work
  const planMeta = {
    ask: "the new streaming tool calls are landing twice in the timeline. plan a fix, then ship it. don't break the existing tests.",
    strategy: "Two writers race the same id; reducer appends on every delta instead of upserting. Keep `ToolCallState` shape stable so renderers don't flicker, drop the redundant `pendingToolCalls` queue, route `tool_call_finalized` through the active map.",
    touches: ["reducer.ts", "store/session.ts", "reducer.test.ts"],
    branch: "fix/dup-tool-calls",
    risks: [
      { tone: "amber", text: "store selectors read pendingToolCalls; need to verify no callers outside `ChatView`." },
      { tone: "fg-3", text: "ChatView virtuoso may reflow on first paint — visually confirm." },
    ],
    estimate: { tokens: "~12k", cost: "$0.08", wall: "~3 min" },
    approval: "draft", // draft | approved | running | done
  };

  const kanban = [
    {
      id: "scout", title: "Scout", tone: "fg-3", icon: "search",
      tasks: [
        { id: "k1", text: "trace duplicate render path in reducer.ts", status: "done", file: "reducer.ts:88", tool: "search", effort: "S", reason: "find every site that mutates activeToolCalls", note: "double-write on streamed deltas" },
        { id: "k2", text: "confirm via __streaming_tool_call log",     status: "done", file: "logs/dev.log",   tool: "read",   effort: "S", reason: "verify the bug pre-patch — two ids per call" },
      ],
    },
    {
      id: "patch", title: "Patch", tone: "accent", icon: "edit",
      tasks: [
        { id: "k3", text: "upsert tool calls by id in reducer",         status: "in_progress", file: "reducer.ts:102", tool: "edit", effort: "M", reason: "single source of truth — same id never produces a duplicate render", note: "+14 −9, tests green" },
        { id: "k4", text: "drop pendingToolCalls (now redundant)",      status: "pending", file: "store/session.ts", tool: "edit", effort: "S", reason: "with upsert we don't need a parallel queue" },
        { id: "k5", text: "wire tool_call_finalized to flush state",    status: "pending", file: "reducer.ts",       tool: "edit", effort: "S", reason: "make finalize the only path that clears `running`" },
      ],
    },
    {
      id: "verify", title: "Verify", tone: "cyan", icon: "check",
      tasks: [
        { id: "k6", text: "extend reducer.test.ts w/ duplicate-id case", status: "pending", file: "reducer.test.ts", tool: "edit",  effort: "S", reason: "lock in the fix — regression guard" },
        { id: "k7", text: "manual sanity in long-run session",           status: "pending",                          tool: "bash",  effort: "S", reason: "subjective — does the session feel calmer?" },
        { id: "k8", text: "tag the agent activity radar afterwards",     status: "pending",                          tool: "edit",  effort: "S", reason: "nice-to-have", note: "nice-to-have" },
      ],
    },
  ];

  // ── Slash command palette
  const commands = [
    { name: "plan",      hint: "draft a plan before writing code",          icon: "◇", group: "Mode" },
    { name: "steer",     hint: "interrupt and redirect mid-tool",           icon: "↺", group: "Mode" },
    { name: "compact",   hint: "compact context window",                    icon: "▤", group: "Session" },
    { name: "branch",    hint: "fork the session from current head",        icon: "⑂", group: "Session" },
    { name: "handoff",   hint: "package the session for a teammate",        icon: "⇲", group: "Session" },
    { name: "model",     hint: "switch model · ⇧⌘M",                         icon: "◉", group: "Agent" },
    { name: "thinking",  hint: "cycle thinking level",                      icon: "✶", group: "Agent" },
    { name: "todo",      hint: "open the kanban surface",                   icon: "▦", group: "View" },
    { name: "minimap",   hint: "toggle the session minimap",                icon: "▢", group: "View" },
    { name: "export",    hint: "export this session to HTML",               icon: "⇪", group: "View" },
  ];

  // ── Available models
  const models = [
    { id: "claude-haiku-4-5",   name: "Haiku 4.5",   provider: "anthropic", note: "fast · cheap",     latency: 110 },
    { id: "claude-sonnet-4-7",  name: "Sonnet 4.7",  provider: "anthropic", note: "default driver",   latency: 320, current: true },
    { id: "claude-opus-4-1",    name: "Opus 4.1",    provider: "anthropic", note: "deep work",        latency: 720 },
    { id: "qwen-3-coder",       name: "Qwen-3 Coder", provider: "local",     note: "on-device",        latency: 60 },
  ];

  // ── Agent activity radar (last 60s, stylized)
  const activity = [
    { t: 0,  k: "read"   }, { t: 1,  k: "read" }, { t: 2,  k: "search" },
    { t: 3,  k: "search" }, { t: 5,  k: "edit" }, { t: 6,  k: "edit" },
    { t: 8,  k: "bash"   }, { t: 9,  k: "bash" }, { t: 11, k: "edit" },
    { t: 14, k: "read"   }, { t: 16, k: "edit" }, { t: 18, k: "search" },
    { t: 20, k: "edit"   }, { t: 22, k: "bash" }, { t: 25, k: "read" },
    { t: 27, k: "edit"   }, { t: 30, k: "edit" }, { t: 32, k: "edit" },
    { t: 35, k: "bash"   }, { t: 37, k: "bash" }, { t: 39, k: "read" },
    { t: 42, k: "edit"   }, { t: 45, k: "search" }, { t: 47, k: "edit" },
    { t: 49, k: "edit"   }, { t: 52, k: "bash" }, { t: 55, k: "edit" },
    { t: 58, k: "edit"   },
  ];

  // ── Status / context
  const ctx = {
    used: 47230,
    total: 200000,
    label: "47.2k / 200k",
    pct: 23,
    cost: "$0.41",
    tokensPerSec: 184,
  };

  // ── Side session (split-pane peer)
  const peer = {
    project: "lattice-kit",
    title: "rewrite token export to css vars",
    status: "running",
    activity: "edit · packages/tokens/build.ts",
    tps: 96,
    todo: { done: 4, total: 7 },
  };

  // ── Microcopy delights
  const microcopy = {
    empty:        "Hand me a project. I'll set the table.",
    streamingTip: "Press ⎋ to interrupt — your cursor is in the room.",
    paletteTip:   "type / to give orders · ⌘K opens the bridge",
    todoEmpty:    "no plan yet. think out loud below.",
    radarHint:    "agent has been busy — last 60 seconds",
  };

  window.OMP_DATA = { projects, messages, kanban, planMeta, commands, models, activity, ctx, peer, microcopy };
})();

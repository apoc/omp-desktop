// Start screen "orbit": the agent loop — tools orbiting the logo, calls out
// and results back.
//
// Plain-script IIFE (AGENTS.md "IIFE rule"); adds its rules to
// `window.OMP_BACKDROPS` (app/backdrops.js, which must load first). Drawing:
// design/backdrops/orbit.js. Pure, covered by test-backdrops.mjs.
(function () {
  // `secs`: the [min, max] wall time a call claims in the log; `fail`: the
  // chance it fails (a red result; only commands that can, can).
  const TOOLS = Object.freeze([
    { name: "read", secs: [0.1, 0.4], fail: 0, calls: ["src/lib.rs", "AGENTS.md", "package.json", "docs/rpc.md"] },
    { name: "grep", secs: [0.1, 0.6], fail: 0, calls: ["\"TODO\"", "unwrap\\(", "fn main", "OMP_BRIDGE"] },
    { name: "edit", secs: [0.1, 0.3], fail: 0, calls: ["+12 −3", "+1 −1", "+48 −20", "+7 −7"] },
    { name: "bash", secs: [0.8, 4.5], fail: 0.25, calls: ["cargo test", "npm test", "git status", "cargo clippy"] },
    { name: "lsp", secs: [0.2, 1.2], fail: 0, calls: ["rename", "references", "hover", "diagnostics"] },
    { name: "web", secs: [0.9, 3.2], fail: 0.1, calls: ["docs.rs", "MDN fetch", "RFC 9110", "crates.io"] },
    { name: "task", secs: [2.5, 6], fail: 0, calls: ["scout ×3", "reviewer", "explore", "plan"] },
    { name: "todo", secs: [0.1, 0.2], fail: 0, calls: ["1/5 done", "3/5 done", "5/5 done", "+2 items"] },
  ]);

  /** Orbit radii around (cx, cy): clear of the logo rect `fit` (when there
   *  is one) by `gap`, within the area less `margin`. */
  function orbitRadii(width, height, fit, { gap = 36, margin = 28 } = {}) {
    const maxX = width / 2 - margin, maxY = height / 2 - margin;
    const rx = Math.min(maxX, Math.max(width * 0.34, fit ? fit.width / 2 + gap : 0));
    const ry = Math.min(maxY, Math.max(height * 0.34, fit ? fit.height / 2 + gap * 1.6 : 0));
    return { rx: Math.max(0, rx), ry: Math.max(0, ry) };
  }

  const ellipsePoint = (angle, cx, cy, rx, ry) => ({ x: cx + Math.cos(angle) * rx, y: cy + Math.sin(angle) * ry });

  /** The next tool call: a tool index, one of its call labels, its outcome
   *  and claimed wall time (tenths of a second). */
  function nextCall(rand, tool = Math.floor(rand() * TOOLS.length)) {
    const { calls, secs: [lo, hi], fail } = TOOLS[tool];
    const label = calls[Math.floor(rand() * calls.length)];
    const ok = rand() >= fail;
    return { tool, label, ok, secs: Math.round((lo + rand() * (hi - lo)) * 10) / 10 };
  }

  /** One model turn: 1–3 parallel calls (mostly one), to distinct tools. */
  function nextTurn(rand) {
    const r = rand();
    const n = Math.min(TOOLS.length, r < 0.45 ? 1 : r < 0.8 ? 2 : 3);
    const free = TOOLS.map((_, i) => i);
    const turn = [];
    for (let i = 0; i < n; i++) turn.push(nextCall(rand, free.splice(Math.floor(rand() * free.length), 1)[0]));
    return turn;
  }

  /** Steps each leg of a call takes: out to the tool, executing (longer for
   *  a slower call, compressed so a 6 s task doesn't stall the screen), back. */
  const callSpans = (call) => ({ out: 34, exec: Math.round(16 + Math.min(call.secs, 6) * 9), back: 30 });

  /** Where a call is `age` steps after launch: its leg and progress (0..1)
   *  through it; "wait" before launch, "done" once back. */
  function callPhase(age, spans) {
    if (age < 0) return { phase: "wait", t: 0 };
    if (age < spans.out) return { phase: "out", t: age / spans.out };
    age -= spans.out;
    if (age < spans.exec) return { phase: "exec", t: age / spans.exec };
    age -= spans.exec;
    if (age < spans.back) return { phase: "back", t: age / spans.back };
    return { phase: "done", t: 1 };
  }

  /** The call log, bottom-left: its first line's left edge `x`, the newest
   *  line's centre `bottom` px above the canvas edge, `lineH` apart, at most
   *  `lines` of them in a `boxW` wide box. `padX`/`padY` keep it clear of the
   *  nodes and their labels. */
  const CALL_LOG = Object.freeze({ x: 24, bottom: 24, lineH: 17, boxW: 200, lines: 5, padX: 56, padY: 26 });

  /** How many call-log lines fit without touching the orbit: the most whose
   *  box's inner corner lies outside the padded ellipse, 0 when under 2 fit
   *  (a lone line reads as noise). */
  function logRoom(height, { cx, cy, rx, ry }) {
    const { x, bottom, lineH, boxW, lines, padX, padY } = CALL_LOG;
    for (let n = lines; n >= 2; n--) {
      const right = x + boxW, top = height - bottom - (n - 0.5) * lineH;
      if (right >= cx || top <= cy) continue;
      if (((right - cx) / (rx + padX)) ** 2 + ((top - cy) / (ry + padY)) ** 2 >= 1) return n;
    }
    return 0;
  }

  /** The call-log line: `bash  cargo test  ✓ 1.4s`, a pending marker while
   *  the call runs. */
  function logLine(call, done) {
    const head = `${TOOLS[call.tool].name.padEnd(5)} ${call.label}`;
    if (!done) return `${head}  …`;
    return call.ok ? `${head}  ✓ ${call.secs.toFixed(1)}s` : `${head}  ✗ exit 1`;
  }

  /** The "thinking" sweep across the logo at turn start: a soft band of
   *  light at progress `k` (0..1) crossing the letters left to right, leaning
   *  like a scanline. Weight (0..1) of the cell at `col`, `row` of a
   *  `cols` × `rows` logo; 0 outside the band and outside 0 < k < 1. */
  function logoSweep(col, row, k, cols, rows) {
    if (!(k > 0 && k < 1)) return 0;
    const band = 5, slant = 1.6;
    const pos = -band * 3 + k * (cols + (rows - 1) * slant + band * 6);
    const d = (col + (rows - 1 - row) * slant - pos) / band;
    return d > -2.5 && d < 2.5 ? Math.exp(-d * d) : 0;
  }

  Object.assign(window.OMP_BACKDROPS, {
    TOOLS, orbitRadii, ellipsePoint, nextCall, nextTurn, callSpans, callPhase, logLine, CALL_LOG, logRoom, logoSweep,
  });
})();

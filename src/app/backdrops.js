// Start screens: the empty workspace's animated backdrops (the `startScreen`
// tweak): the screen list, the math and pointer helpers the screens share,
// and the code corpus the next-token and forward-pass screens write from,
// with the next-token rules.
//
// Exposes `window.OMP_BACKDROPS`; wrapped as an IIFE per the project rule for
// plain <script> tags (see AGENTS.md "IIFE rule"). The rules of the other
// screens are app/backdrops-{latent,orbit,neural}.js, which add theirs to the
// same object (so they load after this file); canvas drawing lives in
// design/backdrops/ (one renderer per screen, the host in backdrop.jsx); the
// matrix rain's own geometry is app/matrix-rain.js. Everything is pure, takes
// its randomness as `rand`, and is covered by test-backdrops.mjs.
(function () {
  const SCREENS = Object.freeze([
    { id: "matrix", label: "Matrix", blurb: "digital rain" },
    { id: "latent", label: "Latent space", blurb: "embeddings + retrieval" },
    { id: "sampling", label: "Next token", blurb: "top-k sampling" },
    { id: "orbit", label: "Agent loop", blurb: "tool calls in orbit" },
    { id: "neural", label: "Forward pass", blurb: "activations firing" },
  ]);
  const DEFAULT_SCREEN = "matrix";

  /** `id` when it names a screen, else the default (a stale stored value). */
  const screenOf = (id) => (SCREENS.some(s => s.id === id) ? id : DEFAULT_SCREEN);

  // ── shared math ──────────────────────────────────────────────────────

  /** Standard normal sample (Box-Muller); `1 - rand()` keeps log away from 0. */
  function gauss(rand) {
    return Math.sqrt(-2 * Math.log(1 - rand())) * Math.cos(2 * Math.PI * rand());
  }

  const easeInOut = (t) => (t < 0.5 ? 2 * t * t : 1 - (-2 * t + 2) ** 2 / 2);

  /** Point at `t` on the quadratic Bézier p0 → p2 bent towards `c`. */
  function bezier(p0, c, p2, t) {
    const u = 1 - t;
    return { x: u * u * p0.x + 2 * u * t * c.x + t * t * p2.x, y: u * u * p0.y + 2 * u * t * c.y + t * t * p2.y };
  }

  /** Probabilities of `logits` at `temperature` (max-shifted for stability). */
  function softmax(logits, temperature = 1) {
    const t = Math.max(temperature, 1e-6);
    const max = Math.max(...logits);
    const exps = logits.map(l => Math.exp((l - max) / t));
    const sum = exps.reduce((a, b) => a + b, 0);
    return exps.map(e => e / sum);
  }

  // ── pointer: the subtle reaction to the mouse (env.pointer) ──

  /** How strongly the pointer at (px, py) reaches a point at (x, y): 1 on
   *  it, easing smoothly to 0 at `radius` and beyond. */
  function proximity(px, py, x, y, radius) {
    const f = 1 - ((x - px) ** 2 + (y - py) ** 2) / (radius * radius);
    return f > 0 ? f * f : 0;
  }

  /** `p` pulled towards the gravity well `well` ({ x, y, strength }): by
   *  `gain`·strength of the way at its centre, a Gaussian falloff of width
   *  `sigma` around it. Never overshoots the well while gain·strength ≤ 1. */
  function pullToward(p, well, sigma, gain = 0.4) {
    const dx = well.x - p.x, dy = well.y - p.y;
    const k = gain * well.strength * Math.exp(-(dx * dx + dy * dy) / (2 * sigma * sigma));
    return { x: p.x + dx * k, y: p.y + dy * k };
  }

  // ── next token: code written token by token, top-k candidates per step ──

  const SNIPPETS = Object.freeze([
    [
      "async function deflake(suite) {",
      "  const runs = await Promise.all(range(20).map(() => suite.run()));",
      "  const failed = runs.filter(r => !r.ok);",
      "  if (failed.length === 0) return \"not flaky\";",
      "  return bisect(failed, { by: \"seed\" });",
      "}",
    ].join("\n"),
    [
      "fn next_token(logits: &[f32], temperature: f32) -> usize {",
      "    let probs = softmax(logits, temperature);",
      "    let r: f32 = rand::random();",
      "    probs.iter().scan(0.0, |acc, p| { *acc += p; Some(*acc) })",
      "        .position(|c| c > r)",
      "        .unwrap_or(probs.len() - 1)",
      "}",
    ].join("\n"),
    [
      "def review(diff):",
      "    for hunk in diff.hunks:",
      "        if hunk.touches(\"tests/\") and not hunk.asserts():",
      "            yield Comment(hunk, \"this test asserts nothing\")",
      "    yield Approve() if not diff.risky else RequestChanges()",
    ].join("\n"),
  ]);
  /** Editor tab title per snippet (same order as SNIPPETS). */
  const SNIPPET_FILES = Object.freeze(["deflake.ts", "sample.rs", "review.py"]);

  const KEYWORDS = new Set([
    "async", "await", "function", "const", "let", "return", "if", "else", "for", "in", "of", "fn", "mut",
    "def", "yield", "and", "not", "import", "from", "true", "false", "null", "None", "Some", "self",
  ]);

  /** Lossless split into tokens: whitespace runs, identifiers, numbers,
   *  string literals and single punctuation marks (`tokens.join("") === src`). */
  function tokenize(src) {
    return src.match(/\s+|[A-Za-z_][A-Za-z0-9_]*!?|\d+(?:\.\d+)?|"[^"\n]*"|./g) ?? [];
  }

  /** `kind` of a token for colouring: keyword | string | number | ident | punct | space. */
  function tokenKind(tok) {
    if (/^\s+$/.test(tok)) return "space";
    if (KEYWORDS.has(tok)) return "keyword";
    if (tok[0] === "\"") return "string";
    if (/^\d/.test(tok)) return "number";
    if (/^[A-Za-z_]/.test(tok)) return "ident";
    return "punct";
  }

  /** Every distinct non-space token of the snippets: the distractor pool. */
  const VOCAB = Object.freeze([...new Set(SNIPPETS.flatMap(tokenize).filter(t => tokenKind(t) !== "space"))]);

  /** The `k` candidates shown for one step, most probable first. The true
   *  next token always wins (the code stays the snippet), by a random
   *  margin, so the bars look different every step; the rest are distinct
   *  distractors from `vocab`. */
  function candidates(truth, k, rand, { vocab = VOCAB, temperature = 0.7 } = {}) {
    const pool = vocab.filter(t => t !== truth);
    const picks = [];
    while (picks.length < k - 1 && pool.length) picks.push(pool.splice(Math.floor(rand() * pool.length), 1)[0]);
    const logits = picks.map(() => rand() * 2.4);
    const top = Math.max(0, ...logits);
    const all = [top + 0.15 + rand() * 1.8, ...logits];
    const probs = softmax(all, temperature);
    return [truth, ...picks].map((tok, i) => ({ tok, p: probs[i] })).sort((a, b) => b.p - a.p);
  }

  /** Tokens of `src` with their editor position (0-based `line`, `col` in
   *  characters) and kind; a whitespace token sits where it starts, its
   *  newlines move the following tokens down. */
  function layoutTokens(src) {
    let line = 0, col = 0;
    return tokenize(src).map(tok => {
      const at = { tok, kind: tokenKind(tok), line, col };
      const nl = tok.lastIndexOf("\n");
      if (nl < 0) col += tok.length;
      else { line += tok.split("\n").length - 1; col = tok.length - nl - 1; }
      return at;
    });
  }

  /** The non-space tokens of the snippets, in order: the forward pass slides
   *  a window over it and predicts the token after the window. */
  const SEQUENCE = Object.freeze(SNIPPETS.flatMap(tokenize).filter(t => tokenKind(t) !== "space"));

  window.OMP_BACKDROPS = {
    SCREENS, DEFAULT_SCREEN, screenOf,
    gauss, easeInOut, bezier, softmax, proximity, pullToward,
    SNIPPETS, SNIPPET_FILES, VOCAB, tokenize, tokenKind, candidates, layoutTokens, SEQUENCE,
  };
})();

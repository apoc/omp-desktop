// Start screen "attention": a small decoder-only transformer generating
// code one token at a time, its multi-head self-attention drawn as arcs and
// per-head causal heatmaps.
//
// Plain-script IIFE (AGENTS.md "IIFE rule"); adds its rules to
// `window.OMP_BACKDROPS` (app/backdrops.js, which must load first). Drawing:
// design/backdrops/attention.js. Pure, covered by test-backdrops.mjs.
(function () {
  const { softmax, tokenKind, tokenAt, clamp } = window.OMP_BACKDROPS;

  /** The heads, each with its own pattern (see `headScores`). */
  const HEADS = Object.freeze([
    { id: "prev", label: "previous token" },
    { id: "bracket", label: "bracket match" },
    { id: "ident", label: "same identifier" },
    { id: "broad", label: "broad context" },
  ]);
  const LAYERS = 4;
  /** Softmax temperature per layer: early layers diffuse, later sharper. */
  const LAYER_TEMPS = Object.freeze([1.4, 1.1, 0.85, 0.7]);
  const BROAD_TEMP = 2.4;  // the broad head's extra flattening

  const OPEN = new Set(["(", "[", "{"]);
  const CLOSE = new Set([")", "]", "}"]);

  /** Index of the bracket that encloses position `q` (the innermost opener
   *  before `q` not closed before it; for a closer at `q` its own opener),
   *  or -1. Only looks backwards: the future is masked. */
  function enclosingOpen(tokens, q) {
    let depth = 0;
    for (let i = q - 1; i >= 0; i--) {
      if (CLOSE.has(tokens[i])) depth++;
      else if (OPEN.has(tokens[i])) {
        if (depth === 0) return i;
        depth--;
      }
    }
    return -1;
  }

  /** Raw attention scores of query `q` over keys 0..q for head `head`
   *  (an id of HEADS); keys after `q` are -Infinity (the causal mask). A
   *  head with nothing to find parks on the first token, the "attention
   *  sink" real models show. */
  function headScores(tokens, q, head) {
    const scores = tokens.map(() => -Infinity);
    const sink = (k) => (k === 0 ? 2.5 : 0);
    if (head === "prev") {
      for (let k = 0; k <= q; k++) scores[k] = k === q - 1 ? 5 : k === q ? 1.5 : -0.25 * (q - k);
    } else if (head === "bracket") {
      const m = enclosingOpen(tokens, q);
      for (let k = 0; k <= q; k++) {
        if (m < 0) scores[k] = sink(k);
        else scores[k] = k === m ? 5 : OPEN.has(tokens[k]) || CLOSE.has(tokens[k]) ? 1 : 0;
      }
    } else if (head === "ident") {
      const word = /^(ident|keyword)$/.test(tokenKind(tokens[q]));
      const hit = (k) => word && k < q && tokens[k] === tokens[q];
      const any = tokens.slice(0, q).some((_, k) => hit(k));
      for (let k = 0; k <= q; k++) scores[k] = hit(k) ? 5 : any ? 0 : sink(k) + (k === q ? 1.5 : 0);
    } else {
      const bias = { keyword: 0.6, ident: 0.4, string: 0.3, number: 0.3 };
      for (let k = 0; k <= q; k++) scores[k] = (bias[tokenKind(tokens[k])] ?? 0) - 0.06 * (q - k);
    }
    return scores;
  }

  /** Attention weights of query `q` for `head` in `layer`: the causal
   *  softmax of `headScores` (zero for every key after `q`, the rest summing
   *  to 1). */
  function attend(tokens, q, head, layer) {
    const temp = LAYER_TEMPS[layer] * (head === "broad" ? BROAD_TEMP : 1);
    const probs = softmax(headScores(tokens, q, head).slice(0, q + 1), temp);
    return tokens.map((_, k) => (k <= q ? probs[k] : 0));
  }

  /** Every head's full (lower-triangular) attention matrix in `layer`:
   *  maps[h][q][k]. */
  function attentionMaps(tokens, layer) {
    return HEADS.map(h => tokens.map((_, q) => attend(tokens, q, h.id, layer)));
  }

  /** The `n` tokens of SEQUENCE from `k` on, wrapping round: the context
   *  window; the next one, `windowAt(k + 1)`'s last, is the prediction. */
  function windowAt(k, n) {
    return Array.from({ length: n }, (_, i) => tokenAt(k + i));
  }

  /** One token's generation, in steps: per layer the attention (arcs grow
   *  in) then the MLP, then the output (prediction appears) and the window
   *  slide. */
  const TIMELINE = Object.freeze({ attn: 18, mlp: 8, out: 16, slide: 14 });
  const CYCLE = LAYERS * (TIMELINE.attn + TIMELINE.mlp) + TIMELINE.out + TIMELINE.slide;

  /** Where step `t` (0 ≤ t < CYCLE) falls: { stage, layer, u } with `u`
   *  0..1 through the stage; `layer` is the last layer run during output
   *  and slide. */
  function phaseAt(t) {
    const per = TIMELINE.attn + TIMELINE.mlp;
    if (t < LAYERS * per) {
      const layer = Math.floor(t / per), r = t - layer * per;
      return r < TIMELINE.attn
        ? { stage: "attn", layer, u: r / TIMELINE.attn }
        : { stage: "mlp", layer, u: (r - TIMELINE.attn) / TIMELINE.mlp };
    }
    const r = t - LAYERS * per;
    return r < TIMELINE.out
      ? { stage: "out", layer: LAYERS - 1, u: r / TIMELINE.out }
      : { stage: "slide", layer: LAYERS - 1, u: (r - TIMELINE.out) / TIMELINE.slide };
  }

  /** Geometry for a `width`×`height` canvas with the logo at `fit` (or
   *  null). Full size: the heads' heatmaps above the logo, the layer stack
   *  below it (layer 0 at the bottom, a residual stream per token slot
   *  rising from the token row); `n` tokens plus a last slot for the
   *  prediction. Compact (a preview tile): the token row with arcs on the
   *  left, the heatmaps 2×2 on the right. Every layer gives the row its
   *  arcs leave from (`attnY`) and how high they may rise (`cap`). */
  function attentionLayout({ width: W, height: H, fit, compact }) {
    if (compact) {
      const pad = 8, gap = 4;
      const size = Math.max(8, Math.min((H - pad * 2 - gap) / 2, W * 0.2));
      const hx = W - pad - size * 2 - gap, hy = (H - size * 2 - gap) / 2;
      const heads = HEADS.map((_, h) => ({ x: hx + (h % 2) * (size + gap), y: hy + Math.floor(h / 2) * (size + gap), size }));
      const n = 8, rowY = H - pad - 4, left = pad + 2, right = hx - 14;
      const slots = Array.from({ length: n + 1 }, (_, i) => left + ((right - left) * (i + 0.5)) / (n + 1));
      const row = { attnY: rowY - 6, mlpY: rowY - 6, normY: rowY - 6, top: pad, bottom: rowY, cap: rowY - 6 - pad - 2 };
      return { n, slots, rowY, layers: Array.from({ length: LAYERS }, () => ({ ...row })), heads, caption: null };
    }
    const band = fit
      ? { top: fit.y - fit.font * 1.6, bottom: fit.y + fit.height + fit.font * 1.6 }
      : { top: H * 0.42, bottom: H * 0.42 };
    const padX = clamp(W * 0.07, 24, 120), padT = Math.max(26, H * 0.05), padB = Math.max(30, H * 0.055);
    const labelW = W < 900 ? 46 : 64;  // layer labels left of the stack

    // ── below the logo: the stack ──
    const availW = W - padX * 2 - labelW;
    const n = clamp(Math.floor(availW / 76) - 1, 5, 12);
    const slotW = Math.min(availW / (n + 1), 110);
    const left = padX + labelW + (availW - slotW * (n + 1)) / 2;
    const slots = Array.from({ length: n + 1 }, (_, i) => left + slotW * (i + 0.5));
    const rowY = H - padB;
    const stackBottom = rowY - 20, stackTop = band.bottom + 6;
    const layerH = Math.max(0, Math.min((stackBottom - stackTop) / LAYERS, 96));
    const layers = Array.from({ length: LAYERS }, (_, l) => {
      const bottom = stackBottom - l * layerH, top = bottom - layerH;
      return {
        top, bottom, attnY: bottom - layerH * 0.18, normY: bottom - layerH * 0.5, mlpY: bottom - layerH * 0.76,
        cap: layerH * 0.78,
      };
    });

    // ── above the logo: one heatmap per head ──
    const capH = 16, labelH = 20;
    const room = band.top - padT - capH - labelH;
    const gap = clamp(W * 0.03, 16, 48);
    const size = Math.min(room, (W - padX * 2 - gap * (HEADS.length - 1)) / HEADS.length, 180);
    let heads = [], caption = null;
    if (size >= 24) {
      const total = size * HEADS.length + gap * (HEADS.length - 1);
      const x0 = (W - total) / 2, y = padT + capH + (room - size) / 2;
      heads = HEADS.map((_, h) => ({ x: x0 + h * (size + gap), y, size }));
      caption = { x: x0, y: y - capH };
    }
    return { n, slots, rowY, layers, heads, caption };
  }

  /** The token slot under canvas x, or -1 off the row (more than half a
   *  slot past either end). */
  function slotAt(x, slots) {
    if (slots.length < 2) return -1;
    const w = slots[1] - slots[0];
    const i = Math.round((x - slots[0]) / w);
    return i >= 0 && i < slots.length && Math.abs(x - slots[i]) <= w / 2 ? i : -1;
  }

  /** Which of `n` even bands index `i` of `count` falls in: the logo is
   *  read as a heatmap, its columns spread over the window's tokens and its
   *  rows over the heads. */
  const bandOf = (i, count, n) => Math.min(n - 1, Math.floor((i * n) / count));

  /** The logo's causal-mask sweep at cell (col, row) with the diagonal
   *  front at `front` (in columns, leaning `slant` columns per row):
   *  { masked: the cell is still ahead of the front, glow: 0..1 on the
   *  front's trailing `width` columns }. */
  function maskSweep(col, row, front, slant = 2, width = 6) {
    const d = front - (col + row * slant);
    return { masked: d < 0, glow: d >= 0 && d < width ? 1 - d / width : 0 };
  }

  Object.assign(window.OMP_BACKDROPS, {
    HEADS, LAYERS, enclosingOpen, headScores, attend, attentionMaps, windowAt,
    TIMELINE, CYCLE, phaseAt, attentionLayout, slotAt, bandOf, maskSweep,
  });
})();

// Start screen "neural": a forward pass, activations firing left to right
// through a layered network.
//
// Plain-script IIFE (AGENTS.md "IIFE rule"); adds its rules to
// `window.OMP_BACKDROPS` (app/backdrops.js, which must load first). Drawing:
// design/backdrops/neural.js. Pure, covered by test-backdrops.mjs.
(function () {
  /** Node positions for layers of `sizes` spread across `rect`: layers
   *  evenly from left to right, each layer's nodes centred vertically. */
  function layerLayout(sizes, rect) {
    const n = sizes.length;
    const tallest = Math.max(...sizes);
    const gapY = tallest > 1 ? rect.height / (tallest - 1) : 0;
    return sizes.map((size, l) => {
      const x = n > 1 ? rect.x + (rect.width * l) / (n - 1) : rect.x + rect.width / 2;
      const top = rect.y + (rect.height - (size - 1) * gapY) / 2;
      return Array.from({ length: size }, (_, i) => ({ x, y: top + i * gapY }));
    });
  }

  /** Like `layerLayout`, but with the horizontal `band` ({ top, bottom })
   *  kept clear for the logo: each layer splits into an upper half stacked
   *  up from the band and a lower half stacked down from it (the upper
   *  takes the odd node), centred on the tallest layer's halves so the
   *  network keeps its lens shape. Spacing: the tightest that fits either
   *  side, capped at `maxGap`. No band → `layerLayout`. */
  function bandLayout(sizes, rect, band, maxGap = Infinity) {
    if (!band) return layerLayout(sizes, rect);
    const n = sizes.length;
    const tallest = Math.max(...sizes);
    const up = Math.ceil(tallest / 2), down = tallest - up;
    const above = band.top - rect.y, below = rect.y + rect.height - band.bottom;
    const gap = Math.max(0, Math.min(maxGap, up > 1 ? above / (up - 0.5) : above, down > 1 ? below / (down - 0.5) : below));
    return sizes.map((size, l) => {
      const x = n > 1 ? rect.x + (rect.width * l) / (n - 1) : rect.x + rect.width / 2;
      const u = Math.ceil(size / 2), d = size - u;
      const nodes = [];
      // Upper half listed top to bottom so indices still read downwards.
      for (let k = u - 1; k >= 0; k--) nodes.push({ x, y: band.top - gap * (0.5 + k + (up - u) / 2) });
      for (let k = 0; k < d; k++) nodes.push({ x, y: band.bottom + gap * (0.5 + k + (down - d) / 2) });
      return nodes;
    });
  }

  /** Pulses leaving node `from` of layer `l` towards `fanout` distinct
   *  random nodes of layer `l + 1`, each with a weight in (0.35, 1]. */
  function firePulses(sizes, l, from, fanout, rand) {
    if (l + 1 >= sizes.length) return [];
    const targets = Array.from({ length: sizes[l + 1] }, (_, i) => i);
    const out = [];
    for (let n = Math.min(fanout, targets.length); n > 0; n--) {
      const to = targets.splice(Math.floor(rand() * targets.length), 1)[0];
      out.push({ l, from, to, t: 0, w: 0.35 + rand() * 0.65 });
    }
    return out;
  }


  /** Firing rules: a node fires once its summed incoming weight reaches
   *  `threshold`, at most `maxFire` (fraction of the layer) per pass so the
   *  cascade stays sparse instead of lighting every node; when a layer's
   *  pulses have all landed, the strongest silent nodes top it up to
   *  `minFire` so a pass never dies out. `fanout` is per fired node, as a
   *  fraction of the next layer; `jitter` staggers pulse starts. */
  const PASS_RULES = Object.freeze({ threshold: 1.2, maxFire: 0.6, minFire: 2, fanout: 0.3, jitter: 0.25 });

  function fireNode(pass, l, i, rand) {
    const { sizes, rules } = pass;
    pass.fired[l][i] = true;
    pass.count[l]++;
    pass.events.push({ l, i, fire: true, w: 1 });
    if (l + 1 >= sizes.length) return;
    const pulses = firePulses(sizes, l, i, Math.max(1, Math.ceil(sizes[l + 1] * rules.fanout)), rand);
    for (const p of pulses) p.t = -rand() * rules.jitter;
    pass.inflight[l + 1] += pulses.length;
    pass.pulses.push(...pulses);
  }

  /** A new forward pass with every input node fired (the token window). */
  function startPass(sizes, rand, rules = PASS_RULES) {
    const pass = {
      sizes, rules, pulses: [], events: [], done: false,
      acc: sizes.map(n => new Array(n).fill(0)),
      fired: sizes.map(n => new Array(n).fill(false)),
      count: sizes.map(() => 0),
      inflight: sizes.map(() => 0),
      settled: sizes.map((_, l) => l === 0),
    };
    for (let i = 0; i < sizes[0]; i++) fireNode(pass, 0, i, rand);
    return pass;
  }

  /** Move every pulse `speed` of an edge along; land arrivals, fire nodes
   *  and settle finished layers. `pass.events` lists this step's landings
   *  (`fire: false`) and firings (`fire: true`) for the renderer. `ease(l, i)`
   *  (0..1, optional) lowers a node's threshold by up to half: the pointer
   *  makes nearby nodes fire more readily. */
  function advancePass(pass, speed, rand, ease = null) {
    const { sizes, rules, acc, fired, count, inflight, settled } = pass;
    pass.events = [];
    const landed = [];
    pass.pulses = pass.pulses.filter(p => {
      p.t += speed;
      if (p.t < 1) return true;
      landed.push(p);
      return false;
    });
    for (const p of landed) {
      const l = p.l + 1;
      inflight[l]--;
      acc[l][p.to] += p.w;
      pass.events.push({ l, i: p.to, fire: false, w: p.w });
      const threshold = rules.threshold * (ease ? 1 - 0.5 * ease(l, p.to) : 1);
      if (!fired[l][p.to] && acc[l][p.to] >= threshold && count[l] < Math.ceil(sizes[l] * rules.maxFire)) {
        fireNode(pass, l, p.to, rand);
      }
    }
    for (let l = 1; l < sizes.length; l++) {
      if (settled[l] || !settled[l - 1] || inflight[l] > 0) continue;
      const silent = acc[l].map((_, i) => i).filter(i => !fired[l][i]).sort((a, b) => acc[l][b] - acc[l][a]);
      while (count[l] < Math.min(rules.minFire, sizes[l]) && silent.length) fireNode(pass, l, silent.shift(), rand);
      settled[l] = true;
    }
    pass.done = settled[sizes.length - 1];
    return pass.events;
  }

  /** Output nodes strongest first (fired before silent, then by activation):
   *  the first is the prediction, the order maps onto `candidates`. */
  function rankOutputs(pass) {
    const l = pass.sizes.length - 1;
    const score = i => (pass.fired[l][i] ? 1e6 : 0) + pass.acc[l][i];
    return pass.acc[l].map((_, i) => i).sort((a, b) => score(b) - score(a));
  }

  Object.assign(window.OMP_BACKDROPS, {
    layerLayout, bandLayout, firePulses, PASS_RULES, startPass, advancePass, rankOutputs,
  });
})();

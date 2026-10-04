// Conversation tree model: turns the `conversation_tree` command's output (the
// merged entries of a session family) into what the navigator draws — one row
// per user prompt with the state of the prompt cache a re-ask would hit, the
// tips (branch ends) and the rows' graph, laid out by
// app/conversation-tree-graph.js. Pure: the caller passes `now` (and `since`,
// the start of the tab's omp process).
//
// Cache facts (measured on omp 18.6.0 / Opus 5.5):
//  - the prefix before prompt P (the context a re-ask resends, without P) is
//    refreshed only by the first request answering P or any sibling of P
//    (re-asked from the same parent), never by later turns;
//  - every 15th conversational prompt is a cache anchor kept refreshed while
//    the conversation is used: a row whose prefix went cold can still read up
//    to its newest live anchor ("partial");
//  - tools + system prompt (`head`) stay cached while any request runs within
//    the TTL, also across processes; the rest does not: a new process rebuilds
//    its system prompt, so only requests since it started touch the cache.
//
// Exposes `window.OMP_CONV_TREE`; IIFE per the project rule for plain
// <script> tags. Regression: test-conversation-tree.mjs.
(function () {
  "use strict";

  const { indexTree, layout } = window.OMP_CONV_GRAPH;

  const EXPIRING_MS = 10 * 60 * 1000;
  const ANCHOR_EVERY = 15;

  const isPrompt = (e) => e.kind === "user" && !e.agent;
  const isRow = (e) => isPrompt(e) || e.kind === "compaction";
  const sortKey = (t) => t ?? -Infinity;
  const cmp = (a, b) => (a < b ? -1 : a > b ? 1 : 0);
  const baseName = (p) => String(p).split(/[\\/]/).pop();

  /** Per entry, in tree order: the conversational-prompt ordinal on its own
   *  path, the chain of cache anchors of the current compaction epoch, the
   *  nearest prompt (`near`) and the nearest row (`row`, prompt or compaction),
   *  itself included. A compaction restarts the count from the prompts it kept
   *  (after `firstKeptId`, inclusive when that entry is itself kept, before the
   *  compaction) and the anchors from nothing. A row also gets the row above
   *  it on its path (`up`) and its sort key (`rowKey`): a prompt's `ts` is its
   *  submit time, which can precede the compaction omp appends before sending
   *  it, so the key never drops below the row above. */
  function walkPaths(x) {
    const st = new Map();
    const keptPrompts = (c) => {
      let n = 0;
      for (let id = x.par.get(c.id); id != null; id = x.par.get(id)) {
        const isFirst = id === c.firstKeptId;
        if (isFirst && !c.firstKeptExact) return n;
        if (isPrompt(x.byId.get(id))) n++;
        if (isFirst) return n;
      }
      return 0; // firstKeptId is not on this path: nothing counts as kept
    };
    for (const e of x.entries) {
      const p = x.par.get(e.id);
      const ps = p == null ? { cnt: 0, anchors: null, near: null, row: null, rowKey: -Infinity, asst: null, comp: null } : st.get(p);
      // `prior`: the last request before this entry on its path — for a prompt,
      // the context a re-ask would resend (a compaction cuts it off).
      const s = { cnt: ps.cnt, anchors: ps.anchors, before: ps.anchors, near: ps.near, row: ps.row, up: null, rowKey: ps.rowKey, asst: ps.asst, prior: ps.asst, comp: ps.comp };
      if (isRow(e)) {
        s.row = e.id;
        s.up = ps.row;
        s.rowKey = Math.max(sortKey(x.time.get(e.id)), ps.rowKey);
      }
      if (isPrompt(e)) {
        s.cnt = ps.cnt + 1;
        s.near = e.id;
        if (s.cnt % ANCHOR_EVERY === 0) s.anchors = { id: e.id, ordinal: s.cnt, prev: ps.anchors };
      } else if (isSizing(e)) {
        s.asst = e.id;
      } else if (e.kind === "compaction") {
        s.cnt = keptPrompts(e);
        s.anchors = null;
        s.asst = null;
        s.comp = e.id;
      }
      st.set(e.id, s);
    }
    return st;
  }

  /** Newest entry of `list` by time (later tree position wins a tie). */
  function newest(x, list) {
    let best = null;
    for (const e of list) {
      const t = x.time.get(e.id);
      if (t != null && (best == null || t >= x.time.get(best.id))) best = e;
    }
    return best;
  }

  const usageTokens = (u) => u.input + u.cacheRead + u.cacheWrite;
  /** Everything an assistant entry leaves in the context for the next request. */
  const contextTokens = (e) => usageTokens(e.usage) + e.usage.output;
  /** An assistant entry that reported its context: aborted and failed replies are saved with all-zero usage. */
  const isSizing = (e) => e.kind === "assistant" && e.usage != null && usageTokens(e.usage) > 0;
  /** What refreshes a cache entry: a reply that reported usage, or a warm-up. */
  const isTouch = (e) => e.kind === "warm" || isSizing(e);

  /** TTL, per-token rates and the head (tools + system prompt) size. */
  function cacheFacts(x, curSet) {
    const assistants = x.entries.filter((e) => e.kind === "assistant" && e.usage);
    const withTtl = (list) => newest(x, list.filter((e) => e.usage.ttl != null));
    const onPath = assistants.filter((e) => curSet.has(e.id));
    const ttlEntry = withTtl(onPath) ?? withTtl(assistants);
    const rate = (count, cost) => {
      const e = newest(x, assistants.filter((a) => a.usage[count] > 0 && a.usage[cost] != null));
      return e ? e.usage[cost] / e.usage[count] : null;
    };
    const read = rate("cacheRead", "costRead");
    const write = rate("cacheWrite", "costWrite");
    const head = assistants.reduce((m, e) => (e.usage.cacheRead > 0 ? Math.min(m, e.usage.cacheRead) : m), Infinity);
    return {
      ttlMs: ttlEntry ? ttlEntry.usage.ttl * 1000 : null,
      rates: read != null && write != null ? { read, write } : null,
      head: head === Infinity ? 0 : head,
      lastRequest: newest(x, x.entries.filter(isTouch)),
    };
  }

  /** Per prompt: its first reply that reported usage, in the prompt's own
   *  compaction epoch (any time). Per context key (`ctxKey`): the latest touch
   *  by a prompt's first reply or a warm-up, and the smallest first-reply size
   *  of its prompts. Per anchor: its latest touch. The touches come twice:
   *  `live` counts only those at or after `since` (the tab process's start) —
   *  an older process wrote a different system prompt, so its cache entries
   *  are not hit — and `raw` counts all, to tell a `staleProcess`. */
  function requestFacts(x, st, since) {
    const first = new Map();
    const childSize = new Map();
    const live = { anchorTouch: new Map(), siblings: new Map() };
    const raw = since === -Infinity ? live : { anchorTouch: new Map(), siblings: new Map() };
    const touch = (field, key, t) => {
      if (t == null) return;
      if (t > (raw[field].get(key) ?? -Infinity)) raw[field].set(key, t);
      if (t >= since && t > (live[field].get(key) ?? -Infinity)) live[field].set(key, t);
    };
    for (const e of x.entries) {
      if (!isTouch(e)) continue;
      const t = x.time.get(e.id);
      const s = st.get(e.id);
      if (s.anchors) touch("anchorTouch", s.anchors.id, t);
      // A reply after a compaction answers the prompt before it with a context that was never that prompt's prefix.
      if (!isSizing(e) || t == null || s.near == null || st.get(s.near).comp !== s.comp) continue;
      const f = first.get(s.near);
      if (!f || t < x.time.get(f.id)) first.set(s.near, e);
    }
    for (const e of x.entries) {
      const f = e.kind === "warm" ? e : isPrompt(e) ? first.get(e.id) : null;
      const t = f ? x.time.get(f.id) : null;
      const key = x.ctxKey(x.par.get(e.id));
      touch("siblings", key, t);
      if (f && e.kind !== "warm") childSize.set(key, Math.min(usageTokens(f.usage), childSize.get(key) ?? Infinity));
    }
    return { first, childSize, live, raw };
  }

  /** Rows and tips all price a re-ask the same way; `anchorTouch` is one of
   *  `requestFacts`' two touch sets. */
  function makeClassifier(facts, first, anchorTouch, now, headLive) {
    const { ttlMs, rates, head } = facts;
    const price = (read, write) => (rates ? read * rates.read + write * rates.write : null);
    /** Size of the context through the anchor prompt (its first request). */
    const anchorTokens = (id) => {
      const f = first.get(id);
      return f?.usage ? usageTokens(f.usage) : head;
    };
    const liveAnchor = (before, prefix) => {
      for (let a = before; a; a = a.prev) {
        const touch = anchorTouch.get(a.id);
        const tokens = anchorTokens(a.id);
        if (tokens < prefix && touch != null && touch + ttlMs > now) {
          return { ordinal: a.ordinal, tokens, until: touch + ttlMs };
        }
      }
      return null;
    };
    /** `touch`: when the prefix was last read; `prefix`: its tokens; `before`:
     *  the anchor chain preceding it. */
    function classify(touch, prefix, before) {
      if (ttlMs == null) {
        return { state: "unknown", until: null, readTokens: null, writeTokens: null, price: null, coldPrice: null, coldWriteTokens: null, anchorOrdinal: null };
      }
      const coldRead = Math.min(head, prefix);
      const coldPrice = price(coldRead, prefix - coldRead);
      let until = touch == null ? null : touch + ttlMs;
      let state = "cold";
      let read = headLive ? coldRead : 0;
      let anchorOrdinal = null;
      if (until != null && until > now) {
        state = until - now <= EXPIRING_MS ? "expiring" : "warm";
        read = prefix;
      } else {
        const a = liveAnchor(before, prefix);
        if (a) {
          state = "partial";
          read = a.tokens;
          until = a.until;
          anchorOrdinal = a.ordinal;
        }
      }
      return { state, until, readTokens: read, writeTokens: prefix - read, price: price(read, prefix - read), coldPrice, coldWriteTokens: prefix - coldRead, anchorOrdinal };
    }
    return classify;
  }

  /** Which way a turn (or a compaction's continuation) is followed: the
   *  current path first, else the child whose subtree has the newest entry. */
  function makeDescender(x, curSet) {
    const latest = new Map();
    for (let i = x.entries.length - 1; i >= 0; i--) {
      const id = x.entries[i].id;
      let m = sortKey(x.time.get(id));
      for (const k of x.kids.get(id) ?? []) m = Math.max(m, latest.get(k));
      latest.set(id, m);
    }
    return (id) => {
      const ks = x.kids.get(id) ?? [];
      const cur = ks.find((k) => curSet.has(k));
      if (cur != null) return cur;
      let best = null;
      for (const k of ks) if (best == null || latest.get(k) >= latest.get(best)) best = k;
      return best;
    };
  }

  /** The turn of prompt `id` along the descent: its last assistant entry and
   *  the last non-empty assistant text. */
  function turnOf(x, down, id) {
    let reply = null;
    let forkEntryId = null;
    for (let n = down(id); n != null && !isPrompt(x.byId.get(n)); n = down(n)) {
      const e = x.byId.get(n);
      if (e.kind !== "assistant") continue;
      forkEntryId = n;
      if (e.text) reply = e.text;
    }
    return { reply, forkEntryId };
  }

  /** Family files newest first (the file name starts with its ISO creation
   *  time), each with the ids on its leaf path. */
  function filesNewestFirst(x) {
    return x.files
      .map((f, i) => ({ f, i, name: baseName(f.path), ids: new Set(x.path(f.leafId)) }))
      .sort((a, b) => cmp(b.name, a.name) || a.i - b.i);
  }

  /** One tip per distinct file leaf, then every other leaf of the tree. */
  function buildTips(x, st, curLeaf, sorted, ctx) {
    const fileOf = (leaf) => {
      const own = sorted.filter((s) => s.f.leafId === leaf);
      if (own.length) return (own.find((s) => s.f.current) ?? own[0]).f;
      if (x.byId.get(leaf).inCurrent) return x.files.find((f) => f.current) ?? null;
      for (let a = leaf; a != null; a = x.par.get(a)) {
        const hit = sorted.find((s) => s.ids.has(a));
        if (hit) return hit.f;
      }
      return null;
    };
    const fileLeaves = new Set(x.files.map((f) => f.leafId).filter((id) => id != null && x.byId.has(id)));
    const leaves = [...fileLeaves];
    for (const e of x.entries) if (!x.kids.has(e.id) && !fileLeaves.has(e.id)) leaves.push(e.id);
    return leaves.map((leaf) => {
      const path = x.path(leaf);
      const { near: rowId, comp, asst, anchors } = st.get(leaf);
      // Requests before a compaction cached a context that no longer exists.
      const from = Math.max(rowId == null ? -1 : path.indexOf(rowId), comp == null ? -1 : path.indexOf(comp)) + 1;
      const after = path.slice(from).map((id) => x.byId.get(id));
      // Continuing from the leaf sends a prompt whose context parent it is: the first replies of the prompts
      // already asked from there (and warm-ups of it) refresh it too.
      const key = x.ctxKey(leaf);
      const touchFrom = (min, siblings) => {
        let t = siblings.get(key) ?? -Infinity;
        for (const e of after) {
          const et = x.time.get(e.id);
          if (isTouch(e) && et != null && et >= min && et > t) t = et;
        }
        return t === -Infinity ? null : t;
      };
      // No reply that reported usage in the leaf's epoch (a compaction, or a prompt after one): its next
      // prompt would be sized like the prompts already asked from there, else the head.
      const tokens = asst != null ? contextTokens(x.byId.get(asst)) : ctx.childSize.get(key) ?? null;
      const c = ctx.assess(touchFrom(ctx.since, ctx.siblings.live), touchFrom(-Infinity, ctx.siblings.raw), tokens ?? ctx.head, anchors);
      const file = fileOf(leaf);
      return {
        leafId: leaf, file: file?.path ?? null, isCurrent: leaf === curLeaf, rowId, title: file?.title ?? null,
        state: c.state, until: c.until, tokens, price: c.price, coldPrice: c.coldPrice, staleProcess: c.staleProcess,
      };
    });
  }

  /** Cached in full: a re-ask reads its whole prefix. */
  const isLive = (state) => state === "warm" || state === "expiring";
  /** Cached in full or up to an anchor. */
  const isCached = (state) => isLive(state) || state === "partial";

  /** `since`: start time (ms) of the tab's omp process; absent = every request counts. */
  function buildModel(tree, { now, since = null }) {
    const x = indexTree(tree);
    const st = walkPaths(x);
    const curFile = x.files.find((f) => f.current);
    const curLeaf = curFile?.leafId != null && x.byId.has(curFile.leafId) ? curFile.leafId : null;
    const curSet = new Set(x.path(curLeaf));
    const facts = cacheFacts(x, curSet);
    const headLive = facts.ttlMs != null && facts.lastRequest != null && x.time.get(facts.lastRequest.id) + facts.ttlMs > now;
    const minT = since ?? -Infinity;
    const req = requestFacts(x, st, minT);
    const classifyLive = makeClassifier(facts, req.first, req.live.anchorTouch, now, headLive);
    const classifyRaw = since == null ? classifyLive : makeClassifier(facts, req.first, req.raw.anchorTouch, now, headLive);
    // staleProcess: cached had the process not changed, but `since` took it out of the cache.
    const assess = (touch, rawTouch, prefix, before) => {
      const c = classifyLive(touch, prefix, before);
      const stale = since != null && !isCached(c.state) && c.state !== "unknown"
        && isCached(classifyRaw(rawTouch, prefix, before).state);
      return { ...c, staleProcess: stale };
    };
    const ctx = { assess, since: minT, head: facts.head, siblings: { live: req.live.siblings, raw: req.raw.siblings }, childSize: req.childSize };
    const files = filesNewestFirst(x);
    const down = makeDescender(x, curSet);
    // Per entry, the newest other file whose leaf path holds it.
    const otherFileOf = new Map();
    for (const s of files) {
      if (s.f.current) continue;
      for (const id of s.ids) if (!otherFileOf.has(id)) otherFileOf.set(id, s.f.path);
    }

    const rows = x.entries
      .filter(isRow)
      .sort((a, b) => cmp(st.get(a.id).rowKey, st.get(b.id).rowKey) || x.pos.get(a.id) - x.pos.get(b.id))
      .map((e) => {
        const ts = x.time.get(e.id);
        if (e.kind === "compaction") return { kind: "compaction", id: e.id, ts };
        const s = st.get(e.id);
        // No request before P in its epoch: after a compaction the context is the summary plus the
        // kept messages, so P's own first request (it adds P's text) is closer than the head.
        const first = req.first.get(e.id);
        const prefix = s.prior != null ? contextTokens(x.byId.get(s.prior))
          : s.comp != null && first?.usage ? usageTokens(first.usage) : facts.head;
        const key = x.ctxKey(x.par.get(e.id));
        const c = assess(req.live.siblings.get(key) ?? null, req.raw.siblings.get(key) ?? null, prefix, s.before);
        // coldPrice is the classifier's: priced as cold against a live head.
        return {
          kind: "prompt", id: e.id, ts, text: e.text, ...turnOf(x, down, e.id),
          ordinal: s.cnt, isAnchor: s.cnt % ANCHOR_EVERY === 0, label: e.label,
          inCurrent: e.inCurrent, onCurrentPath: curSet.has(e.id),
          ...c, prefixTokens: prefix,
          openFile: e.inCurrent ? null : otherFileOf.get(e.id) ?? null,
          tipIndexes: [],
        };
      });

    const index = new Map(rows.map((r, i) => [r.id, i]));
    const tips = buildTips(x, st, curLeaf, files, ctx);
    tips.forEach((t, i) => rows[index.get(t.rowId)]?.tipIndexes.push(i));

    const promptState = new Map(rows.filter((r) => r.kind === "prompt").map((r) => [r.id, r.state]));
    const fallback = facts.ttlMs == null ? "unknown" : "cold";
    const stateOf = (r) => {
      if (r.kind === "prompt") return r.state;
      let n = down(r.id);
      while (n != null && !promptState.has(n)) n = down(n);
      return promptState.get(n) ?? fallback;
    };
    // Lanes go to the current tip first, then to the other tips newest first.
    const tipRows = [...tips]
      .sort((a, b) => Number(b.isCurrent) - Number(a.isCurrent) || cmp(sortKey(x.time.get(b.leafId)), sortKey(x.time.get(a.leafId))) || x.pos.get(b.leafId) - x.pos.get(a.leafId))
      .map((t) => st.get(t.leafId).row);
    const { graph, lanes } = layout(rows, tipRows, (id) => st.get(id).up, stateOf);
    for (const r of rows) r.graph = graph.get(r.id);

    const counts = { warm: 0, expiring: 0, partial: 0, cold: 0, unknown: 0, total: promptState.size };
    for (const s of promptState.values()) counts[s]++;
    return {
      rows, lanes,
      tips, ttlMs: facts.ttlMs, rates: facts.rates, counts,
    };
  }

  window.OMP_CONV_TREE = { buildModel, isLive, isCached };
})();

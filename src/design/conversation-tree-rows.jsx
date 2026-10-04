/* design/conversation-tree-rows.jsx — the list rows of the conversation-tree
   pane (conversation-tree.jsx): formatters, the per-row git-style graph, the
   cache meter and the compaction divider. Everything here is a function of
   the row model (`OMP_CONV_TREE.buildModel`, app/conversation-tree.js) and
   `now`; no state. */

const { isLive: _CTR_isLive } = window.OMP_CONV_TREE;

// Built once: `when` runs for every row on every render.
const TREE_CLOCK = new Intl.DateTimeFormat([], { hour: "2-digit", minute: "2-digit", hour12: false });
const TREE_DAY = new Intl.DateTimeFormat([], { month: "short", day: "numeric" });

// ── Formatters (shared with conversation-tree-detail.jsx) ─────────────────
const TreeFmt = {
  /** `$0.15`; `<$0.01` below a cent; whole dollars from $100. */
  price(usd) {
    if (usd == null) return null;
    if (usd > 0 && usd < 0.005) return "<$0.01";
    return usd >= 100 ? `$${Math.round(usd)}` : `$${usd.toFixed(2)}`;
  },
  /** `<1 min`, `14 min`, `1 h 5 min`, `2 h`. */
  dur(ms) {
    const min = Math.floor(Math.max(0, ms) / 60000);
    if (min < 1) return "<1 min";
    if (min < 60) return `${min} min`;
    const h = Math.floor(min / 60), m = min % 60;
    return m ? `${h} h ${m} min` : `${h} h`;
  },
  /** `10:43` for today, `Oct 3, 10:43` for another day. */
  when(ts, now) {
    if (ts == null) return "";
    const d = new Date(ts);
    const clock = TREE_CLOCK.format(d);
    return d.toDateString() === new Date(now).toDateString() ? clock : `${TREE_DAY.format(d)}, ${clock}`;
  },
  /** `758k`, `13.3k`, `842`. */
  tokens(n) {
    if (n == null) return "?";
    if (n >= 100000) return `${Math.round(n / 1000)}k`;
    if (n >= 1000) return `${(n / 1000).toFixed(1).replace(/\.0$/, "")}k`;
    return String(Math.round(n));
  },
  /** Why a `staleProcess` row/tip cannot reuse its cache (tooltip + detail line). */
  staleNote(since, now) {
    const started = since != null ? ` This tab's process started at ${TreeFmt.when(since, now)}, and a` : " A";
    return `Cached by an earlier omp process of this conversation.${started} new process rebuilds the system prompt (e.g. recalled memories), so that cache cannot be reused.`;
  },
};

// ── Graph geometry: one lane is 16px wide; lane 0 sits at x = 16 ──────────
const TREE_NODE_Y = 31;
const TREE_ROW_H = 66;
const TREE_ROW_H_TAGGED = 76;
const treeLaneX = lane => 16 + 16 * lane;

const TREE_LINE = {
  warm:     { stroke: "var(--lime)" },
  expiring: { stroke: "var(--amber)" },
  partial:  { stroke: "var(--cyan)", dash: "7 3" },
  cold:     { stroke: "var(--fg-5)", dash: "3 4" },
  unknown:  { stroke: "var(--fg-4)" },
};
const treeLine = state => TREE_LINE[state] ?? TREE_LINE.unknown;

function TreeNode({ x, state }) {
  const y = TREE_NODE_Y;
  const { stroke } = treeLine(state);
  if (state === "warm") return (<>
    <circle cx={x} cy={y} r="9.5" fill="color-mix(in oklab, var(--lime) 22%, transparent)" />
    <circle cx={x} cy={y} r="5.5" fill={stroke} />
  </>);
  if (state === "expiring") return (<>
    <circle cx={x} cy={y} r="9.5" fill="none" stroke={stroke} strokeWidth="1.5" strokeDasharray="2 2.5" />
    <circle cx={x} cy={y} r="5.5" fill={stroke} />
  </>);
  if (state === "partial") return (<>
    <circle cx={x} cy={y} r="5.5" fill="var(--bg-elevated)" stroke={stroke} strokeWidth="2" />
    <path d={`M ${x - 5.5} ${y} A 5.5 5.5 0 0 0 ${x + 5.5} ${y} Z`} fill={stroke} />
  </>);
  return <circle cx={x} cy={y} r="5" fill="var(--bg-elevated)" stroke={stroke} strokeWidth="2" />;
}

function TreeGraph({ graph, state, lanes, height }) {
  const width = 18 + 16 * Math.max(1, lanes);
  const cy = TREE_NODE_Y;
  return (
    <svg className="tree-graph" width={width} height={height} viewBox={`0 0 ${width} ${height}`}>
      {graph.segments.map((s, i) => {
        const { stroke, dash } = treeLine(s.state);
        const x = treeLaneX(s.lane);
        const y1 = s.part === "bottom" ? cy : 0;
        const y2 = s.part === "top" ? cy : height;
        return <line key={`s${i}`} x1={x} y1={y1} x2={x} y2={y2} stroke={stroke}
          strokeWidth="2.5" strokeDasharray={dash} />;
      })}
      {graph.curves.map((c, i) => {
        const { stroke, dash } = treeLine(c.state);
        const x1 = treeLaneX(c.fromLane), x2 = treeLaneX(c.toLane), mid = (cy + height) / 2;
        return <path key={`c${i}`} d={`M ${x1} ${cy} C ${x1} ${mid}, ${x2} ${mid}, ${x2} ${height}`}
          fill="none" stroke={stroke} strokeWidth="2.5" strokeDasharray={dash} />;
      })}
      <TreeNode x={treeLaneX(graph.lane)} state={state} />
    </svg>
  );
}

// ── Cache meter: label, bar, price (tokens when there are no rates) ───────
function TreeMeter({ row, ttlMs, now }) {
  const left = row.until != null ? row.until - now : null;
  const priced = row.price != null;
  const amount = priced ? TreeFmt.price(row.price)
    : row.prefixTokens > 0 ? `${TreeFmt.tokens(row.prefixTokens)} tok` : "—";
  let label, bar = null, priceClass;
  if (_CTR_isLive(row.state)) {
    label = `${row.state === "warm" ? "cached" : "expires"} · ${TreeFmt.dur(left ?? 0)}`;
    const pct = ttlMs ? Math.min(100, Math.max(3, ((left ?? 0) / ttlMs) * 100)) : 0;
    bar = <div className="cache-bar"><span style={{ width: `${pct}%` }} /></div>;
    priceClass = "read";
  } else if (row.state === "partial") {
    const total = row.readTokens + row.writeTokens;
    const pct = total > 0 ? Math.round((row.readTokens / total) * 100) : 0;
    label = `${pct} % cached`;
    bar = <div className="cache-bar split"><span style={{ width: `${pct}%` }} /></div>;
    priceClass = "part";
  } else if (row.state === "cold") {
    // A stale row carries its own "earlier process" tag; the meter stays short.
    label = row.until != null ? `cold · since ${TreeFmt.when(row.until, now)}` : "cold";
    priceClass = "write";
  } else {
    label = "cache unknown";
    priceClass = "";
  }
  return (
    <div className={`cache-meter ${row.state}`}>
      <div className="cache-label">{label}</div>
      {bar}
      <div className={`cache-price ${priceClass}`}>{amount}</div>
    </div>
  );
}

// ── Tags under the reply: anchor, partial note, label, tips ───────────────
function treeTags(row, model, now, since, currentFile, onOpenTip) {
  const tags = [];
  if (row.isAnchor) {
    tags.push(<span key="anchor" className="tree-tip anchor"
      title="omp re-marks every 15th prompt on each request, so the cache up to here stays alive while you work">
      ⚓ cache anchor · prompt {row.ordinal}
    </span>);
  }
  if (row.state === "partial") {
    tags.push(<span key="partial" className="tree-tip partial">
      reads up to prompt {row.anchorOrdinal}, writes the rest
    </span>);
  }
  if (row.staleProcess || row.tipIndexes.some(i => model.tips[i]?.staleProcess)) {
    tags.push(<span key="stale" className="tree-tip stale" title={TreeFmt.staleNote(since, now)}>earlier process</span>);
  }
  if (row.label) tags.push(<span key="label" className="tree-tip label" title={row.label}>{row.label}</span>);
  for (const i of row.tipIndexes) {
    const tip = model.tips[i];
    if (!tip) continue;
    if (tip.isCurrent) {
      tags.push(<span key={`tip${i}`} className="tree-tip here">this tab</span>);
      if (_CTR_isLive(tip.state)) {
        tags.push(<span key={`cont${i}`} className={`tree-cont ${tip.state}`}>
          ▸ continue · cached {TreeFmt.dur((tip.until ?? now) - now)}
        </span>);
      } else if (tip.state === "cold") {
        tags.push(<span key={`cont${i}`} className="tree-cont cold">▸ continue · cold</span>);
      } else if (tip.state === "partial") {
        tags.push(<span key={`cont${i}`} className="tree-cont expiring">▸ continue · partly cached</span>);
      }
    } else if (tip.file && tip.file !== currentFile) {
      tags.push(<button key={`tip${i}`} className="tree-tip open" onClick={e => { e.stopPropagation(); onOpenTip(tip.file); }}
        title="open this branch in a new tab">
        ⎘ open · {tip.title || "branch"}
      </button>);
    } else {
      tags.push(<span key={`tip${i}`} className="tree-tip">branch tip</span>);
    }
  }
  return tags;
}

// Memoized: the pane re-renders with App on every bridge update.
const TreeRow = React.memo(function TreeRow({ row, model, now, since, selected, currentFile, onSelect, onOpenTip }) {
  const tags = treeTags(row, model, now, since, currentFile, onOpenTip);
  const height = tags.length ? TREE_ROW_H_TAGGED : TREE_ROW_H;
  return (
    <div className={`tree-row s-${row.state}${selected ? " selected" : ""}`} style={{ height }}
      onClick={() => onSelect(row.id)}>
      <TreeGraph graph={row.graph} state={row.state} lanes={model.lanes} height={height} />
      <div className="tree-text">
        <div className="tree-prompt" title={row.text}>
          <span className="tree-time mono">{TreeFmt.when(row.ts, now)}</span>{row.text || <i>(no text)</i>}
        </div>
        <div className="tree-reply">{row.reply ? row.reply : <i>no text reply</i>}</div>
        {tags.length > 0 && <div className="tree-tips">{tags}</div>}
      </div>
      <TreeMeter row={row} ttlMs={model.ttlMs} now={now} />
    </div>
  );
});

const TreeCompaction = React.memo(function TreeCompaction({ row, now }) {
  return (
    <div className="tree-compaction">
      <span>context compacted · {TreeFmt.when(row.ts, now)}</span>
      <span>prompts above re-ask the full earlier context</span>
    </div>
  );
});

Object.assign(window, { TreeFmt, TreeRow, TreeCompaction });

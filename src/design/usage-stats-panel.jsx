/* ═════════════════════════════════════════════════════════════════════
   usage-stats-panel.jsx — usage/cost dashboard for the active tab's
   profile, sourced from `omp stats --json` (src-tauri/src/stats.rs::fetch).
   Two scope limits the panel makes explicit in its copy rather than
   implying "everything": it is scoped to the active tab's *profile* (not
   merged across every profile — omp itself resolves one profile per
   invocation), and to the installed omp CLI's rolling last-24-hours
   window (the `--json` path has no flag to request more). Unlike
   changes-panel.jsx/approval-rules-panel.jsx it is not scoped to the
   active tab's *project* — there is no per-tab refetch on tab switch,
   only the panel's own refresh button (which does re-run against
   whichever tab's profile is active when clicked).
   ═════════════════════════════════════════════════════════════════════ */

const { Icon: _StatsIcon } = window;

function formatCost(n) {
  return n === null || n === undefined ? "—" : `$${n.toFixed(2)}`;
}

function formatPct(n) {
  return n === null || n === undefined ? "—" : `${(n * 100).toFixed(1)}%`;
}

function formatMs(n) {
  if (n === null || n === undefined) return "—";
  return n >= 1000 ? `${(n / 1000).toFixed(1)}s` : `${Math.round(n)}ms`;
}

function formatCount(n) {
  // `total_premium_requests` (and nothing else this panel renders) is a
  // SQL SUM of a fractional REAL column (provider premium multipliers
  // include values like 0.33/0.25), so it needs its own formatter rather
  // than the integer-assuming `.toLocaleString()` used elsewhere —
  // rounds to 2 places, matching upstream's own `normalizePremiumRequests`.
  return n === null || n === undefined
    ? "—"
    : n.toLocaleString(undefined, { maximumFractionDigits: 2 });
}

// `omp stats`'s own `folder` field observed in practice: a cwd under
// $HOME is stored home-relative with `/` replaced by `-` (e.g.
// `/home/user/my-project` → `-my-project`, NOT the full absolute path
// with every segment flattened), and a cwd equal to `$HOME` itself
// encodes to the bare string `-`. A cwd outside $HOME/tmp instead keeps
// a real absolute-path shape (`/opt-foo/` style). Stripping the leading
// `-` therefore isn't guaranteed to leave a non-empty, meaningful name —
// a home-directory session strips down to "", which without the
// fallback below would render as a blank row (the real key is still
// available via the `title` tooltip either way).
function displayFolder(folder) {
  return folder.replace(/^-/, "") || "~";
}

const EMPTY = { overall: null, byModel: [], byFolder: [], byAgentType: [] };

// Mounted only while open (app-live.jsx gates on `statsOpen`), so there
// is no `open` prop and no early return for it — see the matching note
// in changes-panel.jsx.
function UsageStatsPanel({ onClose, profileLabel }) {
  const bridge = window.OMP_BRIDGE;
  const [data, setData]       = React.useState(EMPTY);
  const [loading, setLoading] = React.useState(false);
  const [error, setError]     = React.useState(null);

  const refresh = React.useCallback(async () => {
    if (!bridge) return;
    setLoading(true);
    setError(null);
    const res = await bridge.usageStats();
    if (!res.ok) {
      // Backend rejection (omp not on PATH, an omp build old enough to
      // predate the `stats` subcommand, a sync failure, ...) — see
      // stats.rs::exit_failure_message for why this is distinct from
      // "zero sessions synced" below.
      setError(res.error);
    } else if (res.value.overall.totalRequests > 0) {
      // `overall` is always a populated struct on a successful call (see
      // stats.rs::AggregatedStats — not optional), so a zero-request
      // count, not `overall`'s presence, is what actually distinguishes
      // "genuinely no usage yet" from a real dashboard.
      setData(res.value);
    } else {
      setError("no usage in the last 24 hours");
    }
    setLoading(false);
  }, [bridge]);

  React.useEffect(() => { refresh(); }, [refresh]);

  const overall = data.overall;

  return (
    <div className="bridge-scrim" onClick={onClose} style={{ paddingTop: "6vh" }}>
      <div className="stats-panel" onClick={e => e.stopPropagation()}>
        <div className="stats-head">
          <_StatsIcon name="cost" size={13} color="var(--accent)" />
          <span className="mono" style={{ color: "var(--fg-2)" }}>usage · {profileLabel} · last 24h</span>
          <button className="btn icon ghost" style={{ marginLeft: "auto" }} onClick={refresh} title="refresh">
            <_StatsIcon name="refresh" size={11} />
          </button>
          <button className="btn icon ghost" onClick={onClose} title="close">
            <_StatsIcon name="close" size={11} />
          </button>
        </div>
        <div className="stats-body">
          {loading && !overall && <div className="panel-empty mono">syncing session logs…</div>}
          {!loading && error && <div className="panel-empty mono">{error}</div>}
          {overall && (
            <>
              <div className="stats-cards">
                <div className="stats-card">
                  <span className="stats-card-label">requests</span>
                  <span className="stats-card-value">{overall.totalRequests.toLocaleString()}</span>
                  <span className="stats-card-sub">{formatPct(overall.errorRate)} error rate</span>
                </div>
                <div className="stats-card">
                  <span className="stats-card-label">cost</span>
                  <span className="stats-card-value">{formatCost(overall.totalCost)}</span>
                  <span className="stats-card-sub">{formatCount(overall.totalPremiumRequests)} premium</span>
                </div>
                <div className="stats-card">
                  <span className="stats-card-label">tokens</span>
                  <span className="stats-card-value">
                    {window.formatTokens(overall.totalInputTokens)} in / {window.formatTokens(overall.totalOutputTokens)} out
                  </span>
                  <span className="stats-card-sub">{formatPct(overall.cacheRate)} cached</span>
                </div>
                <div className="stats-card">
                  <span className="stats-card-label">performance</span>
                  <span className="stats-card-value">{Math.round(overall.avgTokensPerSecond ?? 0)} t/s</span>
                  <span className="stats-card-sub">
                    {formatMs(overall.avgTtft)} ttft · {formatMs(overall.avgDuration)} avg
                  </span>
                </div>
              </div>

              <div className="stats-section-label mono">by model</div>
              <div className="stats-table">
                {data.byModel.length === 0 && <div className="panel-empty mono">no data</div>}
                {data.byModel.map(m => (
                  <div key={`${m.provider}-${m.model}`} className="stats-row">
                    <span className="stats-row-name mono" title={`${m.provider}/${m.model}`}>{m.model}</span>
                    <span className="stats-row-metric mono">{m.totalRequests.toLocaleString()} req</span>
                    <span className="stats-row-metric mono">
                      {window.formatTokens(m.totalInputTokens)}/{window.formatTokens(m.totalOutputTokens)}
                    </span>
                    <span className="stats-row-metric mono">{formatCost(m.totalCost)}</span>
                  </div>
                ))}
              </div>

              <div className="stats-section-label mono">by folder</div>
              <div className="stats-table">
                {data.byFolder.length === 0 && <div className="panel-empty mono">no data</div>}
                {data.byFolder.map(f => (
                  <div key={f.folder} className="stats-row">
                    <span className="stats-row-name mono" title={f.folder}>{displayFolder(f.folder)}</span>
                    <span className="stats-row-metric mono">{f.totalRequests.toLocaleString()} req</span>
                    <span className="stats-row-metric mono">{formatCost(f.totalCost)}</span>
                  </div>
                ))}
              </div>

              {data.byAgentType.length > 0 && (
                <>
                  <div className="stats-section-label mono">by agent type</div>
                  <div className="stats-chips">
                    {data.byAgentType.map(a => (
                      <span key={a.agentType} className="chip muted mono">
                        {a.agentType} · {a.totalRequests.toLocaleString()} req · {formatCost(a.totalCost)}
                      </span>
                    ))}
                  </div>
                </>
              )}
            </>
          )}
        </div>
      </div>
    </div>
  );
}

window.UsageStatsPanel = UsageStatsPanel;

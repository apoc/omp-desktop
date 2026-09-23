/* ═════════════════════════════════════════════════════════════════════
   usage-stats-panel.jsx — cross-session usage/cost dashboard, sourced
   from `omp stats --json` (src-tauri/src/stats.rs::fetch). Unlike
   changes-panel.jsx/approval-rules-panel.jsx, this data is NOT scoped to
   the active tab's project — it aggregates every session log on disk,
   across every project and profile — so there is no per-tab refetch on
   tab switch, only the panel's own refresh button.
   ═════════════════════════════════════════════════════════════════════ */

const { Icon: _StatsIcon } = window;
const { formatTokens: _formatTokens } = window;

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

// `omp stats`'s own `folder` field is already a flattened project key —
// `/` replaced with `-` (e.g. `/home/user/my-project` becomes
// `-home-user-my-project`), not a real filesystem path — so there is no
// separator left to split on here. Only cosmetic cleanup: drop the
// leading `-` every value has (from the path's leading `/`).
function displayFolder(folder) {
  return folder.replace(/^-/, "");
}

const EMPTY = { overall: null, byModel: [], byFolder: [], byAgentType: [] };

// Mounted only while open (app-live.jsx gates on `statsOpen`), so there
// is no `open` prop and no early return for it — see the matching note
// in changes-panel.jsx.
function UsageStatsPanel({ onClose }) {
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
      // Backend rejection (omp not found, `stats` module not installed on
      // this omp build, sync failure, ...) — see stats.rs::exit_failure_message
      // for why this is distinct from "zero sessions synced".
      setError(res.error);
    } else if (res.value?.overall) {
      setData(res.value);
    } else {
      setError("no usage data yet — omp stats hasn't synced any sessions");
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
          <span className="mono" style={{ color: "var(--fg-2)" }}>usage</span>
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
                  <span className="stats-card-sub">{overall.totalPremiumRequests.toLocaleString()} premium</span>
                </div>
                <div className="stats-card">
                  <span className="stats-card-label">tokens</span>
                  <span className="stats-card-value">
                    {_formatTokens(overall.totalInputTokens)} in / {_formatTokens(overall.totalOutputTokens)} out
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
                      {_formatTokens(m.totalInputTokens)}/{_formatTokens(m.totalOutputTokens)}
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

/* ═════════════════════════════════════════════════════════════════════
   approval-rules-panel.jsx — lists tool-approval rules granted for the
   active tab's session/project, with a revoke button per rule.
   Backed by OMP_BRIDGE.listApprovalRules/revokeApprovalRule
   (src-tauri/src/approval.rs::RuleBook). Rules are granted from the ask
   bubble itself (chat/ask-bubble.jsx's "Allow for this session" /
   "Always allow in this project" buttons) — this panel is read + revoke
   only, there's no "add rule" affordance here by design: a rule should
   only ever originate from an actual prompt the human saw and approved.
   ═════════════════════════════════════════════════════════════════════ */

const { Icon: _RulesIcon } = window;

// Mounted only while open (app-live.jsx gates on `rulesOpen`) — see the
// matching note in changes-panel.jsx.
function ApprovalRulesPanel({ onClose }) {
  const bridge = window.OMP_BRIDGE;
  const [rules, setRules]     = React.useState([]);
  const [loading, setLoading] = React.useState(false);

  const refresh = React.useCallback(async () => {
    if (!bridge) return;
    setLoading(true);
    try {
      setRules(await bridge.listApprovalRules());
    } finally {
      setLoading(false);
    }
  }, [bridge]);

  React.useEffect(() => { refresh(); }, [refresh]);

  const handleRevoke = async (rule) => {
    await bridge?.revokeApprovalRule(rule.tool, rule.scope);
    await refresh();
  };

  return (
    <div className="bridge-scrim" onClick={onClose} style={{ paddingTop: "10vh" }}>
      <div className="rules-panel" onClick={e => e.stopPropagation()}>
        <div className="rules-head">
          <_RulesIcon name="check" size={13} color="var(--accent)" />
          <span className="mono" style={{ color: "var(--fg-2)" }}>approval rules</span>
          <button className="btn icon ghost" style={{ marginLeft: "auto" }} onClick={refresh} title="refresh">
            <_RulesIcon name="refresh" size={11} />
          </button>
          <button className="btn icon ghost" onClick={onClose} title="close">
            <_RulesIcon name="close" size={11} />
          </button>
        </div>
        <div className="rules-body">
          {loading && rules.length === 0 && <div className="panel-empty mono">loading…</div>}
          {!loading && rules.length === 0 && (
            <div className="panel-empty mono">
              no standing rules yet — grant one from an "Allow tool" prompt
            </div>
          )}
          {rules.map((rule, i) => (
            <div key={`${rule.scope}-${rule.tool}-${i}`} className="rules-row">
              <span
                className="chip"
                style={{
                  color: rule.scope === "project" ? "var(--cyan)" : "var(--fg-3)",
                  borderColor: rule.scope === "project"
                    ? "color-mix(in oklab, var(--cyan) 30%, var(--line))"
                    : "var(--line-bright)",
                }}
              >
                {rule.scope}
              </span>
              <span className="rules-tool mono">{rule.tool}</span>
              {rule.grantedAt && <span className="chip muted mono">{rule.grantedAt}</span>}
              <button
                className="btn icon ghost"
                style={{ marginLeft: "auto" }}
                title="revoke"
                onClick={() => handleRevoke(rule)}
              >
                <_RulesIcon name="trash" size={10} />
              </button>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}

window.ApprovalRulesPanel = ApprovalRulesPanel;

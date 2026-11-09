/* ═════════════════════════════════════════════════════════════════════
   design/settings/rows-approvals.jsx — custom Settings rows of Approvals
   (window.OMP_SETTINGS_ROWS):
     approvalMode   the tool approval mode editor (default + per-project
                    overrides, approval-mode-section.jsx) — the same
                    component the approvals panel shows
     approvalRules  how many standing rules the active tab's session and
                    project have (OMP_BRIDGE.listApprovalRules) and
                    "Manage rules", which opens the approvals panel
   ═════════════════════════════════════════════════════════════════════ */

/** The rendered tab's entry, null with no tab (EMPTY_PROJECT has no id). */
function _SRAp_project(ctx) {
  return ctx.activeProject?.id ? ctx.activeProject : null;
}

function _SRAp_Mode({ row, ctx, query }) {
  const { SettingsRow: Row, ApprovalModeSection } = window;
  return (
    <Row stack label={row.label} desc={row.desc} query={query}>
      <ApprovalModeSection view={ctx.approvalModes} activeProject={_SRAp_project(ctx)}
        sessions={ctx.sessions} query={query} />
    </Row>
  );
}

function _SRAp_Rules({ row, ctx, query }) {
  const { SettingsRow: Row, SettingsButton: Button, Icon } = window;
  const project = _SRAp_project(ctx);
  const [count, setCount] = React.useState(null);
  React.useEffect(() => {
    if (!ctx.bridge || !project) { setCount(null); return undefined; }
    let live = true;
    ctx.bridge.listApprovalRules().then(rules => { if (live) setCount(Array.isArray(rules) ? rules.length : null); });
    return () => { live = false; };
  }, [ctx.bridge, project?.id]);
  let lead = OMP_TR("Open a tab to see its session and project rules.");
  if (project && count !== null) {
    lead = count === 0
      ? OMP_TR("No standing rules for this tab's session and project.")
      : window.OMP_I18N.plural(count, "{n} standing rule for this tab's session and project.", "{n} standing rules for this tab's session and project.", { n: count });
  }
  return (
    <Row label={row.label} query={query} className="st-linkrow" desc={`${lead} ${window.OMP_I18N.t(row.desc)}`}>
      <Button accent onClick={ctx.openApprovals}>
        {OMP_TR("Manage rules")} <Icon name="external" size={11} />
      </Button>
    </Row>
  );
}

Object.assign(window.OMP_SETTINGS_ROWS = window.OMP_SETTINGS_ROWS || {}, {
  approvalMode: _SRAp_Mode,
  approvalRules: _SRAp_Rules,
});

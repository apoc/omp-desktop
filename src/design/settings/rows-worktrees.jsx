/* Native-managed worktree storage; budgets are advisory, not deletion commands. */
function _STW_Worktrees({ row, query }) {
  const { view, loading, error, refresh, setPolicy, setPin, sweep, restore } = window.OMP_WORKTREE_STORAGE_HOOK.useWorktreeStorage();
  const { validateBudget, formatBytes, expiryDescription } = window.OMP_WORKTREE_STORAGE;
  const [count, setCount] = React.useState("");
  const [bytes, setBytes] = React.useState("");
  const [validation, setValidation] = React.useState(null);
  React.useEffect(() => {
    if (!view?.policy) return;
    setCount(String(view.policy.maxWorktrees));
    setBytes(String(view.policy.maxBytes));
    setValidation(null);
  }, [view?.policy?.maxWorktrees, view?.policy?.maxBytes]);

  const save = event => {
    event.preventDefault();
    const result = validateBudget(count, bytes);
    setValidation(result.error);
    if (result.policy) void setPolicy(result.policy);
  };
  const Row = window.SettingsRow;
  return (
    <Row label={row.label} desc={row.desc} query={query} stack>
      <div className="st-worktrees" aria-busy={loading}>
        <p>Kept checkouts have a 30-day inactivity lease. Open or pinned checkouts are protected; budgets do not override the lease or delete restore points.</p>
        {error && <p className="worktree-error" role="alert">{error}</p>}
        {view?.error && <p className="worktree-error" role="alert">{view.error}</p>}
        {!view && <div><button type="button" className="st-btn" disabled={loading} onClick={() => void refresh()}>Retry loading</button></div>}
        {view && <>
          <div className="st-worktrees-summary">
            <span>{view.retainedCount} retained · {view.sizeComplete ? "" : "at least "}{formatBytes(view.usedBytes)} checkouts</span>
            <span>{formatBytes(view.snapshotBytes)} restore points</span>
          </div>
          {!view.sizeComplete && <p>Some checkout sizes are not measured. Refresh sizes to update the total.</p>}
          {view.overBudget && <p className="st-worktrees-warning">Over budget. Protected or unexpired work and restore points are retained; cleanup may require your attention.</p>}
          <form className="st-worktrees-budget" onSubmit={save}>
            <label>Checkout count limit<input className="st-rem-input" type="number" min="1" step="1" value={count} disabled={loading} onChange={event => setCount(event.target.value)} /></label>
            <label>Storage limit (bytes)<input className="st-rem-input" type="number" min="1" step="1" value={bytes} disabled={loading} onChange={event => setBytes(event.target.value)} /></label>
            <button type="submit" className="st-btn" disabled={loading}>Save limits</button>
          </form>
          {validation && <p className="worktree-error" role="alert">{validation}</p>}
          <div className="st-worktrees-actions">
            <button type="button" className="st-btn" disabled={loading} onClick={() => void refresh()}>Refresh sizes</button>
            <button type="button" className="st-btn" disabled={loading} onClick={() => void sweep()}>Check due worktrees now</button>
          </div>
          <p>Only expired leases are checked; native safety checks still apply. Restoring a checkout does not open its conversation.</p>
          {view.workspaces.length === 0 ? <p>No managed worktrees.</p> :
            <ul className="st-worktrees-list">{view.workspaces.map(workspace => (
              <li className="st-worktrees-item" key={workspace.id}>
                <div className="st-worktrees-info">
                  <strong className="worktree-path">{workspace.path}</strong>
                  <span>{workspace.state === "evicted" ? "Restore point saved" : "Present checkout"} · {workspace.profile} · {expiryDescription(workspace)}</span>
                  <span>{workspace.state === "evicted" ? "Checkout checkpointed" : workspace.sizeKnown ? `${formatBytes(workspace.bytes)} checkout` : "Checkout size not measured"} · {formatBytes(workspace.snapshotBytes)} restore point{workspace.branch ? ` · ${workspace.branch}` : ""}</span>
                  {workspace.error && <span className="worktree-error">{workspace.error}</span>}
                  {workspace.measurementError && <span className="worktree-error">Size measurement: {workspace.measurementError}</span>}
                </div>
                <div className="st-worktrees-actions">
                  <button type="button" className="st-btn" disabled={loading} aria-label={`${workspace.pinned ? "Unpin" : "Pin"} ${workspace.path}`} onClick={() => void setPin(workspace.id, !workspace.pinned)}>{workspace.pinned ? "Unpin" : "Pin"}</button>
                  {workspace.state === "evicted" && <button type="button" className="st-btn" disabled={loading} aria-label={`Restore ${workspace.path}`} onClick={() => void restore(workspace.id)}>Restore</button>}
                </div>
              </li>
            ))}</ul>}
        </>}
      </div>
    </Row>
  );
}
Object.assign(window.OMP_SETTINGS_ROWS = window.OMP_SETTINGS_ROWS || {}, { worktrees: _STW_Worktrees });

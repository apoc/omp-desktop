/* ═════════════════════════════════════════════════════════════════════
   changes-panel.jsx — bounded git status/diff panel for the active tab's
   project. Backed by OMP_BRIDGE.workspaceStatus/workspaceDiff/
   workspaceAccept/workspaceReject (src-tauri/src/workspace.rs — every cap
   noted below is enforced server-side, this component just displays what
   it's given). File list on the left, diff on the right; reuses the
   existing markdown+highlight.js pipeline for diff syntax colouring
   (fenced ```diff block) rather than a bespoke diff renderer.
   ═════════════════════════════════════════════════════════════════════ */

const { Icon: _ChangesIcon, MarkdownContent: _ChangesMarkdown } = window;

const STATUS_KIND_META = {
  Modified:  { label: "M", color: "var(--amber)" },
  Added:     { label: "A", color: "var(--accent)" },
  Deleted:   { label: "D", color: "var(--rose)" },
  Renamed:   { label: "R", color: "var(--cyan)" },
  Untracked: { label: "U", color: "var(--fg-3)" },
};

function ChangesPanel({ open, onClose }) {
  const bridge = window.OMP_BRIDGE;
  const [status, setStatus]         = React.useState({ files: [], truncated: false });
  const [loading, setLoading]       = React.useState(false);
  const [selected, setSelected]     = React.useState(null);
  const [diff, setDiff]             = React.useState(null);
  const [diffLoading, setDiffLoading] = React.useState(false);

  const refreshStatus = React.useCallback(async () => {
    if (!bridge) return;
    setLoading(true);
    try {
      const result = await bridge.workspaceStatus();
      setStatus(result);
      // Keep the current selection if it's still listed; otherwise fall
      // back to the first file so the diff pane is never orphaned.
      setSelected(prev => {
        if (prev && result.files.some(f => f.path === prev)) return prev;
        return result.files[0]?.path ?? null;
      });
    } finally {
      setLoading(false);
    }
  }, [bridge]);

  React.useEffect(() => {
    if (open) refreshStatus();
  }, [open, refreshStatus]);

  React.useEffect(() => {
    if (!open || !selected || !bridge) {
      setDiff(null);
      return undefined;
    }
    let cancelled = false;
    setDiffLoading(true);
    bridge.workspaceDiff(selected)
      .then(result => { if (!cancelled) setDiff(result); })
      .finally(() => { if (!cancelled) setDiffLoading(false); });
    return () => { cancelled = true; };
  }, [open, selected, bridge]);

  const handleAccept = async (path, e) => {
    e.stopPropagation();
    await bridge?.workspaceAccept(path);
    await refreshStatus();
  };

  const handleReject = async (path, e) => {
    e.stopPropagation();
    await bridge?.workspaceReject(path);
    await refreshStatus();
  };

  if (!open) return null;

  return (
    <div className="bridge-scrim" onClick={onClose} style={{ paddingTop: "6vh" }}>
      <div className="changes-panel" onClick={e => e.stopPropagation()}>
        <div className="changes-head">
          <_ChangesIcon name="diff2" size={13} color="var(--accent)" />
          <span className="mono" style={{ color: "var(--fg-2)" }}>changes</span>
          {status.truncated && (
            <span className="chip muted" style={{ marginLeft: 8 }}>truncated at 200 files</span>
          )}
          <button className="btn icon ghost" style={{ marginLeft: "auto" }} onClick={refreshStatus} title="refresh">
            <_ChangesIcon name="refresh" size={11} />
          </button>
          <button className="btn icon ghost" onClick={onClose} title="close">
            <_ChangesIcon name="close" size={11} />
          </button>
        </div>
        <div className="changes-body">
          <div className="changes-file-list">
            {loading && status.files.length === 0 && <div className="changes-empty mono">loading…</div>}
            {!loading && status.files.length === 0 && <div className="changes-empty mono">no changes</div>}
            {status.files.map(f => {
              const meta = STATUS_KIND_META[f.kind] ?? STATUS_KIND_META.Modified;
              return (
                <div
                  key={f.path}
                  className={`changes-file-row ${selected === f.path ? "active" : ""}`}
                  onClick={() => setSelected(f.path)}
                >
                  <span className="changes-kind" style={{ color: meta.color }}>{meta.label}</span>
                  <span className="changes-path mono" title={f.path}>{f.path}</span>
                  <button className="btn icon ghost" title="stage" onClick={e => handleAccept(f.path, e)}>
                    <_ChangesIcon name="check" size={10} />
                  </button>
                  <button className="btn icon ghost" title="discard" onClick={e => handleReject(f.path, e)}>
                    <_ChangesIcon name="trash" size={10} />
                  </button>
                </div>
              );
            })}
          </div>
          <div className="changes-diff">
            {diffLoading && <div className="changes-empty mono">loading diff…</div>}
            {!diffLoading && !diff && <div className="changes-empty mono">select a file</div>}
            {!diffLoading && diff?.kind === "Binary" && (
              <div className="changes-empty mono">binary file — no text diff to show</div>
            )}
            {!diffLoading && diff?.kind === "Untracked" && (
              <div className="changes-empty mono">untracked file — nothing to diff against</div>
            )}
            {!diffLoading && diff?.kind === "Text" && (
              <_ChangesMarkdown text={"```diff\n" + (diff.content || "") + "\n```"} />
            )}
            {!diffLoading && diff?.truncated && (
              <div className="chip muted" style={{ marginTop: 6 }}>diff truncated</div>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}

window.ChangesPanel = ChangesPanel;

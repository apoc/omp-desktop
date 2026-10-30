/* git/git-browser.jsx — the git browser: a full-window view of the active
   tab's project. Files pane (git/file-tree.jsx), the selected file with its
   change inline (git/file-view.jsx), commit graph with refs
   (git/history.jsx). Opened from the toolbar's git button, the
   `desktop.panel.changes` chord, or a path in an edit card (initialPath).
   Every datum comes from app/use-git-browser.jsx (useGitBrowser); a history
   click browses that commit read-only, the working-tree row returns. */

const { Icon: _GB_Icon, GitFileTree: _GB_Tree, GitFileView: _GB_View, GitHistory: _GB_History } = window;

// Memoised: App re-renders on every streamed frame, and none of them touch
// these props (`edits` is a count, not the transcript).
const GitBrowser = React.memo(function GitBrowser({ bridge, onClose, initialPath, branch, edits }) {
  const g = window.useGitBrowser({ bridge, initialPath, branch, edits });
  const rootRef = React.useRef(null);

  // The dialog takes focus, so keystrokes never reach the hidden composer;
  // on close the focus goes back where it was (the composer, usually).
  React.useEffect(() => {
    const restore = document.activeElement;
    rootRef.current?.focus();
    return () => { restore?.focus?.(); };
  }, []);

  // Escape closes the browser, unless something already handled the key or
  // a modal stacked above it holds the focus: those all render in a
  // `.bridge-scrim` (the command bridge, the approvals/stats/update panels,
  // z-index 100 over this overlay's 90). Focus elsewhere does not count —
  // the composer refocuses its textarea under the scrim when a turn ends.
  // On document, bubble phase: after the dialog's own handlers, before the
  // window keymap (use-keymap.jsx), which prevents Escape for
  // `app.interrupt` and skips an already prevented one, so no turn aborts.
  React.useEffect(() => {
    const onKey = e => {
      if (e.key !== "Escape" || e.defaultPrevented) return;
      const focus = document.activeElement;
      if (focus && !rootRef.current?.contains(focus) && focus.closest(".bridge-scrim")) return;
      e.preventDefault();
      onClose();
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [onClose]);

  // The scrim closes on a click that both starts and ends on it, never on a
  // drag-select that merely ends there.
  const downOnScrim = React.useRef(false);

  const repo = g.status?.repo ?? null;
  const changed = g.status?.changed ?? 0;
  const inCommit = Boolean(g.commitSha);

  // The branch chip (or the short sha of a detached HEAD); an unborn branch
  // has a name but no commit yet, so it gets both chips.
  let headChip = null;
  if (repo?.branch) headChip = <span className="gitb-ref head"><_GB_Icon name="branch" size={9} />{repo.branch}</span>;
  else if (repo?.head) headChip = <span className="gitb-ref remote" title="detached HEAD">{repo.head.slice(0, 7)}</span>;
  const unbornChip = repo && !repo.head ? <span className="gitb-ref none" title="unborn branch">no commits</span> : null;

  return (
    <div className="gitb-scrim"
      onMouseDown={e => { downOnScrim.current = e.target === e.currentTarget; }}
      onClick={e => { if (downOnScrim.current && e.target === e.currentTarget) onClose(); downOnScrim.current = false; }}>
      <div className="gitb" ref={rootRef} role="dialog" aria-modal="true" aria-label="git browser" tabIndex={-1}>
        <div className="gitb-head">
          <_GB_Icon name="branch" size={13} color="var(--accent)" />
          <span className="gitb-title">git</span>
          {repo && <span className="gitb-project">{repo.name}</span>}
          {headChip}{unbornChip}
          {repo && (repo.ahead || repo.behind) ? (
            <span className="gitb-chip mono" title="ahead / behind upstream">↑{repo.ahead ?? 0} ↓{repo.behind ?? 0}</span>
          ) : null}
          <span className="gitb-head-stats mono">
            {g.status && <span>{changed} changed</span>}
          </span>
          <button type="button" className="btn ghost" onClick={g.refresh} title="refresh" aria-label="refresh"><_GB_Icon name="refresh" size={12} /></button>
          <button type="button" className="btn ghost" onClick={onClose} title="close (Esc)" aria-label="close"><_GB_Icon name="close" size={12} /></button>
        </div>
        {g.error ? (
          <div className="gitb-empty tall gitb-error">{g.error}</div>
        ) : (
          <div className="gitb-body">
            <_GB_Tree root={g.tree} error={g.commitError}
              expanded={g.expanded} onToggle={g.toggleDir} selected={g.selected} onSelect={g.select}
              changedOnly={inCommit || g.changedOnly} onChangedOnly={inCommit ? null : g.setChangedOnly}
              filter={g.filter} onFilter={g.setFilter} changedCount={changed}
              commit={g.commit} truncated={g.truncated} />
            <_GB_View path={g.selected} file={g.file} error={g.fileError} commit={g.commit}
              onStage={inCommit ? null : () => g.stage(g.selected)}
              onDiscard={inCommit ? null : () => g.discard(g.selected, g.file?.status ?? null)} />
            <_GB_History log={g.log} changedCount={changed}
              selected={g.commitSha ?? "@"} onSelect={g.browse} />
          </div>
        )}
      </div>
    </div>
  );
});

window.GitBrowser = GitBrowser;

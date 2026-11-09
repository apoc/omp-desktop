/* ═════════════════════════════════════════════════════════════════════
   files/files-panel.jsx — the files panel in the side column
   (docs/architecture/file-comments.md): the git browser's files pane
   (GitFileTree; hideable), the selected file with its marks (FileCode),
   and a footer with the tab's mark counts, "clear all" and "send now".

   Props: { ui, canSendNow, onSendNow, onOpenGit }
     ui         — useFileComments (app/use-file-comments.jsx)
     canSendNow — whether the marks can go out without typed text now
     onSendNow  — sends the marks with no typed text
     onOpenGit  — path → the git browser on that file
   ═════════════════════════════════════════════════════════════════════ */
const {
  Icon: _FCP_Icon, CopyButton: _FCP_Copy, GitFileTree: _FCP_Tree, FileCode: _FCP_Code,
  FileState: _FCP_State, FILE_STATES: _FCP_STATES,
} = window;
const { clipLines: _FCP_clip, MAX_LINES: _FCP_MAX_LINES, MAX_LINE_CHARS: _FCP_MAX_LINE_CHARS } = window.OMP_FILE_PREVIEW;
const { formatBytes: _FCP_size } = window.OMP_UPDATER;
const _FCP_NO_MARKS = Object.freeze([]);

function _FCP_Body({ ui, path, clip }) {
  const f = ui.file;
  const value = f?.value;
  const marks = React.useMemo(
    () => (path ? ui.marks.filter(m => m.path === path) : _FCP_NO_MARKS), [ui.marks, path]);
  if (!ui.hasFolder) return <_FCP_State title={OMP_TR("No project folder")} sub={OMP_TR("This tab was opened without a folder.")} />;
  if (!ui.view.selected) {
    return <_FCP_State title={OMP_TR("No file open")} sub={OMP_TR("Pick a file in the tree, or type part of its path in the filter box.")} />;
  }
  if (!f) return <div className="fp-state"><span className="shimmer-text">{OMP_TR("Loading…")}</span></div>;
  if (f.error) return <_FCP_State title={OMP_TR("Can't open this file")} sub={f.error} />;
  const state = _FCP_STATES[value.kind];
  if (state) {
    const sub = state.sub ? OMP_TR(state.sub) : OMP_TR("{size} is over the preview limit.", { size: _FCP_size(value.size) });
    return <_FCP_State title={OMP_TR(state.title)} sub={sub} />;
  }
  if (!clip) return <_FCP_State title={OMP_TR("Not a text file")} sub={OMP_TR("Only text files take explain marks and comments.")} />;
  return (
    <_FCP_Code key={path} path={path} text={clip.text} marks={marks} target={ui.view.target}
      onAdd={ui.addMark} onUpdate={ui.updateMark} onRemove={ui.removeMark} onTargetDone={ui.targetDone} />
  );
}

function _FCP_Foot({ ui, canSendNow, onSendNow }) {
  const { explain, comment, files } = ui.counts;
  const plural = window.OMP_I18N.plural;
  const parts = [];
  if (explain) parts.push(plural(explain, "{n} to explain", "{n} to explain", { n: explain }));
  if (comment) parts.push(plural(comment, "{n} comment", "{n} comments", { n: comment }));
  return (
    <div className="fc-foot">
      <span className="fc-foot-text">
        {parts.length ? (
          <>
            <b>{parts.join(", ")}</b> {plural(files, "in {n} file", "in {n} files", { n: files })}
            {" · "}{OMP_TR("they go out with your next message")}
          </>
        ) : OMP_TR("Pick lines or select text, then explain or comment.")}
      </span>
      <span className="fc-spacer" />
      <button type="button" className="btn ghost" onClick={ui.clearMarks} disabled={!parts.length}>
        <_FCP_Icon name="trash" size={11} /> {OMP_TR("clear all")}
      </button>
      <button type="button" className="btn outlined" onClick={onSendNow} disabled={!parts.length || !canSendNow}
        title={OMP_TR("Send the marks now, with no typed text")}>
        <_FCP_Icon name="send" size={11} /> {OMP_TR("send now")}
      </button>
    </div>
  );
}

function FilesPanel({ ui, canSendNow, onSendNow, onOpenGit }) {
  const value = ui.file?.value;
  const clip = React.useMemo(() => (value?.kind === "Text" ? _FCP_clip(value.text) : null), [value]);
  const path = value?.path ?? ui.view.selected;
  const slash = path ? path.search(/[^/]*$/) : 0;
  const { treeOpen } = ui.view;
  return (
    <section className="fc-panel" aria-label={OMP_TR("files panel")}>
      <div className={`fc-split${treeOpen ? "" : " no-tree"}`}>
        {treeOpen && ui.hasFolder && (
          <_FCP_Tree
            root={ui.tree} error={ui.treeError} expanded={ui.expanded} onToggle={ui.toggleDir}
            selected={ui.view.selected} onSelect={ui.select}
            changedOnly={ui.view.changedOnly && !ui.searchMode} onChangedOnly={ui.searchMode ? null : ui.setChangedOnly}
            filter={ui.view.filter} onFilter={ui.setFilter}
            changedCount={ui.changedCount} truncated={ui.truncated}
            badges={ui.counts.byPath}
            commented={ui.counts.files > 0 && !ui.searchMode
              ? { count: ui.counts.files, on: ui.commentedOnly, onToggle: ui.setCommentedOnly } : null}
            searched={ui.searchMode}
            emptyText={ui.searchMode && !ui.view.filter.trim()
              ? OMP_TR("Not a git repository: type to search the folder.") : undefined}
          />
        )}
        <div className="fc-view">
          <div className="fc-bar">
            <button type="button" className={`btn ghost icon fc-tree-btn${treeOpen ? " on" : ""}`} aria-pressed={treeOpen}
              title={treeOpen ? OMP_TR("hide the file tree") : OMP_TR("show the file tree")}
              onClick={() => ui.setTreeOpen(!treeOpen)}>
              <_FCP_Icon name="sidebar" size={13} />
            </button>
            <span className="fc-crumb mono" title={path ?? ""}>
              {path ? <>{path.slice(0, slash)}<b>{path.slice(slash)}</b></> : null}
            </span>
            {clip && <span className="chip muted mono">{clip.total} {OMP_TR("lines")}</span>}
            {clip?.truncated && (
              <span className="chip warn mono" title={OMP_TR("Shown: the first {n} lines, each cut at {m} characters", { n: _FCP_MAX_LINES, m: _FCP_MAX_LINE_CHARS })}>{OMP_TR("truncated")}</span>
            )}
            <span className="fc-spacer" />
            <button type="button" className="btn ghost icon" onClick={ui.refresh} title={OMP_TR("reload from disk")} aria-label={OMP_TR("reload from disk")}>
              <_FCP_Icon name="refresh" size={12} />
            </button>
            {value && value.kind !== "Outside" && !ui.searchMode && (
              <button type="button" className="btn ghost icon" onClick={() => onOpenGit(value.path)}
                title={OMP_TR("Open in the git browser")} aria-label={OMP_TR("Open in the git browser")}>
                <_FCP_Icon name="diff2" size={12} />
              </button>
            )}
            {value && <_FCP_Copy className="fp-copy" label={OMP_TR("Copy the project-relative path")} text={value.path} />}
          </div>
          <div className="fc-body">
            <_FCP_Body ui={ui} path={value?.path ?? null} clip={clip} />
          </div>
        </div>
      </div>
      <_FCP_Foot ui={ui} canSendNow={canSendNow} onSendNow={onSendNow} />
    </section>
  );
}

window.FilesPanel = FilesPanel;

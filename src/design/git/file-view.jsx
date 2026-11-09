/* git/file-view.jsx — the git browser's middle pane: the whole file (Rust's
   FileView) with its change inline (removed lines in place, added lines
   highlighted), old/new line numbers and hunk navigation. In the working
   tree the change is against HEAD and a changed file can be staged or
   discarded; while a commit is browsed it is that commit's change against
   its first parent, read-only, and the head names the commit. Reuses
   chat.css's .diff-line colours. */

const { Icon: _GV_Icon, CopyButton: _GV_Copy, GIT_STATUS_META: _GV_META } = window;
const { hunkStarts: _GV_hunkStarts, splitPath: _GV_splitPath, diffText: _GV_diffText } = window.OMP_GIT_BROWSER;

function GitFileView({ path, file, error, commit, onStage, onDiscard }) {
  const bodyRef = React.useRef(null);
  const scrollToLine = i => bodyRef.current?.querySelector(`[data-line="${i}"]`)?.scrollIntoView({ block: "center" });
  const [hunk, setHunk] = React.useState(0);
  const lines = file?.kind === "Text" ? file.lines : null;
  const hunks = React.useMemo(() => (lines ? _GV_hunkStarts(lines) : []), [lines]);
  const copyText = React.useMemo(() => (lines ? _GV_diffText(lines) : ""), [lines]);

  // A newly shown file opens on its first change; a refresh of the same
  // file keeps the reader's place.
  const jumpPending = React.useRef(false);
  React.useEffect(() => { setHunk(0); jumpPending.current = true; }, [path, commit?.id]);
  React.useEffect(() => {
    if (!jumpPending.current || !lines) return;
    jumpPending.current = false;
    if (hunks.length) scrollToLine(hunks[0]);
    else bodyRef.current?.scrollTo(0, 0);
  }, [lines, hunks]);

  // A refresh of the same file can leave fewer hunks: the counter clamps to
  // the last one, and ↑↓ step from there.
  const shown = Math.min(hunk, Math.max(hunks.length - 1, 0));

  const jump = (next) => {
    if (!hunks.length) return;
    const i = (next + hunks.length) % hunks.length;
    setHunk(i);
    scrollToLine(hunks[i]);
  };

  if (!path) {
    return (
      <div className="gitb-pane gitb-view">
        <div className="gitb-empty tall">{OMP_TR("select a file")}</div>
      </div>
    );
  }
  const [dir, name] = _GV_splitPath(file?.path ?? path);
  const meta = file?.status ? _GV_META[file.status] : null;
  // Stage/discard only act on the working tree, and only on a change.
  const actions = Boolean(onStage && meta);

  return (
    <div className="gitb-pane gitb-view">
      <div className="gitb-pane-head gitb-view-head mono">
        {commit && (
          <span className="gitb-view-commit" title={`${commit.id}\n${commit.subject}`}>
            <span className="gitb-chip"><_GV_Icon name="commit" size={10} />{commit.short}</span>
            <span className="gitb-view-subject">{commit.subject}</span>
          </span>
        )}
        <span className="gitb-view-path" title={file?.path ?? path}>
          <span className="gitb-view-dir">{dir}</span><span className="gitb-view-name">{name}</span>
        </span>
        {meta && <span className="gitb-chip" style={{ color: meta.color, borderColor: `color-mix(in oklab, ${meta.color} 40%, var(--line))` }}>{meta.title}</span>}
        {lines && (
          <span className="diff-counts">
            <span style={{ color: "var(--diff-add-fg)" }}>+{file.adds}</span>
            <span style={{ color: "var(--diff-rm-fg)" }}>−{file.rems}</span>
          </span>
        )}
        {file?.truncated && <span className="gitb-chip" title={OMP_TR("cut at the view cap: lines past 20 000 or a line's characters past 500")}>{OMP_TR("truncated")}</span>}
        {hunks.length > 0 && (
          <span className="gitb-hunks">
            <button type="button" className="btn ghost icon" onClick={() => jump(shown - 1)} aria-label={OMP_TR("previous change")}><_GV_Icon name="arrowUp" size={11} /></button>
            <span>{shown + 1}/{hunks.length}</span>
            <button type="button" className="btn ghost icon" onClick={() => jump(shown + 1)} aria-label={OMP_TR("next change")}><_GV_Icon name="chev" size={11} /></button>
          </span>
        )}
        {actions && <>
          <button type="button" className="btn ghost gitb-act" onClick={onStage} title="git add"><_GV_Icon name="check" size={11} /> {OMP_TR("stage")}</button>
          <button type="button" className="btn ghost gitb-act danger" onClick={onDiscard} title={OMP_TR("restore from HEAD")}><_GV_Icon name="trash" size={11} /> {OMP_TR("discard")}</button>
        </>}
        {copyText && <_GV_Copy className="gitb-copy" label={OMP_TR("Copy diff")} text={copyText} />}
      </div>
      <div className="gitb-view-body mono selectable" ref={bodyRef}>
        {/* A refetch (refresh, stage, discard) keeps the previous content in
            view; "loading…" only when there is nothing to show yet. */}
        {!file && !error && <div className="gitb-empty tall">{OMP_TR("loading…")}</div>}
        {error && <div className="gitb-empty tall gitb-error">{error}</div>}
        {file?.kind === "Binary" && <div className="gitb-empty tall">{OMP_TR("binary file")}</div>}
        {file?.kind === "TooLarge" && <div className="gitb-empty tall">{OMP_TR("file larger than the 2 MiB view cap")}</div>}
        {file?.kind === "Missing" && (
          <div className="gitb-empty tall">{commit ? "not in this commit" : "no such file in the working tree or HEAD"}</div>
        )}
        {lines && (
          <div className="gitb-lines">
            {lines.map((l, i) => (
              <div key={i} data-line={i} className={`gitb-line k-${l.kind}`}>
                <span className="gitb-ln">{l.old ?? ""}</span>
                <span className="gitb-ln">{l.new ?? ""}</span>
                <span className="diff-mark">{l.kind === "add" ? "+" : l.kind === "rem" ? "−" : " "}</span>
                <span className="gitb-code">{l.text}</span>
              </div>
            ))}
          </div>
        )}
        {lines && lines.length === 0 && <div className="gitb-empty">{OMP_TR("empty file")}</div>}
      </div>
    </div>
  );
}

window.GitFileView = GitFileView;

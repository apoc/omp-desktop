/* design/conversation-tree.jsx — the conversation-tree pane: the active tab's
   conversation as a git-style graph, one row per prompt, each with its
   prompt-cache state (src/app/conversation-tree.js builds the rows; the data
   flow is app/use-conversation-tree.jsx). It replaces the ambient rail while
   open (`.stage.with-tree`, layout/tree.css). Props mirror the hook's result;
   `onBranch`/`onFork`/`onOpenFile` are its actions. */

const {
  Icon: _CT_Icon, TreeFmt: _CT_Fmt, TreeRow: _CT_Row,
  TreeCompaction: _CT_Compaction, TreeDetail: _CT_Detail,
} = window;

const TREE_NO_FILE = "No conversation yet. The tree appears once the tab has a session file.";

const treeTtlLabel = ttlMs => (ttlMs == null ? "cache lifetime unknown" : `cache · ${_CT_Fmt.dur(ttlMs)}`);

function TreeSummary({ model }) {
  const c = model.counts;
  const unknown = c.total > 0 && c.unknown === c.total;
  return (
    <div className="tree-summary">
      {unknown ? (
        <div>The provider reports no cache lifetime, so cache status and prices are unknown.</div>
      ) : (<>
        <div>
          <b className="lime">{c.warm + c.expiring}</b> of {c.total} prompts can be re-asked at cache-read price
          {c.partial > 0 && <>, <b className="cyan">{c.partial}</b> partly cached</>}.
        </div>
        <div className="tree-legend mono">
          <span><i className="lg warm" />cached</span>
          <span><i className="lg expiring" />&lt; 10 min</span>
          <span><i className="lg partial" />partly cached</span>
          <span><i className="lg cold" />cold</span>
          <span className="muted">price = re-ask now</span>
        </div>
      </>)}
    </div>
  );
}

function ConversationTree({
  model, currentFile, error, loading, treeKey, now, since, streaming,
  onRefresh, onClose, onBranch, onFork, onOpenFile,
}) {
  const [selectedId, setSelectedId] = React.useState(null);
  React.useEffect(() => { setSelectedId(null); }, [treeKey]);

  const listRef = React.useRef(null);
  const scrolledFor = React.useRef("");
  // First load of a conversation: show the end (newest prompts).
  React.useLayoutEffect(() => {
    if (!model || model.rows.length === 0 || scrolledFor.current === treeKey) return;
    scrolledFor.current = treeKey;
    listRef.current.scrollTop = listRef.current.scrollHeight;
  }, [model, treeKey]);

  const prompts = React.useMemo(() => (model ? model.rows.filter(r => r.kind === "prompt") : []), [model]);
  const fallback = prompts.findLast(r => r.onCurrentPath) ?? prompts[prompts.length - 1] ?? null;
  const selected = prompts.find(r => r.id === selectedId) ?? fallback;
  // A tip tag has no inline error slot: the bridge files a failed open as a note.
  // Stable, so the memoized rows skip the re-renders every bridge update causes.
  const openTip = React.useCallback(
    path => onOpenFile(path).catch(err => console.error("[tree] open failed:", err)),
    [onOpenFile],
  );
  const branches = model?.tips.length ?? 0;
  const compactions = model ? model.rows.length - prompts.length : 0;

  let empty = null;
  if (error) empty = error;
  else if (!model) empty = treeKey && loading ? "Loading…" : TREE_NO_FILE;
  else if (prompts.length === 0) empty = "No prompts in this conversation yet.";

  return (
    <aside className="tree-drawer">
      <div className="tree-head">
        <span className="tree-title">conversation tree</span>
        {model && (
          <span className="chip muted mono">
            {model.counts.total} prompts
            {branches > 1 ? ` · ${branches} branches` : ""}
            {compactions > 0 ? ` · ${compactions} compactions` : ""}
          </span>
        )}
        {model && <span className="chip muted mono">{treeTtlLabel(model.ttlMs)}</span>}
        <div style={{ flex: 1 }} />
        <button className="btn icon ghost" onClick={onRefresh} disabled={loading || !treeKey} title="refresh">
          <_CT_Icon name="refresh" size={10} />
        </button>
        <button className="btn icon ghost" onClick={onClose} title="close">
          <_CT_Icon name="close" size={10} />
        </button>
      </div>
      {model && prompts.length > 0 && <TreeSummary model={model} />}
      <div className="tree-list" ref={listRef}>
        {empty && <div className="tree-empty">{empty}</div>}
        {model && model.rows.map(row => row.kind === "compaction"
          ? <_CT_Compaction key={row.id} row={row} now={now} />
          : <_CT_Row key={row.id} row={row} model={model} now={now} since={since}
              selected={selected?.id === row.id} currentFile={currentFile}
              onSelect={setSelectedId} onOpenTip={openTip} />)}
      </div>
      {model && selected && (
        <_CT_Detail key={selected.id} row={selected} tips={model.tips} now={now} since={since}
          streaming={streaming} onBranch={onBranch} onFork={onFork} onOpenFile={onOpenFile} />
      )}
    </aside>
  );
}

Object.assign(window, { ConversationTree });

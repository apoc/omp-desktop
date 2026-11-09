/* app/use-file-comments.jsx — the files panel's state
   (docs/architecture/file-comments.md): per tab, the marks (explain or
   comment on lines of a project file, kept in OMP_BROWSER's chip store
   through OMP_FILE_COMMENTS) and the view (selected file, scroll target,
   expanded dirs, filter, tree shown, commented-only); for the shown tab,
   the git browser's status tree cut to the tab's folder, the selected
   file's text and, in a folder without git, the @-mention search hits.

   Fetches only while the panel is open. The tree and the file refetch when
   the tab's branch changes, when an edit/write tool card finishes (`edits`,
   OMP_GIT_BROWSER.finishedEdits) and on `refresh`. Whether the tab shows
   the panel is app-live.jsx's per-tab side column (`open` / `setOpen`).
   Marks and views of a closed tab are dropped; nothing is persisted. */

const _UFC = window.OMP_FILE_COMMENTS;
const { ancestorDirs: _UFC_ancestors } = window.OMP_GIT_BROWSER;
const { entryOf: _UFC_entryOf, updateEntry: _UFC_updateEntry, pruneEntries: _UFC_prune } = window.OMP_SESSION_UI;

const _UFC_NO_PROJECT = "this tab has no project folder";
const _UFC_SEARCH_LIMIT = 50;
const _UFC_SEARCH_DELAY_MS = 120;
const _UFC_VIEW = Object.freeze({
  selected: null, target: null, expanded: Object.freeze(new Set()), filter: "",
  treeOpen: true, changedOnly: false, commentedOnly: false,
});
let _ufcSeq = 0;
// Folder names compare without case where the file system does (Windows,
// macOS): there the folder's case on disk may differ from the git index's.
const _UFC_FOLD_CASE = /^(Win|Mac)/.test(navigator.platform ?? "");

/** `{ value, error }` of a bridge result (`{ok, value | error}`, or null
 *  for a tab without a project folder). */
const _ufcResult = (res) => {
  if (!res) return { value: null, error: _UFC_NO_PROJECT };
  return res.ok ? { value: res.value, error: null } : { value: null, error: res.error };
};

function useFileComments({ bridge, tabId, sessionIds, open, setOpen, project, edits }) {
  const [marksAll, setMarks] = React.useState(window.OMP_BROWSER.EMPTY);
  const [views, setViews] = React.useState({});
  const [fullView, setFullView] = React.useState(false);
  const [nonce, setNonce] = React.useState(0);
  const [status, setStatus] = React.useState({ key: null, value: null, error: null });
  const [file, setFile] = React.useState({ key: null, value: null, error: null });
  const [hits, setHits] = React.useState({ key: null, list: null });

  // A closed tab drops its marks and view.
  const idsKey = (sessionIds ?? []).join("\0");
  React.useEffect(() => {
    const ids = idsKey ? idsKey.split("\0") : [];
    setMarks(s => _UFC_prune(s, ids));
    setViews(m => _UFC_prune(m, ids));
  }, [idsKey]);
  // Leaving the panel leaves full view.
  React.useEffect(() => { if (!open) setFullView(false); }, [open]);

  const view = _UFC_entryOf(views, tabId, _UFC_VIEW);
  const patchView = React.useCallback(
    fn => setViews(m => _UFC_updateEntry(m, tabId, _UFC_VIEW, v => ({ ...v, ...fn(v) }))), [tabId]);

  const folder = project.path || null;
  const repoRoot = project.repoRoot || null;
  const tick = `${project.branch ?? ""}\0${edits}\0${nonce}`;

  React.useEffect(() => {
    if (!open || !folder) return undefined;
    let live = true;
    bridge.gitBrowserStatus().then(res => { if (live) setStatus({ key: folder, ..._ufcResult(res) }); });
    return () => { live = false; };
  }, [bridge, open, folder, tick]);

  const st = status.key === folder ? status : null;
  // The tab folder's part of the tree, paths relative to it (Rust's
  // `StatusView.folder` places the folder in the work tree). A folder Rust
  // could not place has no tree: a work-tree path would be read as
  // folder-relative, the wrong file.
  const repoTree = st?.value?.tree ?? null;
  const placed = st?.value ? st.value.folder ?? null : null;
  const tree = React.useMemo(
    () => (repoTree ? _UFC.folderTree(repoTree, placed, _UFC_FOLD_CASE) : null), [repoTree, placed]);
  const unplaced = !!repoTree && !tree;
  // No repository: the filter box searches the folder instead.
  const searchMode = !!st?.error && !repoRoot;

  const query = view.filter.trim();
  const hitsKey = `${folder}\0${query}`;
  React.useEffect(() => {
    if (!open || !searchMode || !query) return undefined;
    let live = true;
    const timer = setTimeout(async () => {
      const list = await bridge.listFiles(query, _UFC_SEARCH_LIMIT);
      if (live) setHits({ key: hitsKey, list });
    }, _UFC_SEARCH_DELAY_MS);
    return () => { live = false; clearTimeout(timer); };
  }, [bridge, open, searchMode, hitsKey]);
  const searchTree = React.useMemo(() => {
    if (!searchMode) return null;
    if (!query) return _UFC.searchRoot([]);
    return hits.key === hitsKey ? _UFC.searchRoot(hits.list) : null;
  }, [searchMode, query, hits, hitsKey]);

  const marks = _UFC.marksOf(marksAll, tabId);
  const counts = React.useMemo(() => _UFC.counts(marks), [marks]);
  const commentedOnly = view.commentedOnly && counts.files > 0;
  const shownTree = React.useMemo(
    () => (commentedOnly && tree ? _UFC.onlyFiles(tree, new Set(counts.byPath.keys())) : tree),
    [commentedOnly, tree, counts]);
  const expanded = React.useMemo(
    () => (commentedOnly ? new Set([...counts.byPath.keys()].flatMap(_UFC_ancestors)) : view.expanded),
    [commentedOnly, counts, view.expanded]);

  const selected = view.selected;
  const fileKey = open && folder && selected ? `${folder}\0${selected}` : null;
  React.useEffect(() => {
    if (!fileKey) return undefined;
    let live = true;
    bridge.readProjectFile(selected).then(res => { if (live) setFile({ key: fileKey, ..._ufcResult(res) }); });
    return () => { live = false; };
  }, [bridge, fileKey, tick]);

  const actions = React.useMemo(() => {
    const showPath = (path, target) => patchView(v => ({
      selected: path, target, expanded: new Set([...v.expanded, ..._UFC_ancestors(path)]),
    }));
    return {
      select: path => showPath(path, null),
      toggleDir: path => patchView(v => {
        const next = new Set(v.expanded);
        if (next.has(path)) next.delete(path); else next.add(path);
        return { expanded: next };
      }),
      setFilter: filter => patchView(() => ({ filter })),
      setTreeOpen: treeOpen => patchView(() => ({ treeOpen })),
      setChangedOnly: changedOnly => patchView(() => ({ changedOnly })),
      setCommentedOnly: on => patchView(() => ({ commentedOnly: on })),
      /** Opens the panel on `path` (absolute inside the folder, or relative
       *  to it) and, with `range` ({ from, to }), scrolls to those lines and
       *  picks them. A path outside the folder is ignored. */
      openAt: ({ path, range }) => {
        const rel = _UFC.relativeTo(folder, path);
        if (!rel) return;
        showPath(rel, range ? { from: range.from, to: range.to, nonce: Date.now() } : null);
        setOpen(true);
      },
      addMark: mark => setMarks(s => _UFC.addMark(s, tabId, { id: `fc${++_ufcSeq}`, ...mark })),
      updateMark: (id, patch) => setMarks(s => _UFC.updateMark(s, tabId, id, patch)),
      removeMark: id => setMarks(s => _UFC.removeMarks(s, tabId, [id])),
      clearMarks: () => setMarks(s => _UFC.removeMarks(s, tabId, _UFC.marksOf(s, tabId).map(m => m.id))),
      // A submit takes the marks it sends (those ids only, marks added
      // since stay); a goal start that fails hands them back. `id`
      // defaults to the tab shown.
      takeMarks: (ids, id = tabId) => setMarks(s => _UFC.removeMarks(s, id, ids)),
      restoreMarks: (list, id = tabId) => setMarks(s => _UFC.restoreMarks(s, id, list)),
      refresh: () => setNonce(n => n + 1),
      // The code view applied the open target: drop it, so a remount (the
      // panel toggled, a tab switch) does not scroll and pick it again.
      targetDone: nonce => setViews(m => _UFC_updateEntry(m, tabId, _UFC_VIEW,
        v => (v.target?.nonce === nonce ? { ...v, target: null } : v))),
    };
  }, [patchView, folder, tabId, setOpen]);

  return {
    open, fullView, setFullView, hasFolder: !!folder,
    view, expanded, searchMode,
    tree: searchMode ? searchTree : shownTree,
    treeError: searchMode ? null
      : unplaced ? OMP_TR("The project folder could not be placed in its repository's work tree.")
      : (st?.error ?? null),
    treeLoading: !st,
    truncated: !!st?.value?.truncated,
    changedCount: tree?.changed ?? 0,
    file: selected && file.key === fileKey ? file : null,
    marks, counts, commentedOnly,
    ...actions,
  };
}

window.useFileComments = useFileComments;

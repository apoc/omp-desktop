/* app/use-conversation-tree.jsx — data flow of the conversation-tree pane
   (design/conversation-tree.jsx): Rust `conversation_tree` (via
   OMP_BRIDGE.conversationTree) → pure `OMP_CONV_TREE.buildModel` → pane.

   The family is refetched when the pane opens, the active tab or its session
   file changes (branch/fork/new session move a process onto another file),
   a run settles (a new request refreshes cache timestamps) and on the refresh
   button. `now` ticks every 30 s while open so countdowns and the
   warm → expiring → cold transitions move without a refetch. Only the newest
   request lands; a result for a tab or file left meanwhile is dropped. */

const TREE_TICK_MS = 30000;
// `streaming` drops between the steps of one run (turn_end … turn_start), so
// a refetch waits until it stayed down this long: once per run, plus once per
// step whose tools run longer than that.
const TREE_SETTLE_MS = 1500;

function useConversationTree({ bridge, open, sessionId, sessionFile, profileId, processStartedAt, streaming, onBranchText }) {
  // `key` names the conversation on screen: results are tagged with it, so a
  // tab switch never shows the previous tab's tree while the new one loads.
  const key = sessionFile ? `${sessionId}\0${sessionFile}` : "";
  const [result, setResult] = React.useState({ key: "", tree: null, error: null });
  const [loading, setLoading] = React.useState(false);
  const [now, setNow] = React.useState(() => Date.now());
  const [nonce, setNonce] = React.useState(0);

  const refresh = React.useCallback(() => setNonce(n => n + 1), []);

  // Run settled (streaming true → false, and still false TREE_SETTLE_MS
  // later): refetch. A tab switch in the same render fetches by itself.
  const seen = React.useRef({ streaming, key });
  React.useEffect(() => {
    const prev = seen.current;
    seen.current = { streaming, key };
    if (!open || !prev.streaming || streaming || prev.key !== key) return undefined;
    const timer = setTimeout(refresh, TREE_SETTLE_MS);
    return () => clearTimeout(timer);
  }, [open, streaming, key, refresh]);

  React.useEffect(() => {
    if (!open) return undefined;
    setNow(Date.now());
    const timer = setInterval(() => setNow(Date.now()), TREE_TICK_MS);
    return () => clearInterval(timer);
  }, [open]);

  React.useEffect(() => {
    if (!open || !bridge || !key) return undefined;
    let current = true;
    setLoading(true);
    bridge.conversationTree(sessionFile, profileId).then(res => {
      if (!current) return;
      setResult(res.ok ? { key, tree: res.value, error: null } : { key, tree: null, error: res.error });
      setLoading(false);
      setNow(Date.now());
    });
    return () => { current = false; };
    // `sessionFile` is part of `key`.
  }, [bridge, open, key, profileId, nonce]);

  const shown = result.key === key ? result : { key, tree: null, error: null };
  const model = React.useMemo(
    () => (shown.tree ? window.OMP_CONV_TREE.buildModel(shown.tree, { now, since: processStartedAt ?? null }) : null),
    [shown.tree, now, processStartedAt],
  );

  const textRef = React.useRef(onBranchText);
  textRef.current = onBranchText;
  // Branch hands the prompt back for the composer. Both moves change the
  // tab's session file, which refetches by itself once `get_state` names it.
  const branch = React.useCallback(async entryId => {
    const res = await bridge.branchAt(entryId);
    if (res.ok) textRef.current?.(res.text);
    return res;
  }, [bridge]);
  const fork = React.useCallback(entryId => bridge.forkAt(entryId), [bridge]);
  // A row that lives only in another file of the family: resume that file.
  const openFile = React.useCallback(path => {
    const file = shown.tree?.files.find(f => f.path === path);
    return bridge.resumeSession({ path, cwd: file?.cwd ?? "", title: file?.title ?? undefined });
  }, [bridge, shown.tree]);

  return {
    key, model, error: shown.error, loading, now, since: processStartedAt ?? null,
    currentFile: shown.tree?.files.find(f => f.current)?.path ?? null,
    refresh, branch, fork, openFile,
  };
}

Object.assign(window, { useConversationTree });

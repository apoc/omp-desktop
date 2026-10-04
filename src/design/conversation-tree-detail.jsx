/* design/conversation-tree-detail.jsx — footer of the conversation-tree pane
   for the selected prompt: re-ask price now vs after the cache expires, and
   the three actions (branch here, fork after the reply, open in a new tab).
   Rows come from `OMP_CONV_TREE.buildModel`; the action callbacks are the
   pane's (`useConversationTree`) and resolve like the bridge's
   `branchAt`/`forkAt` (`{ok, cancelled?, error?}`) or reject. */

const { Icon: _TD_Icon, TreeFmt: _TD_Fmt } = window;
const { isLive: _TD_isLive, isCached: _TD_isCached } = window.OMP_CONV_TREE;

const TREE_OPEN_TITLE =
  "A new omp process starts with a different system prompt, so the whole conversation is written to the cache again.";

function treeNowDesc(row) {
  const t = _TD_Fmt.tokens;
  if (_TD_isLive(row.state)) return `reads ${t(row.readTokens)} cached tokens`;
  if (row.state === "partial") return `reads ${t(row.readTokens)}, writes ${t(row.writeTokens)} tokens`;
  if (row.state === "cold") return `writes ${t(row.writeTokens)} tokens`;
  return `${t(row.prefixTokens)} tokens of context · cache lifetime unknown`;
}

function TreeCompare({ row, now }) {
  const F = _TD_Fmt;
  const nowValue = row.price != null ? F.price(row.price) : `${F.tokens(row.prefixTokens)} tok`;
  const later = _TD_isCached(row.state) && row.coldPrice != null && row.until != null;
  return (
    <div className="tree-compare">
      <div className="cmp now">
        <div className="cmp-k">re-ask now</div>
        <div className="cmp-v">{nowValue}</div>
        <div className="cmp-d">{treeNowDesc(row)}</div>
      </div>
      {later && (<>
        <div className="cmp-arrow">after {F.when(row.until, now)} →</div>
        <div className="cmp later">
          <div className="cmp-k">in {F.dur(row.until - now)}</div>
          <div className="cmp-v">{F.price(row.coldPrice)}</div>
          <div className="cmp-d">writes {F.tokens(row.coldWriteTokens)} tokens again</div>
        </div>
      </>)}
    </div>
  );
}

function TreeDetail({ row, tips, now, since, streaming, onBranch, onFork, onOpenFile }) {
  const F = _TD_Fmt;
  const [busy, setBusy] = React.useState(false);
  const [error, setError] = React.useState(null);
  React.useEffect(() => { setError(null); }, [row.id]);

  const run = async action => {
    setBusy(true);
    setError(null);
    try {
      const res = await action();
      if (res?.cancelled) setError("Cancelled by omp.");
      else if (res && res.ok === false) setError(res.error || "omp refused the request.");
    } catch (e) {
      setError(String(e?.message ?? e));
    } finally {
      setBusy(false);
    }
  };

  const blocked = busy || streaming;
  const wait = streaming ? "Wait for the current turn to finish." : undefined;
  // A new process rebuilds the system prompt, so opening is priced as the
  // whole conversation of the file's tip written again (its cold price).
  const fileTip = row.openFile ? tips.find(t => t.file === row.openFile) : null;
  const openPrice = fileTip?.coldPrice != null ? F.price(fileTip.coldPrice) : null;
  const title = (row.text || "").length > 48 ? `${row.text.slice(0, 48)}…` : row.text;

  return (
    <div className={`tree-detail s-${row.state}`}>
      <div className="tree-detail-title">
        Re-ask “{title}” <span className="tree-time mono">{F.when(row.ts, now)}</span>
      </div>
      <TreeCompare row={row} now={now} />
      {row.staleProcess && <div className="tree-note">{F.staleNote(since, now)}</div>}
      <div className="tree-actions">
        {row.inCurrent && (
          <button className="btn primary" disabled={blocked}
            title={wait ?? "Start a new session before this prompt and put the prompt back in the composer."}
            onClick={() => run(() => onBranch(row.id))}>
            <_TD_Icon name="branch" size={11} /> Branch here
          </button>
        )}
        {row.inCurrent && row.forkEntryId && (
          <button className="btn outlined" disabled={blocked}
            title={wait ?? "Continue in a new session file that keeps this prompt and its reply."}
            onClick={() => run(() => onFork(row.forkEntryId))}>
            Fork after the reply
          </button>
        )}
        {row.openFile && (
          <button className="btn outlined" disabled={busy} title={TREE_OPEN_TITLE}
            onClick={() => run(() => onOpenFile(row.openFile))}>
            Open in new tab{openPrice ? ` · cold ${openPrice}` : ""}
          </button>
        )}
      </div>
      {error && <div className="tree-error">{error}</div>}
    </div>
  );
}

Object.assign(window, { TreeDetail });

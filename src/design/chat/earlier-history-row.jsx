/* chat/earlier-history-row.jsx — the row at the top of the chat while a
   compaction summarized history the transcript doesn't show (#85,
   docs/architecture/compacted-history.md D8): "Show earlier history"
   loads it from the session file (OMP_BRIDGE.loadOlderHistory), read-only,
   above the transcript. Reads "Loading…" while the load runs; a failed one
   shows its error and Retry. ChatView renders it only while the snapshot's
   `olderHistory.available` holds and the transcript cap leaves room. */

const { Icon: _EH_Icon } = window;

const _EH_COLOR = "var(--lilac)";
const _EH_TAG_STYLE = {
  color: _EH_COLOR,
  background: `color-mix(in oklab, ${_EH_COLOR} 14%, transparent)`,
  borderColor: `color-mix(in oklab, ${_EH_COLOR} 30%, var(--line))`,
};

const EarlierHistoryRow = React.memo(function EarlierHistoryRow({ loading, error, onLoad }) {
  window.OMP_I18N.useLocale();
  // Rust's reason is shown as is; the one the desktop reports itself is a code.
  const why = window.OMP_OLDER_HISTORY.reasonOf(error);
  const reason = why.translate ? OMP_TR(why.text) : why.text;
  return (
    <div className="row tool fade-up earlier-history">
      <div className="ass-rail">
        <div className="tool-glyph" style={{ borderColor: _EH_COLOR, color: _EH_COLOR }}>
          <_EH_Icon name="context" size={11} color={_EH_COLOR} />
        </div>
        <div className="ass-thread" />
      </div>
      <div className="tool-card ok">
        <div className="tool-card-head">
          <span className="tool-tag" style={_EH_TAG_STYLE}>{OMP_TR("history")}</span>
          <span className="tool-title">{OMP_TR("Earlier history was compacted")}</span>
          <div className="tool-card-spacer" />
          <button type="button" className="btn outlined earlier-history-load" disabled={loading} onClick={onLoad}>
            {loading ? OMP_TR("Loading…") : error ? OMP_TR("Retry") : OMP_TR("Show earlier history")}
          </button>
        </div>
        {error && !loading && (
          <div className="earlier-history-error selectable">{OMP_TR("Could not load earlier history: {reason}", { reason })}</div>
        )}
      </div>
    </div>
  );
});

Object.assign(window, { EarlierHistoryRow });

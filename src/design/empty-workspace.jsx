/* ═════════════════════════════════════════════════════════════════════
   empty-workspace.jsx — the session column while no tab is open

   The app starts without a tab (no pathless launch session), and closing
   the last tab returns here. Offers the two ways in — pick a folder, or a
   recent project of the startup profile — and shows any note the bridge
   filed while no tab existed (e.g. a failed "Open with"), which would
   otherwise have no transcript to land in.
   ═════════════════════════════════════════════════════════════════════ */

const { Icon, MarkdownContent } = window;
const { basename, parentName } = window.OMP_PROJECT_NAV;

/** Recent rows shown here; the sidebar lists the rest. */
const EMPTY_RECENT_LIMIT = 6;

function EmptyWorkspace({ recents, notes, onOpenFolder, onOpenRecent }) {
  const newTabHint = window.OMP_KEYMAP ? window.OMP_KEYMAP.hintFor("desktop.tab.new") : "Ctrl+T";
  const shown = recents.slice(0, EMPTY_RECENT_LIMIT);
  return (
    <div className="empty-ws">
      <div className="empty-ws-card">
        <div className="empty-ws-title">no project open</div>
        <button className="btn primary empty-ws-open" onClick={onOpenFolder}>
          <Icon name="folder" size={12} /> open folder…
          {newTabHint && <span className="kbd">{newTabHint}</span>}
        </button>

        {shown.length > 0 && (
          <>
            <div className="empty-ws-section">recent</div>
            {shown.map(r => (
              <button key={r.path} className="empty-ws-recent" title={r.path} onClick={() => onOpenRecent(r.path)}>
                <Icon name="folder" size={11} color="var(--fg-4)" />
                <span className="empty-ws-name">{basename(r.path)}</span>
                <span className="empty-ws-parent">{parentName(r.path)}</span>
              </button>
            ))}
          </>
        )}

        {notes.map((note, i) => (
          <div key={i} className="empty-ws-note">
            <MarkdownContent text={note} />
          </div>
        ))}
      </div>
    </div>
  );
}

Object.assign(window, { EmptyWorkspace });

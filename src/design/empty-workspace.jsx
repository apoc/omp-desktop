/* ═════════════════════════════════════════════════════════════════════
   empty-workspace.jsx — the session column while no tab is open

   The app starts without a tab (no pathless launch session), and closing
   the last tab returns here. Opening a project is the sidebar's and the
   tab bar's job; this space is a welcome screen — the start screen picked
   in Settings → Appearance (`startScreen`, app/backdrops.js) behind the
   ASCII-art OMP-DESKTOP logo (canvas host: design/backdrops/backdrop.jsx)
   — plus any note the bridge filed while no tab existed (e.g. a failed
   "Open with"), which would otherwise have no transcript to land in.
   ═════════════════════════════════════════════════════════════════════ */

const { MarkdownContent, Backdrop } = window;
const { screenOf: _EW_screenOf } = window.OMP_BACKDROPS;

function EmptyWorkspace({ notes, screen }) {
  return (
    <div className="empty-ws" aria-label="no project open">
      <Backdrop screen={_EW_screenOf(screen)} className="empty-ws-canvas" />
      {notes.length > 0 && (
        <div className="empty-ws-notes">
          {notes.map((note, i) => (
            <div key={i} className="empty-ws-note">
              <MarkdownContent text={note} />
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

Object.assign(window, { EmptyWorkspace });

/* ═════════════════════════════════════════════════════════════════════
   toolbar.jsx — the app toolbar between the title bar and the tabs. Left,
   one cluster of icon buttons: project navigation, the panel toggles (each
   open panel's own actions sit beside its toggle), git and usage. Right:
   approvals (with the mode in use), the command bridge, the tab's profile
   menu and settings. Panels carry no close button of their own: their
   toggle here closes them. The todo count and the app version are the
   status bar's. The left cluster scrolls sideways in a narrow window; the
   right one never clips, since the profile menu's pop-up hangs from it,
   and its labels give way first (layout/toolbar.css).
   ═════════════════════════════════════════════════════════════════════ */

const { Icon: _TB_Icon, ProfileMenu: _TB_ProfileMenu } = window;

// An action's chord, or "" while it is unbound (or the keymap not loaded).
function _tbChord(actionId) {
  return window.OMP_KEYMAP ? window.OMP_KEYMAP.hintFor(actionId) : "";
}
// `label (chord)`, or just the label while the action is unbound.
function _tbTip(label, actionId) {
  const chord = _tbChord(actionId);
  return chord ? `${label} (${chord})` : label;
}

// A `.btn ghost` at toolbar size. `pressed` undefined: a plain button;
// boolean: a toggle.
function ToolButton({ icon, title, onClick, pressed, disabled, color, children }) {
  return (
    <button type="button" className={`btn ghost tb-btn${pressed ? " on" : ""}`}
      title={title} aria-label={children ? undefined : title} aria-pressed={pressed}
      disabled={disabled} onClick={onClick}>
      <_TB_Icon name={icon} size={16} color={color} />
      {children}
    </button>
  );
}

// The approvals button: names the tab's running tool approval mode
// (`OMP_APPROVAL_MODE.statusCell`). Yolo as the target turns the glyph to
// `warn` and amber; a change waiting for the turn to end reads
// `running ⇢ target` with the running mode muted.
function ApprovalModeButton({ cell, onClick }) {
  const targetColor = cell.warn ? "var(--amber)" : undefined;
  return (
    <ToolButton icon={cell.warn ? "warn" : "check"} color={targetColor} onClick={onClick}
      title={cell.pending ? `approvals — switches to ${cell.target} when the agent finishes its turn` : "approvals"}>
      <span className="tb-end-label tb-mode" style={{ color: targetColor }}>
        {cell.pending && <span style={{ color: "var(--fg-4)" }}>{cell.running} ⇢ </span>}
        {cell.target}
      </span>
    </ToolButton>
  );
}

/**
 * nav:      { sidebarOpen, onToggleSidebar, onOpenProject, onHistory }
 * rail, subagents, terminal: { open, onToggle }
 * tree:     { open, onToggle, onRefresh, canRefresh }
 * browser:  { open, onToggle, annotate, canAnnotate, onAnnotate(on), fullView, onFullView(on) }
 * approvals: { cell, onOpen }; onGit, onStats, onCommands
 * profile:  ProfileMenu's props (profiles, activeId, startupId, on…)
 * settings: { active, onOpen }
 */
function Toolbar({ nav, rail, subagents, tree, browser, terminal, onGit, approvals, onStats, onCommands, profile, settings }) {
  const commands = _tbChord("desktop.commands.open");
  return (
    <div className="toolbar" role="toolbar" aria-label="app toolbar">
      <div className="tb-main">
        <ToolButton icon="sidebar" title={_tbTip("project sidebar", "desktop.sidebar.toggle")}
          pressed={nav.sidebarOpen} onClick={nav.onToggleSidebar} />
        <ToolButton icon="rail" title="ambient rail" pressed={rail.open} onClick={rail.onToggle} />
        <ToolButton icon="plus" title={_tbTip("open project", "desktop.tab.new")} onClick={nav.onOpenProject} />
        <ToolButton icon="clock" title={_tbTip("conversation history", "desktop.history.open")} onClick={nav.onHistory} />
        <span className="tb-sep" />

        <ToolButton icon="agent" title="subagent manager" pressed={subagents.open} onClick={subagents.onToggle} />
        <ToolButton icon="branch" title="conversation tree (prompt-cache status)" pressed={tree.open} onClick={tree.onToggle} />
        {tree.open && (
          <span className="tb-sub" role="group" aria-label="conversation tree">
            <ToolButton icon="refresh" title="refresh conversation tree" disabled={!tree.canRefresh} onClick={tree.onRefresh} />
          </span>
        )}
        <ToolButton icon="web" title={_tbTip("browser panel", "desktop.browser.toggle")} pressed={browser.open} onClick={browser.onToggle} />
        {browser.open && (
          <span className="tb-sub" role="group" aria-label="browser panel">
            <ToolButton icon="edit" title="annotate the page" pressed={browser.annotate}
              disabled={!browser.canAnnotate} onClick={() => browser.onAnnotate(!browser.annotate)} />
            <ToolButton icon="focus" title="browser full view" pressed={browser.fullView}
              onClick={() => browser.onFullView(!browser.fullView)} />
          </span>
        )}
        <ToolButton icon="terminal" title={_tbTip("terminal", "desktop.terminal.toggle")} pressed={terminal.open} onClick={terminal.onToggle} />
        <span className="tb-sep" />

        <ToolButton icon="diff2" title={_tbTip("git browser", "desktop.panel.changes")} onClick={onGit} />
        <ToolButton icon="cost" title={_tbTip("usage statistics", "desktop.panel.stats")} onClick={onStats} />
      </div>

      <div className="tb-end">
        <ApprovalModeButton cell={approvals.cell} onClick={approvals.onOpen} />
        <ToolButton icon="command" title={commands ? `command bridge (${commands})` : "command bridge"} onClick={onCommands}>
          <span className="tb-end-label">bridge</span>
          {commands && <span className="kbd tb-end-label">{commands}</span>}
        </ToolButton>
        {/* Per-tab omp profile — the selector acts on the active tab only. */}
        <_TB_ProfileMenu {...profile} />
        <ToolButton icon="cog" title={_tbTip("settings", "desktop.settings.open")}
          pressed={settings.active} onClick={settings.onOpen} />
      </div>
    </div>
  );
}

Object.assign(window, { Toolbar });

/* ═════════════════════════════════════════════════════════════════════
   chrome.jsx — window chrome, tabs, status bar
   - WindowChrome (traffic lights, title)
   - TabBar
   - StatusBar
   ═════════════════════════════════════════════════════════════════════ */

const { Icon, ProfileMenu, DEFAULT_PROFILE_ID, TabGroupChip, TabRunDot, TabLabel, RenameField, WorktreeIndicator } = window;
const { groupTabs } = window.OMP_PROJECT_NAV;

// Thin wrappers around the shared `OMP_KEYMAP.hintFor`/`hintKeyFor` — same
// guard and rationale as composer.jsx's copy (kept local rather than a
// third file to import from; see composer.jsx's doc comment for why the
// registry-not-loaded fallback can't move into keymap.js itself).
function hintFor(actionId, fallback) {
  return window.OMP_KEYMAP ? window.OMP_KEYMAP.hintFor(actionId) : fallback;
}

// ── Platform detection ────────────────────────────────────────────────
const IS_WIN = typeof navigator !== "undefined" &&
  (navigator.userAgent.includes("Windows") || navigator.platform.startsWith("Win"));

// ── Window chrome ─────────────────────────────────────────────────────
function WindowChrome({
  project, prStatus, onCmd, onConfigureProject,
  profiles, activeProfileId, startupProfileId,
  onSelectProfile, onCreateProfile, onRenameProfile, onDeleteProfile, onSetStartupProfile,
}) {
  const sourcePath = window.OMP_PROJECT_NAV.projectPath(project);
  const projectName = sourcePath ? window.OMP_PROJECT_NAV.basename(sourcePath) : project.name;
  const titlePr = window.OMP_PR_STATUS.present(prStatus);
  const nativeMac = document.documentElement.classList.contains("native-macos");
  return (
    <div className="chrome" data-tauri-drag-region={nativeMac ? "false" : true}>
      {/* Native macOS traffic lights belong to NSWindow, not the webview. */}
      {!IS_WIN && !nativeMac && (
        <div className="chrome-lights">
          <span className="light red" />
          <span className="light amber" />
          <span className="light green" />
        </div>
      )}

      <div className="chrome-title">
        <span className="mono chrome-brand" style={{ color: "var(--fg-3)" }}>OMP</span>
        <span className="mono chrome-brand" style={{ color: "var(--fg-5)" }}>·</span>
        <span className="chrome-project-name" title={sourcePath || undefined}>{projectName}</span>
        {project.branch && (
          <window.StatusDetail className="chip muted chrome-branch" text={`Current branch: ${project.branch}`}>
            <Icon name="branch" size={10} color="var(--fg-3)" />
            <span className="mono">{project.branch}</span>
          </window.StatusDetail>
        )}
        <WorktreeIndicator tab={project} showLabel />
        {titlePr && (
          <span className="chrome-pr">
            <window.PrStatus model={titlePr} mode="icon" />
            <span className="chrome-pr-label">{titlePr.stale ? "Last known · " : ""}{titlePr.label}</span>
            <window.PrStatus model={titlePr} mode="badges" />
          </span>
        )}
        {sourcePath && onConfigureProject && (
          <button className="chrome-project-config" title="project defaults" aria-label="project defaults"
            onClick={() => onConfigureProject(sourcePath, project.profile)}>
            <Icon name="cog" size={11} />
          </button>
        )}
      </div>

      {/* Per-tab omp profile — the selector acts on the active tab only. */}
      <ProfileMenu
        profiles={profiles}
        activeId={activeProfileId}
        startupId={startupProfileId}
        onSelect={onSelectProfile}
        onCreate={onCreateProfile}
        onRename={onRenameProfile}
        onDelete={onDeleteProfile}
        onSetStartup={onSetStartupProfile}
      />

      <div className="chrome-right">
        <button className="btn ghost outlined chrome-command" onClick={onCmd}
          aria-label="command bridge" title={`command bridge (${hintFor("desktop.commands.open", IS_WIN ? "^K" : "⌘K")})`}>
          <Icon name="command" size={11} /> <span className="chrome-command-label">bridge</span>
          <span className="kbd">{hintFor("desktop.commands.open", IS_WIN ? "^K" : "⌘K")}</span>
        </button>

        {/* Windows controls — right side, hidden on macOS/Linux */}
        {IS_WIN && (
          <div className="win-controls">
            <button className="win-ctrl win-min" title="Minimize">
              <svg width="10" height="10" viewBox="0 0 10 10" aria-hidden="true"><path d="M1 5.5h8" stroke="currentColor" strokeWidth="1" /></svg>
            </button>
            <button className="win-ctrl win-max" title="Maximize / Restore">
              <svg width="10" height="10" viewBox="0 0 10 10" aria-hidden="true"><rect x="1.5" y="1.5" width="7" height="7" fill="none" stroke="currentColor" strokeWidth="1" /></svg>
            </button>
            <button className="win-ctrl win-close" title="Close">
              <svg width="10" height="10" viewBox="0 0 10 10" aria-hidden="true"><path d="M1.5 1.5l7 7M8.5 1.5l-7 7" stroke="currentColor" strokeWidth="1.1" /></svg>
            </button>
          </div>
        )}
      </div>
    </div>
  );
}

// ── Project tabs ─────────────────────────────────────────────────────
// A tab's click props: select on click, close on middle-click, as in
// browsers (#24). WebKit before Safari 18.2 / WebKitGTK 2.46 has no
// `auxclick` and reports it as a `click` with button 1, hence the check in
// onClick too; newer engines never send `click` for button 1, so this
// can't double-fire. Swallowing the middle-button mousedown stops Windows
// autoscroll and Linux primary-selection paste from firing on the tab.
function tabClickProps(onSelect, onClose) {
  return {
    onClick: e => (e.button === 1 ? onClose?.() : onSelect?.()),
    onMouseDown: e => { if (e.button === 1) e.preventDefault(); },
    onAuxClick: e => { if (e.button === 1) { e.preventDefault(); onClose?.(); } },
  };
}

function TabBar({
  projects, activeId, onSelect, onClose, onRename, onNew, onHistory, onNewInProject, onConfigureProject, onReorder,
  sidebarOpen, onToggleSidebar, prStatuses = {},
  profiles = [], appVersion, updateVersion, onUpdate, onCheckUpdate,
  ambientHidden = false, onShowAmbient,
  settings, onSelectSettings, onCloseSettings,
}) {
  // Tabs can run under different profiles, so a tab whose profile is not the
  // built-in one is labelled with it — otherwise two tabs on the same folder
  // in different profiles look identical. Falls back to the raw id until the
  // profile list has loaded.
  const profileLabel = id =>
    id === DEFAULT_PROFILE_ID ? null : (profiles.find(p => p.id === id)?.name ?? id);
  // Tab whose name is being edited inline (#32); double-click enters it.
  const [renaming, setRenaming] = React.useState(null);
  // Drag to reorder (#40): projects along the bar ("projects", keyed by
  // group), and a group chip's members in its dropdown (see TabGroupChip).
  const reorder = window.useDragReorder(onReorder);
  return (
    <div className="tabs" onPointerDown={reorder.onPointerDown}>
      <button className={`tab-add ${sidebarOpen ? "on" : ""}`}
        title={`project sidebar (${hintFor("desktop.sidebar.toggle", "Ctrl+B")})`}
        aria-pressed={!!sidebarOpen}
        onClick={onToggleSidebar}>
        <Icon name="sidebar" size={11} />
      </button>
      {/* Tabs on one folder + profile share a chip (#27); a project with a
          single tab renders as a plain tab. */}
      {groupTabs(projects).map((group) => {
        if (group.tabs.length > 1) {
          return (
            <TabGroupChip key={group.key}
              group={group}
              activeId={activeId}
              profileLabel={profileLabel}
              prStatuses={prStatuses}
              onSelect={onSelect}
              onClose={onClose}
              onNewInProject={onNewInProject}
              onConfigureProject={onConfigureProject}
              onRename={onRename}
              reorder={reorder}
            />
          );
        }
        const p = group.tabs[0];
        const active = p.id === activeId;
        const profile = profileLabel(p.profile);
        return (
          <div key={p.id}
            {...reorder.itemProps("projects", group.key, "x")}
            className={`tab ${active ? "active" : ""}${reorder.dropClass("projects", group.key)}`}
            title={[p.name, p.path].filter(Boolean).join("\n")}
            {...tabClickProps(() => onSelect(p.id), () => onClose?.(p.id))}
            // The first click of the pair already selected the tab.
            onDoubleClick={e => { if (onRename && !e.target.closest(".tab-close")) setRenaming(p.id); }}>
            <span className="tab-bar-mark" style={{ background: active ? p.color : "transparent" }} />
            <Icon name="folder" size={11} color={active ? p.color : "var(--fg-4)"} />
            {renaming === p.id ? (
              <RenameField value={p.name}
                onCommit={name => onRename(p.id, name)}
                onClose={() => setRenaming(null)} />
            ) : (
              <TabLabel tab={p} className="tab-name" title={[p.name, "double-click to rename"].filter(Boolean).join("\n")} />
            )}
            <WorktreeIndicator tab={p} />
            {profile && (
              <span className="chip muted tab-profile" title={`profile: ${profile}`}>{profile}</span>
            )}
            <window.PrStatus status={prStatuses[p.id]} />
            <TabRunDot state={p.runState} />
            {group.path && onConfigureProject && (
              <button className="tab-close" title="project defaults" aria-label="project defaults"
                onClick={e => { e.stopPropagation(); onConfigureProject(group.path, group.profile); }}>
                <Icon name="cog" size={10} />
              </button>
            )}
            <button className="tab-close" onClick={e => { e.stopPropagation(); onClose?.(p.id); }}><Icon name="close" size={9} /></button>
          </div>
        );
      })}
      {/* The Settings app tab (#37): pinned after the projects, never
          dragged; `changed` counts settings off their default. */}
      {settings?.open && (
        <div className={`tab app-tab ${settings.active ? "active" : ""}`}
          title={`settings (${hintFor("desktop.settings.open", "Ctrl+,")})`}
          {...tabClickProps(onSelectSettings, onCloseSettings)}>
          <span className="tab-bar-mark" style={{ background: settings.active ? "var(--fg-3)" : "transparent" }} />
          <Icon name="cog" size={12} />
          <span className="tab-name">Settings</span>
          {settings.changed > 0 && (
            <span className="tab-count" title={`${settings.changed} changed from default`}>{settings.changed}</span>
          )}
          <button className="tab-close" title={`close (${hintFor("desktop.tab.close", "Ctrl+W")})`}
            onClick={e => { e.stopPropagation(); onCloseSettings?.(); }}>
            <Icon name="close" size={9} />
          </button>
        </div>
      )}
      <button className="tab-add" title="open project" onClick={onNew}>
        <Icon name="plus" size={11} />
      </button>
      <button className="tab-add" title={`conversation history (${hintFor("desktop.history.open", "Ctrl+H")})`} onClick={onHistory}>
        <Icon name="clock" size={11} />
      </button>
      <div style={{ flex: 1 }} />
      <div className="tabs-right mono">
        {updateVersion && (
          <button className="btn outlined update-pill" onClick={onUpdate} title={`OMP Desktop v${updateVersion} is available`}>
            <Icon name="arrowUp" size={9} />v{updateVersion}
          </button>
        )}
        {ambientHidden && (
          <button type="button" className="btn ghost ambient-reopen" onClick={onShowAmbient}
            aria-label="Show Ambient" title="Show Ambient">
            <Icon name="radar" size={12} />Ambient
          </button>
        )}
        <button className="btn ghost app-version" onClick={onCheckUpdate} title="check for updates">
          {appVersion ? `v${appVersion}` : "—"}
        </button>
      </div>
    </div>
  );
}

// ── Status bar (footer): connection, tokens, todos, panels ──────────
// The model and thinking level are not repeated here: the composer's
// pills below the prompt box show (and change) both. It spans the window
// under the workspace; the st-ctx meter, st-cost and st-tps cells (each
// with its separator) drop out when the window is narrow (layout/rail.css).
function StatusBar({ ctx, todoDone, todoTotal, onTodo, onSettings, settingsActive = false, onChanges, onRules, approvalMode, onStats, onTree, onTerminal, terminalOpen, onBrowser, browserOpen = false }) {
  return (
    <div className="status">
      <span className="status-cell"><span className="dot live" /> connected</span>
      <span className="status-sep">·</span>
      <span className="status-cell st-ctx mono">
        <span style={{ color: "var(--fg-3)" }}>{ctx.label}</span>
        <span className="status-bar-tube">
          <span className="status-bar-fill" style={{ width: `${Math.min(100, ctx.pct ?? 0)}%` }} />
        </span>
        <span className="st-ctx-pct" style={{ color: "var(--fg-4)" }}>{ctx.pct == null ? "—" : `${ctx.pct.toFixed(1)}%`}</span>
      </span>
      <span className="status-sep st-cost">·</span>
      <span className="status-cell st-cost mono"><span style={{ color: "var(--fg-3)" }}>cost</span> {ctx.cost}</span>
      <span className="status-sep st-tps">·</span>
      <span className="status-cell st-tps mono"><span style={{ color: "var(--fg-3)" }}>{ctx.tokensPerSec}</span> t/s</span>
      <div className="status-gap" />
      <button className="status-cell btn ghost" onClick={onTodo} style={{ height: 20, padding: "0 6px" }}>
        <Icon name="plan" size={11} color="var(--accent)" />
        <span style={{ color: "var(--accent)" }}>todo {todoDone}/{todoTotal}</span>
      </button>
      <span className="status-sep">·</span>
      <button className="status-cell btn ghost" onClick={onChanges} title="git browser" style={{ height: 20, padding: "0 6px" }}>
        <Icon name="diff2" size={11} color="var(--fg-3)" />
      </button>
      <span className="status-sep">·</span>
      <button className="status-cell btn ghost" onClick={onTree} title="conversation tree (prompt-cache status)" style={{ height: 20, padding: "0 6px" }}>
        <Icon name="branch" size={11} color="var(--fg-3)" />
      </button>
      <span className="status-sep">·</span>
      <button className="status-cell btn ghost" onClick={onBrowser} aria-pressed={browserOpen}
        title={`browser panel (${hintFor("desktop.browser.toggle", "Ctrl+Shift+B")})`}
        style={{ height: 20, padding: "0 6px" }}>
        <Icon name="web" size={11} color={browserOpen ? "var(--accent)" : "var(--fg-3)"} />
      </button>
      <span className="status-sep">·</span>
      <ApprovalModeCell cell={approvalMode} onClick={onRules} />
      <span className="status-sep">·</span>
      <button className="status-cell btn ghost" onClick={onStats} title="usage statistics" style={{ height: 20, padding: "0 6px" }}>
        <Icon name="cost" size={11} color="var(--fg-3)" />
      </button>
      <span className="status-sep">·</span>
      <button className={`status-cell btn ghost ${terminalOpen ? "on" : ""}`} onClick={onTerminal}
        title={`terminal (${hintFor("desktop.terminal.toggle", "Ctrl+`")})`}
        aria-pressed={!!terminalOpen} style={{ height: 20, padding: "0 6px" }}>
        <Icon name="terminal" size={11} color={terminalOpen ? "var(--accent)" : "var(--fg-3)"} />
      </button>
      <span className="status-sep">·</span>
      <button className={`status-cell btn ghost ${settingsActive ? "on" : ""}`} onClick={onSettings}
        title={`settings (${hintFor("desktop.settings.open", "Ctrl+,")})`}
        aria-pressed={settingsActive} style={{ height: 20, padding: "0 6px" }}>
        <Icon name="cog" size={11} color={settingsActive ? "var(--accent)" : "var(--fg-3)"} />
      </button>
    </div>
  );
}

// The approvals button: names the tab's running tool approval mode
// (`OMP_APPROVAL_MODE.statusCell`). Yolo as the target turns the glyph to
// `warn` and amber; a change waiting for the turn to end reads
// `running ⇢ target` muted, with the target coloured.
function ApprovalModeCell({ cell, onClick }) {
  const targetColor = cell?.warn ? "var(--amber)" : "var(--fg-3)";
  return (
    <button className="status-cell btn ghost" onClick={onClick}
      title={cell?.pending ? `approvals — switches to ${cell.target} when the agent finishes its turn` : "approvals"}
      style={{ height: 20, padding: "0 6px" }}>
      <Icon name={cell?.warn ? "warn" : "check"} size={11} color={targetColor} />
      {cell && (cell.pending
        ? <span className="mono status-mode" style={{ color: "var(--fg-4)" }}>{cell.running} ⇢ <span style={{ color: targetColor }}>{cell.target}</span></span>
        : <span className="mono status-mode" style={{ color: targetColor }}>{cell.label}</span>)}
    </button>
  );
}



Object.assign(window, { WindowChrome, TabBar, StatusBar });

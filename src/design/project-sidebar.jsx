/* ═════════════════════════════════════════════════════════════════════
   project-sidebar.jsx — left project navigator (issue #27)

   `open`: every tab, grouped by project (folder + profile) exactly like the
   tab bar (`OMP_PROJECT_NAV.groupTabs`), multi-tab projects expandable.
   `recent`: recently opened folders of the active profile that have no
   open tab — computed by the caller (`recentRows`), since only it knows
   the active profile. Rows are containers; the click targets inside them
   are real buttons, so every action is keyboard-reachable.
   ═════════════════════════════════════════════════════════════════════ */

const { Icon, TabRunDot } = window;
const { groupTabs, groupRunState, groupTarget, basename, parentName } = window.OMP_PROJECT_NAV;

// Same guard as chrome.jsx's copy: the registry may not be loaded.
function sidebarHint(actionId, fallback) {
  return window.OMP_KEYMAP ? window.OMP_KEYMAP.hintFor(actionId) : fallback;
}

function ProjectSidebar({
  tabs, activeId, recents, profileLabel,
  onSelectTab, onCloseTab, onNewInProject, onOpenRecent, onForgetRecent, onOpenFolder, onHide,
}) {
  // Group keys the user folded. Not persisted: tab ids (and so pathless
  // groups' keys) don't survive a restart anyway.
  const [collapsed, setCollapsed] = React.useState({});
  const toggle = key => setCollapsed(c => ({ ...c, [key]: !c[key] }));
  const groups = groupTabs(tabs);
  const hideHint = sidebarHint("desktop.sidebar.toggle", "Ctrl+B");

  return (
    <aside className="project-sidebar" aria-label="projects">
      <div className="psb-head">
        <span>projects</span>
        <button className="psb-act" title={`hide sidebar (${hideHint})`} onClick={onHide}>
          <Icon name="sidebar" size={11} />
        </button>
      </div>

      <div className="psb-scroll">
        <div className="psb-section">open</div>
        {groups.length === 0 && <div className="psb-empty">no open tabs</div>}
        {groups.map(group => {
          const multi = group.tabs.length > 1;
          const expanded = multi && !collapsed[group.key];
          const containsActive = group.tabs.some(t => t.id === activeId);
          const profile = profileLabel(group.profile);
          return (
            <React.Fragment key={group.key}>
              {/* A multi-tab project row is only highlighted through its
                  active member row, as in the mockup; a single-tab one is
                  that tab. */}
              <div className={`psb-row psb-project ${containsActive && !expanded ? "active" : ""}`}>
                {multi ? (
                  <button className={`psb-chev ${expanded ? "open" : ""}`}
                    title={expanded ? "collapse" : "expand"} aria-expanded={expanded}
                    onClick={e => { e.stopPropagation(); toggle(group.key); }}>
                    <Icon name="chevR" size={10} />
                  </button>
                ) : <span className="psb-chev-spacer" />}
                <button className="psb-main" title={group.path || group.name}
                  onClick={() => onSelectTab(groupTarget(group, activeId))}>
                  <Icon name="folder" size={11} color={containsActive ? "var(--accent)" : "var(--fg-4)"} />
                  <span className="psb-name">{group.name}</span>
                  {profile && (
                    <span className="chip muted tab-profile" title={`profile: ${profile}`}>{profile}</span>
                  )}
                  <TabRunDot state={groupRunState(group.tabs)} />
                  {multi && <span className="tab-count psb-count">{group.tabs.length}</span>}
                </button>
                <span className="psb-actions">
                  {group.path && (
                    <button className="psb-act" title="new conversation here"
                      onClick={() => onNewInProject(group.path, group.profile)}>
                      <Icon name="plus" size={10} />
                    </button>
                  )}
                  {!multi && (
                    <button className="psb-act" title="close tab" onClick={() => onCloseTab(group.tabs[0].id)}>
                      <Icon name="close" size={9} />
                    </button>
                  )}
                </span>
              </div>
              {expanded && group.tabs.map(t => (
                <div key={t.id} className={`psb-row psb-tab ${t.id === activeId ? "active" : ""}`}>
                  <button className="psb-main" title={t.name} onClick={() => onSelectTab(t.id)}>
                    <span className="psb-name">{t.name}</span>
                    <TabRunDot state={t.runState} />
                  </button>
                  <span className="psb-actions">
                    <button className="psb-act" title="close tab" onClick={() => onCloseTab(t.id)}>
                      <Icon name="close" size={9} />
                    </button>
                  </span>
                </div>
              ))}
            </React.Fragment>
          );
        })}

        <div className="psb-section">recent</div>
        {recents.length === 0 && <div className="psb-empty">no recent projects</div>}
        {recents.map(r => (
          <div key={r.path} className="psb-row psb-recent">
            <span className="psb-chev-spacer" />
            <button className="psb-main" title={r.path} onClick={() => onOpenRecent(r.path)}>
              <Icon name="folder" size={11} color="var(--fg-5)" />
              <span className="psb-name">
                {basename(r.path)}
                <span className="psb-parent">{parentName(r.path)}</span>
              </span>
            </button>
            <span className="psb-actions">
              <button className="psb-act" title="remove from recent" onClick={() => onForgetRecent(r.path)}>
                <Icon name="close" size={9} />
              </button>
            </span>
          </div>
        ))}
      </div>

      <button className="psb-foot" onClick={onOpenFolder}>
        <Icon name="plus" size={11} />open folder…
      </button>
    </aside>
  );
}

Object.assign(window, { ProjectSidebar });

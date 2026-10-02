/* ═════════════════════════════════════════════════════════════════════
   tab-group-chip.jsx — one tab-bar chip for several tabs on one project

   Issue #27: tabs on the same folder *and* profile collapse into a single
   chip (`omp-desktop 3 ▾`); its dropdown lists the member tabs and offers
   "new conversation" in that project. Grouping itself is
   `OMP_PROJECT_NAV.groupTabs` (app/project-nav.js); this file only renders.
   ═════════════════════════════════════════════════════════════════════ */

const { Icon, RenameField } = window;
const { groupTarget, groupRunState } = window.OMP_PROJECT_NAV;

/** A tab's (or group's) run-state dot; nothing while idle. Shared by the
 *  tab bar and the project sidebar so the titles stay in one place. */
function TabRunDot({ state }) {
  if (!state || state === "idle") return null;
  const title = state === "waiting-user" ? "waiting for you"
    : state === "failed" ? "agent process exited"
    : "running";
  return <span className={`tab-run-dot ${state}`} title={title} />;
}

function TabGroupChip({ group, activeId, profileLabel, onSelect, onClose, onNewInProject, onRename }) {
  const [open, setOpen] = React.useState(false);
  // Member tab whose name is being edited inline (#32).
  const [renaming, setRenaming] = React.useState(null);
  const rootRef    = React.useRef(null);
  const triggerRef = React.useRef(null);

  // Focus back to the trigger: a picked row unmounts with the popover, and
  // focus would otherwise fall back to <body> (same as ProfileMenu).
  const close = React.useCallback(() => {
    setOpen(false);
    triggerRef.current?.focus();
  }, []);

  // Outside click / Escape dismiss, attached only while open.
  React.useEffect(() => {
    if (!open) return undefined;
    const onDown = e => { if (!rootRef.current?.contains(e.target)) close(); };
    const onKey  = e => { if (e.key === "Escape") { e.preventDefault(); close(); } };
    document.addEventListener("mousedown", onDown);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDown);
      document.removeEventListener("keydown", onKey);
    };
  }, [open, close]);

  const active  = group.tabs.find(t => t.id === activeId);
  const profile = profileLabel(group.profile);

  return (
    <div ref={rootRef}
      className={`tab tab-group ${active ? "active" : ""}`}
      // A middle click never closes a group: it would take several tabs
      // (and their transcripts) with it. Old WebKit reports it as a `click`
      // with button 1 (see TabBar), hence the guard there too; the
      // mousedown swallow stops autoscroll / primary-selection paste.
      onClick={e => { if (e.button !== 1) onSelect(groupTarget(group, activeId)); }}
      onMouseDown={e => { if (e.button === 1) e.preventDefault(); }}
      onAuxClick={e => { if (e.button === 1) e.preventDefault(); }}>
      <span className="tab-bar-mark" style={{ background: active ? active.color : "transparent" }} />
      <Icon name="folder" size={11} color={active ? active.color : "var(--fg-4)"} />
      <TabRunDot state={groupRunState(group.tabs)} />
      <span className="tab-name" title={group.path}>{group.name}</span>
      <span className="tab-count">{group.tabs.length}</span>
      {profile && (
        <span className="chip muted tab-profile" title={`profile: ${profile}`}>{profile}</span>
      )}
      <button ref={triggerRef} className="tab-group-trigger"
        title="conversations in this project"
        aria-haspopup="menu" aria-expanded={open}
        onClick={e => { e.stopPropagation(); if (open) close(); else setOpen(true); }}>
        <Icon name="chev" size={9} />
      </button>

      {open && (
        <div className="tab-group-pop" role="menu" onClick={e => e.stopPropagation()}>
          {group.tabs.map(t => (
            <div key={t.id} className={`tab-group-row ${t.id === activeId ? "active" : ""}`} role="none">
              {renaming === t.id ? (
                <span className="tab-group-item tab-group-editing">
                  <span className="tab-group-dot"><TabRunDot state={t.runState} /></span>
                  <RenameField value={t.name}
                    onCommit={name => { setRenaming(null); onRename(t.id, name); }}
                    onCancel={() => setRenaming(null)} />
                </span>
              ) : (
                <button className="tab-group-item" role="menuitem"
                  onClick={() => { onSelect(t.id); close(); }}>
                  <span className="tab-group-dot"><TabRunDot state={t.runState} /></span>
                  <span className="tab-name" title={t.name}>{t.name}</span>
                </button>
              )}
              {onRename && renaming !== t.id && (
                <button className="tab-close" title="rename conversation"
                  onClick={() => { onSelect(t.id); setRenaming(t.id); }}>
                  <Icon name="edit" size={9} />
                </button>
              )}
              {/* Stays open: the rest of the group is still listed, and when
                  fewer than two tabs remain the whole chip unmounts. */}
              <button className="tab-close" title="close tab" onClick={() => onClose?.(t.id)}>
                <Icon name="close" size={9} />
              </button>
            </div>
          ))}
          <div className="tab-group-sep" role="separator" />
          <button className="tab-group-item" role="menuitem"
            onClick={() => { onNewInProject?.(group.path, group.profile); close(); }}>
            <span className="tab-group-dot"><Icon name="plus" size={10} /></span>
            <span className="tab-name">new conversation</span>
          </button>
        </div>
      )}
    </div>
  );
}

Object.assign(window, { TabGroupChip, TabRunDot });

/* ═════════════════════════════════════════════════════════════════════
   tab-group-chip.jsx — one tab-bar chip for several tabs on one project

   Issue #27: tabs on the same folder *and* profile collapse into a single
   chip (`omp-desktop 3 ▾`); its dropdown lists the member tabs and offers
   "new conversation" in that project. Grouping itself is
   `OMP_PROJECT_NAV.groupTabs` (app/project-nav.js); this file only renders.
   ═════════════════════════════════════════════════════════════════════ */

const { Icon, RenameField } = window;
const { groupTarget, groupRunState, membersNewestFirst, tabLabel } = window.OMP_PROJECT_NAV;

/** A tab's (or group's) run-state dot; nothing while idle. Shared by the
 *  tab bar and the project sidebar so the titles stay in one place. */
function TabRunDot({ state }) {
  if (!state || state === "idle") return null;
  const title = state === "waiting-user" ? "waiting for you"
    : state === "failed" ? "agent process exited"
    : state === "background" ? "background job running · the agent resumes when it finishes"
    : state === "retrying" ? "retrying a failed request"
    : "running";
  return <span className={`tab-run-dot ${state}`} title={title} />;
}

/** Name of a tab shown on its own (#46): `folder · title` once the title
 *  is no longer the folder name, the folder truncating first. Shared by the
 *  tab bar and the project sidebar; `className` is the caller's name class. */
function TabLabel({ tab, className, title }) {
  const { prefix, title: name } = tabLabel(tab);
  if (!prefix) return <span className={className} title={title}>{name}</span>;
  return (
    <span className={`${className} tab-label`} title={title}>
      {/* A few letters of the folder stay visible however long the title;
          a shorter folder keeps its own width, not a padded 4ch box. */}
      <span className="tab-prefix" style={{ minWidth: `${Math.min(4, prefix.length)}ch` }}>{prefix}</span>
      <span className="tab-sep">·</span>
      <span className="tab-title">{name}</span>
    </span>
  );
}

function TabGroupChip({ group, activeId, profileLabel, onSelect, onClose, onNewInProject, onRename, reorder }) {
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

  window.usePopoverDismiss(open, rootRef, close);

  const active  = group.tabs.find(t => t.id === activeId);
  const profile = profileLabel(group.profile);
  // The × closes one conversation, the one a click on the chip selects (#45):
  // the focused member, else the newest. Never the whole project.
  const closeTarget = group.tabs.find(t => t.id === groupTarget(group, activeId));
  // Drag to reorder (#40), on TabBar's `useDragReorder`: the chip moves
  // along the bar, the dropdown's rows within this project.
  const members = `members:${group.key}`;

  return (
    <div ref={rootRef}
      {...reorder.itemProps("projects", group.key, "x")}
      className={`tab tab-group ${active ? "active" : ""}${reorder.dropClass("projects", group.key)}`}
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
      {/* Old WebKit reports a middle click as `click` with button 1 (see the
          root): it must not close anything, as on the rest of the chip. */}
      <button className="tab-close" title={`close conversation "${closeTarget.name}"`}
        onClick={e => { e.stopPropagation(); if (e.button !== 1) onClose?.(closeTarget.id); }}>
        <Icon name="close" size={9} />
      </button>

      {open && (
        <div className="tab-group-pop" role="menu" data-no-reorder onClick={e => e.stopPropagation()}>
          {membersNewestFirst(group).map(t => (
            <div key={t.id} {...reorder.itemProps(members, t.id, "y")}
              className={`tab-group-row ${t.id === activeId ? "active" : ""}${reorder.dropClass(members, t.id)}`} role="none">
              {renaming === t.id ? (
                <span className="tab-group-item tab-group-editing">
                  <span className="tab-group-dot"><TabRunDot state={t.runState} /></span>
                  <RenameField value={t.name}
                    onCommit={name => onRename(t.id, name)}
                    onClose={() => setRenaming(null)} />
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

Object.assign(window, { TabGroupChip, TabRunDot, TabLabel });

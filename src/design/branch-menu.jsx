/* branch-menu.jsx — the status bar's branch pill and its picker: the tab
   project's local and remote branches (Rust `git_browser_branches`, the
   checked-out one left out), filtered by name; a pick switches the work tree
   to it (`workspace_switch_branch`, `git switch`), and the HEAD watcher
   brings the new name back through the bridge snapshot. The status bar
   clips its overflow, so the menu is portaled to <body> and placed above
   the pill when it opens, as pr-automation-menu.jsx is beside its card.
   chrome.jsx renders it keyed by tab: a tab switch closes it. */

const { Icon: _BM_Icon, OMP_GIT_BROWSER: _BM_GIT } = window;

/** Fixed-position style above the pill, as wide as the window allows. */
function _BM_place(trigger) {
  const rect = trigger.getBoundingClientRect();
  return {
    left: Math.max(8, Math.min(rect.left, window.innerWidth - 368)),
    bottom: window.innerHeight - rect.top + 4,
    maxHeight: Math.max(0, rect.top - 12),
  };
}

// `locked`: an agent works on this repository (a turn, a retry, a pending
// question or a background job, in any tab on a folder of it): the list
// still opens, but no row switches, as the switch would change the files
// under it.
function BranchMenu({ branch, bridge, locked = false }) {
  // Where the open menu sits (placed once, when it opens); null = closed.
  const [place, setPlace] = React.useState(null);
  const open = place !== null;
  const [list, setList] = React.useState(null); // { branches } or { error }
  const [query, setQuery] = React.useState("");
  const triggerRef = React.useRef(null);
  const popRef = React.useRef(null);
  const inputRef = React.useRef(null);
  const rootRef = React.useRef(null);
  rootRef.current = {
    contains: node => triggerRef.current?.contains(node) || popRef.current?.contains(node),
  };
  // The switch in flight, git's refusal and the close that drops a late
  // switch (ui/use-menu-pick.js); a close also resets the filter and list.
  const { busy, error, pick: run, close } = window.useMenuPick(triggerRef, () => {
    setPlace(null);
    setQuery("");
    setList(null);
  });

  React.useEffect(() => {
    if (!open) return undefined;
    let live = true;
    bridge.gitBranches().then(res => {
      if (!live) return;
      setList(!res ? { error: "this tab has no project folder" } : res.ok ? { branches: res.value } : { error: res.error });
    });
    inputRef.current?.focus();
    // The menu is placed once: a resize would leave it off the pill.
    const onResize = () => close(false);
    window.addEventListener("resize", onResize);
    return () => { live = false; window.removeEventListener("resize", onResize); };
  }, [open]); // eslint-disable-line react-hooks/exhaustive-deps

  // An outside click leaves focus where it lands; Escape returns it.
  window.usePopoverDismiss(open, rootRef, () => close(false), close);

  const pick = b => {
    if (locked) return;
    run(async () => {
      const res = await bridge.gitSwitchBranch(b.name, b.remote);
      if (!res?.ok) throw new Error(res ? res.error : "this tab has no project folder");
    }, e => e.message);
  };

  const rows = list?.branches ? _BM_GIT.branchMatches(list.branches, query) : null;
  const first = rows ? rows.local[0] ?? rows.remote[0] : null;
  // ↓ from the filter enters the list; Enter picks the first match (not
  // the Enter that commits an IME composition).
  const onInputKey = e => {
    if (e.key === "ArrowDown") { e.preventDefault(); popRef.current?.querySelector('[role="menuitem"]')?.focus(); }
    else if (e.key === "Enter" && !e.nativeEvent.isComposing && first) { e.preventDefault(); pick(first); }
  };
  // Arrows move between the rows; ↑ off the first row returns to the
  // filter. Tab closes the menu from anywhere in it, the filter included.
  const onPopKey = e => {
    if (e.target === inputRef.current) {
      if (e.key === "Tab" && !e.ctrlKey && !e.altKey && !e.metaKey) { e.preventDefault(); close(); }
      return;
    }
    const firstRow = popRef.current.querySelector('[role="menuitem"]');
    if (e.key === "ArrowUp" && document.activeElement === firstRow) { e.preventDefault(); inputRef.current?.focus(); return; }
    window.menuKeyNav(e, popRef.current, '[role="menuitem"]', close);
  };
  const now = Date.now() / 1000;
  const row = b => (
    <button key={`${b.remote}:${b.name}`} className="branch-item" role="menuitem"
      aria-disabled={busy || locked || undefined} onClick={() => pick(b)}
      title={b.remote ? `switch to a new local branch tracking ${b.name}` : `switch to ${b.name}`}>
      <span className="branch-item-name mono">{b.name}</span>
      {b.at > 0 && <span className="branch-item-age mono">{_BM_GIT.relativeTime(b.at, now)}</span>}
    </button>
  );

  return (
    <>
      <button ref={triggerRef} className="status-cell btn ghost branch-pill" aria-haspopup="menu" aria-expanded={open}
        title={locked ? "branches (no switching while the agent works)" : "switch branch"}
        onClick={() => (open ? close() : setPlace(_BM_place(triggerRef.current)))}>
        <_BM_Icon name="branch" size={11} color="var(--fg-3)" />
        <span className="mono">{branch}</span>
      </button>
      {open && ReactDOM.createPortal(
        <div ref={popRef} className={`branch-pop${busy ? " busy" : ""}${locked ? " locked" : ""}`} style={place}
          role="menu" aria-label="switch branch" onKeyDown={onPopKey}>
          <div className="branch-pop-filter">
            <_BM_Icon name="search" size={11} color="var(--fg-4)" />
            <input ref={inputRef} className="mono" value={query} placeholder="filter branches"
              aria-label="filter branches" spellCheck={false}
              onChange={e => setQuery(e.target.value)} onKeyDown={onInputKey} />
          </div>
          <div className="branch-pop-list">
            {!list ? (
              <div className="branch-pop-note">loading…</div>
            ) : list.error ? (
              <div className="branch-pop-note error">could not list the branches: {list.error}</div>
            ) : (<>
              {rows.local.length > 0 && <div className="branch-pop-head mono" role="none">local</div>}
              {rows.local.map(row)}
              {rows.remote.length > 0 && <div className="branch-pop-head mono" role="none">remote</div>}
              {rows.remote.map(row)}
              {!first && <div className="branch-pop-note">{query.trim() ? "no branch matches" : "no other branches"}</div>}
              {rows.hidden > 0 && <div className="branch-pop-note">{rows.hidden} more — narrow the filter</div>}
            </>)}
          </div>
          {locked && <div className="branch-pop-note" role="status">the agent is working — switch branches once it's idle</div>}
          {error && <div className="branch-pop-note error" role="alert">{error}</div>}
        </div>,
        document.body,
      )}
    </>
  );
}

// Memoised: App re-renders on every streamed frame, while these props
// (`bridge` is window.OMP_BRIDGE; `branch`, `locked`) rarely change.
Object.assign(window, { BranchMenu: React.memo(BranchMenu) });

/* ═════════════════════════════════════════════════════════════════════
   profile-menu.jsx — per-tab omp profile selector (window chrome)

   A profile is `omp --profile <id>`: an isolated tree of auth, sessions,
   settings and caches. One tab owns one omp process, so the profile is a
   per-tab property — this menu always shows and changes the profile of the
   *active* tab, never a global one.

   Ids vs names: the id is immutable and names omp's data directory; the
   name is a free-form label. That is why renaming (including the built-in
   "default" profile) never moves any data. See src-tauri/src/profiles.rs.
   ═════════════════════════════════════════════════════════════════════ */

const { Icon, DEFAULT_PROFILE_ID, isSubmitEnter } = window;

function ProfileMenu({
  profiles = [], activeId = DEFAULT_PROFILE_ID, startupId = DEFAULT_PROFILE_ID,
  onSelect, onCreate, onRename, onDelete, onSetStartup,
}) {
  const [open,  setOpen]  = React.useState(false);
  const [mode,  setMode]  = React.useState(null);   // null | "create" | "rename"
  const [draft, setDraft] = React.useState("");
  const [error, setError] = React.useState(null);
  // Deletion is two-step in place: the trash icon arms a "delete?" row and a
  // second click confirms. A profile's directory holds real credentials and
  // history, so a stray single click must not unlist it — but a modal for a
  // list entry is heavier than the action deserves.
  const [armedDelete, setArmedDelete] = React.useState(null);
  const rootRef    = React.useRef(null);
  const inputRef   = React.useRef(null);
  const triggerRef = React.useRef(null);
  // Bumped by every close. Each async handler captures it and drops its
  // result if the popover it belonged to is gone: `close()` is the only
  // thing that resets `error`/`mode`/`armedDelete`, so a late `setError`
  // from a dismissed round-trip would otherwise sit there and repaint as a
  // stale red hint the next time the menu is opened for something else.
  const openGen = React.useRef(0);

  // An id with no matching entry (list still loading) still renders, using
  // the id as its own label — never a blank chip.
  const active = profiles.find(p => p.id === activeId) ?? { id: activeId, name: activeId };

  const close = React.useCallback(() => {
    openGen.current += 1;
    setOpen(false);
    setMode(null);
    setDraft("");
    setError(null);
    setArmedDelete(null);
    // Escape and pick() both call close() while focus can sit on a row
    // button that's about to unmount; without this, focus falls back to
    // <body> and the next Tab restarts from the top of the document.
    triggerRef.current?.focus();
  }, []);

  // Outside click / Escape dismiss. Attached only while open so the app
  // isn't paying for two document listeners for a closed menu.
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

  React.useEffect(() => { if (mode) inputRef.current?.focus(); }, [mode]);

  const startEdit = kind => {
    setMode(kind);
    setDraft(kind === "rename" ? active.name : "");
    setError(null);
    // The rows stay rendered behind the inline form, so an armed row would
    // sit one click from being unlisted while the footer hint explains
    // deletion instead of the edit actually in progress.
    setArmedDelete(null);
  };
  // Focus explicitly, like close() does: the input is the focused element
  // when the form unmounts (the `mode` effect put focus there), so without
  // this focus falls back to <body> while the popover is still open.
  const cancelEdit = () => { setMode(null); setDraft(""); setError(null); triggerRef.current?.focus(); };

  // Bridge mutations resolve to {ok, value} | {ok: false, error}; the
  // backend's reason (blank name, profile limit, …) is shown inline.
  // `busy` guards re-entry: the input stays enabled across the await, so
  // Enter auto-repeat or a double-click would otherwise fire N create_profile
  // round-trips and leave N stray profiles for one intent.
  const busy = React.useRef(false);
  const commit = async () => {
    if (busy.current) return;
    const name = draft.trim();
    if (!name) { setError("name required"); return; }
    const gen = openGen.current;
    busy.current = true;
    // Held across every await below, including the create path's second
    // round-trip (onSelect -> switchSessionProfile, which kills, respawns
    // and re-listens the tab's process) — releasing it after only the first
    // await left the still-mounted, still-focused form open to a second
    // Enter (auto-repeat included) or save click re-entering commit() and
    // firing a duplicate create_profile for the same name.
    try {
      let res;
      try {
        res = mode === "create"
          ? await onCreate?.(name)
          : await onRename?.(active.id, name);
      } catch (e) {
        res = { ok: false, error: e?.message ?? String(e) };
      }
      if (gen !== openGen.current) return;   // dismissed mid-round-trip
      if (!res?.ok) { setError(res?.error ?? "could not save"); return; }
      // A freshly created profile is what the user wants this tab to use —
      // selecting it here is the whole point of adding it. Awaited, so a
      // refused switch (e.g. no tab open) reports instead of closing on a
      // half-done action.
      if (mode === "create") {
        // Leave create mode first: the profile now *exists*, so the form has
        // done its job whatever the switch does next. Keeping it mounted with
        // the name still in the draft made a refused switch look like a
        // refused create, and the next Enter created a second profile under a
        // suffixed id for the same one intent.
        setMode(null);
        setDraft("");
        let sel;
        try {
          sel = await onSelect?.(res.value.id);
        } catch (e) {
          sel = { ok: false, error: e?.message ?? String(e) };
        }
        if (gen !== openGen.current) return;
        if (sel && !sel.ok) { setError(sel.error ?? "could not switch profile"); return; }
      }
      close();
    } finally {
      busy.current = false;
    }
  };

  // `onSelect` resolves to {ok} | {ok: false, error} on every path
  // (live.js::switchSessionProfile guarantees it), and several of those
  // refusals are invisible anywhere else: "no tab open" when the last tab
  // was closed, an unlisted profile another window deleted, or a switch
  // already in flight for this tab. Await it and keep the popover open with
  // the reason rather than closing on an action that did not happen.
  const pick = async id => {
    if (id === activeId) { close(); return; }
    if (busy.current) return;
    const gen = openGen.current;
    busy.current = true;
    let res;
    try {
      res = await onSelect?.(id);
    } catch (e) {
      res = { ok: false, error: e?.message ?? String(e) };
    } finally {
      busy.current = false;
    }
    if (gen !== openGen.current) return;
    if (res && !res.ok) { setError(res.error ?? "could not switch profile"); return; }
    close();
  };

  const remove = async id => {
    if (armedDelete !== id) { setArmedDelete(id); setError(null); return; }
    // `busy` (a ref) not `armedDelete` (state) is what blocks the second
    // click: two clicks in one tick both read the same pre-render
    // `armedDelete`, so clearing state here is too late to stop a duplicate
    // `delete_profile` - and the backend rejects the second with
    // `unknown profile: …`, reporting failure for a delete that succeeded.
    if (busy.current) return;
    const gen = openGen.current;
    busy.current = true;
    setArmedDelete(null);
    let res;
    try {
      res = await onDelete?.(id);
    } catch (e) {
      res = { ok: false, error: e?.message ?? String(e) };
    } finally {
      busy.current = false;
    }
    if (gen !== openGen.current) return;   // dismissed mid-round-trip
    setError(res?.ok ? null : res?.error ?? "could not delete");
  };

  const setStartup = async id => {
    if (id === startupId) return;   // already the default - nothing to do
    // Same `busy` ref as create/delete: the tick stays clickable across the
    // round-trip, and the snapshot only repaints once the backend confirms.
    if (busy.current) return;
    const gen = openGen.current;
    busy.current = true;
    setError(null);
    let res;
    try {
      res = await onSetStartup?.(id);
    } catch (e) {
      res = { ok: false, error: e?.message ?? String(e) };
    } finally {
      busy.current = false;
    }
    if (gen !== openGen.current) return;   // dismissed mid-round-trip
    if (res && !res.ok) setError(res.error ?? "could not set default");
  };

  return (
    <div className="profile-menu" ref={rootRef}>
      <button
        ref={triggerRef}
        className="btn ghost outlined profile-trigger"
        title="omp profile for this tab (auth, sessions, settings)"
        aria-haspopup="menu"
        aria-expanded={open}
        onClick={() => (open ? close() : setOpen(true))}>
        <Icon name="layers" size={11} />
        <span className="mono profile-trigger-name">{active.name}</span>
        <Icon name="chev" size={9} color="var(--fg-4)" />
      </button>

      {open && (
        <div className="profile-pop" role="menu">
          <div className="profile-pop-head mono" role="none">profile · this tab</div>

          {/* role="none" on every non-menuitem container: a generic element
              between role="menu" and its items breaks the owned-elements
              relationship, which costs positional announcements ("item 2 of
              5") in AT that honours menu ownership. This wrapper exists only
              to carry max-height/overflow-y. */}
          <div className="profile-list" role="none">
          {profiles.map(p => {
            const armed = armedDelete === p.id;
            const isStartup = p.id === startupId;
            return (
              <div key={p.id} className="profile-row" role="none">
                {/* Two marks per row with different glyphs, because they mean
                    different things and have very different blast radii:
                    the boxed *tick* in the gutter is "new tabs and the next
                    launch start here" (persisted, app-wide, reversible), and
                    the `live` ring on the row is "this tab's process is
                    running here" (one click respawns the tab and drops its
                    transcript). Two identical checks 10px apart were
                    indistinguishable.

                    Both are rendered conditionally rather than painted
                    `color="transparent"`: `Icon` always fills its accent dot
                    regardless of `color`, and `live`'s inner circle is
                    `fill="currentColor"`, so a "hidden" glyph still shows a
                    mark. An empty box / empty gutter is the off state.

                    The tick is a *radio*, not a checkbox: `ProfilesFile::
                    startup` is a single pointer that always resolves to
                    exactly one listed id, and `setStartup` returns early on
                    the already-ticked row — so the control is one-of-a-set,
                    not togglable. A checkbox tells a screen-reader user they
                    can uncheck it, and the attempt is a silent no-op. */}
                <button
                  className={`btn icon ghost profile-star ${isStartup ? "on" : ""}`}
                  title={isStartup
                    ? `“${p.name}” is the default for new tabs`
                    : `make “${p.name}” the default for new tabs`}
                  role="menuitemradio"
                  aria-checked={isStartup}
                  onClick={() => setStartup(p.id)}>
                  {isStartup && <Icon name="check" size={10} color="var(--accent)" dotColor="var(--accent)" />}
                </button>
                <button
                  role="menuitem"
                  className={`profile-item ${p.id === activeId ? "active" : ""}`}
                  onClick={() => pick(p.id)}>
                  <span className="profile-item-mark">
                    {p.id === activeId && (
                      <Icon name="live" size={9} color="var(--accent)" dotColor="transparent" />
                    )}
                  </span>
                  <span className="profile-item-name">{p.name}</span>
                  <span className="profile-item-id mono">
                    {p.id === DEFAULT_PROFILE_ID ? "~/.omp/agent" : `~/.omp/profiles/${p.id}`}
                  </span>
                </button>
                {/* The built-in profile is omp's own tree and every tab's
                    fallback — it has no delete affordance at all. A spacer
                    (not `display: none`) fills the same ~24px column that
                    `.btn.profile-del` reserves via `opacity: 0` on every
                    other row, so this row's flex:1 `.profile-item` doesn't
                    stretch wider and throw off the id-text alignment below. */}
                {p.id !== DEFAULT_PROFILE_ID ? (
                  <button
                    role="menuitem"
                    className={`btn icon ghost profile-del ${armed ? "armed" : ""}`}
                    title={armed
                      ? "click again to remove from the list (keeps files on disk)"
                      : `delete profile “${p.name}”`}
                    onClick={() => remove(p.id)}>
                    {armed
                      ? <span className="profile-del-label mono">delete?</span>
                      : <Icon name="trash" size={10} />}
                  </button>
                ) : (
                  <span className="profile-del-spacer" aria-hidden="true" />
                )}
              </div>
            );
          })}
          </div>

          <div className="profile-sep" role="none" />

          {mode ? (
            <div className="profile-form" role="none">
              <input
                ref={inputRef}
                className="profile-input"
                value={draft}
                maxLength={48}
                placeholder={mode === "create" ? "work, home, client…" : "new name"}
                onChange={e => { setDraft(e.target.value); setError(null); }}
                onKeyDown={e => {
                  // Raw `key === "Enter"` would also fire on the Enter that
                  // commits an IME candidate, saving a half-typed name as a
                  // permanent, slug-derived id. Same guard as the composer.
                  if (isSubmitEnter(e)) { e.preventDefault(); commit(); }
                  if (e.key === "Escape") { e.stopPropagation(); cancelEdit(); }
                }} />
              <button className="btn icon ghost" title="save" onClick={commit}>
                <Icon name="check" size={10} />
              </button>
              <button className="btn icon ghost" title="cancel" onClick={cancelEdit}>
                <Icon name="close" size={9} />
              </button>
            </div>
          ) : (
            <React.Fragment>
              <button role="menuitem" className="profile-item" onClick={() => startEdit("create")}>
                <Icon name="plus" size={10} />
                <span className="profile-item-name">new profile…</span>
              </button>
              <button role="menuitem" className="profile-item" onClick={() => startEdit("rename")}>
                <Icon name="edit" size={10} />
                <span className="profile-item-name">rename “{active.name}”</span>
              </button>
            </React.Fragment>
          )}

          {error && <div className="profile-hint err" role="none">{error}</div>}
          <div className="profile-hint" role="none">
            {armedDelete
              ? "delete only unlists it — files under ~/.omp/profiles stay on disk"
              : "tick = default for new tabs · switching restarts this tab’s agent"}
          </div>
        </div>
      )}
    </div>
  );
}

// Memoised: WindowChrome re-renders on every streaming notify(), while the
// menu's props (profile list, active id, stable handlers) rarely change.
Object.assign(window, { ProfileMenu: React.memo(ProfileMenu) });

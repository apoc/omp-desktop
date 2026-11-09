/* ═════════════════════════════════════════════════════════════════════
   design/path-setting.jsx — a Rust-owned program path setting in Settings
   (Terminal's shell, Browser's Chromium): `usePathSetting` reads and saves
   it, `PathPicker` is the row's control: a button naming the value and its
   drop-down menu (rows from app/path-setting.js `menu`, then "other…",
   Rust's file dialog). Settings → Agent's startup profile reuses the
   picker without "other…". The row frame is the caller's (SettingsRow).
   ═════════════════════════════════════════════════════════════════════ */

const { Icon: _PSet_Icon } = window;

/**
 * The "other…" pick in flight per setting (`api.key`), kept outside the
 * component: closing Settings unmounts it, and on Linux (rfd's GTK3 dialog
 * ignores the parent window) the panel can be closed and reopened while
 * the dialog is up. A remount waits for this before it reads the setting,
 * so it shows the pick, and a second "other…" does nothing until the
 * dialog is gone.
 */
const _PSet_pickInFlight = new Map();

/**
 * One Rust-owned path setting: `api` is a module constant `{ key, read,
 * save, pick }` whose functions take the bridge (`read` → settings or null,
 * `save(bridge, value)` / `pick` → `{ ok, settings }` | `{ ok: false, error }`,
 * `settings` null from `pick` = the dialog was cancelled). Returns the
 * settings, the reason Rust refused the last change, `save(value)` and
 * `pick()` (the file dialog).
 */
function usePathSetting(bridge, api) {
  const [settings, setSettings] = React.useState(null);
  const [error, setError] = React.useState(null);
  React.useEffect(() => {
    if (!bridge) return undefined;
    let live = true;
    Promise.resolve(_PSet_pickInFlight.get(api.key))
      .then(() => api.read(bridge))
      .then((s) => { if (live && s) setSettings(s); });
    return () => { live = false; };
  }, [bridge, api]);
  const apply = React.useCallback((res) => {
    if (!res.ok) { setError(res.error); return; }
    setError(null);
    if (res.settings) setSettings(res.settings);
  }, []);
  // Sent even for the ticked row: Rust's reply is the stored setting, which
  // the menu may not show.
  const save = React.useCallback(async (value) => {
    apply(await api.save(bridge, value));
  }, [bridge, api, apply]);
  const pick = React.useCallback(async () => {
    if (_PSet_pickInFlight.has(api.key)) return;
    const pending = api.pick(bridge);
    _PSet_pickInFlight.set(api.key, pending);
    try { apply(await pending); } finally { _PSet_pickInFlight.delete(api.key); }
  }, [bridge, api, apply]);
  return { settings, error, save, pick };
}

/**
 * The control of a Settings row naming a path setting: a button (`label`
 * its text, `title` its tooltip, `name` the menu's accessible name) and its
 * drop-down menu: `rows` (`{ name, hint, path, value, checked }`, exactly
 * one checked), then "other…" when `pick` is given. `disabled` until the
 * setting is read. A row saves its `value`; `error` shows under the button.
 */
function PathPicker({ name, label, title, rows, disabled, error, save, pick }) {
  const [open, setOpen] = React.useState(false);
  const rootRef = React.useRef(null);
  // precedent:ignore — the menu trigger/close pattern of the other popover menus
  const menuRef = React.useRef(null);
  const triggerRef = React.useRef(null);

  const close = React.useCallback((refocus = true) => {
    setOpen(false);
    if (refocus) triggerRef.current?.focus();
  }, []);
  // An outside click leaves focus where it lands; Escape returns it.
  window.usePopoverDismiss(open, rootRef, () => close(false), close);

  // Focus the checked row when the menu opens, and scroll the Settings page
  // so the menu is in view (a row near the bottom drops it past the edge).
  React.useEffect(() => {
    if (!open) return;
    menuRef.current?.scrollIntoView({ block: "nearest" });
    menuRef.current?.querySelector('[aria-checked="true"]')?.focus({ preventScroll: true });
  }, [open]);

  // Arrows, Home and End move between the rows; Tab closes the menu.
  const onMenuKey = e => window.menuKeyNav(e, menuRef.current, "button", close);

  return (
    <div className="st-pick" ref={rootRef}>
      <button ref={triggerRef} type="button" className="st-sel"
        aria-haspopup="menu" aria-expanded={open} aria-label={name} disabled={disabled} title={title}
        onClick={() => (open ? close() : setOpen(true))}>
        <span className="st-sel-v">{OMP_TR(label)}</span>
        <_PSet_Icon name="chev" size={10} color="var(--fg-4)" />
      </button>
      {/* `data-st-esc`: while open, the Settings page leaves Escape and the
          arrows to this menu (settings/page.jsx). */}
      {open && (
        <div ref={menuRef} className="st-menu" role="menu" aria-label={name} onKeyDown={onMenuKey} data-st-esc="">
          {rows.map(r => (
            <button key={r.value || "default"} type="button" className="st-menu-item"
              role="menuitemradio" aria-checked={r.checked} title={r.path || undefined}
              onClick={() => { close(); save(r.value); }}>
              <span className="st-menu-mark">
                {r.checked && <_PSet_Icon name="check" size={10} color="var(--accent)" />}
              </span>
              <span className="st-menu-name">{OMP_TR(r.name)}</span>
              {r.hint && <span className="st-menu-hint">{OMP_TR(r.hint)}</span>}
            </button>
          ))}
          {pick && (
            <>
              <div className="st-menu-sep" role="separator" />
              <button type="button" className="st-menu-item" role="menuitem"
                onClick={() => { close(); pick(); }}>
                <span className="st-menu-mark" />
                <span className="st-menu-name">{OMP_TR("other…")}</span>
                <span className="st-menu-hint">{OMP_TR("browse")}</span>
              </button>
            </>
          )}
        </div>
      )}
      {error != null && <div className="st-path-error">{error}</div>}
    </div>
  );
}

Object.assign(window, { usePathSetting, PathPicker });

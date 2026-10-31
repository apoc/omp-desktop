/* thinking-menu.jsx — the composer's thinking pill and its level menu (#10).
   The levels are omp's own list for the tab's current model
   (`get_available_thinking_levels`, `off` first), fetched each time the
   menu opens and again when the model changes while it is open. A pick is
   `set_thinking_level`; the pill shows the level omp reports applied
   (live.js, `thinking_level_changed`), so a pick omp clamps shows what omp
   chose. Cycling stays on the keymap (`app.thinking.cycle`) and the
   `/thinking` palette entry. composer.jsx renders this by its global name,
   keyed by tab: a tab switch remounts it, closed, with nothing in flight. */

const { Icon: _TM_Icon, THINKING_LEVELS: _TM_LEVELS } = window;

function ThinkingMenu({ model, level, cycleHint, onLoad, onSet }) {
  const [open, setOpen] = React.useState(false);
  // { key, levels } or { key, error }, tagged with the model it was fetched
  // for: shown only while that still matches, so a model switch never shows
  // the previous model's levels, not even until the refetch lands.
  const [list, setList] = React.useState(null);
  const rootRef = React.useRef(null);
  const popRef = React.useRef(null);
  const triggerRef = React.useRef(null);
  // A pick in flight, its refusal and the close that drops a late one
  // (ui/use-menu-pick.js).
  const { busy, error, pick: run, close } = window.useMenuPick(triggerRef, () => setOpen(false));
  const key = model ? window.modelKey(model) : "";
  const shown = list?.key === key ? list : null;

  React.useEffect(() => {
    if (!open) return undefined;
    let live = true;
    onLoad().then(
      levels => { if (live) setList({ key, levels }); },
      e => { if (live) setList({ key, error: e?.message ?? String(e) }); },
    );
    return () => { live = false; };
  }, [open, key]); // eslint-disable-line react-hooks/exhaustive-deps

  // An outside click leaves focus where it lands; Escape returns it.
  window.usePopoverDismiss(open, rootRef, () => close(false), close);

  // Focus the checked level (else the first) once the list is in, and
  // again after a refetch replaced the rows.
  React.useEffect(() => {
    if (!open || !shown?.levels) return;
    const pop = popRef.current;
    if (!pop || pop.contains(document.activeElement)) return;
    (pop.querySelector('[aria-checked="true"]') ?? pop.querySelector('[role="menuitemradio"]'))?.focus();
  }, [open, shown]);

  // Arrows, Home and End move between the levels; Tab closes the menu.
  const onPopKey = e => window.menuKeyNav(e, popRef.current, '[role="menuitemradio"]', close);

  // Sent even for the ticked level: in `auto` mode the tick is only what
  // auto resolved to, and picking it is how the level gets pinned.
  const pick = value => run(() => onSet(value), e => e?.timedOut
    ? "omp has not answered yet; the level may still change"
    : `not applied: ${e?.message ?? e}`);

  return (
    <div className="thinking-menu" ref={rootRef}>
      <button ref={triggerRef} className="composer-pill" aria-haspopup="menu" aria-expanded={open}
        title={cycleHint ? `thinking level (${cycleHint} cycles)` : "thinking level"}
        onClick={() => (open ? close() : setOpen(true))}>
        <_TM_Icon name="thinking" size={11} color="var(--lilac)" />
        <span style={{ color: "var(--fg-2)" }}>thinking · {level}</span>
        <_TM_Icon name="chev" size={10} color="var(--fg-4)" />
      </button>
      {open && (
        <div ref={popRef} className={`thinking-pop${busy ? " busy" : ""}`} role="menu" aria-label="thinking level" onKeyDown={onPopKey}>
          <div className="thinking-pop-head mono" role="none">thinking · {model?.name}</div>
          {!shown ? (
            <div className="thinking-pop-note" role="none">loading…</div>
          ) : shown.error ? (
            <div className="thinking-pop-note error" role="none">could not load the levels: {shown.error}</div>
          ) : (<>
            {shown.levels.map(l => (
              <button key={l} className={`thinking-item${l === level ? " active" : ""}`}
                role="menuitemradio" aria-checked={l === level} aria-disabled={busy || undefined}
                onClick={() => pick(l)}>
                <span className="thinking-item-mark">
                  {l === level && <_TM_Icon name="check" size={10} color="var(--accent)" />}
                </span>
                <span className="thinking-item-name mono">{l}</span>
                {_TM_LEVELS[l] && <span className="thinking-item-hint">{_TM_LEVELS[l].hint}</span>}
              </button>
            ))}
            {shown.levels.length <= 1 && (
              <div className="thinking-pop-note" role="none">this model has no thinking levels</div>
            )}
          </>)}
          {error && <div className="thinking-pop-note error" role="none">{error}</div>}
          {cycleHint && <div className="thinking-pop-foot mono" role="none">{cycleHint} cycles the level</div>}
        </div>
      )}
    </div>
  );
}

Object.assign(window, { ThinkingMenu });

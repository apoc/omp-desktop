/* ═════════════════════════════════════════════════════════════════════
   design/settings/shortcuts-editor.jsx — Settings → Shortcuts: every
   KEYMAP_ACTIONS action with its chords, where they come from (`default`,
   `desktop` overlay, `omp` keybindings) and rebind / + chord / clear, plus
   reset for a desktop override. A change to any action, omp-sourced ones
   included, is written to the desktop overlay, which wins over omp's file.
   Record mode captures the next chord (bare Escape cancels); a chord
   already bound to another action is refused. Filtered by the page search
   (`query`) and the editor's own filter field.

   Registered as the `shortcuts` custom row (window.OMP_SETTINGS_ROWS);
   `ctx.keymap` is useKeymap()'s result (app/use-keymap.jsx).
   ═════════════════════════════════════════════════════════════════════ */

const { KEYMAP_ACTIONS: _SKE_ACTIONS, formatChord: _SKE_fmt } = window.OMP_KEYMAP;

/** `KEYMAP_ACTIONS` label lookup, translated, shared by the conflict-refusal
 *  message (record listener) and the row's own conflict warning. */
function _SKE_labelFor(id) {
  const label = _SKE_ACTIONS.find(a => a.id === id)?.label;
  return label ? OMP_TR(label) : id;
}

/** Whether `action` matches the lowercased filter `lq`: label, id or one
 *  of its effective chords as shown. */
function _SKE_matches(action, lq) {
  if (!lq) return true;
  if (action.label.toLowerCase().includes(lq)) return true;
  if (OMP_TR(action.label).toLowerCase().includes(lq)) return true;
  if (action.id.toLowerCase().includes(lq)) return true;
  return window.OMP_KEYMAP.keysFor(action.id).some(c => _SKE_fmt(c).toLowerCase().includes(lq));
}

/** One action's row: chords, source chip, action buttons, plus its error or
 *  conflict warning line under it. */
function _SKE_Row({ action, chords, src, recording, rowError, conflict, disabled, query, onRebind, onAddChord, onClear, onReset }) {
  const Row = window.SettingsRow;
  return (
    <>
      <Row label={action.label} desc={`\`${action.id}\``} query={query} className="st-kb-row">
        <div className="st-kb-ctl">
          {recording
            ? <span className="st-kb-recording mono" data-st-esc="">{OMP_TR("press a chord · esc cancels")}</span>
            : (
              <div className="st-chords">
                {chords.length
                  ? chords.map(c => <span className="st-kbd" key={c}>{_SKE_fmt(c)}</span>)
                  : <span className="st-kb-unbound mono">{OMP_TR("unbound")}</span>}
              </div>
            )}
          <span className={`st-srcchip ${src}`}>{src}</span>
          <div className="st-kb-actions">
            <button type="button" className="st-ghost" disabled={disabled} onClick={onRebind}>{OMP_TR("rebind")}</button>
            <button type="button" className="st-ghost" disabled={disabled} onClick={onAddChord}>{OMP_TR("+ chord")}</button>
            <button type="button" className="st-ghost" disabled={disabled} onClick={onClear}>{OMP_TR("clear")}</button>
            {src === "desktop" && (
              <button type="button" className="st-ghost" disabled={disabled} onClick={onReset}>{OMP_TR("reset")}</button>
            )}
          </div>
        </div>
      </Row>
      {(rowError || conflict) && (
        <div className="st-kb-warn">
          {rowError || OMP_TR("also bound to “{name}” — that binding wins", { name: _SKE_labelFor(conflict.actions[0]) })}
        </div>
      )}
    </>
  );
}

function ShortcutsEditor({ ctx, query }) {
  const { keymap } = ctx;
  const [filter,      setFilter]      = React.useState("");
  const [recordingId, setRecordingId] = React.useState(null);
  const [recordMode,  setRecordMode]  = React.useState("replace"); // "replace" | "add"
  const [rowError,    setRowError]    = React.useState(null); // { id, message }

  // Fresh from disk each time the section is shown: the files may have been
  // edited by hand meanwhile.
  React.useEffect(() => { keymap.reload(); }, []); // eslint-disable-line react-hooks/exhaustive-deps

  // Groups in registry order; both the page search and the local filter
  // must match. A page search that names no action (it found the section
  // by its own keywords, e.g. "hotkeys") does not narrow the list.
  const grouped = React.useMemo(() => {
    let page = (query ?? "").trim().toLowerCase();
    if (page && !_SKE_ACTIONS.some(a => _SKE_matches(a, page))) page = "";
    const own = filter.trim().toLowerCase();
    const groups = [];
    for (const action of _SKE_ACTIONS) {
      if (!_SKE_matches(action, page) || !_SKE_matches(action, own)) continue;
      const last = groups[groups.length - 1];
      if (last?.name === action.group) last.actions.push(action);
      else groups.push({ name: action.group, actions: [action] });
    }
    return groups;
  }, [query, filter, keymap.payload, keymap.error]);

  const sourceFor = id => {
    if (keymap.payload?.overlay[id] !== undefined) return "desktop";
    if (keymap.payload?.omp[id]     !== undefined) return "omp";
    return "default";
  };
  const conflictFor = id => keymap.conflicts?.find(c => c.actions[1] === id) ?? null;

  const startRecord = (id, mode) => {
    setRowError(null);
    setRecordingId(id);
    setRecordMode(mode);
  };

  // Leaving the Settings tab (page kept mounted, `ctx.active` false) ends
  // recording, so the next key typed elsewhere is not taken as a chord.
  const active = ctx.active !== false;
  React.useEffect(() => { if (!active) setRecordingId(null); }, [active]);

  // Record mode: the next chord, captured before the global dispatcher and
  // the Settings page's own keys (Escape, arrows) see it.
  React.useEffect(() => {
    if (!recordingId || !active) return undefined;
    const capture = (e) => {
      // Let an active IME composition (CJK candidate window, dead-key
      // compose step) run its own key handling — don't hijack it into a
      // chord, and don't preventDefault/stopPropagation what the IME needs.
      if (e.isComposing) return;
      e.preventDefault();
      e.stopPropagation();
      // Only a *bare* Escape cancels recording — a modified variant is a
      // real chord a user may want to record (e.g. moving app.interrupt off
      // bare escape).
      if (e.key === "Escape" && !e.ctrlKey && !e.altKey && !e.shiftKey && !e.metaKey) {
        setRecordingId(null);
        return;
      }
      const chord = window.OMP_KEYMAP.chordFromEvent(e);
      if (!chord) return; // bare modifier — wait for a real key

      const existing = window.OMP_KEYMAP.lookup(chord);
      if (existing && existing !== recordingId) {
        setRowError({ id: recordingId, message: OMP_TR("{chord} is already bound to “{name}” — clear that binding first.", { chord: _SKE_fmt(chord), name: _SKE_labelFor(existing) }) });
        setRecordingId(null);
        return;
      }

      const current = window.OMP_KEYMAP.keysFor(recordingId);
      const keys = recordMode === "add" ? [...current, chord] : [chord];
      const id = recordingId;
      setRecordingId(null);
      keymap.setBinding(id, keys).then(err => {
        if (err) setRowError({ id, message: err });
      });
    };
    window.addEventListener("keydown", capture, true); // capture phase
    return () => window.removeEventListener("keydown", capture, true);
  }, [recordingId, recordMode, active, keymap.setBinding]);

  const run = async (id, call) => {
    setRowError(null);
    const err = await call();
    if (err) setRowError({ id, message: err });
  };

  const disabled = !!keymap.error;
  const overlayPath = keymap.overlayPath ?? "—";
  const ompPath     = keymap.payload?.ompPath ?? "no keybindings file";
  const inherited   = keymap.payload?.inheritedPath;

  return (
    <div className="st-kb">
      <div className="st-kb-top">
        <input className="st-kb-filter mono" placeholder={OMP_TR("filter actions or chords…")} value={filter}
          aria-label={OMP_TR("filter shortcuts")} onChange={e => setFilter(e.target.value)} />
      </div>
      {keymap.error && (
        <div className="st-kb-banner">
          {OMP_TR("Shortcuts are running on omp config + defaults. Rebinding is disabled until the overlay file is fixed or deleted:")} <span className="mono st-kb-path">{overlayPath}</span>
        </div>
      )}
      {grouped.length === 0
        ? <div className="st-kb-empty">{OMP_TR("no matching action")}</div>
        : grouped.map(group => (
          <div className="st-kb-group" key={group.name}>
            <div className="st-kb-group-name">{OMP_TR(group.name)}</div>
            {group.actions.map(a => (
              <_SKE_Row
                key={a.id}
                action={a}
                chords={window.OMP_KEYMAP.keysFor(a.id)}
                src={sourceFor(a.id)}
                recording={recordingId === a.id}
                rowError={rowError?.id === a.id ? rowError.message : null}
                conflict={conflictFor(a.id)}
                disabled={disabled}
                query={query}
                onRebind={() => startRecord(a.id, "replace")}
                onAddChord={() => startRecord(a.id, "add")}
                onClear={() => run(a.id, () => keymap.setBinding(a.id, []))}
                onReset={() => run(a.id, () => keymap.resetBinding(a.id))}
              />
            ))}
          </div>
        ))}
      <div className="st-kb-foot mono">
        <span>{OMP_TR("desktop overrides →")} <span className="st-kb-path">{overlayPath}</span></span>
        <span>omp → <span className="st-kb-path">{ompPath}</span>
          {inherited && <span className="st-kb-dim"> {OMP_TR("+ inherits")} {inherited}</span>}
        </span>
      </div>
    </div>
  );
}

Object.assign(window.OMP_SETTINGS_ROWS = window.OMP_SETTINGS_ROWS || {}, { shortcuts: ShortcutsEditor });

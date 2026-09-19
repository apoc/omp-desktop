/* ═════════════════════════════════════════════════════════════════════
   shortcuts-modal.jsx — Keyboard shortcuts viewer and rebinder.

   Props: { open, onClose, keymap }
     keymap — result of useKeymap() from app/use-keymap.jsx.

   Entry points:
     - desktop.shortcuts.open action (Ctrl+/) via global dispatcher
     - /shortcuts palette command
   ═════════════════════════════════════════════════════════════════════ */

const { Icon } = window;
const { KEYMAP_ACTIONS, formatChord } = window.OMP_KEYMAP;

/** `KEYMAP_ACTIONS` label lookup shared by the conflict-refusal message
 *  (record listener) and the row's own conflict warning. */
function labelFor(id) {
  return KEYMAP_ACTIONS.find(a => a.id === id)?.label ?? id;
}

/** One action's row: chords/source chip/action buttons, plus its error or
 *  conflict warning line. Split out of `ShortcutsModal` to keep that
 *  function focused on state/effects rather than per-row markup. */
function ShortcutRow({ action, chords, src, recording, rowError, conflict, disabled, onRebind, onAddChord, onClear, onReset }) {
  return (
    <React.Fragment>
      <div className="kb-row">
        <div className="kb-label">
          {action.label}
          <span className="kb-id mono">{action.id}</span>
        </div>

        {recording
          ? <span className="kb-recording mono">press a chord · esc cancels</span>
          : <div className="kb-chords">
              {chords.length
                ? chords.map(c => <span className="kbd" key={c}>{formatChord(c)}</span>)
                : <span className="kb-unbound mono">unbound</span>}
            </div>}

        <span className={`chip kb-src ${src}`}>{src}</span>

        <div className="kb-actions">
          <button className="btn ghost" disabled={disabled} onClick={onRebind}>rebind</button>
          <button className="btn ghost" disabled={disabled} onClick={onAddChord}>+ chord</button>
          <button className="btn ghost" disabled={disabled} onClick={onClear}>clear</button>
          {src === "desktop" && (
            <button className="btn ghost" disabled={disabled} onClick={onReset}>reset</button>
          )}
        </div>
      </div>

      {(rowError || conflict) && (
        <div className="kb-warn">
          {rowError && <div>{rowError}</div>}
          {!rowError && conflict && (
            <div>
              also bound to &ldquo;{labelFor(conflict.actions[0])}&rdquo; — that binding wins
            </div>
          )}
        </div>
      )}
    </React.Fragment>
  );
}

function ShortcutsModal({ open, onClose, keymap }) {
  const [q,           setQ]           = React.useState("");
  const [recordingId, setRecordingId] = React.useState(null);
  const [recordMode,  setRecordMode]  = React.useState("replace"); // "replace" | "add"
  const [rowError,    setRowError]    = React.useState(null); // { id, message }
  const inputRef = React.useRef(null);

  // ── Derived: groups in registry order ──────────────────────────────────────

  const grouped = React.useMemo(() => {
    const lq = q.toLowerCase();
    const filter = a => {
      if (!lq) return true;
      if (a.label.toLowerCase().includes(lq)) return true;
      if (a.id.toLowerCase().includes(lq)) return true;
      const effectiveChords = window.OMP_KEYMAP.keysFor(a.id);
      if (effectiveChords.some(c => formatChord(c).toLowerCase().includes(lq))) return true;
      return false;
    };

    const groups = [];
    const seen   = new Set();
    for (const action of KEYMAP_ACTIONS) {
      if (!filter(action)) continue;
      if (!seen.has(action.group)) {
        seen.add(action.group);
        groups.push({ name: action.group, actions: [] });
      }
      groups[groups.length - 1].actions.push(action);
    }
    return groups;
  }, [q, keymap.payload, keymap.error]);

  // ── Source classification per action ───────────────────────────────────────

  function sourceFor(id) {
    if (keymap.payload?.overlay[id] !== undefined) return "desktop";
    if (keymap.payload?.omp[id]     !== undefined) return "omp";
    return "default";
  }


  // ── Open: reload + focus ───────────────────────────────────────────────────

  React.useEffect(() => {
    if (!open) return;
    keymap.reload();
    setQ("");
    setRowError(null);
    setRecordingId(null);
    requestAnimationFrame(() => inputRef.current?.focus());
  }, [open]); // eslint-disable-line react-hooks/exhaustive-deps

  // ── Escape / scrim close ───────────────────────────────────────────────────

  React.useEffect(() => {
    if (!open) return;
    const onKey = (e) => {
      if (e.key === "Escape") {
        e.preventDefault();
        e.stopPropagation();
        if (recordingId) {
          setRecordingId(null);
        } else {
          onClose();
        }
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open, recordingId, onClose]);

  // ── Record mode ────────────────────────────────────────────────────────────

  function startRecord(id, mode) {
    setRowError(null);
    setRecordingId(id);
    setRecordMode(mode);
  }

  React.useEffect(() => {
    if (!recordingId) return;

    const capture = (e) => {
      // Let an active IME composition (CJK candidate window, dead-key
      // compose step) run its own key handling — don't hijack it into a
      // chord, and don't preventDefault/stopPropagation what the IME needs
      // to see (e.g. its own Escape to cancel the candidate window).
      if (e.isComposing) return;
      e.preventDefault();
      e.stopPropagation();
      // Only a *bare* Escape cancels recording — a modified variant
      // (ctrl+escape, shift+escape, …) is a real chord a user may want to
      // record (e.g. moving app.interrupt off bare escape) and must fall
      // through to chordFromEvent below instead of silently cancelling.
      if (e.key === "Escape" && !e.ctrlKey && !e.altKey && !e.shiftKey && !e.metaKey) {
        setRecordingId(null);
        return;
      }
      const chord = window.OMP_KEYMAP.chordFromEvent(e);
      if (!chord) return; // bare modifier — wait for a real key

      // Check for conflict with another action.
      const existing = window.OMP_KEYMAP.lookup(chord);
      if (existing && existing !== recordingId) {
        const label = labelFor(existing);
        setRowError({ id: recordingId, message: `${formatChord(chord)} is already bound to \u201c${label}\u201d — clear that binding first.` });
        setRecordingId(null);
        return;
      }

      // Commit.
      const current = window.OMP_KEYMAP.keysFor(recordingId);
      const keys = recordMode === "add" ? [...current, chord] : [chord];
      setRecordingId(null);
      keymap.setBinding(recordingId, keys).then(err => {
        if (err) setRowError({ id: recordingId, message: err });
      });
    };

    window.addEventListener("keydown", capture, true); // capture phase
    return () => window.removeEventListener("keydown", capture, true);
  }, [recordingId, recordMode, keymap.setBinding]);

  // ── Helpers ────────────────────────────────────────────────────────────────

  async function handleClear(id) {
    setRowError(null);
    const err = await keymap.setBinding(id, []);
    if (err) setRowError({ id, message: err });
  }

  async function handleReset(id) {
    setRowError(null);
    const err = await keymap.resetBinding(id);
    if (err) setRowError({ id, message: err });
  }

  const disabled = !!keymap.error;

  // ── Conflict lookup for a losing action ────────────────────────────────────

  function conflictFor(id) {
    return keymap.conflicts?.find(c => c.actions[1] === id) ?? null;
  }

  if (!open) return null;

  // ── Footer paths ────────────────────────────────────────────────────────────

  const overlayPath = keymap.overlayPath ?? "—";
  const ompPath     = keymap.payload?.ompPath ?? "no keybindings file";
  const inherited   = keymap.payload?.inheritedPath;

  return (
    <div className="bridge-scrim" onClick={onClose} style={{ paddingTop: "8vh" }}>
      <div className="bridge slide-in" onClick={e => e.stopPropagation()}
           style={{ width: "min(760px, calc(100vw - 32px))", maxHeight: "80vh" }}>

        {/* Header / filter input */}
        <div className="bridge-input-row" style={{ padding: "12px 16px", gap: 10 }}>
          <Icon name="grid" size={14} color="var(--fg-3)" />
          <input
            ref={inputRef}
            className="bridge-input mono"
            placeholder="filter actions…"
            value={q}
            onChange={e => setQ(e.target.value)}
          />
          <span className="kbd">esc</span>
        </div>

        {/* Error banner (corrupt overlay or failed list) */}
        {keymap.error && (
          <div className="kb-banner">
            Shortcuts are running on omp config + defaults.
            Rebinding is disabled until the overlay file is fixed or deleted:
            <br />
            <span className="mono" style={{ wordBreak: "break-all" }}>{overlayPath}</span>
          </div>
        )}

        {/* Action rows */}
        <div className="bridge-body" style={{ maxHeight: "58vh", padding: "6px 8px" }}>
          {grouped.length === 0
            ? <div className="bridge-empty">no matching action</div>
            : grouped.map(group => (
              <div className="bridge-group" key={group.name}>
                <div className="bridge-group-head">{group.name}</div>
                {group.actions.map(a => (
                  <ShortcutRow
                    key={a.id}
                    action={a}
                    chords={window.OMP_KEYMAP.keysFor(a.id)}
                    src={sourceFor(a.id)}
                    recording={recordingId === a.id}
                    rowError={rowError?.id === a.id ? rowError.message : null}
                    conflict={conflictFor(a.id)}
                    disabled={disabled}
                    onRebind={() => startRecord(a.id, "replace")}
                    onAddChord={() => startRecord(a.id, "add")}
                    onClear={() => handleClear(a.id)}
                    onReset={() => handleReset(a.id)}
                  />
                ))}
              </div>
            ))}
        </div>

        {/* Footer */}
        <div className="bridge-foot mono" style={{ fontSize: "var(--d-text-xs)", gap: 8 }}>
          <span>desktop overrides → <span style={{ color: "var(--fg-2)" }}>{overlayPath}</span></span>
          <span style={{ color: "var(--fg-4)" }}>·</span>
          <span>omp → <span style={{ color: "var(--fg-2)" }}>{ompPath}</span>
            {inherited && <span style={{ color: "var(--fg-4)" }}> + inherits {inherited}</span>}
          </span>
          <span style={{ color: "var(--fg-4)" }}>·</span>
          <span className="kbd">esc</span> close
        </div>
      </div>
    </div>
  );
}

window.ShortcutsModal = ShortcutsModal;

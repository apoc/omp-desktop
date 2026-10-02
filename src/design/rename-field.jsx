/* ═════════════════════════════════════════════════════════════════════
   rename-field.jsx — inline editor for a conversation's name (issue #32)

   Swapped in for a tab's (or sidebar row's) label while renaming. Enter
   or leaving the field commits, Escape cancels; an empty or unchanged
   name is a cancel. The caller sends the rename
   (`OMP_BRIDGE.renameSession`) and unmounts the field either way — the
   label updates once omp confirms.
   ═════════════════════════════════════════════════════════════════════ */

function RenameField({ value, onCommit, onCancel, className = "" }) {
  const [draft, setDraft] = React.useState(value);
  const inputRef = React.useRef(null);
  // Exactly one outcome per edit: Enter unmounts the field, which can
  // still fire a blur, and the unmount below must not finish it again.
  const done = React.useRef(false);
  // Read at unmount, after the closures of the first render went stale.
  const latest = React.useRef(null);

  const finish = commit => {
    if (done.current) return;
    done.current = true;
    const { draft: text, value: current, onCommit: commitFn, onCancel: cancelFn } = latest.current;
    const next = text.trim();
    if (commit && next && next !== current) commitFn(next);
    else cancelFn();
  };
  latest.current = { draft, value, onCommit, onCancel, finish };

  React.useEffect(() => {
    inputRef.current?.focus();
    inputRef.current?.select();
    // Unmounted mid-edit — a group popover closed by an outside click, or
    // the tab folded into a group chip: that is leaving the field too, so
    // commit like a blur. Otherwise the parent's edit state would linger
    // and reopen the field whenever the row came back.
    return () => latest.current.finish(true);
  }, []);

  // The field sits inside clickable rows and tabs: keep its clicks (caret
  // placement, word-select double-click, middle-click) from selecting,
  // re-entering the edit or closing the tab.
  const stop = e => e.stopPropagation();
  return (
    <input ref={inputRef}
      className={`rename-field ${className}`}
      value={draft}
      aria-label="conversation name"
      spellCheck={false}
      onChange={e => setDraft(e.target.value)}
      onClick={stop} onDoubleClick={stop} onAuxClick={stop}
      onKeyDown={e => {
        // `isSubmitEnter`, not a raw Enter: the Enter that commits an IME
        // candidate must not commit a half-typed name (same as composer).
        if (window.isSubmitEnter(e)) { e.preventDefault(); finish(true); return; }
        // Stopped here: the window keymap would abort a running turn on
        // Escape, and an open group popover would close with it.
        if (e.key === "Escape") { e.preventDefault(); e.stopPropagation(); finish(false); }
      }}
      onBlur={() => finish(true)} />
  );
}

Object.assign(window, { RenameField });

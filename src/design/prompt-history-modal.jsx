/* ═════════════════════════════════════════════════════════════════════
   prompt-history-modal.jsx — Ctrl+Up picker over the active tab's
   in-memory prompt history (issue #16). No fetch, no persistence: the
   list is handed in as `entries` (newest first) straight from the
   bridge snapshot.
   ═════════════════════════════════════════════════════════════════════ */

const { Icon } = window;

function PromptHistoryModal({ open, entries, onClose, onPick }) {
  const [activeIdx, setActiveIdx] = React.useState(0);
  const listRef = React.useRef(null);
  const containerRef = React.useRef(null);
  const restoreFocusRef = React.useRef(null);

  // Move DOM focus onto the modal itself when it opens, and back to
  // whatever had it (the composer textarea, reached via Ctrl+Up) when it
  // closes — same "focus falls back to <body> otherwise" fix as
  // profile-menu.jsx's triggerRef.focus(). The focus grab alone isn't a
  // complete guard, though: the composer has its own "refocus when
  // streaming ends" effect (composer.jsx, `!isStreaming` → `ta.focus()`)
  // that can steal focus back while this is still open mid-turn — see the
  // capture-phase keydown listener below, which is the actual guard.
  React.useEffect(() => {
    if (!open) return;
    restoreFocusRef.current = document.activeElement;
    requestAnimationFrame(() => containerRef.current?.focus());
    return () => { restoreFocusRef.current?.focus?.(); };
  }, [open]);

  // Reset selection to the newest entry each time the modal opens.
  React.useEffect(() => { if (open) setActiveIdx(0); }, [open]);

  const clampedIdx = entries.length > 0 ? Math.max(0, Math.min(activeIdx, entries.length - 1)) : 0;

  React.useEffect(() => {
    if (!open || !listRef.current) return;
    listRef.current.children[clampedIdx]?.scrollIntoView({ block: "nearest" });
  }, [clampedIdx, open]);

  const pick = (text) => { onPick?.(text); onClose(); };

  // Capture phase + stopPropagation, not bubble: focus alone (above)
  // isn't a reliable guard once the composer's own streaming-end
  // refocus effect can run while this is still open, so intercept
  // before the event ever reaches the composer's onKeyDown — same
  // pattern as shortcuts-modal.jsx's chord recorder. Modified keys are
  // let through untouched so Ctrl+Up still reaches the keymap toggle.
  React.useEffect(() => {
    if (!open) return;
    const onKey = (e) => {
      if (e.ctrlKey || e.altKey || e.metaKey) return;
      if (e.key === "Escape") {
        e.preventDefault(); e.stopPropagation();
        onClose();
      } else if (e.key === "ArrowDown") {
        e.preventDefault(); e.stopPropagation();
        setActiveIdx(Math.max(0, Math.min(clampedIdx + 1, entries.length - 1)));
      } else if (e.key === "ArrowUp") {
        e.preventDefault(); e.stopPropagation();
        setActiveIdx(Math.max(clampedIdx - 1, 0));
      } else if (e.key === "Enter") {
        // Swallowed unconditionally, even with an empty list (nothing to
        // pick): this listener exists precisely so Enter can never reach
        // the composer's send() while the picker is open, regardless of
        // whether there's an entry under the cursor.
        e.preventDefault(); e.stopPropagation();
        if (entries[clampedIdx]) pick(entries[clampedIdx]);
      }
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [open, onClose, entries, clampedIdx]);

  if (!open) return null;

  return (
    <div className="bridge-scrim" onClick={onClose} style={{ paddingTop: "8vh" }}>
      <div ref={containerRef} tabIndex={-1} className="bridge slide-in" onClick={e => e.stopPropagation()} style={{ width: "min(640px, calc(100vw - 32px))", maxHeight: "72vh", outline: "none" }}>
        <div className="bridge-input-row" style={{ padding: "12px 16px", gap: 10 }}>
          <Icon name="clock" size={16} color="var(--accent)" />
          <span style={{ color: "var(--fg)", fontWeight: 550, flex: 1 }}>Prompt history</span>
          <span className="mono" style={{ color: "var(--fg-4)", fontSize: "var(--d-text-xs)" }}>
            {entries.length} {entries.length === 1 ? "prompt" : "prompts"}
          </span>
          <span className="kbd">esc</span>
        </div>

        <div ref={listRef} className="bridge-body" style={{ maxHeight: "56vh", padding: "6px 8px" }}>
          {entries.length === 0 && (
            <div className="bridge-empty">No prompts sent in this tab yet.</div>
          )}
          {entries.map((text, idx) => {
            const isSelected = idx === clampedIdx;
            return (
              <div
                key={idx}
                className={`bridge-row ${isSelected ? "active" : ""}`}
                style={{
                  padding: "8px 14px", margin: "2px 0",
                  borderRadius: 10, cursor: "pointer",
                  border: isSelected ? "1px solid color-mix(in oklab, var(--accent) 30%, var(--line))" : "1px solid transparent",
                  background: isSelected ? "var(--bg-hover)" : "transparent",
                  color: isSelected ? "var(--fg)" : "var(--fg-2)",
                  fontSize: "var(--d-text-sm)",
                  lineHeight: "1.35",
                  overflow: "hidden",
                  display: "-webkit-box",
                  WebkitLineClamp: 2,
                  WebkitBoxOrient: "vertical",
                  whiteSpace: "pre-wrap",
                }}
                onMouseEnter={() => setActiveIdx(idx)}
                onClick={() => pick(text)}>
                {text}
              </div>
            );
          })}
        </div>

        <div className="bridge-foot mono" style={{ display: "flex", alignItems: "center", gap: 8 }}>
          <span className="kbd">↑↓</span> navigate
          <span className="kbd">↵</span> insert into composer
          <span className="kbd">esc</span> close
        </div>
      </div>
    </div>
  );
}

window.PromptHistoryModal = PromptHistoryModal;

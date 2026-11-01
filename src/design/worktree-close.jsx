/* Explicit authorization for a managed worktree close. */
function _WTC_Dialog({ request, onResolve }) {
  const panelRef = React.useRef(null);
  const cancelRef = React.useRef(null);
  const submitted = React.useRef(false);
  const busy = !!request.busy;
  const prompt = window.OMP_WORKTREE_STORAGE.closePrompt(request);
  window.useModalFocus(cancelRef);

  React.useEffect(() => {
    if (busy) panelRef.current?.focus();
    else {
      submitted.current = false;
      cancelRef.current?.focus();
    }
  }, [busy, request.error]);
  const resolve = (action) => {
    if (submitted.current || !window.OMP_WORKTREE_STORAGE.canCloseWith(request, action)) return;
    submitted.current = true;
    onResolve(action);
  };

  React.useEffect(() => {
    const onKey = (event) => {
      event.stopPropagation();
      const panel = panelRef.current;
      if (event.key === "Escape") {
        event.preventDefault();
        resolve("cancel");
        return;
      }
      if (event.key === "Tab") {
        event.preventDefault();
        const buttons = [...(panel?.querySelectorAll("button:not(:disabled)") ?? [])];
        if (!buttons.length) { panel?.focus(); return; }
        const index = buttons.indexOf(document.activeElement);
        buttons[index < 0 ? 0 : (index + (event.shiftKey ? buttons.length - 1 : 1)) % buttons.length].focus();
        return;
      }
      const inside = !!panel?.contains(event.target);
      if (inside && !event.ctrlKey && !event.altKey && !event.metaKey && (event.key === "Enter" || event.key === " ")) return;
      event.preventDefault();
      if (!inside) (cancelRef.current?.disabled ? panel : cancelRef.current)?.focus();
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [busy, onResolve, prompt.canRemove]);

  return (
    <div className="bridge-scrim worktree-close-scrim" onClick={() => resolve("cancel")}>
      <div className="close-confirm-panel worktree-close" ref={panelRef} tabIndex={-1}
        role="dialog" aria-modal="true" aria-labelledby="worktree-close-title" aria-describedby="worktree-close-details"
        aria-busy={busy} onClick={event => event.stopPropagation()}>
        <div className="close-confirm-head"><span id="worktree-close-title" className="mono">Close {request.name || "conversation"}?</span></div>
        <div className="close-confirm-body worktree-close-body" id="worktree-close-details">
          <div className="mono worktree-path">{request.path}</div>
          <p>{prompt.keep}</p>
          <p>{prompt.preserve}</p>
          <p>{prompt.caches}</p>
          {prompt.pin && <p>{prompt.pin}</p>}
          {request.error && <p className="worktree-error" role="alert">{request.error}</p>}
          {busy && <p role="status">Saving close choice…</p>}
        </div>
        <div className="close-confirm-foot worktree-close-actions">
          <button type="button" className="btn ghost" ref={cancelRef} disabled={busy} onClick={() => resolve("cancel")}>Cancel</button>
          <button type="button" className="btn outlined" disabled={busy} onClick={() => resolve("keep")}>Keep for now</button>
          <button type="button" className="btn outlined danger" disabled={!prompt.canRemove} onClick={() => resolve("snapshotRemove")}>Save restore point and remove</button>
        </div>
      </div>
    </div>
  );
}
window.OMP_WORKTREE_CLOSE = { WorktreeCloseDialog: _WTC_Dialog };

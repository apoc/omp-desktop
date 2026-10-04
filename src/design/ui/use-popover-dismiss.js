/* ui/use-popover-dismiss.js — outside-click / Escape dismissal shared by the
   dropdown menus (profile-menu.jsx, tab-group-chip.jsx, thinking-menu.jsx).

   usePopoverDismiss(open, rootRef, onOutside, onEscape = onOutside): while
   `open`, a mousedown outside `rootRef` calls `onOutside`, and Escape calls
   `onEscape`. Escape is prevented, so the window keymap (use-keymap.jsx
   skips defaultPrevented events) does not also abort the running turn. The
   listeners are attached only while open, and the callbacks are read
   through a ref, so an inline arrow does not re-attach them every render. */

(function () {
  function usePopoverDismiss(open, rootRef, onOutside, onEscape = onOutside) {
    const handlers = React.useRef(null);
    handlers.current = { onOutside, onEscape };

    React.useEffect(() => {
      if (!open) return undefined;
      const onDown = e => { if (!rootRef.current?.contains(e.target)) handlers.current.onOutside(); };
      const onKey  = e => { if (e.key === "Escape") { e.preventDefault(); handlers.current.onEscape(); } };
      document.addEventListener("mousedown", onDown);
      document.addEventListener("keydown", onKey);
      return () => {
        document.removeEventListener("mousedown", onDown);
        document.removeEventListener("keydown", onKey);
      };
    }, [open, rootRef]);
  }

  window.usePopoverDismiss = usePopoverDismiss;
})();

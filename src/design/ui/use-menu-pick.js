/* ui/use-menu-pick.js — a dropdown menu whose pick runs an async action and
   stays open on failure (thinking-menu.jsx, branch-menu.jsx).

   useMenuPick(triggerRef, onClose) → { busy, error, pick, close }:
   - pick(action, describe): runs `action()` unless a pick is in flight;
     `busy` while it runs. It resolving closes the menu; it throwing keeps
     the menu open with `describe(error)` as `error`.
   - close(refocus = true): clears busy, error and the pick in flight, calls
     `onClose` (the menu's own reset) and returns focus to `triggerRef`.
   Every close drops the pick in flight, so one that settles after its menu
   closed leaves the next opening alone: no focus pulled back to the
   trigger, no stale error, and the reopened menu takes a new pick. */

(function () {
  function useMenuPick(triggerRef, onClose) {
    const [busy, setBusy] = React.useState(false);
    const [error, setError] = React.useState(null);
    const pending = React.useRef(null);
    const onCloseRef = React.useRef(onClose);
    onCloseRef.current = onClose;

    const close = React.useCallback((refocus = true) => {
      pending.current = null;
      setBusy(false);
      setError(null);
      onCloseRef.current();
      if (refocus) triggerRef.current?.focus();
    }, [triggerRef]);

    const pick = async (action, describe) => {
      if (pending.current) return;
      const token = {};
      pending.current = token;
      setBusy(true);
      setError(null);
      try {
        await action();
      } catch (e) {
        if (pending.current !== token) return;
        pending.current = null;
        setBusy(false);
        setError(describe(e));
        return;
      }
      if (pending.current === token) close();
    };

    return { busy, error, pick, close };
  }

  window.useMenuPick = useMenuPick;
})();

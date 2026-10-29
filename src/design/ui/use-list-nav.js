// ui/use-list-nav.js — keyboard-driven popup lists.
//
// useActiveRowIntoView: keep the highlighted row in view as the arrow keys
// move it (the composer's slash menu and `@` mention list, the session and
// prompt history modals). `listRef` is the list element, its children the
// rows; nothing scrolls while `shown` is false.
//
// useListKeys: a modal list's window-level keys while `open` — ↑/↓ move the
// highlight within `count` rows, Enter calls `onEnter(index)` for a row under
// it, Escape `onClose`. `guard` is for a list opened over the composer
// (prompt history): listen in the capture phase and stop the event, so the
// composer's own keydown never sees it; swallow Enter even with nothing to
// pick, so it can never reach send(); and let Ctrl/Alt/Meta chords through to
// the keymap.
//
// Wrapped in an IIFE so neither leaks into document scope.
(function () {
  function useActiveRowIntoView(listRef, index, shown) {
    React.useEffect(() => {
      if (!shown || !listRef.current) return;
      listRef.current.children[index]?.scrollIntoView({ block: "nearest" });
    }, [index, shown, listRef]);
  }

  function useListKeys({ open, count, index, setIndex, onEnter, onClose, guard = false }) {
    React.useEffect(() => {
      if (!open) return undefined;
      const take = (e) => { e.preventDefault(); if (guard) e.stopPropagation(); };
      const onKey = (e) => {
        if (guard && (e.ctrlKey || e.altKey || e.metaKey)) return;
        if (e.key === "Escape") {
          take(e);
          onClose();
        } else if (e.key === "ArrowDown") {
          take(e);
          setIndex(Math.max(0, Math.min(index + 1, count - 1)));
        } else if (e.key === "ArrowUp") {
          take(e);
          setIndex(Math.max(index - 1, 0));
        } else if (e.key === "Enter") {
          const has = index < count;
          if (guard || has) take(e);
          if (has) onEnter(index);
        }
      };
      window.addEventListener("keydown", onKey, guard);
      return () => window.removeEventListener("keydown", onKey, guard);
    }, [open, count, index, setIndex, onEnter, onClose, guard]);
  }

  window.useActiveRowIntoView = useActiveRowIntoView;
  window.useListKeys = useListKeys;
})();

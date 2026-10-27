// ui/use-modal-focus.js — a modal rendered inside #root takes focus when it
// opens and hands it back to what had it when it closes. Used by
// prompt-history-modal.jsx, update-modal.jsx and confirm-close.jsx (their
// capture-phase key guards stay their own). `targetRef` gets focus on the
// next frame, after the modal has mounted. A portal modal that makes #root
// inert uses image-lightbox.jsx's useModalLayer instead.
//
// Wrapped in an IIFE so `useModalFocus` doesn't leak into document scope.
(function () {
  function useModalFocus(targetRef, open = true) {
    React.useEffect(() => {
      if (!open) return undefined;
      const restore = document.activeElement;
      requestAnimationFrame(() => targetRef.current?.focus());
      return () => { restore?.focus?.(); };
    }, [open, targetRef]);
  }

  // Portal previews/lightboxes own focus while #root is inert. Async setup
  // requests stay queued until that owner closes, without intercepting its keys.
  function modalAvailable() {
    return !document.getElementById("root")?.inert;
  }

  function observeModalAvailability(changed) {
    const root = document.getElementById("root");
    if (!root) return () => {};
    const observer = new MutationObserver(changed);
    observer.observe(root, { attributes: true, attributeFilter: ["inert"] });
    return () => observer.disconnect();
  }

  function useModalAvailable() {
    return React.useSyncExternalStore(observeModalAvailability, modalAvailable);
  }

  window.useModalFocus = useModalFocus;
  window.useModalAvailable = useModalAvailable;
})();

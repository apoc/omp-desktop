/* Serialize native storage operations; Rust remains the policy authority. */
function _WTS_useWorktreeStorage() {
  const [view, setView] = React.useState(null);
  const [loading, setLoading] = React.useState(false);
  const [error, setError] = React.useState(null);
  const [listenerError, setListenerError] = React.useState(null);
  const queue = React.useRef(Promise.resolve());
  const pending = React.useRef(0);
  const mounted = React.useRef(false);

  const run = React.useCallback((command, args, isRestore = false) => {
    pending.current++;
    if (mounted.current) setLoading(true);
    const operation = queue.current.then(async () => {
      const invoke = window.__TAURI__?.core?.invoke;
      if (!invoke) throw new Error("Native worktree storage is unavailable.");
      const result = await invoke(command, args);
      if (isRestore) {
        // Restore returns a workspace, not a storage view.
        const next = await invoke("worktree_storage_view");
        if (mounted.current) setView(next);
      } else if (mounted.current) {
        setView(result);
      }
      if (mounted.current) setError(null);
      return result;
    }).catch((failure) => {
      if (mounted.current) setError(String(failure?.message || failure));
      return null;
    }).finally(() => {
      pending.current--;
      if (mounted.current) setLoading(pending.current > 0);
    });
    queue.current = operation;
    return operation;
  }, []);

  React.useEffect(() => {
    let stopped = false;
    let unlisten = null;
    mounted.current = true;
    const start = async () => {
      try {
        const listen = window.__TAURI__?.event?.listen;
        if (!listen) throw new Error("Native worktree storage notifications are unavailable.");
        const off = await listen("worktree-storage://changed", () => {
          if (!stopped) void run("worktree_storage_view");
        });
        if (stopped) { off(); return; }
        unlisten = off;
        setListenerError(null);
      } catch (failure) {
        if (!stopped) setListenerError(`Worktree storage notifications failed: ${String(failure?.message || failure)}`);
      }
      // Subscribe first so changes during the initial read cannot be missed.
      if (!stopped) {
        const initial = await run("worktree_storage_view");
        if (!stopped && initial) void run("worktree_storage_view", { measure: true });
      }
    };
    void start();
    return () => {
      stopped = true;
      mounted.current = false;
      unlisten?.();
    };
  }, [run]);

  return {
    view, loading, error: [error, listenerError].filter(Boolean).join(" · ") || null,
    refresh: () => run("worktree_storage_view", { measure: true }),
    setPolicy: (policy) => run("worktree_storage_set_policy", { policy }),
    setPin: (id, pinned) => run("worktree_storage_set_pin", { id, pinned }),
    sweep: () => run("worktree_storage_sweep"),
    restore: (id) => run("worktree_storage_restore", { id }, true),
  };
}
window.OMP_WORKTREE_STORAGE_HOOK = { useWorktreeStorage: _WTS_useWorktreeStorage };

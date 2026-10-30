/* Native keep-awake snapshots and action ownership. No activity is inferred here. */
(function () {
  function status(snapshot, session) {
    if (!session) return "Waiting for this chat's native state.";
    const active = snapshot.active
      ? " Native sleep prevention is active globally."
      : "";
    if (!session.enabled) return `Off for this chat.${active}`;
    if (!session.working) return `Enabled; this chat is idle.${active}`;
    return snapshot.active
      ? "Agent working; native sleep prevention is active globally."
      : "Agent working; native sleep prevention is not active.";
  }

  function create(bridge, changed) {
    let alive = true;
    let snapshot = null;
    let readError = null;
    let listenerError = null;
    let off = null;
    const actions = new Map();
    const notify = () => {
      if (alive) changed();
    };
    const accept = (value) => {
      if (
        !alive ||
        !value ||
        !Number.isSafeInteger(value.revision) ||
        (snapshot && value.revision <= snapshot.revision)
      )
        return;
      snapshot = value;
      readError = null;
      notify();
    };
    async function start() {
      try {
        const unlisten = await bridge.onKeepAwakeChanged(accept);
        if (!alive) {
          unlisten();
          return;
        }
        off = unlisten;
      } catch (error) {
        if (!alive) return;
        listenerError = String(error?.message ?? error);
        notify();
      }
      try {
        const result = await bridge.keepAwakeSnapshot();
        if (!alive) return;
        if (result.ok) accept(result.value);
        else if (!snapshot) {
          readError = result.error;
          notify();
        }
      } catch (error) {
        if (alive && !snapshot) {
          readError = String(error?.message ?? error);
          notify();
        }
      }
    }
    function view(sessionId) {
      const session = sessionId
        ? (snapshot?.sessions?.find((s) => s.id === sessionId) ?? null)
        : null;
      const action = sessionId ? actions.get(sessionId) : null;
      const global = actions.get(null);
      return {
        snapshot,
        session,
        error:
          action?.error ??
          readError ??
          listenerError ??
          snapshot?.error ??
          null,
        defaultError:
          global?.error ??
          readError ??
          listenerError ??
          snapshot?.error ??
          null,
        pending: !!action?.pending,
        defaultPending: !!global?.pending,
      };
    }
    async function run(key, invoke, stillOwned = () => true) {
      if (!alive || actions.get(key)?.pending) return;
      const token = {};
      actions.set(key, { token, pending: true, error: null });
      notify();
      let result;
      try {
        result = await invoke();
      } catch (error) {
        result = { ok: false, error: String(error?.message ?? error) };
      }
      if (!alive || actions.get(key)?.token !== token) return;
      if (result?.ok) accept(result.value);
      actions.set(key, {
        token,
        pending: false,
        error:
          result?.ok || !stillOwned()
            ? null
            : (result?.error ?? "Request failed"),
      });
      notify();
    }
    return {
      start,
      view,
      setDefault: (enabled) =>
        run(null, () => bridge.setKeepAwakeDefault(enabled)),
      setSession: (id, enabled, stillOwned) => {
        if (!id || !snapshot?.sessions?.some((s) => s.id === id)) return;
        return run(
          id,
          () => bridge.setKeepAwakeSession(id, enabled),
          stillOwned,
        );
      },
      dispose() {
        alive = false;
        if (off) {
          off();
          off = null;
        }
        actions.clear();
      },
    };
  }
  window.OMP_KEEP_AWAKE = { create, status };
})();

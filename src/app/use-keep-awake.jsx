/* One subscription for Settings and the status bar; Rust owns activity. */
function useKeepAwake(bridge, sessionId) {
  const controller = React.useRef(null);
  const owner = React.useRef({ id: sessionId, generation: 0 });
  if (owner.current.id !== sessionId) {
    owner.current = { id: sessionId, generation: owner.current.generation + 1 };
  }
  const [, refresh] = React.useReducer((n) => n + 1, 0);
  React.useEffect(() => {
    if (!bridge) return undefined;
    const client = window.OMP_KEEP_AWAKE.create(bridge, refresh);
    controller.current = client;
    void client.start();
    return () => {
      controller.current = null;
      client.dispose();
    };
  }, [bridge]);
  const view = controller.current?.view(sessionId) ?? {
    snapshot: null,
    session: null,
    error: null,
    defaultError: null,
    pending: false,
    defaultPending: false,
  };
  const generation = owner.current.generation;
  return {
    ...view,
    setSession: (enabled) => {
      const current = () =>
        bridge?.activeSessionId === sessionId &&
        owner.current.id === sessionId &&
        owner.current.generation === generation;
      if (!sessionId || !current()) return;
      return controller.current?.setSession(sessionId, enabled, current);
    },
    setDefault: (enabled) => controller.current?.setDefault(enabled),
  };
}
window.useKeepAwake = useKeepAwake;

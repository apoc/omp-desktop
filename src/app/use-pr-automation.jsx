/* Per-tab PR automation: the controller owns polling and dispatch; this hook
   supplies current React state and redraws when its visible state changes. */
function usePrAutomation({
  bridge,
  tabId,
  sessions,
  runState,
  blocked,
  featureEnabled = true,
  connected = bridge?.isConnected ?? true,
}) {
  const [, redraw] = React.useState(0);
  const [visible, setVisible] = React.useState(
    window.document?.visibilityState !== "hidden",
  );
  const context = React.useRef(null);
  context.current = {
    bridge,
    tabId,
    sessions,
    runState,
    blocked,
    connected,
    featureEnabled,
    visible,
  };
  const controller = React.useRef(null);
  if (!controller.current) {
    controller.current = window.OMP_PR_AUTOMATION.createController({
      getContext: () => context.current,
      onChange: () => redraw((n) => n + 1),
    });
  }
  const automation = controller.current;
  React.useEffect(() => {
    automation.start();
    return () => automation.stop();
  }, [automation]);
  React.useEffect(() => {
    automation.sync();
  }, [
    automation,
    bridge,
    tabId,
    sessions,
    runState,
    blocked,
    connected,
    featureEnabled,
    visible,
  ]);
  React.useEffect(() => {
    const onFocus = () => automation.refresh();
    const onVisibilityChange = () => {
      const shown = window.document?.visibilityState !== "hidden";
      context.current.visible = shown;
      setVisible(shown);
      automation.sync();
      if (shown) automation.refresh();
    };
    window.addEventListener?.("focus", onFocus);
    window.document?.addEventListener("visibilitychange", onVisibilityChange);
    return () => {
      window.removeEventListener?.("focus", onFocus);
      window.document?.removeEventListener(
        "visibilitychange",
        onVisibilityChange,
      );
    };
  }, [automation]);
  return {
    ...automation.view(),
    toggle: automation.toggle,
    pause: automation.pause,
    refresh: automation.refresh,
  };
}

window.usePrAutomation = usePrAutomation;

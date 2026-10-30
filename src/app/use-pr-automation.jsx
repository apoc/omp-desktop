/* Per-tab PR automation: the controller owns polling and dispatch; this hook
   supplies current React state and redraws when its visible state changes.
   `railVisible`: the card's rail is on screen (layout not focus, not replaced
   by the tree or browser); with the window, it gates reads while Auto-fix is
   off. */
function usePrAutomation({
  bridge,
  tabId,
  sessionIds,
  runState,
  blocked,
  projectKey,
  branchKey = null,
  conversationKey = null,
  featureEnabled = true,
  connected = bridge?.isConnected ?? true,
  railVisible = true,
}) {
  const [, redraw] = React.useState(0);
  const [windowVisible, setWindowVisible] = React.useState(
    window.document?.visibilityState !== "hidden",
  );
  const visible = railVisible && windowVisible;
  const context = React.useRef(null);
  context.current = {
    bridge,
    tabId,
    sessionIds,
    runState,
    blocked,
    projectKey,
    connected,
    branchKey,
    conversationKey,
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
    sessionIds,
    runState,
    blocked,
    projectKey,
    connected,
    branchKey,
    conversationKey,
    featureEnabled,
    visible,
  ]);
  React.useEffect(() => {
    const onFocus = () => automation.refresh();
    const onVisibilityChange = () => {
      const shown = window.document?.visibilityState === "visible";
      setWindowVisible(shown);
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
    // `onFocusCapture` of the conversation: focus entering it from another
    // element refreshes the card. Moves inside it would each start a GitHub
    // read, and focus coming back from <body> (no relatedTarget, e.g. after
    // clicking transcript text) is not a return: window focus is the
    // listener above.
    onConversationFocus: (e) => {
      if (e.relatedTarget && !e.currentTarget.contains(e.relatedTarget))
        automation.refresh();
    },
  };
}

window.usePrAutomation = usePrAutomation;

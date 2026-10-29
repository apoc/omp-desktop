/* One native policy snapshot backs the Context card and Settings editor. */
function useContextPolicy({
  bridge,
  tabId,
  profileId,
  profileName,
  model,
  active,
  snapshot,
  processStartedAt,
  ctx,
}) {
  const owner = JSON.stringify([
    tabId,
    profileId,
    model?.provider,
    model?.id,
    processStartedAt,
  ]);
  const latest = React.useRef(owner);
  latest.current = owner;
  const refresh = React.useCallback(() => {
    if (!tabId || latest.current !== owner)
      return Promise.reject(
        new Error(
          "Open this profile's conversation to read its native policy.",
        ),
      );
    return bridge.readContextPolicy();
  }, [bridge, tabId, owner]);
  const apply = React.useCallback(
    (input) => {
      if (!tabId || latest.current !== owner)
        return Promise.reject(
          new Error("Conversation changed; reload its context policy."),
        );
      return bridge.setContextPolicy(input);
    },
    [bridge, tabId, owner],
  );
  React.useEffect(() => {
    if (active && tabId && bridge?.isConnected) void refresh().catch(() => {});
  }, [active, tabId, owner, bridge, refresh]);
  const mine =
    snapshot?.policy?.profileId === profileId &&
    (!snapshot.policy.supported ||
      !snapshot.policy.model ||
      (snapshot.policy.model.provider === model?.provider &&
        snapshot.policy.model.id === model?.id));
  return {
    policy: mine ? snapshot.policy : null,
    loading: !!tabId && !snapshot?.error && (!mine || snapshot?.loading),
    saving: mine && !!snapshot?.saving,
    error:
      snapshot?.error ||
      (!tabId
        ? "Open a conversation to edit its profile's native context policy."
        : null),
    profileName,
    ctx,
    onRefresh: refresh,
    onApply: apply,
  };
}
window.useContextPolicy = useContextPolicy;

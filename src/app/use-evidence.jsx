/* Native Evidence is authoritative; this hook owns UI requests, not the ledger. */
function useEvidence({
  bridge,
  tabId,
  profileId,
  projectPath,
  processStartedAt,
  conversationVersion,
  snapshot,
}) {
  const view = snapshot?.view ?? null;
  const base = JSON.stringify([
    tabId,
    profileId,
    processStartedAt,
    conversationVersion,
  ]);
  const identity = React.useRef({ base, native: null, generation: 0 });
  if (identity.current.base !== base)
    identity.current = { base, native: null, generation: 0 };
  const native = view?.sessionId
    ? `${view.epoch}:${view.sessionId}:${view.branchToken}`
    : null;
  if (native && identity.current.native && native !== identity.current.native)
    identity.current.generation++;
  if (native) identity.current.native = native;
  // First load must not close a just-opened inspector; actual owner changes do.
  const ownerKey = `${base}:${identity.current.generation}`;
  const latest = React.useRef(ownerKey);
  latest.current = ownerKey;
  const [libraryState, setLibraryState] = React.useState({
    owner: base,
    library: null,
    error: null,
  });
  const [operation, setOperation] = React.useState({
    owner: ownerKey,
    busy: false,
    error: null,
  });
  const pendingRequest = React.useRef(null);
  const check = React.useCallback(() => {
    if (
      !tabId ||
      latest.current !== ownerKey ||
      bridge.activeSessionId !== tabId
    )
      throw new Error("Conversation changed; reopen its Evidence inspector.");
  }, [bridge, tabId, ownerKey]);
  const refresh = React.useCallback(async () => {
    check();
    const result = await bridge.readEvidence();
    check();
    return result;
  }, [bridge, check]);
  const mutate = React.useCallback(
    async (input) => {
      check();
      const result = await bridge.changeEvidence(input);
      check();
      return result;
    },
    [bridge, check],
  );
  const loadLibrary = React.useCallback(async () => {
    check();
    try {
      const library = await bridge.evidenceLibrary(projectPath);
      check();
      setLibraryState({ owner: base, library, error: null });
      return library;
    } catch (error) {
      if (latest.current === ownerKey)
        setLibraryState((previous) => ({
          ...previous,
          owner: base,
          error: error.message,
        }));
      throw error;
    }
  }, [bridge, projectPath, base, check, ownerKey]);
  React.useEffect(() => {
    if (!tabId || !bridge.isConnected) return;
    void refresh().catch(() => {});
    void loadLibrary().catch(() => {});
  }, [tabId, ownerKey, bridge, refresh, loadLibrary]);
  React.useEffect(() => {
    const focused = () => {
      if (tabId && bridge.isConnected) void loadLibrary().catch(() => {});
    };
    window.addEventListener("focus", focused);
    return () => window.removeEventListener("focus", focused);
  }, [tabId, bridge, loadLibrary]);
  const library = libraryState.owner === base ? libraryState.library : null;
  const runLibrary = React.useCallback(
    async (action) => {
      check();
      setOperation({ owner: ownerKey, busy: true, error: null });
      try {
        const result = await action();
        check();
        await loadLibrary();
        return result;
      } catch (error) {
        if (latest.current === ownerKey)
          setOperation({ owner: ownerKey, busy: false, error: error.message });
        throw error;
      } finally {
        if (latest.current === ownerKey)
          setOperation((previous) => ({ ...previous, busy: false }));
      }
    },
    [check, loadLibrary, ownerKey],
  );
  const savePreset = React.useCallback(
    (preset) => {
      if (!library)
        return Promise.reject(
          new Error("Load the preset library before saving."),
        );
      const input = {
        id: preset.id || null,
        name: preset.name,
        planningPrompt: preset.planningPrompt,
        collectionPrompt: preset.collectionPrompt,
        assessmentPrompt: preset.assessmentPrompt,
        triggers: preset.triggers,
        tracking: preset.tracking,
        handoff: preset.handoff,
      };
      return runLibrary(() =>
        bridge.saveEvidencePreset(input, library.revision),
      );
    },
    [bridge, library, runLibrary],
  );
  const assignPreset = React.useCallback(
    (scope, presetId) => {
      if (!library)
        return Promise.reject(
          new Error("Load the preset library before changing defaults."),
        );
      return runLibrary(() =>
        bridge.assignEvidencePreset(
          scope,
          presetId,
          projectPath,
          library.revision,
        ),
      );
    },
    [bridge, projectPath, library, runLibrary],
  );
  const deletePreset = React.useCallback(
    (id) => {
      if (!library)
        return Promise.reject(
          new Error("Load the preset library before deleting a preset."),
        );
      return runLibrary(() =>
        bridge.deleteEvidencePreset(id, library.revision),
      );
    },
    [bridge, library, runLibrary],
  );
  const applyPreset = React.useCallback(
    (preset, source = "conversation") =>
      mutate({
        op: "policy",
        policy: { preset, source, project: projectPath || null },
        selection: source === "conversation" ? "conversation" : "inherit",
      }),
    [mutate, projectPath],
  );
  const useInheritedPreset = React.useCallback(async () => {
    const next = await loadLibrary();
    check();
    return mutate({
      op: "policy",
      policy: next.resolved,
      selection: "inherit",
    });
  }, [loadLibrary, check, mutate]);
  const request = React.useCallback(
    async (input) => {
      check();
      const key = JSON.stringify([
        ownerKey,
        input.outcomeId,
        input.requirementId,
        input.text,
      ]);
      if (!input.requestId && pendingRequest.current?.key !== key)
        pendingRequest.current = { key, id: `request-${crypto.randomUUID()}` };
      const requestId = input.requestId || pendingRequest.current.id;
      const result = await bridge.requestEvidence(
        input.requestId ? input : { ...input, newRequestId: requestId },
      );
      check();
      pendingRequest.current = null;
      return result;
    },
    [bridge, check, ownerKey],
  );
  const assetSource = React.useCallback(
    async (id) => {
      check();
      const asset = await bridge.evidenceAssetSource(id);
      check();
      return asset;
    },
    [bridge, check],
  );
  const assetText = React.useCallback(
    async (id) => {
      check();
      const result = await bridge.evidenceAssetText(id);
      check();
      return result;
    },
    [bridge, check],
  );
  const pickArtifact = React.useCallback(async () => {
    check();
    const artifact = await bridge.pickEvidenceArtifact();
    check();
    return artifact;
  }, [bridge, check]);
  return {
    ownerKey,
    profileId,
    projectPath,
    view,
    library,
    loading: !!snapshot?.loading || (!!tabId && !view && !snapshot?.error),
    saving:
      !!snapshot?.saving || (operation.owner === ownerKey && operation.busy),
    error:
      snapshot?.error ||
      (operation.owner === ownerKey ? operation.error : null) ||
      (!tabId ? "Open a conversation to collect evidence." : null),
    libraryError: libraryState.owner === base ? libraryState.error : null,
    refresh,
    mutate,
    request,
    loadLibrary,
    savePreset,
    deletePreset,
    assignPreset,
    applyPreset,
    useInheritedPreset,
    pickArtifact,
    assetSource,
    assetText,
  };
}
window.useEvidence = useEvidence;

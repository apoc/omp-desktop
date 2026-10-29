/* app/use-bridge-snapshot.jsx — custom hooks that decouple the App
   component from the cross-cutting effects:
   - useBridgeSnapshot:  subscribes to OMP_BRIDGE.onUpdate and routes the
                         snapshot fields into a setter map.
   - useThemeEffect:     reflects tweaks state onto <html> classes /
                         CSS custom properties. Shortcuts dispatch is handled
                         by useKeymapDispatch in app/use-keymap.jsx. */

const { NULL_MODEL: _UB_NULL_MODEL, DEFAULT_PROFILE_ID: _UB_DEFAULT_PROFILE_ID } = window;

function useBridgeSnapshot(bridge, setters) {
  React.useEffect(() => {
    if (!bridge) return undefined;
    const unsub = bridge.onUpdate((snap) => {
      setters.setMessages(snap.messages);
      setters.setStreaming(snap.isStreaming);
      setters.setAsyncPending(snap.asyncPending === true);
      setters.setCtx(snap.ctx);
      setters.setKanban(snap.kanban);
      setters.setPlanMeta(snap.planMeta);
      setters.setModels(snap.models);
      setters.setActivity(snap.activity);
      setters.setSparkline(snap.sparkline);
      setters.setModelState(snap.model || _UB_NULL_MODEL);
      if (snap.thinkingLevel) setters.setThinkingLevel(snap.thinkingLevel);
      setters.setSessions(snap.sessions ?? []);
      setters.setPromptHistory(snap.promptHistory ?? []);
      setters.setSubagents(snap.subagents);
      setters.setSubagentTranscripts(snap.subagentTranscripts ?? {});
      setters.setBackgroundTasks(snap.backgroundTasks ?? window.OMP_BACKGROUND_TASKS.empty());
      setters.setAgentContext(snap.agentContext);
      setters.setContextPolicy(snap.contextPolicy ?? null);
      setters.setQueue(snap.queue);
      setters.setQueueSending(snap.queueSending);
      setters.setGoal(snap.goal);
      setters.setExtWidgets(snap.extWidgets);
      setters.setLiveVoice(snap.liveVoice ?? null);
      setters.setDictation(snap.dictation ?? null);
      setters.setDictationCompleted(snap.dictationCompleted ?? []);
      setters.setProfiles(snap.profiles ?? []);
      setters.setStartupProfileId(snap.startupProfileId ?? _UB_DEFAULT_PROFILE_ID);
      setters.setRecentProjects(snap.recentProjects ?? []);
      setters.setNoTabProfileId(snap.noTabProfileId ?? _UB_DEFAULT_PROFILE_ID);
      setters.setWorkspaceNotes(snap.workspaceNotes ?? []);
      setters.setApprovalModes(snap.approvalModes ?? null);
      setters.setCloseConfirm(snap.closeConfirm ?? null);
      setters.setConversationSetup(snap.conversationSetup ?? null);
      if (snap.activeSessionId) setters.setActiveSessionId(snap.activeSessionId);
    });
    return unsub;
  }, [bridge]);
}

function useThemeEffect(t) {
  React.useEffect(() => {
    const root = document.documentElement;
    root.classList.remove("density-cozy", "density-compact", "density-dense");
    root.classList.add(`density-${t.density}`);
    if (t.monoChat) root.classList.add("mono-chat");
    else            root.classList.remove("mono-chat");
    // The accent override and its three derived tokens (app/accent.js), so
    // focus rings, glows and the xterm selection follow it. Cleared first:
    // an accent equal to the theme's own keeps the theme's hand-tuned set.
    window.OMP_ACCENT.applyThemeTokens(root, t.theme, t.accent);
    if (t.fontSize) root.style.fontSize = `${t.fontSize}%`;
  }, [t.theme, t.density, t.accent, t.monoChat, t.fontSize]);
}


Object.assign(window, { useBridgeSnapshot, useThemeEffect });

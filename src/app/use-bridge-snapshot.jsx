/* app/use-bridge-snapshot.jsx — custom hooks that decouple the App
   component from the cross-cutting effects:
   - useBridgeSnapshot:  subscribes to OMP_BRIDGE.onUpdate and routes the
                         snapshot fields into a setter map.
   - useThemeEffect:     reflects tweaks state onto <html> classes /
                         CSS custom properties.
   - useCommandShortcut: ⌘K / ⌃K toggles the command bridge; Escape closes
                         it. Centralised here so app-live.jsx only owns
                         render + handlers.
   - useHistoryShortcut: ⌘H / ⌃H toggles the conversation-history modal. */

const { NULL_MODEL: _UB_NULL_MODEL, DEFAULT_PROFILE_ID: _UB_DEFAULT_PROFILE_ID } = window;

function useBridgeSnapshot(bridge, setters) {
  React.useEffect(() => {
    if (!bridge) return undefined;
    const unsub = bridge.onUpdate((snap) => {
      setters.setMessages(snap.messages);
      setters.setStreaming(snap.isStreaming);
      setters.setCtx(snap.ctx);
      setters.setKanban(snap.kanban);
      setters.setPlanMeta(snap.planMeta);
      setters.setModels(snap.models);
      setters.setActivity(snap.activity);
      setters.setSparkline(snap.sparkline);
      setters.setModelState(snap.model || _UB_NULL_MODEL);
      if (snap.thinkingLevel) setters.setThinkingLevel(snap.thinkingLevel);
      setters.setSessions(snap.sessions ?? []);
      setters.setProfiles(snap.profiles ?? []);
      setters.setStartupProfileId(snap.startupProfileId ?? _UB_DEFAULT_PROFILE_ID);
      if (snap.activeSessionId) setters.setActiveSessionId(snap.activeSessionId);
    });
    return unsub;
  }, [bridge]);
}

function useThemeEffect(t) {
  React.useEffect(() => {
    const root = document.documentElement;
    root.classList.remove("theme-aurora", "theme-phosphor", "theme-daylight");
    root.classList.add(`theme-${t.theme}`);
    root.classList.remove("density-cozy", "density-compact", "density-dense");
    root.classList.add(`density-${t.density}`);
    if (t.monoChat) root.classList.add("mono-chat");
    else            root.classList.remove("mono-chat");
    if (t.accent)   root.style.setProperty("--accent", t.accent);
    if (t.fontSize) root.style.fontSize = `${t.fontSize}%`;
  }, [t.theme, t.density, t.accent, t.monoChat, t.fontSize]);
}

function useCommandShortcut(setBridgeOpen, setBridgeView) {
  React.useEffect(() => {
    const onKey = (e) => {
      if (e.key === "k" && (e.metaKey || e.ctrlKey)) {
        e.preventDefault();
        setBridgeOpen((v) => {
          if (!v) setBridgeView("commands");
          return !v;
        });
      }
      if (e.key === "Escape") setBridgeOpen(false);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [setBridgeOpen, setBridgeView]);
}

function useHistoryShortcut(setHistoryOpen) {
  React.useEffect(() => {
    const onKey = (e) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "h") {
        e.preventDefault();
        setHistoryOpen((v) => !v);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [setHistoryOpen]);
}

Object.assign(window, { useBridgeSnapshot, useThemeEffect, useCommandShortcut, useHistoryShortcut });

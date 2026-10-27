// Preferences and display-only tab names for the native all-tab tracker.
// Never derive notifications from replayed frontend messages or run-state polling.
function useNotifications({ sessions, viewedSession, tweaks }) {
  const last = React.useRef("");
  const finished = tweaks.notifyFinished === true;
  const questions = tweaks.notifyQuestions === true;
  React.useEffect(() => {
    const invoke = window.__TAURI__?.core?.invoke;
    if (!invoke) return;
    const configuration = {
      finished,
      questions,
      viewedSession: viewedSession || null,
      tabs: sessions.map((session) => ({
        id: session.id,
        title: session.name || "New conversation",
      })),
    };
    const key = JSON.stringify(configuration);
    if (last.current === key) return;
    last.current = key;
    invoke("desktop_notifications_configure", { configuration }).catch(
      (error) => {
        if (last.current === key) last.current = "";
        console.warn(
          "[notifications] could not configure desktop notifications:",
          error,
        );
      },
    );
  }, [sessions, viewedSession, finished, questions]);
}

window.useNotifications = useNotifications;

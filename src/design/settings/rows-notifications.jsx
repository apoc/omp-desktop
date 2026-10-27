// Local desktop alerts are independent of Remote access's phone Web Push.
function _SRN_DesktopNotifications({ row, ctx, query, modified, onReset }) {
  const {
    SettingsRow: Row,
    SettingsToggle: Toggle,
    SettingsMark: Mark,
  } = window;
  const [permission, setPermission] = React.useState(null);
  const [pending, setPending] = React.useState(false);
  const [error, setError] = React.useState("");
  const busy = React.useRef(false);
  const sequence = React.useRef(0);
  const invoke = (request) => {
    const native = window.__TAURI__?.core?.invoke;
    if (!native)
      return Promise.reject(
        new Error("Desktop notifications are available in the installed app."),
      );
    return native("desktop_notifications_permission", { request });
  };
  React.useEffect(() => {
    let live = true;
    const refresh = () => {
      if (busy.current) return;
      const seq = ++sequence.current;
      invoke(false).then(
        (value) => {
          if (live && seq === sequence.current) setPermission(value);
        },
        (failure) => {
          if (live && seq === sequence.current) setError(String(failure));
        },
      );
    };
    refresh();
    window.addEventListener("focus", refresh);
    return () => {
      live = false;
      sequence.current++;
      window.removeEventListener("focus", refresh);
    };
  }, []);
  const set = async (key, enabled) => {
    if (busy.current) return;
    setError("");
    if (!enabled) {
      ctx.setTweak(key, false);
      return;
    }
    const seq = ++sequence.current;
    busy.current = true;
    setPending(true);
    try {
      const result = await invoke(true);
      if (sequence.current !== seq) return;
      setPermission(result);
      // Do not save an enabled preference when the OS declined authorization.
      if (result === "granted") ctx.setTweak(key, true);
    } catch (failure) {
      if (sequence.current === seq) setError(String(failure));
    } finally {
      busy.current = false;
      setPending(false);
    }
  };
  const reset = () => {
    sequence.current++;
    onReset();
  };
  const denied = permission === "denied";
  return (
    <Row
      label={row.label}
      desc={row.desc}
      query={query}
      modified={modified}
      onReset={reset}
      stack
    >
      <div className="st-rem" aria-busy={pending}>
        {[
          ["notifyFinished", "Conversation finished"],
          ["notifyQuestions", "User input needed"],
        ].map(([key, label]) => (
          <div className="st-rem-line" key={key}>
            <span className="st-rem-lbl">
              <Mark text={label} query={query} />
            </span>
            <Toggle
              value={ctx.t[key] === true}
              label={label}
              disabled={pending}
              onChange={(value) => set(key, value)}
            />
          </div>
        ))}
        <div className={denied ? "st-rem-warn" : "st-rem-status"} role="status">
          {pending
            ? "Waiting for notification permission…"
            : denied
              ? "Notifications are blocked. Allow OMP Desktop in System Settings → Notifications, then enable the switch again. The OS will not show the permission popup again after a denial."
              : permission === "prompt"
                ? "macOS will ask for notification permission when you enable either switch."
                : "System notification settings and Focus / Do Not Disturb also control whether banners appear."}
        </div>
        {error && (
          <div className="st-row-error" role="alert">
            {error}
          </div>
        )}
      </div>
    </Row>
  );
}

Object.assign((window.OMP_SETTINGS_ROWS = window.OMP_SETTINGS_ROWS || {}), {
  desktopNotifications: _SRN_DesktopNotifications,
});

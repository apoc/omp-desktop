/* ═════════════════════════════════════════════════════════════════════
   design/settings/rows-persona.jsx — Settings → Persona
   (window.OMP_SETTINGS_ROWS):
     personaEnable        start/stop the login service
     personaSchedule      interval, quiet hours, quiet weekends
     personaBudget        the daily token limit and today's use
     personaInstructions  open the service's instructions file

   The service owns `persona/settings.json`; every row shows
   `personaStatus()` (read on mount, refreshed on `persona://status`) and
   saves by sending the COMPLETE settings object to `personaSettings`.
   Each change validates with `OMP_PERSONA.validateSettings`; overlapping
   saves run one by one through a single queue and start from the newest
   settings that were sent or reported.
   ═════════════════════════════════════════════════════════════════════ */

// Settings are sent whole, so a change must not start from a stale copy.
// One shared status/settings pair and one queue serve all four rows.
let _PR_bridge = null;
let _PR_status = null;
let _PR_settings = null;
let _PR_queue = Promise.resolve();
const _PR_subs = new Set();
let _PR_stop = null;
let _PR_connecting = null;

function _PR_publish(status) {
  _PR_status = status;
  if (status?.settings) _PR_settings = status.settings;
  else if (!status) _PR_settings = null;
  for (const sub of _PR_subs) sub(status);
}

function _PR_retain(bridge, setStatus) {
  if (_PR_bridge !== bridge) {
    _PR_stop?.();
    _PR_stop = null;
    _PR_connecting = null;
    _PR_bridge = bridge;
    _PR_status = null;
    _PR_settings = null;
  }
  _PR_subs.add(setStatus);
  if (_PR_status) setStatus(_PR_status);
  if (!_PR_stop && !_PR_connecting && bridge) {
    let statusSeen = false;
    const myBridge = bridge;
    _PR_connecting = Promise.resolve(bridge.onPersona("status", value => {
      if (_PR_bridge === myBridge) {
        statusSeen = true;
        _PR_publish(value ?? null);
      }
    })).then(unlisten => {
      _PR_connecting = null;
      if (_PR_bridge === myBridge && _PR_subs.size > 0) _PR_stop = unlisten;
      else unlisten?.();
    }).then(() => (_PR_bridge === myBridge ? bridge.personaStatus() : null)).then(value => {
      if (_PR_bridge === myBridge && !statusSeen) _PR_publish(value ?? null);
    });
  }
  return () => {
    _PR_subs.delete(setStatus);
    if (_PR_subs.size === 0 && _PR_stop) {
      _PR_stop();
      _PR_stop = null;
    }
  };
}

/** The service status for one row, plus `apply(patch)`: merge into the newest
 *  settings inside the shared queue and send them whole. A refused value
 *  keeps the old settings and reports the validation message. */
function _PR_usePersona(bridge) {
  const [status, setStatus] = React.useState(_PR_bridge === bridge ? _PR_status : null);
  const [error, setError] = React.useState(null);
  React.useEffect(() => _PR_retain(bridge, setStatus), [bridge]);
  const apply = React.useCallback(patch => {
    const next = _PR_queue.then(async () => {
      const base = _PR_settings ?? _PR_status?.settings;
      if (!base) {
        setError(OMP_TR("Enable Ompy to change these."));
        return false;
      }
      const merged = { ...base, ...(typeof patch === "function" ? patch(base) : patch) };
      const check = window.OMP_PERSONA.validateSettings(merged);
      if (!check.ok) {
        setError(check.message);
        return false;
      }
      const result = await bridge.personaSettings(check.value);
      if (result?.ok === false) {
        setError(result.error || OMP_TR("Could not save the setting."));
        return false;
      }
      setError(null);
      // The next change starts from what was just sent, even before the
      // service's status broadcast lands.
      _PR_settings = check.value;
      return true;
    });
    _PR_queue = next.catch(() => {});
    return next;
  }, [bridge]);
  return { status, error, apply, setError };
}

/** Text/number field committed on blur or Enter; re-syncs when the saved
 *  value changes. `onCommit` returning `false` rejects the text and the field
 *  shows the saved value again. */
function _PR_Field({ value, onCommit, label, type = "text", min, max, step, width, disabled, placeholder }) {
  const [text, setText] = React.useState(value);
  React.useEffect(() => setText(value), [value]);
  const commit = () => {
    if (text === value) return;
    if (onCommit(text) === false) setText(value);
  };
  return (
    <input className="st-rem-input" type={type} value={text} aria-label={OMP_TR(label)}
      placeholder={placeholder} spellCheck={false} disabled={disabled}
      min={min} max={max} step={step}
      style={{ width, fontFamily: type === "text" ? undefined : "inherit" }}
      onChange={e => setText(e.target.value)} onBlur={commit}
      onKeyDown={e => {
        // Enter confirms an IME candidate; only a plain Enter commits.
        if (e.key !== "Enter" || e.nativeEvent?.isComposing || e.keyCode === 229) return;
        e.currentTarget.blur();
      }} />
  );
}

function _PR_Line({ label, children }) {
  return <div className="st-rem-line"><span className="st-rem-lbl">{OMP_TR(label)}</span>{children}</div>;
}

function _PR_Enable({ row, ctx, query }) {
  const Row = window.SettingsRow;
  const Toggle = window.SettingsToggle;
  const { status, error, setError } = _PR_usePersona(ctx.bridge);
  // Enable answers before the service's status does; the toggle keeps the
  // user's intent until a status either confirms or contradicts it.
  const [pending, setPending] = React.useState(null);
  const [busy, setBusy] = React.useState(false);
  React.useEffect(() => {
    setPending(value => (value === null || !!status === value ? null : value));
  }, [status]);
  const toggle = enable => {
    if (busy) return;
    setBusy(true);
    setError(null);
    Promise.resolve(enable ? ctx.bridge.personaEnable() : ctx.bridge.personaDisable())
      .then(result => {
        if (result?.ok === false) {
          setError(result.error || OMP_TR("Could not change the Ompy service."));
          return;
        }
        setPending(enable);
      }, err => setError(err?.message ?? String(err)))
      .finally(() => setBusy(false));
  };
  return (
    <Row label={row.label} desc={row.desc} query={query}>
      <Toggle value={pending ?? !!status} onChange={toggle} label={row.label} disabled={busy} />
      {error && <div className="st-row-error">{error}</div>}
    </Row>
  );
}

function _PR_Schedule({ row, ctx, query }) {
  const Row = window.SettingsRow;
  const Toggle = window.SettingsToggle;
  const { status, error, apply, setError } = _PR_usePersona(ctx.bridge);
  const settings = status?.settings;
  const offline = !settings;
  // Validate against the newest settings before queueing, so a refused value
  // makes `_PR_Field` show the saved one again instead of waiting a round trip.
  const commit = value => {
    const base = _PR_settings ?? settings;
    if (!base) return false;
    const patch = typeof value === "function" ? value(base) : value;
    const check = window.OMP_PERSONA.validateSettings({ ...base, ...patch });
    if (!check.ok) {
      setError(check.message);
      return false;
    }
    apply(patch);
    return true;
  };
  const commitInterval = text => {
    const n = Number(text);
    return commit({ intervalMin: text.trim() === "" ? NaN : n });
  };
  const commitQuiet = field => text => commit({ [field]: text.trim() });
  return (
    <Row label={row.label} desc={row.desc} query={query} stack>
      <div className="st-rem">
        <_PR_Line label="Interval">
          <_PR_Field type="number" min={5} max={1440} step={1} width={90}
            value={String(settings?.intervalMin ?? "")} label="Interval in minutes"
            disabled={offline} onCommit={commitInterval} />
          <span className="st-rem-sub">{OMP_TR("minutes")}</span>
        </_PR_Line>
        <_PR_Line label="Quiet hours">
          <_PR_Field width={80} value={settings?.quietStart ?? ""} label="Quiet hours from"
            placeholder="20:00" disabled={offline} onCommit={commitQuiet("quietStart")} />
          <span className="st-rem-sub">{OMP_TR("to")}</span>
          <_PR_Field width={80} value={settings?.quietEnd ?? ""} label="Quiet hours to"
            placeholder="07:00" disabled={offline} onCommit={commitQuiet("quietEnd")} />
        </_PR_Line>
        <_PR_Line label="Quiet on weekends">
          <Toggle value={!!settings?.quietWeekends} label="Quiet on weekends" disabled={offline}
            onChange={value => apply({ quietWeekends: value })} />
        </_PR_Line>
        {offline && <div className="st-rem-note">{OMP_TR("Enable Ompy to change these.")}</div>}
        {error && <div className="st-rem-status err">{error}</div>}
      </div>
    </Row>
  );
}

function _PR_Budget({ row, ctx, query }) {
  const Row = window.SettingsRow;
  const { status, error, apply, setError } = _PR_usePersona(ctx.bridge);
  const settings = status?.settings;
  const offline = !settings;
  const commit = text => {
    const base = _PR_settings ?? settings;
    if (!base) return false;
    const patch = { dailyTokenLimit: text.trim() === "" ? NaN : Number(text) };
    const check = window.OMP_PERSONA.validateSettings({ ...base, ...patch });
    if (!check.ok) {
      setError(check.message);
      return false;
    }
    apply(patch);
    return true;
  };
  return (
    <Row label={row.label} desc={row.desc} query={query} stack>
      <div className="st-rem">
        <_PR_Line label="Daily token limit">
          <_PR_Field type="number" min={100_000} max={1_000_000_000} step={100_000} width={160}
            value={String(settings?.dailyTokenLimit ?? "")} label="Daily token limit"
            disabled={offline} onCommit={commit} />
        </_PR_Line>
        <div className="st-rem-status">
          {status
            ? OMP_TR("Used today: {used}", { used: window.OMP_PERSONA.compactTokens(status.tokensToday ?? 0) })
            : OMP_TR("Enable Ompy to change these.")}
        </div>
        {error && <div className="st-rem-status err">{error}</div>}
      </div>
    </Row>
  );
}

function _PR_Instructions({ row, ctx, query }) {
  const Row = window.SettingsRow;
  const Btn = window.SettingsButton;
  const { status } = _PR_usePersona(ctx.bridge);
  const [busy, setBusy] = React.useState(false);
  const [error, setError] = React.useState(null);
  const open = () => {
    if (busy || !ctx.bridge?.personaOpenInstructions) return;
    setBusy(true);
    setError(null);
    Promise.resolve(ctx.bridge.personaOpenInstructions())
      .then(result => {
        if (result?.ok === false) setError(result.error || OMP_TR("Could not open the instructions file."));
      }, err => setError(err?.message ?? String(err)))
      .finally(() => setBusy(false));
  };
  return (
    <Row label={row.label} desc={row.desc} query={query} stack>
      <div className="st-rem">
        <div className="st-btns">
          <Btn onClick={open} disabled={!status || busy}>{OMP_TR("Open instructions file")}</Btn>
        </div>
        {!status && <div className="st-rem-note">{OMP_TR("Enable Ompy to change these.")}</div>}
        {error && <div className="st-rem-status err">{error}</div>}
      </div>
    </Row>
  );
}

Object.assign(window.OMP_SETTINGS_ROWS = window.OMP_SETTINGS_ROWS || {}, {
  personaEnable: _PR_Enable,
  personaSchedule: _PR_Schedule,
  personaBudget: _PR_Budget,
  personaInstructions: _PR_Instructions,
});

/* ═════════════════════════════════════════════════════════════════════
   design/settings/rows-remote-phones.jsx — Phones and Notifications rows
   of Settings → Remote access (window.OMP_SETTINGS_ROWS):
     remotePair     one-time QR code dialog
     remoteDevices  paired phones: rename, revoke (asks first)
     remotePush     Web Push: triggers, only-while-locked, VAPID contact, test notification
   The QR is an <img> of the SVG as a data URL — never injected as HTML.
   Depends on `rows-remote-shared.jsx` (`_SRR_Icon`, `_SRR_useRemote`,
   `_SRR_useAsync`, `_SRR_Field`, `_SRR_Line`).
   ═════════════════════════════════════════════════════════════════════ */

/** Seconds left until `expiresAt` (unix seconds), never negative. */
const _SRR_left = (expiresAt, now) => Math.max(0, Math.ceil(expiresAt - now / 1000));

function _SRR_PairDialog({ pair, active = true, onClose }) {
  const [now, setNow] = React.useState(Date.now());
  const onCloseRef = React.useRef(onClose);
  onCloseRef.current = onClose;
  React.useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 1000);
    const onKey = e => { if (e.key === "Escape") { e.stopPropagation(); onCloseRef.current(); } };
    if (active) window.addEventListener("keydown", onKey, true);
    return () => { clearInterval(t); window.removeEventListener("keydown", onKey, true); };
  }, [active]);
  const left = _SRR_left(pair.expiresAt, now);
  const src = `data:image/svg+xml;base64,${btoa(unescape(encodeURIComponent(pair.svg)))}`;
  return (
    <div className="bridge-scrim" onClick={onClose} style={{ paddingTop: "12vh" }}>
      <div className="st-rem-dialog" role="dialog" aria-label="Pair a phone" data-st-esc="" onClick={e => e.stopPropagation()}>
        <div className="st-rem-dialog-head">
          <span>Pair a phone</span>
          <button type="button" className="st-ghost" onClick={onClose} title="close"><_SRR_Icon name="close" size={11} /></button>
        </div>
        {left > 0 ? (
          <>
            <img className="st-rem-qr" src={src} alt="Pairing QR code" width={240} height={240} />
            <div className="st-path">{pair.url}</div>
            <div className="st-rem-status">Scan with the phone camera · valid {left}s · one use</div>
          </>
        ) : <div className="st-rem-status err">The code expired. Close this dialog and pair again.</div>}
      </div>
    </div>
  );
}

function _SRR_Pair({ row, ctx, query }) {
  const Row = window.SettingsRow, Btn = window.SettingsButton;
  const { status } = _SRR_useRemote(ctx.bridge);
  const [{ pair, error, busy }, setState] = React.useState({ pair: null, error: null, busy: false });
  const patch = React.useCallback(p => setState(s => ({ ...s, ...p })), []);
  const base = React.useRef(0);
  const count = status?.devices?.length ?? 0;
  const liveRef = React.useRef(true);
  const pairing = React.useRef(false);
  const close = React.useCallback(() => { pairing.current = false; patch({ pair: null }); void ctx.bridge.remotePairCancel(); }, [ctx.bridge, patch]);
  React.useEffect(() => {
    liveRef.current = true;
    return () => {
      liveRef.current = false;
      if (pairing.current) { pairing.current = false; void ctx.bridge.remotePairCancel(); }
    };
  }, [ctx.bridge]);
  // A new device while the dialog is up means the code was used.
  React.useEffect(() => { if (pair && count > base.current) { pairing.current = false; patch({ pair: null }); } }, [count, pair, patch]);
  const start = async () => {
    if (pairing.current) return;
    pairing.current = true;
    patch({ busy: true });
    try {
      const r = await ctx.bridge.remotePairStart();
      if (!liveRef.current) { if (r?.ok !== false) void ctx.bridge.remotePairCancel(); return; }
      if (r?.ok === false) { pairing.current = false; patch({ error: r.error ?? "failed" }); return; }
      base.current = count;
      patch({ pair: r.value, error: null });
    } finally {
      if (liveRef.current) patch({ busy: false });
    }
  };
  return (
    <Row label={row.label} desc={row.desc} query={query}>
      <Btn accent onClick={start} disabled={!status?.listening || busy || !!pair}
        title={status?.listening ? undefined : "Enable remote access first"}>Pair a phone…</Btn>
      {pair && <_SRR_PairDialog pair={pair} active={ctx.active !== false} onClose={close} />}
      {error && <div className="st-row-error">{error}</div>}
    </Row>
  );
}

function _SRR_Device({ device, onRename, onRevoke }) {
  const Btn = window.SettingsButton;
  const [asking, setAsking] = React.useState(false);
  return (
    <div className="st-rem-dev">
      <_SRR_Field value={device.name} label="Device name" mono={false} width={220} onCommit={text => text.trim() && onRename(device.id, text.trim())} />
      <span className="st-rem-sub">{device.connected ? "connected" : "offline"}{device.pushSubscribed ? " · push" : ""}</span>
      <div className="st-btns" style={{ marginLeft: "auto" }}>
        {asking ? (
          <>
            <Btn accent onClick={() => { setAsking(false); onRevoke(device.id); }}>Confirm revoke</Btn>
            <Btn onClick={() => setAsking(false)}>Keep</Btn>
          </>
        ) : <Btn onClick={() => setAsking(true)}>Revoke</Btn>}
      </div>
    </div>
  );
}

function _SRR_Devices({ row, ctx, query }) {
  const Row = window.SettingsRow;
  const { status, error, run } = _SRR_useRemote(ctx.bridge);
  const devices = status?.devices ?? [];
  return (
    <Row label={row.label} desc={row.desc} query={query} stack>
      <div className="st-rem">
        {devices.length === 0 && <div className="st-rem-status">No phone paired yet.</div>}
        {devices.map(d => (
          <_SRR_Device key={d.id} device={d}
            onRename={(id, name) => run(() => ctx.bridge.remoteDeviceRename(id, name))}
            onRevoke={id => run(() => ctx.bridge.remoteDeviceRevoke(id))} />
        ))}
        {error && <div className="st-row-error">{error}</div>}
      </div>
    </Row>
  );
}

function _SRR_Push({ row, ctx, query }) {
  const Row = window.SettingsRow, Toggle = window.SettingsToggle, Btn = window.SettingsButton;
  const { status, error, apply, run } = _SRR_useRemote(ctx.bridge);
  const push = status?.settings?.push;
  // Prefill an empty contact once from git; the user still has to save it.
  const suggest = _SRR_useAsync(() => ctx.bridge.remoteDefaultContact(), "", [ctx.bridge]);
  const contact = push?.contact || suggest;
  const set = (patch) => apply({ push: patch });
  const generated = status?.settings?.cert?.kind !== "files";
  return (
    <Row label={row.label} desc={row.desc} query={query} stack>
      <div className="st-rem">
        <_SRR_Line label="Enable push">
          <Toggle value={!!push?.enabled} label="Enable push notifications"
            onChange={v => apply(base => ({ push: v ? { enabled: true, contact: (base.push?.contact || suggest).trim() } : { enabled: false } }))} />
        </_SRR_Line>
        <_SRR_Line label="A question is waiting">
          <Toggle value={!!push?.questions} label="Notify on questions" onChange={v => set({ questions: v })} />
        </_SRR_Line>
        <_SRR_Line label="A turn finished">
          <Toggle value={!!push?.finished} label="Notify on finished turns" onChange={v => set({ finished: v })} />
        </_SRR_Line>
        {status?.lockDetection && (
          <_SRR_Line label="Only while the desktop is locked">
            <Toggle value={!!push?.onlyWhenLocked} label="Notify only while the desktop is locked" onChange={v => set({ onlyWhenLocked: v })} />
          </_SRR_Line>
        )}
        <_SRR_Line label="Contact (VAPID)">
          <_SRR_Field value={contact} label="Push contact" placeholder="you@example.com" width={240} disabled={!push}
            onCommit={text => set({ contact: text.trim() })} />
        </_SRR_Line>
        {generated && (
          <div className="st-rem-warn">Push needs a certificate the phone trusts. A generated certificate is not trusted by default; use your own files.</div>
        )}
        <div className="st-btns">
          <Btn onClick={() => run(() => ctx.bridge.remotePushTest())} disabled={!push?.enabled}>Send test notification</Btn>
        </div>
        {status?.pushError && <div className="st-row-error">{status.pushError}</div>}
        {error && <div className="st-row-error">{error}</div>}
      </div>
    </Row>
  );
}

Object.assign(window.OMP_SETTINGS_ROWS = window.OMP_SETTINGS_ROWS || {}, {
  remotePair: _SRR_Pair,
  remoteDevices: _SRR_Devices,
  remotePush: _SRR_Push,
});

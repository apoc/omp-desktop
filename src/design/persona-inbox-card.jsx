/* ═════════════════════════════════════════════════════════════════════
   persona-inbox-card.jsx — Ompy's Inbox in the rail: what waits for the
   human (approvals, decisions), the newest results, and the wake-ups the
   service has queued.

   Shown on every tab while Settings → Rail "Inbox" is on and the service is
   connected; a null `status` renders nothing at all, so an offline
   service leaves no empty card behind. Answers go through `personaResolve`
   (`answerOptions` from app/persona.js); a secret input's value is only
   ever sent, never shown again. The schedule comes from `personaSchedule`
   (`list_schedule`) and is ordered by `scheduleView`.
   ═════════════════════════════════════════════════════════════════════ */

const _PI_TICK_MS = 30_000;
const _PI_SCHEDULE_MS = 60_000;

function PersonaInboxCard({ status, items, bridge }) {
  window.OMP_I18N.useLocale();
  const [now, setNow] = React.useState(() => Date.now());
  const [schedule, setSchedule] = React.useState(null);
  // One request at a time: a second click would race the first reply.
  const [busy, setBusy] = React.useState(null);
  const [failure, setFailure] = React.useState(null);
  // Free-text drafts by item id. A secret draft lives here only until it is
  // sent; nothing renders it back.
  const [drafts, setDrafts] = React.useState({});

  React.useEffect(() => {
    if (!status) return undefined;
    const timer = setInterval(() => setNow(Date.now()), _PI_TICK_MS);
    return () => clearInterval(timer);
  }, [status]);

  // A status broadcast follows every schedule change, and the timer covers
  // one omp queued through its own tool while nothing else changed.
  React.useEffect(() => {
    if (!status || !bridge?.personaSchedule) return undefined;
    let live = true;
    const load = () => Promise.resolve(bridge.personaSchedule()).then(result => {
      if (live && result?.ok) setSchedule(result.value ?? null);
    }, () => {});
    load();
    const timer = setInterval(load, _PI_SCHEDULE_MS);
    return () => { live = false; clearInterval(timer); };
  }, [bridge, status]);

  if (!status) return null;

  const t = window.OMP_I18N.t;
  const view = window.OMP_PERSONA.inboxView(items);
  const sched = window.OMP_PERSONA.scheduleView(schedule, status);
  const relative = at => window.OMP_WIDGETS.relativeTime(at, now);

  const settle = (item, answerValue) => {
    if (busy || !bridge?.personaResolve) return;
    setBusy(item.id);
    setFailure(null);
    Promise.resolve(bridge.personaResolve(item.id, answerValue))
      .then(result => {
        if (result?.ok === false) {
          setFailure(t("failed: {error}", { error: result.error || t("unknown error") }));
          return;
        }
        setDrafts(current => {
          const next = { ...current };
          delete next[item.id];
          return next;
        });
      }, err => setFailure(t("failed: {error}", { error: err?.message ?? String(err) })))
      .finally(() => setBusy(null));
  };

  const send = item => {
    const text = (drafts[item.id] ?? "").trim();
    if (text) settle(item, text);
  };

  const item = entry => {
    const options = window.OMP_PERSONA.answerOptions(entry);
    const draft = drafts[entry.id] ?? "";
    return (
      <div className="persona-inbox-item" key={entry.id}>
        <div className="persona-inbox-title">{entry.title}</div>
        {entry.body && (entry.kind === "approval"
          ? <pre className="ask-approval-details persona-inbox-details">{entry.body}</pre>
          : <div className="persona-inbox-body">{entry.body}</div>)}
        {options.length > 0 ? (
          <div className="persona-inbox-actions">
            {options.map(option => (
              <button type="button" key={option.value} className="btn outlined persona-inbox-btn" disabled={!!busy}
                onClick={() => settle(entry, option.value)}>
                {OMP_TR(option.label)}
              </button>
            ))}
          </div>
        ) : entry.kind === "decision" ? (
          <div className="persona-inbox-answer">
            <input type={entry.secret ? "password" : "text"} className="persona-inbox-input"
              value={draft} disabled={!!busy} autoComplete="off" spellCheck={false}
              aria-label={OMP_TR(entry.secret ? "Secret answer" : "Answer")}
              placeholder={OMP_TR("Type your answer")}
              onChange={e => setDrafts(current => ({ ...current, [entry.id]: e.target.value }))}
              onKeyDown={e => {
                // Enter confirms an IME candidate; only a plain Enter sends.
                if (e.key !== "Enter" || e.nativeEvent?.isComposing || e.keyCode === 229) return;
                send(entry);
              }} />
            <button type="button" className="btn outlined persona-inbox-btn"
              disabled={!!busy || draft.trim() === ""} onClick={() => send(entry)}>
              {OMP_TR("Send")}
            </button>
          </div>
        ) : null}
        <button type="button" className="persona-inbox-dismiss" disabled={!!busy}
          onClick={() => settle(entry, null)}>
          {OMP_TR("Dismiss")}
        </button>
      </div>
    );
  };

  return (
    <section className="rail-card glass persona-inbox" aria-label={OMP_TR("Inbox")}>
      <div className="rail-card-head">
        <window.Icon name="conversation" size={11} color="var(--accent)" />
        <span className="mono" style={{ color: "var(--fg-2)" }}>{OMP_TR("Inbox")}</span>
        <span className="chip muted mono persona-inbox-count">{OMP_TR("{n} open", { n: view.badge })}</span>
      </div>
      {view.open.length === 0 && <p className="persona-inbox-empty">{OMP_TR("Nothing waiting.")}</p>}
      {view.open.map(entry => item(entry))}

      {view.results.length > 0 && (
        <>
          <div className="persona-inbox-sub">{OMP_TR("Recent")}</div>
          {view.results.map(result => (
            <div className="persona-inbox-result" key={result.id}>
              <span className="persona-inbox-result-title">{result.title}</span>
              <span className="persona-inbox-time">{relative(result.createdAt)}</span>
              <button type="button" className="persona-inbox-dismiss" disabled={!!busy}
                onClick={() => settle(result, null)}>
                {OMP_TR("Dismiss")}
              </button>
            </div>
          ))}
        </>
      )}

      {sched.entries.length > 0 && (
        <>
          <div className="persona-inbox-sub">{OMP_TR("Scheduled")}</div>
          {sched.entries.map(entry => (
            <div className="persona-inbox-scheduled" key={entry.id || `${entry.kind}:${entry.atMs}`}>
              <span className="persona-inbox-result-title">{entry.label}</span>
              <span className="persona-inbox-time">{relative(entry.atMs)}</span>
            </div>
          ))}
        </>
      )}

      {failure && <div className="persona-failure" role="status">{failure}</div>}
    </section>
  );
}

Object.assign(window, { PersonaInboxCard });

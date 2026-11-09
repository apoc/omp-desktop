/* queue-strip.jsx — the steers and follow-ups omp holds for the agent,
   above the composer. One row per message, from omp's own queue snapshot
   (app/message-queue.js) plus "sending" rows omp has not acknowledged
   yet. ⚡ (while the agent works) stops the current step so the message
   goes in at once, ↑ turns a follow-up into a steer, ✎ takes a message
   back into the prompt box, ✕ removes it. Every action is omp's: a row
   only goes away with omp's next queue snapshot, and `false` from the
   bridge means the message was already delivered. composer.jsx re-keys
   this per tab. */

const { Icon: _QS_Icon } = window;
const { rows: _QS_rows } = window.OMP_QUEUE;

const _QS_KIND_LABEL = { steering: "steer", followUp: "follow-up" };
const _QS_NOTICE_MS = 4000;
// The shared ghost icon button (styles.css), sized down for the row.
const _QS_BTN = "btn icon ghost queue-btn";

function QueueStrip({ queue, sending, canSendNow, onSendNow, onRemove, onPromote, onEdit }) {
  const rows = React.useMemo(() => _QS_rows(queue, sending), [queue, sending]);
  // One request at a time across the strip: omp acts on the first
  // matching message, so a second request for a duplicate text would
  // remove (or promote) the next one. A click's state update is flushed
  // before the next input event, so the disabled buttons are the guard.
  const [busy, setBusy] = React.useState(false);
  const [notice, setNotice] = React.useState(null); // { key, text }
  React.useEffect(() => {
    if (!notice) return undefined;
    const timer = setTimeout(() => setNotice(null), _QS_NOTICE_MS);
    return () => clearTimeout(timer);
  }, [notice]);
  if (!rows.length) return null;

  const run = async (row, action) => {
    if (busy) return;
    setBusy(true);
    setNotice(null);
    let text = null;
    try {
      if (!(await action(row))) text = OMP_TR("already delivered");
    } catch (e) {
      text = OMP_TR("failed: {error}", { error: e?.message ?? e });
    }
    setBusy(false);
    if (text) setNotice({ key: row.key, text });
  };

  return (
    <div className="queue-strip" role="list" aria-label={OMP_TR("queued messages")}>
      {rows.map(r => {
        const note = r.sending ? OMP_TR("sending…") : notice?.key === r.key ? notice.text : null;
        return (
          <div className={`queue-row ${r.kind}${r.sending ? " sending" : ""}`} role="listitem" key={r.key}>
            <span className="queue-kind">{OMP_TR(_QS_KIND_LABEL[r.kind])}</span>
            <span className="queue-text" title={r.text}>{r.text}</span>
            {note && <span className="queue-note">{note}</span>}
            {!r.sending && (<>
              {canSendNow && (
                <button className={_QS_BTN} disabled={busy} onClick={() => run(r, onSendNow)}
                  title={OMP_TR("send now: stop the agent's current step (as Esc does) and deliver this message at once")}
                  aria-label={OMP_TR("send now")}>
                  <_QS_Icon name="bolt" size={11} />
                </button>
              )}
              {r.kind === "followUp" && (
                <button className={_QS_BTN} disabled={busy} onClick={() => run(r, onPromote)}
                  title={OMP_TR("steer now: deliver at the agent's next step")} aria-label={OMP_TR("steer now")}>
                  <_QS_Icon name="arrowUp" size={11} />
                </button>
              )}
              {r.editable && (
                <button className={_QS_BTN} disabled={busy} onClick={() => run(r, onEdit)}
                  title={OMP_TR("edit: take the text back into the prompt box")} aria-label={OMP_TR("edit")}>
                  <_QS_Icon name="edit" size={11} />
                </button>
              )}
              <button className={_QS_BTN} disabled={busy} onClick={() => run(r, onRemove)}
                title={OMP_TR("remove from the queue")} aria-label={OMP_TR("remove")}>
                <_QS_Icon name="close" size={10} />
              </button>
            </>)}
          </div>
        );
      })}
    </div>
  );
}

Object.assign(window, { QueueStrip });

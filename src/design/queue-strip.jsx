/* queue-strip.jsx — the steers and follow-ups omp holds for the agent,
   above the composer. One row per message, from omp's own queue snapshot
   (app/message-queue.js) plus "sending" rows omp has not acknowledged
   yet. ✕ removes a message, ✎ takes it back into the prompt box, ↑ turns
   a follow-up into a steer. Every action is omp's: a row only goes away
   with omp's next queue snapshot, and `false` from the bridge means the
   message was already delivered. composer.jsx re-keys this per tab. */

const { Icon: _QS_Icon } = window;
const { rows: _QS_rows } = window.OMP_QUEUE;

const _QS_KIND_LABEL = { steering: "steer", followUp: "follow-up" };
const _QS_NOTICE_MS = 4000;
// The shared ghost icon button (styles.css), sized down for the row.
const _QS_BTN = "btn icon ghost queue-btn";

function QueueStrip({ queue, sending, onRemove, onPromote, onEdit }) {
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
      if (!(await action(row))) text = "already delivered";
    } catch (e) {
      text = `failed: ${e?.message ?? e}`;
    }
    setBusy(false);
    if (text) setNotice({ key: row.key, text });
  };

  return (
    <div className="queue-strip" role="list" aria-label="queued messages">
      {rows.map(r => {
        const note = r.sending ? "sending…" : notice?.key === r.key ? notice.text : null;
        return (
          <div className={`queue-row ${r.kind}${r.sending ? " sending" : ""}`} role="listitem" key={r.key}>
            <span className="queue-kind">{_QS_KIND_LABEL[r.kind]}</span>
            <span className="queue-text" title={r.text}>{r.text}</span>
            {note && <span className="queue-note">{note}</span>}
            {!r.sending && (<>
              {r.kind === "followUp" && (
                <button className={_QS_BTN} disabled={busy} onClick={() => run(r, onPromote)}
                  title="steer now: deliver at the agent's next step" aria-label="steer now">
                  <_QS_Icon name="arrowUp" size={11} />
                </button>
              )}
              {r.editable && (
                <button className={_QS_BTN} disabled={busy} onClick={() => run(r, onEdit)}
                  title="edit: take the text back into the prompt box" aria-label="edit">
                  <_QS_Icon name="edit" size={11} />
                </button>
              )}
              <button className={_QS_BTN} disabled={busy} onClick={() => run(r, onRemove)}
                title="remove from the queue" aria-label="remove">
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

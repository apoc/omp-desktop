/* pr-checks.jsx — the Changes card's CI line for the PR's head commit:
   the step in progress (or the outcome) with done/total, one dot per check
   (a proportional bar past OMP_PR_AUTOMATION's dot limit, so a big matrix
   never overflows), and on click every check in a capped, scrollable list,
   running and failed first; a row opens that check's CI page. The controller
   re-reads every 15 s while a check is queued or running. */

const { ciSummary: _PC_summary } = window.OMP_PR_AUTOMATION;

const _PC_WORD = { queued: "queued", running: "running", success: "passed", failure: "failed", neutral: "skipped" };
// Bar segments, finished first, so the bar fills from the left as CI runs.
const _PC_BAR = ["success", "failure", "neutral", "running", "queued"];

function PrChecks({ checks, onOpen }) {
  const [open, setOpen] = React.useState(false);
  const listId = React.useId();
  const ci = _PC_summary(checks);
  if (!ci.total) return null;
  const spoken = `${ci.done} of ${ci.total} checks finished` +
    (ci.count.failure ? `, ${ci.count.failure} failed` : "") +
    (ci.count.running ? `, ${ci.count.running} running` : "");
  return (
    <div className={`pr-ci is-${ci.state}`}>
      <button
        className="pr-ci-line"
        aria-expanded={open}
        aria-controls={open ? listId : undefined}
        aria-label={`Checks: ${ci.label}${ci.more ? ` and ${ci.more} more` : ""}. ${spoken}`}
        title={ci.label}
        onClick={() => setOpen((v) => !v)}
      >
        <span className="pr-ci-glyph" aria-hidden="true" />
        <span className="pr-ci-label">{ci.label}</span>
        {ci.more > 0 && <span className="pr-ci-more">+{ci.more}</span>}
        <span className="pr-ci-count">{ci.done}/{ci.total}</span>
        <window.Icon name={open ? "chev" : "chevR"} size={10} />
      </button>
      {ci.dots ? (
        <div className="pr-ci-dots" role="img" aria-label={spoken}>
          {checks.map((c, i) => (
            <span key={i} className={`pr-ci-dot is-${c.state}`} title={`${c.name} · ${_PC_WORD[c.state]}`} />
          ))}
        </div>
      ) : (
        <div className="pr-ci-bar" role="img" aria-label={spoken}>
          {_PC_BAR.map((s) => ci.count[s] ? (
            <span key={s} className={`pr-ci-seg is-${s}`} style={{ flexGrow: ci.count[s] }}
              title={`${ci.count[s]} ${_PC_WORD[s]}`} />
          ) : null)}
        </div>
      )}
      {open && (
        <ul id={listId} className="pr-ci-list">
          {ci.list.map((c, i) => (
            <li key={i}>
              <button onClick={() => onOpen(c.url)} title={`${c.name} · open its CI page`}>
                <span className={`pr-ci-dot is-${c.state}`} aria-hidden="true" />
                <span className="pr-ci-name">{c.name}</span>
                <span className="pr-ci-word">{_PC_WORD[c.state]}</span>
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

window.PrChecks = PrChecks;

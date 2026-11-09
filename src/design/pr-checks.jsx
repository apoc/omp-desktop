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
  const ciLabel = ci.state === "queued" ? OMP_TR("{n} queued", { n: ci.count.queued })
    : ci.state === "failure" ? OMP_TR("{n} failed", { n: ci.count.failure })
    : ci.state === "running" ? ci.label
    : OMP_TR(ci.label);
  const spoken = OMP_TR("{done} of {total} checks finished, {failed} failed, {running} running",
    { done: ci.done, total: ci.total, failed: ci.count.failure, running: ci.count.running });
  return (
    <div className={`pr-ci is-${ci.state}`}>
      <button
        className="pr-ci-line"
        aria-expanded={open}
        aria-controls={open ? listId : undefined}
        aria-label={`${OMP_TR("Checks:")} ${ciLabel}${ci.more ? ` ${OMP_TR("and {n} more", { n: ci.more })}` : ""}. ${spoken}`}
        title={ciLabel}
        onClick={() => setOpen((v) => !v)}
      >
        <span className="pr-ci-glyph" aria-hidden="true" />
        <span className="pr-ci-label">{ciLabel}</span>
        {ci.more > 0 && <span className="pr-ci-more">+{ci.more}</span>}
        <span className="pr-ci-count">{ci.done}/{ci.total}</span>
        <window.Icon name={open ? "chev" : "chevR"} size={10} />
      </button>
      {ci.dots ? (
        <div className="pr-ci-dots" role="img" aria-label={spoken}>
          {checks.map((c, i) => (
            <span key={i} className={`pr-ci-dot is-${c.state}`} title={`${c.name} · ${OMP_TR(_PC_WORD[c.state])}`} />
          ))}
        </div>
      ) : (
        <div className="pr-ci-bar" role="img" aria-label={spoken}>
          {_PC_BAR.map((s) => ci.count[s] ? (
            <span key={s} className={`pr-ci-seg is-${s}`} style={{ flexGrow: ci.count[s] }}
              title={`${ci.count[s]} ${OMP_TR(_PC_WORD[s])}`} />
          ) : null)}
        </div>
      )}
      {open && (
        <ul id={listId} className="pr-ci-list">
          {ci.list.map((c, i) => (
            <li key={i}>
              <button onClick={() => onOpen(c.url)} title={`${c.name} · ${OMP_TR("open its CI page")}`}>
                <span className={`pr-ci-dot is-${c.state}`} aria-hidden="true" />
                <span className="pr-ci-name">{c.name}</span>
                <span className="pr-ci-word">{OMP_TR(_PC_WORD[c.state])}</span>
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

window.PrChecks = PrChecks;

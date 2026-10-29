// Remains outside the scrolling transcript and independent of rail visibility.
function PendingInput({ requests, concurrentWork = false, onOpen }) {
  const { Icon: InputIcon, OMP_PENDING_INPUT: input } = window;
  const summary = input.summary(requests, concurrentWork);
  if (!summary.requests) return null;
  const count = summary.questionsOnly ? summary.questions : summary.requests;
  const noun = summary.questionsOnly ? "question" : "request";
  return (
    <section className="pending-input" aria-label="Pending questions">
      <div className="pending-input-head">
        <InputIcon name="circle" size={11} />
        <span role="status">
          {count} {noun}
          {count === 1 ? "" : "s"} waiting for you
        </span>
        <button
          type="button"
          className="btn outlined"
          onClick={() => onOpen(requests[0].id)}
        >
          {summary.requests > 1 ? "Answer next" : "Answer"}
          <InputIcon name="arrow" size={10} />
        </button>
      </div>
      {summary.concurrentWork && (
        <p className="pending-input-note">
          Other tasks are still active. You can answer without stopping them.
        </p>
      )}
      {summary.requests === 1 ? (
        <button
          type="button"
          className="pending-input-title"
          onClick={() => onOpen(requests[0].id)}
          title={input.title(requests[0])}
        >
          {input.title(requests[0])}
        </button>
      ) : (
        <details className="pending-input-list">
          <summary>Show all {summary.requests} pending requests</summary>
          <ul>
            {requests.map((request) => (
              <li key={request.id}>
                <button type="button" onClick={() => onOpen(request.id)}>
                  <span>{input.title(request)}</span>
                  <span className="pending-input-kind">
                    {request.sending || request.recoverySending
                      ? "sending…"
                      : request.recovery
                        ? "restored"
                        : "answer"}
                  </span>
                </button>
              </li>
            ))}
          </ul>
        </details>
      )}
    </section>
  );
}
window.PendingInput = PendingInput;

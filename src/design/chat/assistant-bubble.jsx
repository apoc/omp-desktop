/* chat/assistant-bubble.jsx — assistant block (text + plan + thoughts +
   a failed request's failure) + InlinePlan (mini-plan rendered inline in the
   first plan reply). */

const { Icon: _ChatIcon, MarkdownContent: _ChatMd, AnnotablePlan: _ChatAP, CopyButton: _ChatCopy } = window;

function InlinePlan({ plan }) {
  return (
    <div className="inline-plan slide-in">
      <div className="inline-plan-head">
        <_ChatIcon name="plan" size={12} color="var(--accent)" />
        <span style={{ color: "var(--fg-2)", fontWeight: 600 }}>{plan.title}</span>
        <span className="chip muted">{plan.phases.reduce((n, p) => n + p.tasks.length, 0)} tasks</span>
        <div style={{ flex: 1 }} />
        <button className="btn ghost" style={{ height: 22 }}>open kanban →</button>
      </div>
      <div className="inline-plan-body">
        {plan.phases.map((ph) => (
          <div key={ph.id} className="inline-phase">
            <div className="inline-phase-head">
              <span className="mono" style={{ color: "var(--fg-3)" }}>{ph.label.toUpperCase()}</span>
              <span className="hr" />
            </div>
            {ph.tasks.map((t) => (
              <div key={t.id} className={`inline-task status-${t.status}`}>
                <span className="task-mark">
                  {t.status === "done" && <_ChatIcon name="check" size={10} />}
                  {t.status === "in_progress" && <span className="pulse-dot" />}
                  {t.status === "pending" && <span className="mono" style={{ color: "var(--fg-4)" }}>○</span>}
                </span>
                <span className="task-text selectable">{t.text}</span>
              </div>
            ))}
          </div>
        ))}
      </div>
    </div>
  );
}

// The message's raw markdown, one text block after another — what the
// model wrote, code fences and line breaks included. A live message can
// carry an empty text block (a turn that went straight to a tool call).
const _messageText = (msg) => (msg.blocks ?? [])
  .filter((b) => b.type === "text" && b.text?.trim())
  .map((b) => b.text).join("\n\n");

// A request that failed for good — omp's own retries are behind it
// (app/turn-status.js `failureOf`). `retryable` (the "temporary" chip) is
// omp's live `prompt_result` verdict and unknown for a reloaded turn.
function _AB_Failure({ failure: f }) {
  const where = [f.provider, f.model].filter(Boolean).join(" · ");
  return (
    <div className="ass-failure">
      <div className="ass-failure-head">
        <span className="ass-failure-title">request failed</span>
        {f.httpStatus != null && <span className="chip danger mono">HTTP {f.httpStatus}</span>}
        {f.retryable && (
          <span className="chip warn" title="omp already retried it; sending again later may work">temporary</span>
        )}
        {where && <span className="chip muted mono">{where}</span>}
      </div>
      <div className="ass-failure-msg selectable">{f.headline}</div>
      {f.raw !== f.headline && (
        <details className="ass-failure-raw">
          <summary>provider response</summary>
          <pre className="selectable">{f.raw}</pre>
        </details>
      )}
    </div>
  );
}

function AssistantBubble({ msg, idx, highlighted, annotable, annotations, onAnnotate }) {
  // A failed request has no text of its own; its copy is the provider's error.
  const copyText = msg.streaming ? "" : (_messageText(msg) || msg.failure?.raw || "");
  return (
    <div className={`row assistant fade-up${highlighted ? " mm-hot" : ""}`} data-msg-idx={idx}>
      <div className="ass-rail">
        <div className={`ass-glyph${msg.failure ? " failed" : ""}`}>
          <_ChatIcon name="sparkle" size={11} color={msg.failure ? "var(--rose)" : "var(--accent)"} />
        </div>
        <div className="ass-thread" />
      </div>
      <div className="ass-body">
        <div className="ass-meta">
          <span className="mono" style={{ color: "var(--accent)" }}>{msg.model ?? "–"}</span>
          <span className="chip muted">{msg.time}</span>
          {msg.lead === "thinking" && (
            <span className="chip" style={{ color: "var(--lilac)", borderColor: "color-mix(in oklab, var(--lilac) 30%, var(--line))" }}>
              <_ChatIcon name="thinking" size={10} />
              thinking
            </span>
          )}
          <_ChatCopy className="ass-copy" label="Copy message" text={copyText} />
        </div>
        {msg.thought && (
          <div className="thought selectable">
            <span className="mono" style={{ color: "var(--fg-4)" }}>// </span>
            <span style={{ color: "var(--fg-3)", fontStyle: "italic" }}>{msg.thought}</span>
          </div>
        )}
        {msg.blocks?.map((b, i) => {
          if (b.type === "text") {
            // Last message in plan mode: render annotatable blocks (not streaming)
            if (annotable && !msg.streaming) {
              return (
                <_ChatAP key={i} text={b.text}
                  annotations={annotations}
                  onAnnotate={onAnnotate} />
              );
            }
            return (
              <_ChatMd key={i} text={b.text}
                streaming={msg.streaming && i === msg.blocks.length - 1} />
            );
          }
          if (b.type === "plan") {
            return <InlinePlan key={i} plan={b} />;
          }
          return null;
        })}
        {msg.failure && <_AB_Failure failure={msg.failure} />}
      </div>
    </div>
  );
}

Object.assign(window, { AssistantBubble, InlinePlan });

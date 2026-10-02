/* chat/assistant-bubble.jsx — assistant block (text + plan + thoughts) +
   InlinePlan (mini-plan rendered inline in the first plan reply). */

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
const _copyBlocks = (msg) => (msg.blocks ?? []).filter((b) => b.type === "text" && b.text?.trim());
const _messageText = (msg) => _copyBlocks(msg).map((b) => b.text).join("\n\n");

function AssistantBubble({ msg, idx, highlighted, annotable, annotations, onAnnotate }) {
  const copyable = !msg.streaming && _copyBlocks(msg).length > 0;
  return (
    <div className={`row assistant fade-up${highlighted ? " mm-hot" : ""}`} data-msg-idx={idx}>
      <div className="ass-rail">
        <div className="ass-glyph"><_ChatIcon name="sparkle" size={11} color="var(--accent)" /></div>
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
          {copyable && (
            <_ChatCopy className="ass-copy" label="Copy message" getText={() => _messageText(msg)} />
          )}
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
      </div>
    </div>
  );
}

Object.assign(window, { AssistantBubble, InlinePlan });

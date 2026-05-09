/* ui/plan-annotations.jsx — block-level annotations on the
   assistant's plan reply. segmentPlan parses the plan via marked.lexer
   so each top-level token (paragraph, heading, list) becomes its own
   commentable block. */

const { Icon: _PA_Icon } = window;

// paragraphs / headings / lists of the streamed plan before sending feedback.
function segmentPlan(text) {
  if (!text) return [];
  try {
    if (!window.marked) throw new Error("no marked");
    const tokens = window.marked.lexer(text);
    return tokens
      .filter(t => t.type !== "space")
      .map((t, i) => ({ index: i, kind: t.type, raw: t.raw ?? "", html: window.marked.parser([t]) }));
  } catch {
    return [{ index: 0, kind: "paragraph", raw: text, html: `<pre>${text.replace(/</g,"&lt;")}</pre>` }];
  }
}

const CommentForm = ({ block, initial, onSave, onCancel }) => {
  const [text, setText] = React.useState(initial);
  const ref = React.useRef(null);
  React.useEffect(() => { ref.current?.focus(); }, []);
  return (
    <div className="plan-comment-form">
      <div className="plan-comment-form-quote mono">{block.raw.split("\n")[0].trim().slice(0, 80)}{block.raw.length > 80 ? "…" : ""}</div>
      <textarea ref={ref} className="plan-comment-form-area"
        value={text} placeholder="your comment…"
        onChange={e => setText(e.target.value)}
        onKeyDown={e => {
          if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) { e.preventDefault(); onSave(text.trim()); }
          if (e.key === "Escape") { e.stopPropagation(); onCancel(); }
        }}
      />
      <div className="plan-comment-form-foot">
        {initial && (
          <button className="btn ghost" style={{ color: "var(--rose)" }} onClick={() => onSave(null)}>
            <_PA_Icon name="trash" size={9} /> remove
          </button>
        )}
        <div style={{ flex: 1 }} />
        <button className="btn ghost" onClick={onCancel}>cancel</button>
        <button className="btn outlined" onClick={() => onSave(text.trim())} disabled={!text.trim() && !initial}>
          save <span className="kbd" style={{ marginLeft: 2 }}>⌘↵</span>
        </button>
      </div>
    </div>
  );
};

const AnnotablePlan = ({ text, annotations, onAnnotate }) => {
  const [selectedBlock, setSelectedBlock] = React.useState(null);
  const blocks = React.useMemo(() => segmentPlan(text), [text]);

  if (blocks.length === 0) return (
    <div className="md-content selectable" style={{ color: "var(--fg-4)", fontFamily: "var(--font-mono)", fontSize: "var(--d-text-sm)" }}>
      (no plan content yet)
    </div>
  );

  return (
    <div className="plan-annot-blocks">
      {blocks.map(block => {
        const ann    = annotations[block.index];
        const isOpen = selectedBlock === block.index;
        const isHr   = block.kind === "hr";
        return (
          <div key={block.index}
            className={`plan-block${isOpen ? " is-selected" : ""}${ann ? " has-comment" : ""}`}>
            <div className="plan-block-body md-content selectable"
              dangerouslySetInnerHTML={{ __html: block.html }} />
            {!isHr && (
              <button className="plan-block-add" title={ann ? "edit comment" : "add comment"}
                onClick={() => setSelectedBlock(isOpen ? null : block.index)}>
                {ann
                  ? <_PA_Icon name="edit" size={9} color="var(--amber)" />
                  : <_PA_Icon name="plus" size={9} color="var(--fg-3)" />}
              </button>
            )}
            {ann && !isOpen && (
              <div className="plan-comment-chip" onClick={() => setSelectedBlock(block.index)}>
                <_PA_Icon name="edit" size={8} color="var(--lilac)" />
                <span>{ann.comment}</span>
              </div>
            )}
            {isOpen && (
              <CommentForm
                block={block}
                initial={ann?.comment ?? ""}
                onSave={comment => {
                  onAnnotate(block.index, comment ? { raw: block.raw, comment } : null);
                  setSelectedBlock(null);
                }}
                onCancel={() => setSelectedBlock(null)}
              />
            )}
          </div>
        );
      })}
    </div>
  );
};

Object.assign(window, { Icon, TOOL_META, Sparkline, TokenGauge, ActivityRadar, MarkdownContent, AnnotablePlan });


Object.assign(window, { AnnotablePlan, segmentPlan });

/* ═════════════════════════════════════════════════════════════════════
   panels.jsx — Plan surface: intent → drafting → review → running → done
   ═════════════════════════════════════════════════════════════════════ */

const { Icon, TOOL_META, MarkdownContent } = window;

// ── Intent phase ─────────────────────────────────────────────────────
function IntentPhase({ onSubmit, onClose, initialIntent = "" }) {
  const [text, setText] = React.useState(initialIntent);
  const ref = React.useRef(null);
  React.useEffect(() => { ref.current?.focus(); }, []);
  const submit = () => { if (text.trim()) onSubmit(text.trim()); };
  return (
    <div className="plan-intent-wrap">
      <div className="plan-intent-card">
        <textarea
          ref={ref}
          className="plan-intent-textarea selectable"
          placeholder="Describe what you want to build or change. Be as specific as you like — the agent will draft a plan before writing any code."
          value={text}
          onChange={e => setText(e.target.value)}
          onKeyDown={e => { if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) { e.preventDefault(); submit(); } }}
        />
        <div className="plan-intent-meta">
          <span className="mono" style={{ color: "var(--fg-4)" }}>shift+↵ newline</span>
          <span className="mono" style={{ color: "var(--fg-4)" }}>⌘↵ draft plan</span>
        </div>
      </div>
      <div className="plan-intent-foot">
        <button className="btn ghost" onClick={onClose}>cancel</button>
        <button className="btn primary" onClick={submit} disabled={!text.trim()}>
          <Icon name="plan" size={11} /> draft plan
        </button>
      </div>
    </div>
  );
}

// ── Drafting phase ────────────────────────────────────────────────────
function DraftingPhase({ text, onAbort }) {
  return (
    <div className="plan-draft-wrap">
      <div className="plan-draft-status">
        <span className="dot live" />
        <span className="mono" style={{ color: "var(--lilac)" }}>drafting plan…</span>
        <button className="btn ghost" style={{ marginLeft: "auto", height: 22 }} onClick={onAbort}>
          <Icon name="stop" size={10} /> abort
        </button>
      </div>
      <div className="plan-draft-scroll">
        <MarkdownContent text={text || ""} streaming={true} />
      </div>
    </div>
  );
}

// ── Block segmentation ────────────────────────────────────────────────
function segmentPlan(text) {
  if (!text) return [];
  try {
    if (!window.marked) throw new Error("marked unavailable");
    const tokens = window.marked.lexer(text);
    return tokens
      .filter(t => t.type !== "space")
      .map((t, i) => ({
        index: i,
        kind:  t.type,
        raw:   t.raw ?? "",
        html:  window.marked.parser([t]),
      }));
  } catch {
    return [{ index: 0, kind: "paragraph", raw: text, html: `<pre>${text.replace(/</g,"&lt;")}</pre>` }];
  }
}

// ── Annotable plan ────────────────────────────────────────────────────
function AnnotablePlan({ text, annotations, onAnnotate, selectedBlock, onSelectBlock }) {
  const blocks = React.useMemo(() => segmentPlan(text), [text]);

  if (blocks.length === 0) {
    return (
      <div className="plan-empty-state">
        <Icon name="info" size={14} color="var(--fg-4)" />
        <span className="mono" style={{ color: "var(--fg-4)" }}>the agent didn't produce a plan. submit feedback or edit your intent.</span>
      </div>
    );
  }

  return (
    <div className="plan-annot-blocks">
      {blocks.map(block => {
        const ann    = annotations[block.index];
        const isOpen = selectedBlock === block.index;
        const isHr   = block.kind === "hr";
        return (
          <div
            key={block.index}
            className={`plan-block${isOpen ? " is-selected" : ""}${ann ? " has-comment" : ""}`}
          >
            <div className="plan-block-body md-content"
              dangerouslySetInnerHTML={{ __html: block.html }} />
            {!isHr && (
              <button
                className="plan-block-add"
                title={ann ? "edit comment" : "add comment"}
                onClick={() => onSelectBlock(isOpen ? null : block.index)}
              >
                {ann
                  ? <Icon name="edit" size={9} color="var(--amber)" />
                  : <Icon name="plus" size={9} color="var(--fg-3)" />}
              </button>
            )}
            {ann && !isOpen && (
              <div className="plan-comment-chip" onClick={() => onSelectBlock(block.index)}>
                <Icon name="edit" size={8} color="var(--lilac)" />
                <span>{ann.comment}</span>
              </div>
            )}
            {isOpen && (
              <CommentForm
                block={block}
                initial={ann?.comment ?? ""}
                onSave={(comment) => {
                  onAnnotate(block.index, comment ? { raw: block.raw, comment } : null);
                  onSelectBlock(null);
                }}
                onCancel={() => onSelectBlock(null)}
              />
            )}
          </div>
        );
      })}
    </div>
  );
}

function CommentForm({ block, initial, onSave, onCancel }) {
  const [text, setText] = React.useState(initial);
  const ref = React.useRef(null);
  React.useEffect(() => { ref.current?.focus(); }, []);
  return (
    <div className="plan-comment-form">
      <div className="plan-comment-form-quote mono">{block.raw.split("\n")[0].trim().slice(0, 80)}{block.raw.length > 80 ? "…" : ""}</div>
      <textarea
        ref={ref}
        className="plan-comment-form-area"
        value={text}
        placeholder="your comment…"
        onChange={e => setText(e.target.value)}
        onKeyDown={e => {
          if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) { e.preventDefault(); onSave(text.trim()); }
          if (e.key === "Escape") { e.stopPropagation(); onCancel(); }
        }}
      />
      <div className="plan-comment-form-foot">
        {initial && (
          <button className="btn ghost" style={{ color: "var(--rose)" }} onClick={() => onSave(null)}>
            <Icon name="trash" size={9} /> remove
          </button>
        )}
        <div style={{ flex: 1 }} />
        <button className="btn ghost" onClick={onCancel}>cancel</button>
        <button className="btn outlined" onClick={() => onSave(text.trim())}
          disabled={!text.trim() && !initial}>
          save <span className="kbd" style={{ marginLeft: 2 }}>⌘↵</span>
        </button>
      </div>
    </div>
  );
}

// ── Review phase ──────────────────────────────────────────────────────
function ReviewPhase({ text, annotations, onAnnotate, onSubmitReview, onApprove }) {
  const [selectedBlock, setSelectedBlock] = React.useState(null);
  const [overall, setOverall] = React.useState("");
  const commentCount = Object.keys(annotations).length;
  const canSubmit = commentCount > 0 || overall.trim().length > 0;

  // ⌘↵ = approve (when no comment form open); ⌘⇧↵ = submit review
  React.useEffect(() => {
    const onKey = e => {
      if (!e.metaKey && !e.ctrlKey) return;
      if (e.key === "Enter" && !e.shiftKey && selectedBlock === null) {
        e.preventDefault(); onApprove();
      }
      if (e.key === "Enter" && e.shiftKey && canSubmit) {
        e.preventDefault(); onSubmitReview(annotations, overall, text);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [selectedBlock, canSubmit, annotations, overall, text]);

  return (
    <div className="plan-review-wrap">
      <div className="plan-review-scroll">
        <AnnotablePlan
          text={text}
          annotations={annotations}
          onAnnotate={onAnnotate}
          selectedBlock={selectedBlock}
          onSelectBlock={setSelectedBlock}
        />
      </div>
      <div className="plan-review-foot">
        <div className="plan-overall">
          <span className="mono" style={{ color: "var(--fg-4)", fontSize: "var(--d-text-xs)", marginBottom: 4, display: "block" }}>overall comment</span>
          <textarea
            className="plan-overall-area"
            placeholder="anything else to add? (optional)"
            value={overall}
            onChange={e => setOverall(e.target.value)}
          />
        </div>
        <div className="plan-review-actions">
          <span className="mono" style={{ color: "var(--fg-4)", fontSize: "var(--d-text-xs)" }}>
            {commentCount > 0 ? `${commentCount} comment${commentCount !== 1 ? "s" : ""}` : "no comments"}
          </span>
          <div style={{ flex: 1 }} />
          <button className="btn outlined" onClick={() => onSubmitReview(annotations, overall, text)} disabled={!canSubmit}>
            <Icon name="refresh" size={10} /> submit review
          </button>
          <button className="btn primary" onClick={onApprove}>
            <Icon name="play" size={10} /> approve &amp; execute
            <span className="kbd" style={{ marginLeft: 4 }}>⌘↵</span>
          </button>
        </div>
      </div>
    </div>
  );
}

// ── Phase pill ────────────────────────────────────────────────────────
function PhasePill({ phase }) {
  const map = {
    intent:   { color: "var(--fg-2)",    icon: "edit",     label: "intent"   },
    drafting: { color: "var(--lilac)",   icon: "thinking", label: "drafting" },
    review:   { color: "var(--amber)",   icon: "edit",     label: "review"   },
    running:  { color: "var(--cyan)",    icon: "play",     label: "running"  },
    done:     { color: "var(--accent)",  icon: "check",    label: "done"     },
  };
  const m = map[phase] ?? map.intent;
  return (
    <span className="chip" style={{
      color: m.color,
      borderColor: `color-mix(in oklab, ${m.color} 35%, var(--line))`,
      background:  `color-mix(in oklab, ${m.color} 12%, transparent)`,
    }}>
      <Icon name={m.icon} size={9} color={m.color} /> {m.label}
    </span>
  );
}

// ── Plan kanban (orchestrator) ────────────────────────────────────────
function PlanKanban({
  kanban, planMeta, onClose,
  phase = "intent", onPhaseChange,
  planText = "", isStreaming = false,
  onSubmitIntent, onSubmitReview, onApprove, onAbort,
  initialIntent = "",
  // legacy compat
  mode, onMode,
}) {
  // legacy prop shim
  const currentPhase = phase ?? mode ?? "intent";
  const setPhase     = onPhaseChange ?? onMode ?? (() => {});

  const [annotations, setAnnotations] = React.useState({});

  // Clear annotations when entering a new drafting cycle
  React.useEffect(() => {
    if (currentPhase === "drafting") setAnnotations({});
  }, [currentPhase]);

  const handleAnnotate = (idx, value) => {
    setAnnotations(prev => {
      const next = { ...prev };
      if (value === null) delete next[idx]; else next[idx] = value;
      return next;
    });
  };

  const total  = kanban.reduce((n, c) => n + c.tasks.length, 0);
  const done   = kanban.reduce((n, c) => n + c.tasks.filter(t => t.status === "done").length, 0);
  const inProg = kanban.reduce((n, c) => n + c.tasks.filter(t => t.status === "in_progress").length, 0);

  const titles = { intent: "new plan", drafting: "drafting plan", review: "review plan", running: "executing plan", done: "plan complete" };
  const annotCount = Object.keys(annotations).length;

  return (
    <div className="kanban-scrim" onClick={onClose}>
      <div className="kanban slide-in" onClick={e => e.stopPropagation()}>

        {/* Header */}
        <div className="kanban-head">
          <div style={{ display: "flex", flexDirection: "column", gap: 4, flex: 1, minWidth: 0 }}>
            <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
              <Icon name="plan" size={16} color="var(--accent)" />
              <span style={{ fontSize: "var(--d-text-lg)", fontWeight: 600 }}>{titles[currentPhase] ?? "plan"}</span>
              <PhasePill phase={currentPhase} />
              {(currentPhase === "running" || currentPhase === "done") && (
                <span className="chip muted mono">{done}/{total}{inProg ? ` · ${inProg} live` : ""}</span>
              )}
              {currentPhase === "review" && annotCount > 0 && (
                <span className="chip" style={{ color: "var(--amber)", borderColor: "color-mix(in oklab, var(--amber) 30%, var(--line))" }}>
                  {annotCount} comment{annotCount !== 1 ? "s" : ""}
                </span>
              )}
            </div>
            {planMeta?.ask && (currentPhase === "review" || currentPhase === "running" || currentPhase === "done") && (
              <div className="plan-ask selectable">
                <span className="mono" style={{ color: "var(--fg-4)" }}>ask &nbsp;</span>
                <span style={{ color: "var(--fg-2)" }}>{planMeta.ask}</span>
              </div>
            )}
          </div>
          <button className="btn ghost icon" onClick={onClose} title="close (esc)">
            <Icon name="close" size={11} />
          </button>
        </div>

        {/* Phase body */}
        {currentPhase === "intent" && (
          <IntentPhase
            onSubmit={onSubmitIntent}
            onClose={onClose}
            initialIntent={initialIntent}
          />
        )}

        {currentPhase === "drafting" && (
          <DraftingPhase text={planText} onAbort={onAbort} />
        )}

        {currentPhase === "review" && (
          <ReviewPhase
            text={planText}
            annotations={annotations}
            onAnnotate={handleAnnotate}
            onSubmitReview={onSubmitReview}
            onApprove={onApprove}
          />
        )}

        {(currentPhase === "running" || currentPhase === "done") && (
          <>
            {planMeta?.risks?.length > 0 && (
              <div className="plan-risks">
                <span className="mono" style={{ color: "var(--amber)" }}>risks</span>
                {planMeta.risks.map((r, i) => (
                  <span key={i} className="chip" style={{
                    color: `var(--${r.tone})`,
                    borderColor: `color-mix(in oklab, var(--${r.tone}) 30%, var(--line))`,
                    background:  `color-mix(in oklab, var(--${r.tone}) 8%, transparent)`,
                  }}>{r.text}</span>
                ))}
              </div>
            )}
            <div className="kanban-progress">
              <div className="kanban-progress-fill" style={{ width: total ? `${(done/total)*100}%` : "0%" }} />
            </div>
            <div className="kanban-cols">
              {kanban.map((col, idx) => (
                <KanbanCol key={col.id} col={col} idx={idx} mode={currentPhase} />
              ))}
            </div>
            <div className="kanban-foot mono">
              {currentPhase === "running" && (
                <>
                  <span style={{ color: "var(--fg-4)" }}>agent is executing the plan</span>
                  <div style={{ flex: 1 }} />
                  <button className="btn danger" onClick={onAbort}>
                    <Icon name="stop" size={10} /> abort
                  </button>
                </>
              )}
              {currentPhase === "done" && (
                <>
                  <span style={{ color: "var(--accent)" }}>plan complete · {done}/{total} tasks shipped</span>
                  <div style={{ flex: 1 }} />
                  <button className="btn primary" onClick={onClose}>close</button>
                </>
              )}
            </div>
          </>
        )}

      </div>
    </div>
  );
}

// ── Kanban column ─────────────────────────────────────────────────────
function KanbanCol({ col, idx, mode }) {
  const colDone = col.tasks.filter(t => t.status === "done").length;
  return (
    <div className="kanban-col">
      <div className="kanban-col-head">
        <span className="kanban-col-mark" style={{ background: `var(--${col.tone})` }} />
        <Icon name={col.icon} size={11} color={`var(--${col.tone})`} />
        <span style={{ color: "var(--fg)", fontWeight: 600 }}>{col.title}</span>
        <span className="chip muted">{colDone}/{col.tasks.length}</span>
      </div>
      {col.tasks.map((t, i) => (
        <KanbanCard key={t.id} task={t} idx={idx * 8 + i} mode={mode} />
      ))}
      {mode === "running" && (
        <button className="kanban-add">+ add task</button>
      )}
    </div>
  );
}

// ── Kanban card ───────────────────────────────────────────────────────
function KanbanCard({ task, idx, mode }) {
  const [open, setOpen] = React.useState(false);
  const tone  = task.status === "done" ? "ok" : task.status === "in_progress" ? "live" : "pending";
  const tmeta = TOOL_META[task.tool] || { color: "var(--fg-3)", icon: "circle", label: task.tool };
  const effortColor = task.effort === "L" ? "var(--rose)" : task.effort === "M" ? "var(--amber)" : "var(--fg-3)";
  return (
    <div className={`kcard ${tone} fade-up ${open ? "open" : ""}`}
      style={{ animationDelay: `${idx * 30}ms` }}
      onClick={() => setOpen(v => !v)}>
      <div className="kcard-head">
        {task.status === "done"        && <span className="kcard-mark ok"><Icon name="check" size={10} /></span>}
        {task.status === "in_progress" && <span className="kcard-mark live"><span className="pulse-dot" /></span>}
        {task.status === "pending"     && <span className="kcard-mark pending">○</span>}
        <span className="kcard-text selectable">{task.text}</span>
      </div>
      <div className="kcard-tags">
        <span className="chip mono" style={{
          color: tmeta.color,
          borderColor: `color-mix(in oklab, ${tmeta.color} 30%, var(--line))`,
          background:  `color-mix(in oklab, ${tmeta.color} 10%, transparent)`,
        }}>
          <Icon name={tmeta.icon} size={9} color={tmeta.color} /> {tmeta.label}
        </span>
        {task.effort && (
          <span className="chip mono" style={{ color: effortColor, borderColor: `color-mix(in oklab, ${effortColor} 30%, var(--line))` }}>
            {task.effort}
          </span>
        )}
        {task.file && (
          <span className="chip mono muted" style={{ overflow: "hidden", textOverflow: "ellipsis", maxWidth: 140 }}>
            <Icon name="file" size={9} color="var(--fg-4)" />{task.file}
          </span>
        )}
      </div>
      {open && task.reason && (
        <div className="kcard-why selectable">
          <span className="mono" style={{ color: "var(--fg-4)" }}>// why &nbsp;</span>
          <span style={{ color: "var(--fg-3)", fontStyle: "italic" }}>{task.reason}</span>
        </div>
      )}
      {mode === "running" && task.status === "in_progress" && (
        <div className="kcard-live mono">
          <span className="dot live" />
          <span style={{ color: "var(--cyan)" }}>agent is here</span>
          <span className="shimmer-text" style={{ marginLeft: "auto" }}>writing patch…</span>
        </div>
      )}
    </div>
  );
}

Object.assign(window, { PlanKanban });

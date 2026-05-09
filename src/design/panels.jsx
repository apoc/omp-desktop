/* ═════════════════════════════════════════════════════════════════════
   panels.jsx — Plan surface (review → approved → running → done)
   The plan is a real workspace: strategy, risks, estimates,
   per-task reasoning, approve/edit/counter, then live progress.
   ═════════════════════════════════════════════════════════════════════ */

const { Icon, TOOL_META } = window;

function PlanKanban({ kanban, planMeta, onClose, mode = "review", onApprove, onMode }) {
  const [phase, setPhase] = React.useState(mode); // review | running | done
  React.useEffect(() => setPhase(mode), [mode]);

  const total = kanban.reduce((n, c) => n + c.tasks.length, 0);
  const done = kanban.reduce((n, c) => n + c.tasks.filter((t) => t.status === "done").length, 0);
  const inProg = kanban.reduce((n, c) => n + c.tasks.filter((t) => t.status === "in_progress").length, 0);

  const titleByPhase = {
    review:  "draft plan · waiting for approval",
    running: "shipping plan · agent has the wheel",
    done:    "plan complete",
  };

  return (
    <div className="kanban-scrim" onClick={onClose}>
      <div className="kanban slide-in" onClick={(e) => e.stopPropagation()}>
        {/* Header */}
        <div className="kanban-head">
          <div style={{ display: "flex", flexDirection: "column", gap: 4, flex: 1, minWidth: 0 }}>
            <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
              <Icon name="plan" size={16} color="var(--accent)" />
              <span style={{ fontSize: "var(--d-text-lg)", fontWeight: 600 }}>The Plan</span>
              <PhasePill phase={phase} />
              <span className="chip muted mono">{done}/{total}{inProg ? ` · ${inProg} live` : ""}</span>
              <span className="chip muted">
                <Icon name="branch" size={9} color="var(--fg-3)" />
                <span className="mono">{planMeta.branch}</span>
              </span>
            </div>
            <div className="plan-ask selectable">
              <span className="mono" style={{ color: "var(--fg-4)" }}>ask &nbsp;</span>
              <span style={{ color: "var(--fg-2)" }}>{planMeta.ask}</span>
            </div>
          </div>
          <button className="btn ghost icon" onClick={onClose} title="close (esc)">
            <Icon name="close" size={11} />
          </button>
        </div>

        {/* Strategy + budget */}
        <div className="plan-prefly">
          <div className="plan-strategy selectable">
            <div className="plan-strategy-head">
              <Icon name="thinking" size={11} color="var(--lilac)" />
              <span className="mono" style={{ color: "var(--lilac)" }}>strategy</span>
              <button className="btn ghost" style={{ marginLeft: "auto", height: 20, fontSize: "var(--d-text-xs)" }}>
                <Icon name="edit" size={10} /> rewrite
              </button>
            </div>
            <p>{planMeta.strategy}</p>
            <div className="plan-touches">
              <span className="mono" style={{ color: "var(--fg-4)" }}>touches</span>
              {planMeta.touches.map((f) => (
                <span key={f} className="chip mono" style={{ color: "var(--cyan)", borderColor: "color-mix(in oklab, var(--cyan) 30%, var(--line))" }}>
                  <Icon name="file" size={9} color="var(--cyan)" /> {f}
                </span>
              ))}
            </div>
          </div>

          <div className="plan-budget">
            <div className="plan-budget-row">
              <span className="mono" style={{ color: "var(--fg-4)" }}>tokens</span>
              <span className="mono" style={{ color: "var(--fg)" }}>{planMeta.estimate.tokens}</span>
            </div>
            <div className="plan-budget-row">
              <span className="mono" style={{ color: "var(--fg-4)" }}>cost</span>
              <span className="mono" style={{ color: "var(--accent)" }}>{planMeta.estimate.cost}</span>
            </div>
            <div className="plan-budget-row">
              <span className="mono" style={{ color: "var(--fg-4)" }}>wall</span>
              <span className="mono" style={{ color: "var(--fg)" }}>{planMeta.estimate.wall}</span>
            </div>
            <div className="plan-budget-row" style={{ borderTop: "1px dashed var(--line)", paddingTop: 6 }}>
              <span className="mono" style={{ color: "var(--fg-4)" }}>tasks</span>
              <span className="mono" style={{ color: "var(--fg)" }}>{total}</span>
            </div>
          </div>
        </div>

        {/* Risks */}
        {planMeta.risks?.length > 0 && (
          <div className="plan-risks">
            <span className="mono" style={{ color: "var(--amber)" }}>risks</span>
            {planMeta.risks.map((r, i) => (
              <span key={i} className="chip" style={{
                color: `var(--${r.tone})`,
                borderColor: `color-mix(in oklab, var(--${r.tone}) 30%, var(--line))`,
                background: `color-mix(in oklab, var(--${r.tone}) 8%, transparent)`,
              }}>
                {r.text}
              </span>
            ))}
          </div>
        )}

        {/* Progress rail (only meaningful while running) */}
        <div className="kanban-progress">
          <div className="kanban-progress-fill" style={{ width: `${(done / total) * 100}%` }} />
        </div>

        {/* Columns */}
        <div className="kanban-cols">
          {kanban.map((col, idx) => (
            <KanbanCol key={col.id} col={col} idx={idx} mode={phase} />
          ))}
        </div>

        {/* Footer — actions change with phase */}
        <div className="kanban-foot mono">
          {phase === "review" && (
            <>
              <span style={{ color: "var(--fg-4)" }}>
                ⌥drag cards to reorder · click any card to refine reasoning · ⌘↵ approves
              </span>
              <div style={{ flex: 1 }} />
              <button className="btn outlined" onClick={() => onMode?.("review")}>
                <Icon name="edit" size={10} /> ask agent to revise
              </button>
              <button className="btn outlined" onClick={onClose}>
                save draft
              </button>
              <button className="btn primary" onClick={() => { onApprove?.(); onMode?.("running"); }}>
                <Icon name="play" size={10} /> approve & ship
                <span className="kbd" style={{ marginLeft: 4 }}>⌘↵</span>
              </button>
            </>
          )}
          {phase === "running" && (
            <>
              <span style={{ color: "var(--fg-4)" }}>
                agent is working from this plan. you can pause, branch, or counter-propose at any moment.
              </span>
              <div style={{ flex: 1 }} />
              <button className="btn outlined">
                <Icon name="branch" size={10} /> branch from here
              </button>
              <button className="btn danger">
                <Icon name="stop" size={10} /> pause
              </button>
            </>
          )}
          {phase === "done" && (
            <>
              <span style={{ color: "var(--accent)" }}>plan complete · {done}/{total} tasks shipped</span>
              <div style={{ flex: 1 }} />
              <button className="btn outlined">export retro</button>
              <button className="btn primary" onClick={onClose}>close</button>
            </>
          )}
        </div>
      </div>
    </div>
  );
}

function PhasePill({ phase }) {
  const map = {
    review:  { color: "var(--amber)", icon: "edit",  label: "draft" },
    running: { color: "var(--cyan)",  icon: "play",  label: "running" },
    done:    { color: "var(--accent)", icon: "check", label: "done" },
  };
  const m = map[phase];
  return (
    <span className="chip" style={{
      color: m.color,
      borderColor: `color-mix(in oklab, ${m.color} 35%, var(--line))`,
      background: `color-mix(in oklab, ${m.color} 12%, transparent)`,
    }}>
      <Icon name={m.icon} size={9} color={m.color} /> {m.label}
    </span>
  );
}

function KanbanCol({ col, idx, mode }) {
  const colDone = col.tasks.filter((t) => t.status === "done").length;
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
      {mode === "review" && (
        <button className="kanban-add">+ add task</button>
      )}
    </div>
  );
}

function KanbanCard({ task, idx, mode }) {
  const [open, setOpen] = React.useState(false);
  const tone = task.status === "done" ? "ok" : task.status === "in_progress" ? "live" : "pending";
  const tmeta = TOOL_META[task.tool] || { color: "var(--fg-3)", icon: "circle", label: task.tool };
  const effortColor = task.effort === "L" ? "var(--rose)" : task.effort === "M" ? "var(--amber)" : "var(--fg-3)";

  return (
    <div className={`kcard ${tone} fade-up ${open ? "open" : ""}`}
      style={{ animationDelay: `${idx * 30}ms` }}
      onClick={() => setOpen((v) => !v)}>
      <div className="kcard-head">
        {task.status === "done" && <span className="kcard-mark ok"><Icon name="check" size={10} /></span>}
        {task.status === "in_progress" && <span className="kcard-mark live"><span className="pulse-dot" /></span>}
        {task.status === "pending" && <span className="kcard-mark pending">○</span>}
        <span className="kcard-text selectable">{task.text}</span>
      </div>
      <div className="kcard-tags">
        <span className="chip mono" style={{
          color: tmeta.color,
          borderColor: `color-mix(in oklab, ${tmeta.color} 30%, var(--line))`,
          background: `color-mix(in oklab, ${tmeta.color} 10%, transparent)`,
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
            <Icon name="file" size={9} color="var(--fg-4)" />
            {task.file}
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

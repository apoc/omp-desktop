/* ═════════════════════════════════════════════════════════════════════
   panels.jsx — Kanban execution surface (running → done)
   Opened after plan approval; populated by agent's todo_write tool.
   ═════════════════════════════════════════════════════════════════════ */

const { Icon, TOOL_META } = window;

// ── Phase pill ────────────────────────────────────────────────────────
function PhasePill({ phase }) {
  const map = {
    running: { color: "var(--cyan)",   icon: "play",  label: "running" },
    done:    { color: "var(--accent)", icon: "check", label: "done"    },
  };
  const m = map[phase] ?? map.running;
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

// ── Plan kanban ───────────────────────────────────────────────────────
function PlanKanban({ kanban, planMeta, onClose, onAbort }) {
  const total  = kanban.reduce((n, c) => n + c.tasks.length, 0);
  const done   = kanban.reduce((n, c) => n + c.tasks.filter(t => t.status === "done").length, 0);
  const inProg = kanban.reduce((n, c) => n + c.tasks.filter(t => t.status === "in_progress").length, 0);

  // Derive phase from task data — no external state needed
  const allDone = total > 0 && done === total;
  const phase   = allDone ? "done" : "running";

  return (
    <div className="kanban-scrim" onClick={onClose}>
      <div className="kanban slide-in" onClick={e => e.stopPropagation()}>

        {/* Header */}
        <div className="kanban-head">
          <div style={{ display: "flex", flexDirection: "column", gap: 4, flex: 1, minWidth: 0 }}>
            <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
              <Icon name="plan" size={16} color="var(--accent)" />
              <span style={{ fontSize: "var(--d-text-lg)", fontWeight: 600 }}>
                {phase === "done" ? "plan complete" : "executing plan"}
              </span>
              <PhasePill phase={phase} />
              <span className="chip muted mono">
                {done}/{total}{inProg ? ` · ${inProg} live` : ""}
              </span>
            </div>
            {planMeta?.ask && (
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

        {/* Risks */}
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

        {/* Progress rail */}
        <div className="kanban-progress">
          <div className="kanban-progress-fill"
            style={{ width: total ? `${(done / total) * 100}%` : "0%" }} />
        </div>

        {/* Columns */}
        <div className="kanban-cols">
          {kanban.length > 0
            ? kanban.map((col, idx) => (
                <KanbanCol key={col.id} col={col} idx={idx} mode={phase} />
              ))
            : (
              <div style={{ padding: "32px 24px", color: "var(--fg-4)", fontFamily: "var(--font-mono)", fontSize: "var(--d-text-sm)" }}>
                waiting for agent to write tasks…
              </div>
            )
          }
        </div>

        {/* Footer */}
        <div className="kanban-foot mono">
          {phase === "running" && (
            <>
              <span style={{ color: "var(--fg-4)" }}>agent is executing the plan</span>
              <div style={{ flex: 1 }} />
              <button className="btn danger" onClick={onAbort}>
                <Icon name="stop" size={10} /> abort
              </button>
            </>
          )}
          {phase === "done" && (
            <>
              <span style={{ color: "var(--accent)" }}>
                plan complete · {done}/{total} tasks shipped
              </span>
              <div style={{ flex: 1 }} />
              <button className="btn primary" onClick={onClose}>close</button>
            </>
          )}
        </div>

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

/* chat/approval-row.jsx — a tool call an approval rule let through (#42).
   reader.rs answered omp's "Allow tool:" prompt itself; this row says which
   tool, and what the call does (the prompt's first detail line: command,
   path, action), with the prompt's full details one click away. The
   details are the tool's arguments, so they render as plain text, never
   markdown. Live-only and desktop-made (no `ts`), like job rows:
   get_messages' merge keeps it in place. Pure parts: app/approval.js. */

const { Icon: _AR_Icon, TOOL_META: _AR_TOOL_META } = window;
const { rowView: _AR_rowView } = window.OMP_APPROVAL;

const ApprovalRow = React.memo(function ApprovalRow({ msg, idx, highlighted }) {
  const [open, setOpen] = React.useState(false);
  const { color, icon, label } = _AR_TOOL_META.approval;
  const view = _AR_rowView(msg);
  const toggle = () => { if (view.expandable) setOpen(o => !o); };
  return (
    <div className={`row tool fade-up${highlighted ? " mm-hot" : ""}`} data-msg-idx={idx}>
      <div className="ass-rail">
        <div className="tool-glyph" style={{ borderColor: color, color }}>
          <_AR_Icon name={icon} size={11} color={color} />
        </div>
        <div className="ass-thread" />
      </div>
      <div className="tool-card ok approval-row-card">
        <div className={`tool-card-head${view.expandable ? " approval-row-toggle" : ""}`}
          role={view.expandable ? "button" : undefined}
          tabIndex={view.expandable ? 0 : undefined}
          aria-expanded={view.expandable ? open : undefined}
          onClick={toggle}
          onKeyDown={e => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); toggle(); } }}>
          <span className="tool-tag" style={{
            color,
            background: `color-mix(in oklab, ${color} 14%, transparent)`,
            borderColor: `color-mix(in oklab, ${color} 30%, var(--line))`,
          }}>{label}</span>
          <span className="tool-title approval-row-title" title={view.summary || undefined}>
            {msg.tool || "tool"}
            {view.summary && <span className="approval-row-summary"> · {view.summary}</span>}
          </span>
          <div className="tool-card-spacer" />
          <span className="chip muted mono approval-row-chip" title="answered by one of your approval rules">rule</span>
          {view.expandable && <_AR_Icon name={open ? "chev" : "chevR"} size={10} color="var(--fg-4)" />}
        </div>
        {open && view.expandable && (
          <div className="approval-row-details mono selectable">{msg.details}</div>
        )}
      </div>
    </div>
  );
});

Object.assign(window, { ApprovalRow });

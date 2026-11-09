/* widgets/widget-card.jsx — rail cards for widget plugins (user guide:
   docs/widgets.md). The card model is neutral — a title plus a `run`
   `{ state: "idle"|"running"|"ok"|"error", widget, error, durationMs, at,
   lastOkAt }` built by app/use-widgets.jsx — so other widget sources (#52)
   can reuse WidgetCard. Also the approval card a plugin shows until its
   exact command is approved, the card for a config-level error, and the
   per-card error boundary. Blocks come from widgets/widget-blocks.jsx. */

const { Icon: _WC_Icon, WidgetBlocks: _WC_Blocks, OMP_WIDGETS: { argvDisplay: _WC_argvDisplay } } = window;

function _wcTime(ms) {
  if (!ms) return "";
  const d = new Date(ms);
  return `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
}

function WidgetErrorCard({ title, error }) {
  return (
    <div className="rail-card glass wdg-card tone-error">
      <div className="rail-card-head">
        <span className="wdg-dot" />
        <span className="mono wdg-title">{title}</span>
      </div>
      <div className="wdg-error selectable">{error}</div>
    </div>
  );
}

/** `source`: set for content another program pushes (omp extensions, #52)
 *  rather than a plugin run — shown as the card's chip in place of the run
 *  timing, with the accent border. `attention`: the plugin's unacknowledged
 *  attention key (docs/widgets.md#attention); a click anywhere on the card
 *  calls `onAck`. */
function WidgetCard({ title, run, onRefresh, onInsert, insertCfg, source, attention, onAck }) {
  const state = run?.state ?? "idle";
  const widget = run?.widget ?? null;
  const stale = state === "running" && widget != null;
  const toneClass = state === "error" ? "tone-error" : (state === "ok" || stale) && widget ? `tone-${widget.status}` : "tone-neutral";
  const meta = source ?? (state === "running" ? "running…" : run?.durationMs != null ? `${run.durationMs} ms · ${_wcTime(run.at)}` : "");
  return (
    <div role={attention ? "group" : undefined} aria-label={attention ? `${title}: needs attention` : undefined}
      className={`rail-card glass wdg-card ${toneClass}${stale ? " wdg-stale" : ""}${source ? " wdg-pushed" : ""}${attention ? " wdg-attn" : ""}`}
      onClick={attention ? onAck : undefined}>
      <div className="rail-card-head">
        <span className={`wdg-dot${state === "running" ? " pulse-dot" : ""}`} />
        <span className="mono wdg-title">{title}</span>
        {meta ? <span className="chip muted mono wdg-meta">{meta}</span> : <span className="wdg-meta" />}
        {attention && (
          <button className="btn icon ghost wdg-ack" title={OMP_TR("Acknowledge")} aria-label={OMP_TR("Acknowledge")}
            onClick={(e) => { e.stopPropagation(); onAck?.(); }}>
            <_WC_Icon name="check" size={10} />
          </button>
        )}
        {onRefresh && (
          <button className="btn icon ghost" title={OMP_TR("refresh")} aria-label={`refresh ${title}`} disabled={state === "running"} onClick={onRefresh}>
            <_WC_Icon name="refresh" size={10} />
          </button>
        )}
      </div>
      {state === "error" && (
        <>
          <div className="wdg-error selectable">{run.error}</div>
          {run.lastOkAt != null && <div className="wdg-note mono">{OMP_TR("last ok")} {_wcTime(run.lastOkAt)}</div>}
        </>
      )}
      {(state === "ok" || stale) && widget && (
        <>
          <_WC_Blocks blocks={widget.blocks} onInsert={onInsert} insertCfg={insertCfg} />
          {widget.skipped > 0 && <div className="wdg-note mono">{window.OMP_I18N.plural(widget.skipped, "{n} unsupported block", "{n} unsupported blocks", { n: widget.skipped })}</div>}
        </>
      )}
      {state === "idle" && <div className="wdg-note mono">{OMP_TR("not run yet")}</div>}
    </div>
  );
}

/** A plugin that has never been approved, or whose command or script
 *  changed since (`changed`), runs nothing until the user approves its exact
 *  argv here. The argv is shown one element per line, quoted and escaped
 *  (OMP_WIDGETS.argvDisplay): this card is the only gate, so a newline, an
 *  empty argument or a bidi override must not change what the user reads. */
function WidgetApprovalCard({ title, command, changed, onApprove }) {
  const [busy, setBusy] = React.useState(false);
  const approve = () => {
    if (busy || !onApprove) return;
    setBusy(true);
    // The card unmounts once the approval lands; on a stale fingerprint it
    // stays and the button must work again.
    Promise.resolve()
      .then(onApprove)
      .catch((err) => console.error("[widgets] approve failed:", err))
      .finally(() => setBusy(false));
  };
  return (
    <div className={`rail-card glass wdg-card wdg-approval${changed ? " wdg-approval-changed" : ""}`}>
      <div className="rail-card-head">
        <span className="wdg-dot" />
        <span className="mono wdg-title">{title}</span>
        <span className="chip muted mono wdg-meta">{changed ? "changed" : "needs approval"}</span>
      </div>
      <div className="wdg-note">
        {changed
          ? "This plugin's command or script changed since you approved it. It will not run until you approve it again."
          : "This plugin runs the command below automatically once approved."}
      </div>
      <div className="wdg-argv mono selectable">
        {(command ?? []).map((arg, i) => <div key={i} className="wdg-argv-line">{_WC_argvDisplay(arg)}</div>)}
      </div>
      <div className="wdg-approval-actions">
        <button className="btn primary" disabled={busy || !onApprove} onClick={approve}>
          {changed ? "Approve again" : "Approve"}
        </button>
      </div>
    </div>
  );
}

/** Per-card error boundary: a render error in one card shows that card's
 *  error card instead of unmounting the app. A changed `resetKey` (e.g. a new
 *  run) clears the error and renders the children again. */
class WidgetBoundary extends React.Component {
  constructor(props) {
    super(props);
    this.state = { error: null };
  }

  static getDerivedStateFromError(error) {
    return { error };
  }

  componentDidCatch(error, info) {
    console.error(`[widgets] card "${this.props.title}" failed to render:`, error, info?.componentStack);
  }

  componentDidUpdate(prev) {
    if (this.state.error && prev.resetKey !== this.props.resetKey) this.setState({ error: null });
  }

  render() {
    const { error } = this.state;
    if (!error) return this.props.children;
    return <WidgetErrorCard title={this.props.title} error={`render failed: ${error?.message ?? String(error)}`} />;
  }
}

Object.assign(window, { WidgetCard, WidgetErrorCard, WidgetApprovalCard, WidgetBoundary });

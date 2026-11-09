/* widgets/widget-blocks.jsx — renderers for the fixed widget block types
   (contract: docs/widgets.md). Blocks arrive normalised by
   OMP_WIDGETS.parseOutput (app/widgets.js). Everything is text; nothing from
   a plugin is interpreted as HTML, and links open only through the bridge's
   navigation guard after a second safeUrl check. */

const { Icon: _WB_Icon, useSaNow: _WB_useNow } = window;
const { safeUrl: _wbSafeUrl, insertText: _wbInsertText, relativeTime: _wbRelativeTime, insertAction: _wbInsertAction, insertTitle: _wbInsertTitle } = window.OMP_WIDGETS;

/** Relative "time" labels are minute-granular, so a list re-renders once a
 *  minute — and only while it shows at least one timed item. */
const _WB_TIME_TICK_MS = 60_000;

function _wbOpen(url) {
  const safe = _wbSafeUrl(url);
  const open = window.OMP_BRIDGE?.openExternalUrl;
  if (!safe || !open) return;
  // openExternalUrl resolves to {ok, error} and does not throw; an open that
  // can't start (no xdg-open, guard refusal) must still leave a trace.
  Promise.resolve(open(safe)).then(
    (res) => { if (!res?.ok) console.error("[widgets] open failed:", res?.error); },
    (err) => console.error("[widgets] open failed:", err),
  );
}

function WidgetInsertButton({ text, onInsert, insertCfg }) {
  const title = _wbInsertTitle(insertCfg);
  return (
    <button className="btn icon ghost" title={title} aria-label={title} onClick={(e) => onInsert?.(text, _wbInsertAction(insertCfg, e.altKey))}>
      <_WB_Icon name="plus" size={9} />
    </button>
  );
}

function WidgetItem({ item, now, onInsert, insertCfg }) {
  const insert = _wbInsertText(item);
  const url = _wbSafeUrl(item.url);
  const timed = item.time != null;
  const itemTitle = [item.label, item.detail].filter(Boolean).join("\n");
  return (
    <div className={`wdg-item tone-${item.tone}`}>
      <span className="wdg-dot" />
      <span className="wdg-item-text" title={itemTitle || undefined}>
        <span className="wdg-item-label selectable">{item.label}</span>
        {item.detail && <span className="wdg-item-detail selectable">{item.detail}</span>}
      </span>
      {timed && (
        <span className="wdg-item-time mono" title={new Date(item.time).toISOString()}>
          {_wbRelativeTime(item.time, now)}
        </span>
      )}
      {(insert || url) && (
        <span className="wdg-item-actions">
          {insert && <WidgetInsertButton text={insert} onInsert={onInsert} insertCfg={insertCfg} />}
          {url && (
            <button className="btn icon ghost" title={url} aria-label={`open ${url}`} onClick={() => _wbOpen(url)}>
              <_WB_Icon name="external" size={9} />
            </button>
          )}
        </span>
      )}
    </div>
  );
}

function WidgetList({ block, onInsert, insertCfg }) {
  const [expanded, setExpanded] = React.useState(false);
  const { items, limit } = block;
  const shown = limit && !expanded && items.length > limit ? items.slice(0, limit) : items;
  const timed = shown.some((it) => it.time != null);
  const now = _WB_useNow(timed, _WB_TIME_TICK_MS);
  return (
    <>
      {block.title && <div className="wdg-section mono">{block.title}<span className="wdg-count">{items.length}</span></div>}
      <div className="wdg-list">
        {shown.map((it, i) => <WidgetItem key={i} item={it} now={now} onInsert={onInsert} insertCfg={insertCfg} />)}
        {shown.length < items.length && (
          <button className="btn ghost wdg-more" onClick={() => setExpanded(true)}>+{items.length - shown.length} {OMP_TR("more")}</button>
        )}
      </div>
    </>
  );
}

function WidgetLink({ block }) {
  const url = _wbSafeUrl(block.url);
  const label = block.label || url;
  // A link the parser could not vouch for (non-http, too long) is shown as
  // its label only — never as a button that would try to open it.
  if (!url) return label ? <div className="wdg-text selectable">{label}</div> : null;
  return (
    <button className="btn ghost wdg-link" title={url} onClick={() => _wbOpen(url)}>
      <_WB_Icon name="external" size={9} />
      <span className="wdg-link-label">{label}</span>
    </button>
  );
}

function WidgetBlock({ block, onInsert, insertCfg }) {
  switch (block.type) {
    case "status":
      return (
        <div className={`wdg-status tone-${block.tone}`}>
          <span className="wdg-dot" />
          <span className="mono wdg-label">{block.label}</span>
          <span className="wdg-value selectable">{block.value}</span>
        </div>
      );
    case "number":
      return (
        <div className="wdg-number">
          <span className="wdg-number-value mono">{block.value}</span>
          <span className="wdg-label">{block.unit ? `${block.unit} · ` : ""}{block.label}</span>
        </div>
      );
    case "progress":
      return (
        <div className="wdg-progress">
          <div className="wdg-label mono">{block.label} <span className="wdg-value">{block.value}/{block.max}</span></div>
          <div className="status-bar-tube wdg-tube"><div className="status-bar-fill" style={{ width: `${(block.value / block.max) * 100}%` }} /></div>
        </div>
      );
    case "text":
      // `mono` never comes from a plugin (parseOutput drops it): extension
      // widget lines (#52) are terminal lines, aligned for a fixed width.
      return (
        <div className="wdg-text-row">
          <div className={`wdg-text selectable${block.mono ? " mono" : ""}`}>{block.text}</div>
          {block.insert && <WidgetInsertButton text={block.insert} onInsert={onInsert} insertCfg={insertCfg} />}
        </div>
      );
    case "kv":
      return (
        <>
          {block.title && <div className="wdg-section mono">{block.title}</div>}
          <div className="wdg-kv">
            {block.rows.map((r, i) => (
              <React.Fragment key={i}>
                <span className="wdg-label mono">{r.k}</span>
                <span className="wdg-value selectable" title={r.v}>{r.v}</span>
              </React.Fragment>
            ))}
          </div>
        </>
      );
    case "list":
      return <WidgetList block={block} onInsert={onInsert} insertCfg={insertCfg} />;
    case "link":
      return <WidgetLink block={block} />;
    default:
      return null;
  }
}

// Memoised: the App re-renders on every streaming delta, while `blocks` is
// the cached parse of the last output (OMP_WIDGETS.parsedLast) and
// `onInsert` and `insertCfg` (the plugin's `insert` from widgets.json,
// undefined for extension widgets) keep their identity across App
// re-renders, so the blocks re-render only on a new result or a fresh
// plugins snapshot (a `widgets_state` refetch gives `insertCfg` a new
// identity). `onInsert(text, action)`: `action` from insertAction.
const WidgetBlocks = React.memo(function WidgetBlocks({ blocks, onInsert, insertCfg }) {
  window.OMP_I18N.useLocale();
  return <>{blocks.map((b, i) => <WidgetBlock key={i} block={b} onInsert={onInsert} insertCfg={insertCfg} />)}</>;
});

Object.assign(window, { WidgetBlocks });

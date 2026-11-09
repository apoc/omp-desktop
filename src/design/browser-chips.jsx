/* browser-chips.jsx — the annotation chips above the composer's attachment
   strip (docs/architecture/browser.md, "Annotate"): one chip per
   saved browser annotation, `#1 button.save — "overflows on mobile"`, with ×
   to remove. Styled as paste chips: the label is a button (when
   `onChipClick` is given; it scrolls the panel to the annotated element —
   the caller decides (app-live.jsx) whether the panel is on the page the
   chip was picked from) and the `#n selector` part is mono. `dropped` is
   how many chip screenshots would not fit the image cap if the message
   went out now; their text blocks still go. */

const { Icon: _BC_Icon } = window;
const { chipLabel: _BC_label, MAX_IMAGES: _BC_CAP } = window.OMP_BROWSER;

/** `#n selector` in mono, then the comment part of `chipLabel` as text. */
function _BC_Text({ chip }) {
  const label = _BC_label(chip);
  const cut = label.indexOf(" — ");
  if (cut < 0) return <span className="browser-chip-text mono">{label}</span>;
  return (
    <span className="browser-chip-text">
      <span className="mono">{label.slice(0, cut)}</span>{label.slice(cut)}
    </span>
  );
}

function BrowserChips({ chips, dropped = 0, onRemove, onChipClick }) {
  if (!chips.length) return null;
  return (
    <div className="browser-chips">
      {chips.map((c) => {
        const body = (<><_BC_Icon name="web" size={10} /><_BC_Text chip={c} /></>);
        return (
          <span className="paste-chip browser-chip" key={c.id} title={c.pick.url}>
            {onChipClick
              ? <button type="button" className="paste-chip-label browser-chip-label" onClick={() => onChipClick(c)}>{body}</button>
              : <span className="paste-chip-label browser-chip-label">{body}</span>}
            <button type="button" className="browser-chip-remove" title={OMP_TR("remove annotation")} aria-label={OMP_TR("remove annotation")}
              onClick={() => onRemove(c.id)}>
              <_BC_Icon name="close" size={9} />
            </button>
          </span>
        );
      })}
      {dropped > 0 && (
        <span className="browser-chips-note">
          {window.OMP_I18N.plural(dropped, "{n} screenshot", "{n} screenshots", { n: dropped })} · {OMP_TR("over the {cap}-image limit, the extras are not attached", { cap: _BC_CAP })}
        </span>
      )}
    </div>
  );
}

Object.assign(window, { BrowserChips });

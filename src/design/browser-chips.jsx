/* browser-chips.jsx — the annotation chips above the composer's attachment
   strip (docs/architecture/browser.md, "Annotate"): one chip per
   saved browser annotation, `#1 button.save — "overflows on mobile"`, with ×
   to remove. A chip click (`onChipClick`) scrolls the panel to the
   annotated element — the caller decides (app-live.jsx) whether the panel
   is on the page the chip was picked from. A reserved chip is on its way
   out with a message that has not settled yet (a second submit would ship
   it twice): it is dimmed and marked as in flight. `dropped` is how many
   chip screenshots would not fit the image cap if the message went out now; their text blocks still
   go. */

const { Icon: _BC_Icon } = window;
const { chipLabel: _BC_label, MAX_IMAGES: _BC_CAP } = window.OMP_BROWSER;

function BrowserChips({ chips, dropped = 0, onRemove, onChipClick }) {
  if (!chips.length) return null;
  return (
    <div className="browser-chips">
      {chips.map((c) => (
        <span className={`browser-chip${c.reserved ? " reserved" : ""}${onChipClick ? " clickable" : ""}`} key={c.id}
          title={c.reserved ? `${c.pick.url} — sending…` : c.pick.url}
          onClick={() => onChipClick?.(c)}>
          <_BC_Icon name="web" size={10} />
          <span className="browser-chip-text">{_BC_label(c)}</span>
          <button className="browser-chip-remove" title="remove annotation"
            onClick={e => { e.stopPropagation(); onRemove(c.id); }}>
            <_BC_Icon name="close" size={9} />
          </button>
        </span>
      ))}
      {dropped > 0 && (
        <span className="browser-chips-note">
          {dropped} screenshot{dropped === 1 ? "" : "s"} over the {_BC_CAP}-image limit will not be attached
        </span>
      )}
    </div>
  );
}

Object.assign(window, { BrowserChips });

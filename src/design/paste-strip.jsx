/* paste-strip.jsx — the long pastes collapsed in the composer's draft
   (#31). One chip per `[paste #N …]` token still in the text: the label
   toggles a read-only preview of the pasted text, "expand" turns the
   token back into editable text. Which preview is open is visual state
   only; composer.jsx re-keys this per tab, so it never carries over. */

const { Icon: _PS_Icon } = window;

function PasteStrip({ pastes, onExpand }) {
  const [openId, setOpenId] = React.useState(null);
  const open = pastes.find(p => p.id === openId) ?? null;
  // A preview whose token was deleted, expanded or sent closes for good:
  // ids restart after a send, so the next draft's paste #1 must not open
  // by itself.
  if (openId !== null && !open) setOpenId(null);
  if (!pastes.length) return null;
  return (
    <div className="paste-strip">
      <div className="paste-chips">
        {pastes.map(p => {
          const isOpen = p === open;
          return (
            <div className={`paste-chip${isOpen ? " open" : ""}`} key={p.id}>
              <button
                className="paste-chip-label"
                title={isOpen ? "hide pasted text" : "show pasted text"}
                aria-expanded={isOpen}
                aria-controls={isOpen ? "paste-preview" : undefined}
                onClick={() => setOpenId(isOpen ? null : p.id)}
              >
                <_PS_Icon name="file" size={11} color="var(--fg-3)" />
                <span className="mono">paste #{p.id}</span>
                <span className="paste-chip-meta">{p.lines} line{p.lines === 1 ? "" : "s"}</span>
                <_PS_Icon name={isOpen ? "chev" : "chevR"} size={10} color="var(--fg-4)" />
              </button>
              <button className="paste-chip-expand" title="put the pasted text into the prompt to edit it" onClick={() => onExpand(p.id)}>
                expand
              </button>
            </div>
          );
        })}
      </div>
      {open && (
        <pre id="paste-preview" className="paste-preview mono selectable" tabIndex={0} aria-label={`paste #${open.id}`}>
          {open.text}
        </pre>
      )}
    </div>
  );
}

Object.assign(window, { PasteStrip });

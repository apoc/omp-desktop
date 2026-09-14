/* mention-menu.jsx — dropdown shown above the composer while typing an
   `@file` mention. Purely presentational: fetching, debouncing, and
   keyboard handling live in composer.jsx; this component only renders
   `items` and reports picks/hovers back up. */

const { Icon: _MM_Icon } = window;

/** Split a project-relative path into its directory and basename parts,
 *  so the basename can be emphasised the way editors do it. */
function splitMentionPath(path) {
  const slash = path.lastIndexOf("/");
  return slash === -1
    ? { dir: "", base: path }
    : { dir: path.slice(0, slash + 1), base: path.slice(slash + 1) };
}

function MentionMenu({ items, activeIndex, onPick, onHover, listRef }) {
  if (!items.length) return null;
  return (
    <div className="mention-pop" role="listbox" id="mention-menu" ref={listRef}>
      {items.map((item, i) => {
        const { dir, base } = splitMentionPath(item.path);
        return (
          <button
            key={item.path}
            id={`mention-row-${i}`}
            role="option"
            aria-selected={i === activeIndex}
            className={`mention-row${i === activeIndex ? " active" : ""}`}
            onMouseEnter={() => onHover(i)}
            onMouseDown={(e) => { e.preventDefault(); onPick(item); }}
          >
            <_MM_Icon name={item.isDir ? "folder" : "file"} size={13} color="var(--fg-3)" />
            <span className="mono" style={{ color: "var(--fg)" }}>
              {dir && <span style={{ color: "var(--fg-4)" }}>{dir}</span>}
              <strong>{base}</strong>
              {item.isDir && <span style={{ color: "var(--fg-4)" }}>/</span>}
            </span>
          </button>
        );
      })}
    </div>
  );
}

Object.assign(window, { MentionMenu });

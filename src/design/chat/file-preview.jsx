/* ═════════════════════════════════════════════════════════════════════
   chat/file-preview.jsx — quick look at a project file (issue #39): a read
   card's target or a file link in the agent's text. Text highlighted, the
   read lines tinted and scrolled to; images shown whole. Read-only, a
   snapshot taken when it opens.

   Props: { target, onClose, onOpenGit, onComment }
     target    — { path, range } (app/file-preview.js readTarget/linkTarget)
     onClose   — Esc, the close button, a click on the scrim
     onOpenGit — path → the git browser on that file (the preview closes)
     onComment — (path, range) → the files panel on that file and range
                 (the preview closes); text files only

   Also exports FILE_STATES and FileState (the non-text states), which the
   files panel (design/files/) shows too.
   ═════════════════════════════════════════════════════════════════════ */
const { Icon: _FP_Icon, CopyButton: _FP_Copy, useModalLayer: _FP_useModalLayer } = window;
const {
  highlightLines: _FP_highlight, clipLines: _FP_clip,
  inRange: _FP_inRange, MAX_LINES: _FP_MAX_LINES, MAX_LINE_CHARS: _FP_MAX_LINE_CHARS,
} = window.OMP_FILE_PREVIEW;
const { formatBytes: _FP_size } = window.OMP_UPDATER;
const { toDataUrl: _FP_toDataUrl } = window.OMP_IMAGES;

// Lines kept above the first read line when scrolling to it.
const _FP_LEAD_LINES = 4;

// The non-content kinds of Rust's `FilePreview` (TooLarge's text names the
// size, below).
const FILE_STATES = {
  Binary:   { title: "Binary file", sub: "There is no text preview for this file." },
  TooLarge: { title: "Too large to preview" },
  Missing:  { title: "File no longer exists", sub: "It was deleted or moved after the agent touched it." },
  Outside:  { title: "Outside the project", sub: "The preview reads only files inside this tab's project folder." },
};

// Memoised: a re-render of the head (a copy click) must not rebuild every row.
const _FP_TextBody = React.memo(function _FP_TextBody({ path, text, range }) {
  const lines = React.useMemo(() => _FP_highlight(path, text, window.hljs), [path, text]);
  const bodyRef = React.useRef(null);
  React.useLayoutEffect(() => {
    if (!range) return;
    const row = bodyRef.current?.querySelector(`[data-ln="${Math.max(1, range.from - _FP_LEAD_LINES)}"]`);
    row?.scrollIntoView({ block: "start" });
  }, [lines, range]);
  const single = range?.to === range?.from;
  return (
    <div className="fp-lines mono hljs selectable" ref={bodyRef}>
      {lines.map((html, i) => {
        const n = i + 1;
        const hot = _FP_inRange(n, range) ? (single ? " is-target" : " is-read") : "";
        return (
          <div key={i} className={`fp-line${hot}`} data-ln={n}>
            <span className="fp-ln">{n}</span>
            <span className="fp-code" dangerouslySetInnerHTML={{ __html: html || " " }} />
          </div>
        );
      })}
    </div>
  );
});

function FileState({ title, sub }) {
  return (
    <div className="fp-state">
      <div>
        <div className="fp-state-title">{title}</div>
        <div className="fp-state-sub">{sub}</div>
      </div>
    </div>
  );
}

function FilePreview({ target, onClose, onOpenGit, onComment }) {
  // null while loading; then the bridge's `{ok, value | error}`.
  const [res, setRes] = React.useState(null);
  const scrimRef = React.useRef(null);
  // Whether the press began on the scrim: a drag-select out of the code
  // that ends there still clicks the scrim, and must not close the preview.
  const downOnScrim = React.useRef(false);

  React.useEffect(() => {
    let live = true;
    setRes(null);
    // `{ok, value | error}`, never a rejection (live.js `_invokeResult`).
    window.OMP_BRIDGE.readProjectFile(target.path)
      .then((r) => { if (live) setRes(r ?? { ok: false, error: "No tab is open." }); });
    return () => { live = false; };
  }, [target.path]);

  // Capture phase + preventDefault: the global keymap dispatcher skips
  // defaultPrevented events, so Esc closes the preview and nothing else.
  React.useEffect(() => {
    const onKey = (e) => {
      if (e.key !== "Escape") return;
      e.preventDefault();
      e.stopPropagation();
      onClose();
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [onClose]);

  // Modal, as the image lightbox: the app behind is inert, focus returns.
  _FP_useModalLayer(scrimRef);

  const value = res?.ok ? res.value : null;
  // Rust's project-relative path once known, the link's or card's before.
  const shownPath = value?.path ?? target.path;
  const slash = shownPath.search(/[^/\\]*$/);
  const state = value && FILE_STATES[value.kind];
  // A refused or unreadable path has nothing to open in the git browser.
  const openable = !res || (res.ok && value.kind !== "Outside");
  const clip = React.useMemo(() => (value?.kind === "Text" ? _FP_clip(value.text) : null), [value]);
  // Memoised: a rebuilt multi-megabyte data URL is one React has to compare.
  const imgSrc = React.useMemo(() => (value?.kind === "Image" ? _FP_toDataUrl(value) : null), [value]);
  const range = target.range;

  let body;
  if (!res) body = <div className="fp-state"><span className="shimmer-text">{OMP_TR("Loading…")}</span></div>;
  else if (!res.ok) body = <FileState title={OMP_TR("Can't preview this file")} sub={res.error} />;
  else if (state) {
    const sub = state.sub ? OMP_TR(state.sub) : OMP_TR("{size} is over the preview limit.", { size: _FP_size(value.size) });
    body = <FileState title={OMP_TR(state.title)} sub={sub} />;
  } else if (imgSrc) {
    body = (
      <div className="fp-img-wrap">
        <img src={imgSrc} alt={shownPath} />
      </div>
    );
  } else body = <_FP_TextBody path={shownPath} text={clip.text} range={range} />;

  return ReactDOM.createPortal(
    <div
      ref={scrimRef}
      className="fp-scrim"
      role="dialog"
      aria-modal="true"
      aria-label={OMP_TR("Preview of {path}", { path: shownPath })}
      tabIndex={-1}
      onMouseDown={(e) => { downOnScrim.current = e.target === e.currentTarget; }}
      onClick={(e) => {
        if (downOnScrim.current && e.target === e.currentTarget) onClose();
        downOnScrim.current = false;
      }}
    >
      <div className="fp-panel">
        <div className="fp-head">
          <_FP_Icon name={value?.kind === "Image" ? "image" : "file"} size={13} color="var(--cyan)" />
          <span className="fp-crumb mono" title={shownPath}>
            {shownPath.slice(0, slash)}<b>{shownPath.slice(slash)}</b>
          </span>
          {clip && <span className="chip muted mono">{clip.total} {OMP_TR("lines")}</span>}
          {clip?.truncated && (
            <span className="chip warn mono" title={OMP_TR("Shown: the first {n} lines, each cut at {m} characters", { n: _FP_MAX_LINES, m: _FP_MAX_LINE_CHARS })}>{OMP_TR("truncated")}</span>
          )}
          {value && value.kind !== "Missing" && value.kind !== "Outside" && <span className="chip muted mono">{_FP_size(value.size)}</span>}
          {value?.kind === "Text" && range && (
            <span className="chip accent mono">
              {range.to === range.from ? `line ${range.from}` : `read ${range.from}–${range.to}`}
            </span>
          )}
          <div className="fp-spacer" />
          <_FP_Copy className="fp-copy" label={OMP_TR("Copy the project-relative path")} text={shownPath} />
          {onComment && value?.kind === "Text" && (
            <button type="button" className="btn outlined fp-comment" onClick={() => onComment(shownPath, range ?? null)}
              title={OMP_TR("Explain or comment lines of this file in the files panel")}>
              <_FP_Icon name="edit" size={12} /> {OMP_TR("Comment in files panel")}
            </button>
          )}
          {openable && (
            <button type="button" className="btn outlined" onClick={() => onOpenGit(shownPath)} title={OMP_TR("Open in the git browser")}>
              <_FP_Icon name="branch" size={12} /> {OMP_TR("Open in git browser")}
            </button>
          )}
          <button type="button" className="btn ghost icon" onClick={onClose} title={OMP_TR("Close (Esc)")} aria-label={OMP_TR("Close")}>
            <_FP_Icon name="close" size={12} />
          </button>
        </div>
        <div className="fp-body">{body}</div>
      </div>
    </div>,
    document.body,
  );
}

Object.assign(window, { FilePreview, FILE_STATES, FileState });

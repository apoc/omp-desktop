/* ═════════════════════════════════════════════════════════════════════
   files/file-code.jsx — one file in the files panel
   (docs/architecture/file-comments.md): the file preview's highlighted
   rows (OMP_FILE_PREVIEW.highlightLines) plus a marker column, the tab's
   marks on this file, and the pick → explain / comment flow.

   Picking: press / drag / shift-click on the line numbers picks lines; a
   text selection in the code picks its lines and keeps the selected text.
   A pick shows a popup with "explain" (adds the mark at once) and
   "comment" (opens the form under the picked lines; one "comment" button
   or ⌘/Ctrl+↵ saves, Esc cancels). A saved mark tints its lines, numbers
   its first line and shows a card under its last one (edit, remove); a
   mark whose lines changed since shows "changed since".

   Props: { path, text, marks, target, onAdd, onUpdate, onRemove, onTargetDone }
     path    — Rust's folder-relative path (FilePreview.path)
     text    — the clipped text (OMP_FILE_PREVIEW.clipLines)
     marks   — the tab's marks on this file
     target  — { from, to, nonce } or null: scroll to and pick those lines,
               then `onTargetDone(nonce)` (the hook drops it)
     onAdd(mark), onUpdate(id, patch), onRemove(id) — the hook's actions
   Exported memoised: the app re-renders on every streamed frame, and a
   file has up to 20 000 rows; every prop is a stable reference.
   ═════════════════════════════════════════════════════════════════════ */
const { Icon: _FC_Icon } = window;
const { highlightLines: _FC_highlight } = window.OMP_FILE_PREVIEW;
const { isStale: _FC_isStale } = window.OMP_FILE_COMMENTS;

// Lines kept above a target when scrolling to it (the preview's lead).
const _FC_LEAD_LINES = 4;
// The popup sits this far above the pick's first line.
const _FC_POP_RISE = 34;

const _FC_Row = React.memo(function _FC_Row({ n, html, cls, badge, badgeKind }) {
  return (
    <div className={`fp-line${cls}`} data-ln={n}>
      <span className="fc-mark">{badge ? <span className={`fc-num ${badgeKind}`}>{badge}</span> : null}</span>
      <span className="fp-ln">{n}</span>
      <span className="fp-code" dangerouslySetInnerHTML={{ __html: html || " " }} />
    </div>
  );
});

const _fcRange = (m) => (m.to > m.from ? `${m.from}–${m.to}` : `${m.from}`);

function _FC_Card({ mark, stale, onEdit, onRemove }) {
  const head = (
    <>
      <span className="mono fc-card-ref">#{mark.n} · {_fcRange(mark)}</span>
      {mark.selection && <span className="mono fc-card-sel" title={mark.selection}>“{mark.selection}”</span>}
      {stale && <span className="chip warn fc-card-stale" title={OMP_TR("The marked lines changed since; the agent reads the file as it is now.")}>{OMP_TR("changed since")}</span>}
    </>
  );
  const remove = (
    <button type="button" className="btn ghost fc-card-btn" title={OMP_TR("remove")} aria-label={OMP_TR("remove")} onClick={onRemove}>
      <_FC_Icon name="trash" size={9} />
    </button>
  );
  if (mark.kind === "explain") {
    return (
      <div className="fc-card explain">
        {head}
        <span className="fc-card-kind"><_FC_Icon name="sparkle" size={10} /> {OMP_TR("explain")}</span>
        {remove}
      </div>
    );
  }
  return (
    <div className="fc-card">
      <div className="fc-card-head">
        {head}
        <span className="fc-spacer" />
        <button type="button" className="btn ghost fc-card-btn" title={OMP_TR("edit")} aria-label={OMP_TR("edit")} onClick={onEdit}>
          <_FC_Icon name="edit" size={9} />
        </button>
        {remove}
      </div>
      <div className="fc-card-text">{mark.text}</div>
    </div>
  );
}

function _FC_Form({ quote, initial, onSave, onCancel }) {
  const [text, setText] = React.useState(initial);
  const save = () => { if (text.trim()) onSave(text.trim()); };
  return (
    <div className="fc-form plan-comment-form">
      <div className="plan-comment-form-quote mono">{quote}</div>
      <textarea className="plan-comment-form-area" autoFocus value={text} placeholder={OMP_TR("your comment…")}
        onChange={e => setText(e.target.value)}
        onKeyDown={e => {
          if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) { e.preventDefault(); save(); }
          // Prevented: the keymap's Esc would interrupt the agent's turn. An
          // Esc ending an IME composition is the IME's.
          if (e.key === "Escape" && !e.nativeEvent.isComposing) { e.preventDefault(); onCancel(); }
        }} />
      <div className="plan-comment-form-foot">
        <span className="fc-spacer" />
        <button type="button" className="btn outlined" onClick={save} disabled={!text.trim()}>
          {OMP_TR("comment")} <span className="kbd">⌘↵</span>
        </button>
      </div>
    </div>
  );
}

function FileCode({ path, text, marks, target, onAdd, onUpdate, onRemove, onTargetDone }) {
  const html = React.useMemo(() => _FC_highlight(path, text, window.hljs), [path, text]);
  const raw = React.useMemo(() => text.split("\n"), [text]);
  // { from, to, selection, top, left }: the popup's lines and place.
  const [pick, setPick] = React.useState(null);
  // { from, to, selection, id?, text }: the open comment form (`id` when
  // it edits a mark).
  const [form, setForm] = React.useState(null);
  const linesRef = React.useRef(null);
  const anchor = React.useRef(null);
  const dragging = React.useRef(false);

  const lineOf = (node) => {
    const el = node?.nodeType === 3 ? node.parentElement : node;
    const row = el?.closest?.("[data-ln]");
    return row && linesRef.current?.contains(row) ? Number(row.dataset.ln) : null;
  };
  const rowBox = (n) => {
    const row = linesRef.current?.querySelector(`[data-ln="${n}"]`);
    return row ? { top: row.offsetTop, bottom: row.offsetTop + row.offsetHeight } : { top: 0, bottom: 0 };
  };
  // The popup above the pick, or under it when there is no room above in
  // the scrolled view.
  const popTop = (top, bottom) => {
    const scrolled = linesRef.current?.parentElement?.scrollTop ?? 0;
    return top - scrolled >= _FC_POP_RISE ? top - _FC_POP_RISE : bottom + 4;
  };
  // A pick takes the focus into the code (a line-number press prevents the
  // default, a target came from elsewhere), so its Esc is the panel's.
  const focusCode = () => linesRef.current?.focus({ preventScroll: true });
  const pickLines = (a, b) => {
    const from = Math.max(1, Math.min(a, b, raw.length));
    const to = Math.min(Math.max(a, b), raw.length);
    setPick({ from, to, selection: null, popTop: popTop(rowBox(from).top, rowBox(to).bottom), left: 72 });
  };
  const clearSelection = () => window.getSelection()?.removeAllRanges();

  // A drag over the line numbers ends wherever the button comes up.
  React.useEffect(() => {
    const up = () => { dragging.current = false; };
    window.addEventListener("mouseup", up);
    return () => window.removeEventListener("mouseup", up);
  }, []);

  // Esc drops a pick when it is not aimed elsewhere (focus in the panel or
  // nowhere), and is prevented so the keymap's Esc does not interrupt the
  // agent's turn; the form's textarea takes its own Esc. A press outside
  // the code drops it too.
  React.useEffect(() => {
    if (!pick) return undefined;
    const onKey = (e) => {
      if (e.key !== "Escape" || e.isComposing || e.defaultPrevented) return;
      const focus = document.activeElement;
      if (focus && focus !== document.body && !focus.closest?.(".fc-panel")) return;
      e.preventDefault();
      setPick(null);
    };
    // The code's scroller counts as inside: its scrollbars keep the pick.
    const onDown = (e) => { if (!linesRef.current?.parentElement?.contains(e.target)) setPick(null); };
    window.addEventListener("keydown", onKey, true);
    document.addEventListener("mousedown", onDown, true);
    return () => {
      window.removeEventListener("keydown", onKey, true);
      document.removeEventListener("mousedown", onDown, true);
    };
  }, [pick]);

  // An edit form whose mark went away (removed, cleared, sent) closes.
  React.useEffect(() => {
    if (form?.id && !marks.some(m => m.id === form.id)) setForm(null);
  }, [form, marks]);

  // A target (opened from the preview, a chat link or a chip): scrolled to
  // and picked once, then handed back so a remount does not repeat it.
  const done = React.useRef(null);
  React.useLayoutEffect(() => {
    if (!target || done.current === target.nonce) return;
    done.current = target.nonce;
    const row = linesRef.current?.querySelector(`[data-ln="${Math.max(1, target.from - _FC_LEAD_LINES)}"]`);
    row?.scrollIntoView({ block: "start" });
    setForm(null);
    anchor.current = target.from;
    pickLines(target.from, target.to);
    // After this commit's passive effects: a closing modal (the preview's
    // "Comment in files panel") lifts `inert` and returns focus to its
    // opener only then, and the focus must end in the code.
    requestAnimationFrame(focusCode);
    onTargetDone(target.nonce);
  }, [target, html]);

  const stale = React.useMemo(() => new Set(marks.filter(m => _FC_isStale(m, raw)).map(m => m.id)), [marks, raw]);
  // Per line: the tint kind (a comment wins over an explain), the mark
  // numbered on it, the marks whose card follows it.
  const lineInfo = React.useMemo(() => {
    const kind = new Map();
    const badge = new Map();
    const ends = new Map();
    for (const m of [...marks].sort((a, b) => a.n - b.n)) {
      const last = Math.min(m.to, raw.length);
      for (let n = m.from; n <= last; n++) if (kind.get(n) !== "comment") kind.set(n, m.kind);
      if (!badge.has(m.from)) badge.set(m.from, m);
      if (!ends.has(last)) ends.set(last, []);
      ends.get(last).push(m);
    }
    return { kind, badge, ends };
  }, [marks, raw.length]);

  const onMouseDown = (e) => {
    if (e.button !== 0 || e.target.closest(".fc-pop, .fc-card, .fc-form")) return;
    if (!e.target.closest(".fp-ln, .fc-mark")) { setPick(null); return; }
    const n = lineOf(e.target);
    if (!n) return;
    e.preventDefault();
    clearSelection();
    setForm(null);
    if (e.shiftKey && anchor.current) pickLines(anchor.current, n);
    else { anchor.current = n; pickLines(n, n); }
    focusCode();
    dragging.current = true;
  };
  const onMouseOver = (e) => {
    if (!dragging.current) return;
    const n = lineOf(e.target);
    if (n) pickLines(anchor.current, n);
  };
  // A text selection in the code: its lines and text. A selection ending
  // at the very start of a row (dragged down to whole lines) ends on the
  // row before.
  const onMouseUp = (e) => {
    if (dragging.current || e.target.closest(".fc-pop, .fc-card, .fc-form")) return;
    const sel = window.getSelection();
    if (!sel || sel.isCollapsed || !sel.rangeCount) return;
    const range = sel.getRangeAt(0);
    const from = lineOf(range.startContainer);
    let to = lineOf(range.endContainer);
    const selected = sel.toString();
    if (!from || !to || !selected.trim()) return;
    if (range.endOffset === 0 && to > from) to -= 1;
    const rect = range.getBoundingClientRect();
    const box = linesRef.current.getBoundingClientRect();
    setForm(null);
    anchor.current = from;
    setPick({
      from, to, selection: selected,
      popTop: popTop(rect.top - box.top, rect.bottom - box.top), left: Math.max(0, rect.left - box.left),
    });
  };

  const markOf = (p, kind, comment) => ({
    path, from: p.from, to: p.to, kind, text: comment, selection: p.selection,
    lines: raw.slice(p.from - 1, p.to),
  });
  const explain = () => {
    onAdd(markOf(pick, "explain", null));
    setPick(null);
    clearSelection();
  };
  const comment = () => {
    setForm({ from: pick.from, to: pick.to, selection: pick.selection, text: "" });
    setPick(null);
    clearSelection();
  };

  const quoteOf = (f) => {
    const what = f.selection ? `“${f.selection.replace(/\s+/g, " ").trim()}”` : raw[f.from - 1]?.trim() ?? "";
    return `${_fcRange(f)} · ${what}`;
  };
  // Keyed per mark: a form moved to another mark starts from that mark's text.
  const formEl = form && (
    <div key={`form:${form.id ?? "new"}`} className="fc-form-wrap">
      <_FC_Form quote={quoteOf(form)} initial={form.text} onCancel={() => setForm(null)}
        onSave={(t) => {
          if (form.id) onUpdate(form.id, { text: t });
          else onAdd(markOf(form, "comment", t));
          setForm(null);
        }} />
    </div>
  );

  const hot = form ?? pick;
  const rows = [];
  for (let i = 0; i < html.length; i++) {
    const n = i + 1;
    const k = lineInfo.kind.get(n);
    const cls = `${k ? ` has-${k}` : ""}${hot && n >= hot.from && n <= hot.to ? " is-picking" : ""}`;
    const b = lineInfo.badge.get(n);
    rows.push(<_FC_Row key={n} n={n} html={html[i]} cls={cls} badge={b?.n} badgeKind={b?.kind} />);
    for (const m of lineInfo.ends.get(n) ?? []) {
      rows.push(form?.id === m.id ? formEl : (
        <_FC_Card key={`c:${m.id}`} mark={m} stale={stale.has(m.id)}
          onEdit={() => { setPick(null); setForm({ id: m.id, from: m.from, to: m.to, selection: m.selection, text: m.text ?? "" }); }}
          onRemove={() => onRemove(m.id)} />
      ));
    }
    if (form && !form.id && form.to === n) rows.push(formEl);
  }

  return (
    <div className="fp-lines fc-lines mono hljs selectable" ref={linesRef} tabIndex={-1}
      onMouseDown={onMouseDown} onMouseOver={onMouseOver} onMouseUp={onMouseUp}>
      {rows}
      {pick && (
        <div className="fc-pop" style={{ top: pick.popTop, left: pick.left }}>
          <button type="button" className="btn ghost fc-pop-explain" onClick={explain}>
            <_FC_Icon name="sparkle" size={10} /> {OMP_TR("explain")}
          </button>
          <button type="button" className="btn ghost" onClick={comment}>
            <_FC_Icon name="edit" size={10} /> {OMP_TR("comment")}
          </button>
        </div>
      )}
    </div>
  );
}

window.FileCode = React.memo(FileCode);

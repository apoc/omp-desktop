/* ═════════════════════════════════════════════════════════════════════
   composer.jsx — input area + slash palette + ⌘K command bridge
   ═════════════════════════════════════════════════════════════════════ */

const { Icon } = window;
const { parseMentionQuery, applyMention } = window.OMP_MENTIONS;
const { prepareImage, imageFilesFromTransfer, imageFilesFromClipboardAsync, toDataUrl, MAX_ATTACHMENTS } = window.OMP_IMAGES;

// Thin wrappers around the shared `OMP_KEYMAP.hintFor`/`hintKeyFor` (display
// logic lives there so chrome.jsx's ⌘K/history hints can reuse it too,
// instead of each file re-deriving chord display independently). The guard
// here is the one thing that can't move: "registry not loaded yet"
// (`window.OMP_KEYMAP` absent — first render before keymap.js runs, should
// never happen in normal script order but guarded anyway) keeps showing
// `fallback`, distinct from "loaded but unbound" (the user cleared the
// binding), which `OMP_KEYMAP.hintFor`/`hintKeyFor` already report as `""`.
function hintFor(actionId, fallback) {
  return window.OMP_KEYMAP ? window.OMP_KEYMAP.hintFor(actionId) : fallback;
}
function hintKeyFor(actionId, fallback) {
  return window.OMP_KEYMAP ? window.OMP_KEYMAP.hintKeyFor(actionId) : fallback;
}

// ── The composer (input + plan/steer modes + send) ────────────────────
function Composer({ onSend, onPick, planMode, onTogglePlan, onOpenCmd, onOpenModel, currentModel, thinking, onCycleThinking, isStreaming, onAbort, onApprove, annotationCount = 0, microcopy, onFollowUp }) {
  const [text, setText]       = React.useState("");
  const [activeIdx, setActiveIdx] = React.useState(0);
  const taRef   = React.useRef(null);
  const listRef = React.useRef(null);
  // paste blocks: id → raw content; collapsed in textarea as [paste #N +K lines]
  const pasteBlocksRef   = React.useRef(new Map());
  const pasteCounterRef  = React.useRef(0);
  // Pending image attachments (icon-picked or pasted), sent alongside the
  // next message. Cleared on send. { id, name, image: ImageContent, src }[]
  const [attachments, setAttachments] = React.useState([]);
  // Count of prepareImage() calls still in flight — sendWith blocks while
  // this is nonzero so a fast Enter/click can't race ahead of an
  // in-progress paste/pick and send the text without its image (the image
  // would then land, orphaned, on the *next* message instead).
  const [pendingImages, setPendingImages] = React.useState(0);
  const attachCounterRef = React.useRef(0);
  const fileInputRef     = React.useRef(null);

  const cmds = window.OMP_DATA?.commands || [];

  // ── @-mention file-path autocomplete ─────────────────────────────────
  // Caret tracked separately from `text`: the mention token depends on
  // *where* the cursor sits, not just the text content — arrow-key/mouse
  // moves into an existing @token must re-derive it without an edit.
  const [caret, setCaret]                       = React.useState(0);
  const [mentionItems, setMentionItems]         = React.useState([]);
  const [mentionActiveIdx, setMentionActiveIdx] = React.useState(0);
  const [mentionDismissedKey, setMentionDismissedKey] = React.useState(null);
  const mentionListRef = React.useRef(null);
  const mentionReqRef  = React.useRef(0);

  const mentionRange = React.useMemo(() => parseMentionQuery(text, caret), [text, caret]);
  const mentionKey    = mentionRange ? `${mentionRange.start}:${mentionRange.query}` : null;
  const showMention   = mentionRange !== null && mentionItems.length > 0 && mentionDismissedKey !== mentionKey;

  // Debounced fetch — keyed on the query text, not the caret, so moving
  // the caret within an unchanged token never re-fires it. A monotonic
  // request id drops a response that lands after a newer query fired.
  React.useEffect(() => {
    // No active token — also forget any Escape-dismissal recorded for a
    // token that no longer exists, and invalidate any request already in
    // flight for it, so neither can resurrect stale items for an unrelated
    // later "@src" at the same offset (e.g. next message, or after fully
    // clearing the draft). A dismissal survives a same-offset backspace-
    // then-retype of the identical query, by design — Escape means "not
    // this exact text", and re-arriving at exactly that text should still
    // honor it until the query actually differs.
    if (!mentionRange) {
      mentionReqRef.current++;
      setMentionItems([]);
      setMentionDismissedKey(null);
      return;
    }
    const myReq = ++mentionReqRef.current;
    const timer = setTimeout(async () => {
      const items = await window.OMP_BRIDGE.listFiles(mentionRange.query, 30);
      if (mentionReqRef.current === myReq) { setMentionItems(items); setMentionActiveIdx(0); }
    }, 60);
    return () => clearTimeout(timer);
  }, [mentionRange?.query, mentionRange !== null]);

  // Derive slash state inline — no useEffect, no stale flicker.
  // Suppressed while the mention menu is showing: both can't render in
  // the same absolutely-positioned spot (e.g. "/plan add @src/foo.js").
  const slashQ = text.startsWith("/") ? text.slice(1).split(" ")[0].toLowerCase() : null;
  const filtered = slashQ !== null
    ? cmds.filter(c => !slashQ || c.name.startsWith(slashQ) || c.name.includes(slashQ))
    : [];
  const showSlash = filtered.length > 0 && !showMention;

  // Keep activeIdx in bounds; auto-select when single result
  const clampedIdx = showSlash ? Math.min(activeIdx, filtered.length - 1) : 0;

  // Scroll active item into view
  React.useEffect(() => {
    if (!showSlash || !listRef.current) return;
    const el = listRef.current.children[clampedIdx];
    el?.scrollIntoView({ block: "nearest" });
  }, [clampedIdx, showSlash]);

  // Scroll active mention row into view
  React.useEffect(() => {
    if (!showMention || !mentionListRef.current) return;
    const el = mentionListRef.current.children[mentionActiveIdx];
    el?.scrollIntoView({ block: "nearest" });
  }, [mentionActiveIdx, showMention]);

  React.useEffect(() => {
    const ta = taRef.current;
    if (!ta) return;
    ta.style.height = "auto";
    ta.style.height = `${Math.min(ta.scrollHeight, 320)}px`;
  }, [text]);

  // Restore focus when the agent finishes streaming and the textarea re-enables.
  React.useEffect(() => {
    if (!isStreaming) requestAnimationFrame(() => taRef.current?.focus());
  }, [isStreaming]);

  const execCmd = (cmd) => {
    setText("");
    setActiveIdx(0);
    setMentionDismissedKey(null);
    pasteBlocksRef.current.clear();
    pasteCounterRef.current = 0;
    onPick?.(cmd);
  };

  // The '@' itself is part of `insertText`, not just a display trigger:
  // the sent message keeps "@path/to/file" as a recognizable in-text file
  // reference (same convention as Claude Code's own @file mentions).
  // A directory pick's trailing '/' (no space) keeps the token "open" so
  // parseMentionQuery still matches it next render, re-querying one level
  // deeper — dropping the '@' here would silently break that, since the
  // token detector has nothing left to anchor on.
  //
  // A name containing whitespace or an embedded '@' can never stay
  // "open": parseMentionQuery stops its backward scan at the first space,
  // and separately rejects a query containing '@' (and an '@' preceded by
  // an ordinary character fails the token's own precursor check) — so
  // either character in the middle of the inserted path would make the
  // token permanently unrecoverable (drill-down silently dead for that
  // one directory, e.g. a Next.js parallel-route dir like `app/@modal`).
  // Closing normally instead still reaches nested entries — the backend
  // fuzzy-matches a full relative path in one query, so a fresh
  // "@dir with space/sub" from scratch works; drill-down is a
  // convenience, not a requirement.
  const pickMention = (item) => {
    if (!item || !mentionRange) return;
    const canStayOpen = item.isDir && !/[\s@]/.test(item.path);
    const insertText = canStayOpen ? `@${item.path}/` : `@${item.path} `;
    const { text: nextText, caret: nextCaret } = applyMention(text, mentionRange, insertText);
    setText(nextText);
    setCaret(nextCaret);
    requestAnimationFrame(() => {
      const ta = taRef.current;
      if (!ta) return;
      ta.selectionStart = ta.selectionEnd = nextCaret;
      ta.focus();
    });
  };

  // Expand [paste #N +K lines] tokens back to their real content before sending.
  const expandPastes = (txt) =>
    txt.replace(/\[paste #(\d+) \+\d+ lines?\]/g, (match, id) =>
      pasteBlocksRef.current.get(Number(id)) ?? match);

  // Route a completed draft through the full send pipeline. `dispatcher` is
  // either `onSend` (normal) or `onFollowUp` (follow-up); both get the same
  // paste-expansion, state-reset and focus-restore treatment. The slash-popup
  // shortcut only applies to a plain send — a follow-up must always send the
  // literal draft (plan §7: Ctrl+Q/Ctrl+Enter sends a follow-up even while a
  // '/' command is being typed), never silently reroute into executing the
  // highlighted palette command instead.
  const sendWith = (dispatcher, { followUp = false } = {}) => {
    if (showSlash && !followUp) { execCmd(filtered[clampedIdx]); return; }
    if (pendingImages > 0) return; // a paste/pick is still preparing — its image would ship on the *next* message instead
    // follow-up (`onFollowUp` dispatcher) requires non-empty text — annotations
    // are a send-only affordance (app-live.jsx merges them into the message).
    // Plain send can proceed with annotations or attached images alone.
    const canSend = followUp
      ? !!text.trim()
      : (text.trim() || attachments.length > 0 || (planMode && annotationCount > 0));
    if (!canSend) return;
    const images = attachments.map(a => a.image);
    dispatcher(expandPastes(text.trim()), images);
    setText("");
    setMentionDismissedKey(null);
    pasteBlocksRef.current.clear();
    pasteCounterRef.current = 0;
    setAttachments([]);
    requestAnimationFrame(() => taRef.current?.focus());
  };
  const send = () => sendWith(onSend);

  // Pick, downscale/re-encode and queue image files as pending attachments.
  // Silently drops files that fail to decode, and drops any that would push
  // the batch over MAX_ATTACHMENTS or MAX_TOTAL_ATTACH_BYTES, rather than
  // blocking the rest — same policy either way: keep what fits, drop the
  // rest of this paste/pick silently (the user can always attach the
  // dropped ones separately).
  const addFiles = async (fileList) => {
    const files = Array.from(fileList || []).filter(f => f.type.startsWith("image/"));
    const room  = MAX_ATTACHMENTS - attachments.length;
    if (files.length === 0 || room <= 0) return;
    const slice = files.slice(0, room);
    setPendingImages(n => n + slice.length);
    try {
      const prepared = await Promise.all(slice.map(async (file) => {
        try {
          const image = await prepareImage(file);
          return { id: `att-${++attachCounterRef.current}`, name: file.name, image, src: toDataUrl(image) };
        } catch {
          return null; // undecodable file — drop, don't block the rest of the batch
        }
      }));
      const ok = prepared.filter(Boolean);
      // Cap against the latest `prev`, not the `attachments` this call closed
      // over — a concurrent addFiles (fast double-paste) may have already
      // appended by the time this resolves.
      if (ok.length > 0) setAttachments(prev => [...prev, ...ok].slice(0, MAX_ATTACHMENTS));
    } finally {
      setPendingImages(n => n - slice.length);
    }
  };
  const removeAttachment = (id) => setAttachments(prev => prev.filter(a => a.id !== id));

  // Collapse long pastes into a token so the textarea stays navigable.
  // Threshold: more than 5 lines OR more than 500 characters. An image on
  // the clipboard is attached in every case; it only short-circuits the
  // text handling below when there's no accompanying text to preserve.
  const onPaste = (e) => {
    const imageFiles = imageFilesFromTransfer(e.clipboardData);
    const raw = e.clipboardData?.getData("text/plain") ?? "";
    if (imageFiles.length > 0) {
      addFiles(imageFiles);
      // Some sources (spreadsheet cells, rich-text apps) put a rendered
      // bitmap on the clipboard *alongside* real text — attach the image
      // but keep going into the text handling below instead of discarding
      // it. Only an image with no accompanying text short-circuits here.
      if (!raw) { e.preventDefault(); return; }
    } else {
      // WebKitGTK never puts image/* into the synchronous paste event's
      // DataTransfer (only text/*), so the extraction above always comes
      // back empty there for an image paste — fall back to the async
      // Clipboard API, which does see it. Fire-and-forget: there is no
      // synchronous default action to block when the sync DataTransfer
      // carried no image, and on engines where the sync path already
      // works this resolves to zero files and is a no-op.
      imageFilesFromClipboardAsync().then((files) => { if (files.length > 0) addFiles(files); });
    }
    const lines = raw.split("\n");
    if (lines.length <= 5 && raw.length <= 500) return; // short — let browser handle normally
    e.preventDefault();
    const id    = ++pasteCounterRef.current;
    pasteBlocksRef.current.set(id, raw);
    const token = `[paste #${id} +${lines.length} line${lines.length === 1 ? "" : "s"}]`;
    const ta    = taRef.current;
    const start = ta ? ta.selectionStart : text.length;
    const end   = ta ? ta.selectionEnd   : text.length;
    const next  = text.slice(0, start) + token + text.slice(end);
    setText(next);
    // Reposition cursor after the token on next frame (state not flushed yet).
    requestAnimationFrame(() => {
      if (!taRef.current) return;
      const pos = start + token.length;
      taRef.current.selectionStart = taRef.current.selectionEnd = pos;
      setCaret(pos);
    });
  };

  const onKey = (e) => {
    if (showMention) {
      if (e.key === "ArrowDown") { e.preventDefault(); setMentionActiveIdx(i => (i + 1) % mentionItems.length); return; }
      if (e.key === "ArrowUp")   { e.preventDefault(); setMentionActiveIdx(i => (i - 1 + mentionItems.length) % mentionItems.length); return; }
      if (e.key === "Escape")    { e.preventDefault(); setMentionDismissedKey(mentionKey); return; }
      if (e.key === "Tab" || (isSubmitEnter(e) && !e.shiftKey)) { e.preventDefault(); pickMention(mentionItems[mentionActiveIdx]); return; }
    }
    if (showSlash) {
      if (e.key === "ArrowDown")  { e.preventDefault(); setActiveIdx(i => Math.min(i + 1, filtered.length - 1)); return; }
      if (e.key === "ArrowUp")    { e.preventDefault(); setActiveIdx(i => Math.max(i - 1, 0)); return; }
      if (e.key === "Escape")     { e.preventDefault(); setText(""); return; }
      if (e.key === "Tab")        { e.preventDefault(); setActiveIdx(i => (i + 1) % filtered.length); return; }
    }
    // followUp must be checked before the plain-Enter branch: `ctrl+enter` is
    // a default followUp chord and `isSubmitEnter` would match it first.
    if (window.OMP_KEYMAP?.matches(e.nativeEvent ?? e, "app.message.followUp")) {
      e.preventDefault();
      if (onFollowUp) sendWith(onFollowUp, { followUp: true });
      return;
    }
    // isSubmitEnter (app/constants.js) owns the IME-composition guard.
    if (isSubmitEnter(e) && !e.shiftKey) { e.preventDefault(); send(); return; }
  };

  // Live keymap hints — computed once per render, reused across the
  // placeholder, title, kbd chips and footer so they can never disagree.
  const bridgeHint    = hintFor("desktop.commands.open", "⌘K");
  const bridgeKeyHint = hintKeyFor("desktop.commands.open", "K");
  const abortHint = hintFor("app.interrupt", "⎋");

  return (
    <div className={`composer ${planMode ? "plan-on" : ""}`}>
      {planMode && (
        <div className="plan-strip">
          <Icon name="plan" size={12} color="var(--amber)" />
          <span style={{ color: "var(--amber)" }}>plan mode</span>
          <span style={{ color: "var(--fg-3)" }}>· I'll draft before I write</span>
          <button className="btn ghost" onClick={onTogglePlan} style={{ marginLeft: "auto", height: 22 }}>exit</button>
        </div>
      )}

      {showSlash && (
        <div className="slash-pop" ref={listRef}>
          {filtered.map((c, i) => (
            <button key={c.name}
              className={`slash-row${i === clampedIdx ? " active" : ""}`}
              onMouseEnter={() => setActiveIdx(i)}
              onMouseDown={(e) => { e.preventDefault(); execCmd(c); }}>
              <span className="slash-glyph">{c.icon}</span>
              <span className="mono" style={{ color: "var(--accent)" }}>/{c.name}</span>
              <span style={{ color: "var(--fg-3)" }}>{c.hint}</span>
              <span className="chip muted" style={{ marginLeft: "auto" }}>{c.group}</span>
            </button>
          ))}
        </div>
      )}

      {showMention && (
        <MentionMenu
          items={mentionItems}
          activeIndex={mentionActiveIdx}
          onPick={pickMention}
          onHover={setMentionActiveIdx}
          listRef={mentionListRef}
        />
      )}

      {attachments.length > 0 && (
        <div className="attach-strip">
          {attachments.map(a => (
            <div className="attach-chip" key={a.id}>
              <img className="attach-thumb" src={a.src} alt={a.name || "attached image"} />
              <button className="attach-remove" title="remove" onClick={() => removeAttachment(a.id)}>
                <Icon name="close" size={9} />
              </button>
            </div>
          ))}
        </div>
      )}

      <div className="composer-row">
        <button className="btn icon ghost" title="attach image" onClick={() => fileInputRef.current?.click()}>
          <Icon name="image" size={13} />
        </button>
        <input
          ref={fileInputRef}
          type="file"
          accept="image/*"
          multiple
          style={{ display: "none" }}
          onChange={(e) => { addFiles(e.target.files); e.target.value = ""; }}
        />
        <button className="btn icon ghost" title="dictate">
          <Icon name="voice" size={13} />
        </button>
        <div className="composer-input">
          <textarea
            ref={taRef}
            rows="1"
            placeholder={
              planMode && !isStreaming
                ? (microcopy?.planTip ?? "describe what to build, or give feedback on the plan…")
                : isStreaming
                  ? microcopy?.streamingTip
                  : (microcopy?.paletteTip ?? `what should we ship?  ·  / for commands${bridgeHint ? `  ·  ${bridgeHint} for the bridge` : ""}`)
            }
            value={text}
            onChange={(e) => { setText(e.target.value); setCaret(e.target.selectionStart); }}
            onSelect={(e) => setCaret(e.target.selectionStart)}
            onKeyDown={onKey}
            onPaste={onPaste}
            className="selectable"
            role={showMention ? "combobox" : undefined}
            aria-expanded={showMention ? true : undefined}
            aria-controls={showMention ? "mention-menu" : undefined}
            aria-activedescendant={showMention ? `mention-row-${mentionActiveIdx}` : undefined}
          />
        </div>
        <button className="btn outlined" title={bridgeHint ? `open command bridge (${bridgeHint})` : "open command bridge"} onClick={onOpenCmd}>
          <Icon name="command" size={11} />
          {bridgeKeyHint && <span className="kbd" style={{ marginLeft: 2 }}>{bridgeKeyHint}</span>}
        </button>
        {isStreaming ? (
          <>
            {(text.trim() || attachments.length > 0) && (
              <button className="btn outlined" onClick={send} disabled={pendingImages > 0}
                style={{ color: "var(--amber)", borderColor: "color-mix(in oklab, var(--amber) 40%, var(--line))" }}>
                <Icon name="arrow" size={10} color="var(--amber)" /> steer
              </button>
            )}
            <button className="btn danger" onClick={onAbort}>
              <Icon name="stop" size={10} /> abort {abortHint && <span className="kbd">{abortHint}</span>}
            </button>
          </>
        ) : (
          <>
            {planMode && (
              <button className="btn outlined" onClick={onApprove}
                style={{ color: "var(--amber)", borderColor: "color-mix(in oklab, var(--amber) 40%, var(--line))" }}>
                <Icon name="play" size={10} color="var(--amber)" /> approve
              </button>
            )}
            <button className="btn primary" onClick={send}
              disabled={!(text.trim() || attachments.length > 0 || (planMode && annotationCount > 0)) || pendingImages > 0}>
              {planMode
                ? `send feedback${annotationCount > 0 ? ` · ${annotationCount} comment${annotationCount !== 1 ? "s" : ""}` : ""}`
                : "send"}
              {" "}<Icon name="arrow" size={11} />
            </button>
          </>
        )}
      </div>

      <div className="composer-foot">
        <button className="composer-pill" onClick={onOpenModel}>
          <span className="dot live" />
          <span style={{ color: "var(--fg-2)" }}>{currentModel?.name}</span>
          <Icon name="chev" size={10} color="var(--fg-4)" />
        </button>
        <button className="composer-pill" onClick={onCycleThinking}>
          <Icon name="thinking" size={11} color="var(--lilac)" />
          <span style={{ color: "var(--fg-2)" }}>thinking · {thinking}</span>
        </button>
        <button className={`composer-pill ${planMode ? "on" : ""}`} onClick={onTogglePlan}>
          <Icon name="plan" size={11} color={planMode ? "var(--amber)" : "var(--fg-3)"} />
          <span style={{ color: planMode ? "var(--amber)" : "var(--fg-2)" }}>plan mode</span>
        </button>
        <div style={{ flex: 1 }} />
        <span className="mono" style={{ color: "var(--fg-4)", fontSize: "var(--d-text-xs)" }}>
          {[
            ...(isStreaming && (text.trim() || attachments.length > 0) ? ["↵ steer"] : ["↵ send", "⇧↵ newline"]),
            // Dropped entirely when unbound rather than showing a keyless
            // "abort" segment that advertises a shortcut that isn't there.
            ...(abortHint ? [`${abortHint} abort`] : []),
          ].join(" · ")}
        </span>
      </div>
    </div>
  );
}

// ── ⌘K Command bridge — two views: commands → model picker ────────────
//
//  commands view  — lists all slash-commands; /model drills into picker
//  models view    — filterable model list; Esc returns to commands
//
function CommandBridge({ open, onClose, onPick, onPickModel, currentModelId, onPickLogin, loginProviders, initialView = "commands" }) {
  const [q, setQ]       = React.useState("");
  const [view, setView] = React.useState("commands");
  const inputRef = React.useRef(null);

  React.useEffect(() => {
    if (open) {
      setQ("");
      setView(initialView);
      setTimeout(() => inputRef.current?.focus(), 30);
    }
  }, [open]);

  React.useEffect(() => {
    const onKey = (e) => {
      if (e.key !== "Escape" || !open) return;
      if (view === "models") { if (initialView === "models") onClose(); else { setView("commands"); setQ(""); } }
      else if (view === "login") { if (initialView === "login") onClose(); else { setView("commands"); setQ(""); } }
      else onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open, onClose, view]);

  if (!open) return null;

  const fil    = (s) => s.toLowerCase().includes(q.toLowerCase());
  const models = window.OMP_DATA.models;

  // ── Model picker view ──────────────────────────────────────────────
  if (view === "models") {
    const modelHits = models.filter((m) => !q || fil(m.name) || fil(m.id));
    return (
      <div className="bridge-scrim" onClick={onClose}>
        <div className="bridge slide-in" onClick={(e) => e.stopPropagation()}>
          <div className="bridge-input-row">
            <button className="btn icon ghost" title="back"
              onClick={() => { setView("commands"); setQ(""); }}
              style={{ marginRight: 4 }}>
              <Icon name="chevR" size={12} color="var(--fg-3)"
                style={{ transform: "rotate(180deg)", display: "block" }} />
            </button>
            <input ref={inputRef} className="bridge-input mono"
              placeholder="filter models…" value={q}
              onChange={(e) => setQ(e.target.value)} />
            <span className="kbd">esc</span>
          </div>
          <div className="bridge-body">
            <div className="bridge-group">
              <div className="bridge-group-head mono" style={{ display: "flex", alignItems: "center", gap: 8 }}>
                switch model
                <span style={{ color: "var(--fg-4)" }}>
                  tauri:{window.__TAURI__ ? "✓" : "✗"}
                  · connected:{window.OMP_BRIDGE?.isConnected ? "✓" : "✗"}
                  · models:{window.OMP_DATA.models.length}
                </span>
                <button className="btn ghost" style={{ marginLeft: "auto", height: 18, fontSize: "var(--d-text-xs)", padding: "0 6px" }}
                  onClick={() => window.OMP_BRIDGE?.refreshModels()}>
                  refresh
                </button>
              </div>
              {modelHits.map((m) => (
                <button key={m.id}
                  className={`bridge-row ${m.id === currentModelId ? "active" : ""}`}
                  onClick={() => { onPickModel(m); onClose(); }}>
                  <span className="bridge-glyph">
                    {m.id === currentModelId
                      ? <Icon name="check" size={10} color="var(--accent)" />
                      : <Icon name="bolt"  size={10} color="var(--cyan)" />}
                  </span>
                  <span style={{ color: m.id === currentModelId ? "var(--accent)" : "var(--fg)" }}>{m.name}</span>
                  <span className="mono" style={{ color: "var(--fg-4)" }}>{m.id}</span>
                  <span style={{ color: "var(--fg-3)" }}>· {m.note}</span>
                  <span className="chip muted" style={{ marginLeft: "auto" }}>{m.latency}ms</span>
                </button>
              ))}
              {modelHits.length === 0 && <div className="bridge-empty">no models found</div>}
            </div>
          </div>
          <div className="bridge-foot mono">
            <span className="kbd">↑↓</span> navigate
            <span className="kbd">↵</span> switch
            <span className="kbd">esc</span> back
          </div>
        </div>
      </div>
    );
  }

  // ── Login view ───────────────────────────────────────────────────────────
  if (view === "login") {
    return (
      <div className="bridge-scrim" onClick={onClose}>
        <div className="bridge slide-in" onClick={(e) => e.stopPropagation()}>
          <div className="bridge-input-row">
            <button className="btn icon ghost" title="back"
              onClick={() => { setView("commands"); setQ(""); }}
              style={{ marginRight: 4 }}>
              <Icon name="chevR" size={12} color="var(--fg-3)"
                style={{ transform: "rotate(180deg)", display: "block" }} />
            </button>
            <span className="bridge-input mono" style={{ cursor: "default", lineHeight: "normal" }}>
              login
            </span>
            <span className="kbd">esc</span>
          </div>
          <div className="bridge-body">
            <div className="bridge-group">
              <div className="bridge-group-head mono">select provider</div>
              {loginProviders === null && (
                <div className="bridge-empty" style={{ padding: "16px 32px" }}>loading providers…</div>
              )}
              {loginProviders !== null && loginProviders.length === 0 && (
                <div className="bridge-empty">no providers available</div>
              )}
              {loginProviders !== null && loginProviders.map((p) => (
                <button key={p.id}
                  className={`bridge-row ${p.authenticated ? "active" : ""}`}
                  onClick={() => { if (p.available) { onPickLogin(p); onClose(); } }}>
                  <span className="bridge-glyph">
                    {p.authenticated
                      ? <Icon name="check" size={10} color="var(--accent)" />
                      : <Icon name="bolt"  size={10} color={p.available ? "var(--cyan)" : "var(--fg-5)"} />}
                  </span>
                  <span style={{ color: p.authenticated ? "var(--accent)" : p.available ? "var(--fg)" : "var(--fg-4)" }}>
                    {p.name}
                  </span>
                  <span className="mono" style={{ color: "var(--fg-4)" }}>{p.id}</span>
                  <span className="chip muted" style={{ marginLeft: "auto" }}>
                    {p.authenticated ? "logged in" : p.available ? "available" : "unavailable"}
                  </span>
                </button>
              ))}
            </div>
          </div>
          <div className="bridge-foot mono">
            <span className="kbd">↵</span> authenticate
            <span className="kbd">esc</span> back
          </div>
        </div>
      </div>
    );
  }

  // ── Commands view ──────────────────────────────────────────────────
  const cmds    = window.OMP_DATA.commands;
  const cmdHits = cmds.filter((c) => !q || fil(c.name) || fil(c.hint));
  const groups  = {};
  cmdHits.forEach((c) => { (groups[c.group] = groups[c.group] || []).push(c); });
  const activeModelName = models.find((m) => m.id === currentModelId)?.name ?? "–";

  return (
    <div className="bridge-scrim" onClick={onClose}>
      <div className="bridge slide-in" onClick={(e) => e.stopPropagation()}>
        <div className="bridge-input-row">
          <Icon name="command" size={14} color="var(--accent)" />
          <input ref={inputRef} className="bridge-input mono"
            placeholder="cross the bridge — type to filter…" value={q}
            onChange={(e) => setQ(e.target.value)} />
          <span className="kbd">esc</span>
        </div>
        <div className="bridge-body">
          {Object.entries(groups).map(([g, list]) => (
            <div key={g} className="bridge-group">
              <div className="bridge-group-head mono">{g.toLowerCase()}</div>
              {list.map((c) => {
                const isModel = c.name === "model";
                const isLogin = c.name === "login";
                const drillsIn = isModel || isLogin;
                return (
                  <button key={c.name} className="bridge-row"
                    onClick={() => {
                      if (isModel) { setQ(""); setView("models"); }
                      else if (isLogin) { setQ(""); setView("login"); }
                      else { onPick(c); onClose(); }
                    }}>
                    <span className="bridge-glyph">{c.icon}</span>
                    <span className="mono" style={{ color: "var(--accent)" }}>/{c.name}</span>
                    <span style={{ color: "var(--fg-3)" }}>{c.hint}</span>
                    {isModel && (
                      <span className="mono" style={{ color: "var(--fg-4)", marginLeft: "auto" }}>
                        {activeModelName}
                      </span>
                    )}
                    <Icon name={drillsIn ? "chevR" : "arrow"} size={11} color="var(--fg-4)"
                      style={{ marginLeft: drillsIn ? 8 : "auto" }} />
                  </button>
                );
              })}
            </div>
          ))}
          {cmdHits.length === 0 && (
            <div className="bridge-empty">no luck — try `plan`, `branch`, `model`…</div>
          )}
        </div>
        <div className="bridge-foot mono">
          <span className="kbd">↑↓</span> navigate
          <span className="kbd">↵</span> run
          <span className="kbd">esc</span> close
          <span style={{ marginLeft: "auto", color: "var(--fg-4)" }}>{window.OMP_DATA.microcopy.paletteTip}</span>
        </div>
      </div>
    </div>
  );
}

Object.assign(window, { Composer, CommandBridge });

/* ═════════════════════════════════════════════════════════════════════
   composer.jsx — input area + slash palette + ⌘K command bridge
   ═════════════════════════════════════════════════════════════════════ */

const { Icon } = window;

// ── The composer (input + plan/steer modes + send) ────────────────────
function Composer({ onSend, planMode, onTogglePlan, onOpenCmd, onOpenModel, currentModel, thinking, onCycleThinking, isStreaming, onAbort, microcopy }) {
  const [text, setText] = React.useState("");
  const [showSlash, setShowSlash] = React.useState(false);
  const taRef = React.useRef(null);
  const cmds = (window.OMP_DATA?.commands || []);
  const filtered = text.startsWith("/")
    ? cmds.filter((c) => c.name.startsWith(text.slice(1).toLowerCase()))
    : [];

  React.useEffect(() => {
    setShowSlash(text.startsWith("/") && filtered.length > 0);
  }, [text, filtered.length]);

  React.useEffect(() => {
    const ta = taRef.current;
    if (!ta) return;
    ta.style.height = "auto";
    ta.style.height = `${Math.min(ta.scrollHeight, 320)}px`;
  }, [text]);

  const send = () => {
    if (!text.trim() || isStreaming) return;
    onSend(text.trim());
    setText("");
  };

  const onKey = (e) => {
    if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); send(); }
    if (e.key === "Escape" && isStreaming) { onAbort(); }
    if (e.key === "k" && (e.metaKey || e.ctrlKey)) { e.preventDefault(); onOpenCmd(); }
  };

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
        <div className="slash-pop">
          {filtered.map((c) => (
            <button key={c.name} className="slash-row"
              onMouseDown={(e) => { e.preventDefault(); setText(`/${c.name} `); taRef.current?.focus(); }}>
              <span className="slash-glyph">{c.icon}</span>
              <span className="mono" style={{ color: "var(--accent)" }}>/{c.name}</span>
              <span style={{ color: "var(--fg-3)" }}>{c.hint}</span>
              <span className="chip muted" style={{ marginLeft: "auto" }}>{c.group}</span>
            </button>
          ))}
        </div>
      )}

      <div className="composer-row">
        <button className="btn icon ghost" title="attach image">
          <Icon name="image" size={13} />
        </button>
        <button className="btn icon ghost" title="dictate">
          <Icon name="voice" size={13} />
        </button>
        <div className="composer-input">
          <textarea
            ref={taRef}
            rows="1"
            placeholder={isStreaming ? microcopy.streamingTip : "what should we ship?  ·  / for commands  ·  ⌘K for the bridge"}
            value={text}
            onChange={(e) => setText(e.target.value)}
            onKeyDown={onKey}
            disabled={isStreaming && !text}
            className="selectable"
          />
        </div>
        <button className="btn outlined" title="open command bridge (⌘K)" onClick={onOpenCmd}>
          <Icon name="cmd" size={11} />
          <span className="kbd" style={{ marginLeft: 2 }}>K</span>
        </button>
        {isStreaming ? (
          <button className="btn danger" onClick={onAbort}>
            <Icon name="stop" size={10} /> abort <span className="kbd">⎋</span>
          </button>
        ) : (
          <button className="btn primary" onClick={send} disabled={!text.trim()}>
            send <Icon name="arrow" size={11} />
          </button>
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
          ↵ send · ⇧↵ newline · ⎋ abort
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
function CommandBridge({ open, onClose, onPick, onPickModel, currentModelId }) {
  const [q, setQ]       = React.useState("");
  const [view, setView] = React.useState("commands");
  const inputRef = React.useRef(null);

  React.useEffect(() => {
    if (open) {
      setQ("");
      setView("commands");
      setTimeout(() => inputRef.current?.focus(), 30);
    }
  }, [open]);

  React.useEffect(() => {
    const onKey = (e) => {
      if (e.key !== "Escape" || !open) return;
      if (view === "models") { setView("commands"); setQ(""); }
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
          <Icon name="cmd" size={14} color="var(--accent)" />
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
                return (
                  <button key={c.name} className="bridge-row"
                    onClick={() => {
                      if (isModel) { setQ(""); setView("models"); }
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
                    <Icon name={isModel ? "chevR" : "arrow"} size={11} color="var(--fg-4)"
                      style={{ marginLeft: isModel ? 8 : "auto" }} />
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

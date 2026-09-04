/* ═════════════════════════════════════════════════════════════════════
   history-modal.jsx — Conversation history modal & session resume
   Allows browsing and restoring sessions from ~/.omp/agent/sessions/
   ═════════════════════════════════════════════════════════════════════ */

const { Icon } = window;

function formatRelativeTime(ts) {
  if (!ts) return "—";
  const date = new Date(ts);
  if (isNaN(date.getTime())) return ts;
  const now = new Date();
  const diffSec = Math.floor((now - date) / 1000);
  if (diffSec < 60) return "just now";
  if (diffSec < 3600) return `${Math.floor(diffSec / 60)}m ago`;
  if (diffSec < 86400) return `${Math.floor(diffSec / 3600)}h ago`;
  if (diffSec < 604800) return `${Math.floor(diffSec / 86400)}d ago`;
  return date.toLocaleDateString();
}

function HistoryModal({ open, onClose, onResume, activeCwd }) {
  const [sessions, setSessions]       = React.useState([]);
  const [loading, setLoading]         = React.useState(false);
  const [filterScope, setFilterScope] = React.useState("all"); // 'all' | 'current'
  const [query, setQuery]             = React.useState("");
  const [activeIdx, setActiveIdx]     = React.useState(0);
  const inputRef                      = React.useRef(null);
  const listRef                       = React.useRef(null);

  const fetchSessions = React.useCallback(async () => {
    if (!window.OMP_BRIDGE?.listSavedSessions) return;
    setLoading(true);
    try {
      const list = await window.OMP_BRIDGE.listSavedSessions();
      setSessions(list || []);
    } catch (err) {
      console.error("[HistoryModal] Failed to list sessions:", err);
      setSessions([]);
    } finally {
      setLoading(false);
    }
  }, []);

  // Fetch when opened
  React.useEffect(() => {
    if (open) {
      setQuery("");
      setActiveIdx(0);
      fetchSessions();
      setTimeout(() => inputRef.current?.focus(), 50);
    }
  }, [open, fetchSessions]);

  // Normalize path for comparison
  const normPath = p => (p || "").replace(/\\/g, "/").replace(/\/+$/, "").toLowerCase();
  const currentProjectName = activeCwd
    ? normPath(activeCwd).split("/").pop() || "current"
    : "current";

  // Filtered session list
  const filtered = React.useMemo(() => {
    let list = sessions;
    if (filterScope === "current" && activeCwd) {
      const activeNorm = normPath(activeCwd);
      list = list.filter(s => normPath(s.cwd) === activeNorm);
    }
    if (!query.trim()) return list;
    const q = query.toLowerCase().trim();
    return list.filter(s =>
      (s.title && s.title.toLowerCase().includes(q)) ||
      (s.project_name && s.project_name.toLowerCase().includes(q)) ||
      (s.cwd && s.cwd.toLowerCase().includes(q)) ||
      (s.preview && s.preview.toLowerCase().includes(q))
    );
  }, [sessions, filterScope, activeCwd, query]);

  // Keep activeIdx in bounds
  const clampedIdx = filtered.length > 0
    ? Math.min(Math.max(0, activeIdx), filtered.length - 1)
    : 0;

  // Scroll active item into view
  React.useEffect(() => {
    if (!listRef.current) return;
    const el = listRef.current.children[clampedIdx];
    el?.scrollIntoView({ block: "nearest" });
  }, [clampedIdx]);

  // Keyboard navigation
  React.useEffect(() => {
    if (!open) return;
    const onKey = (e) => {
      if (e.key === "Escape") {
        e.preventDefault();
        onClose();
      } else if (e.key === "ArrowDown") {
        e.preventDefault();
        setActiveIdx(i => Math.min(i + 1, filtered.length - 1));
      } else if (e.key === "ArrowUp") {
        e.preventDefault();
        setActiveIdx(i => Math.max(i - 1, 0));
      } else if (e.key === "Enter") {
        if (filtered[clampedIdx]) {
          e.preventDefault();
          onResume?.(filtered[clampedIdx]);
          onClose();
        }
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open, onClose, onResume, filtered, clampedIdx]);

  if (!open) return null;

  const currentCount = sessions.filter(s => activeCwd && normPath(s.cwd) === normPath(activeCwd)).length;

  return (
    <div className="bridge-scrim" onClick={onClose} style={{ paddingTop: "8vh" }}>
      <div className="bridge slide-in" onClick={e => e.stopPropagation()} style={{ width: "min(740px, calc(100vw - 32px))", maxHeight: "80vh" }}>
        
        {/* Header */}
        <div className="bridge-input-row" style={{ padding: "12px 16px", gap: 10 }}>
          <Icon name="clock" size={16} color="var(--accent)" />
          <input
            ref={inputRef}
            className="bridge-input mono"
            placeholder="Search saved conversations by title, query, project…"
            value={query}
            onChange={e => { setQuery(e.target.value); setActiveIdx(0); }}
          />
          {query && (
            <button className="btn icon ghost" title="Clear search" onClick={() => setQuery("")}>
              <Icon name="close" size={10} color="var(--fg-4)" />
            </button>
          )}
          <button className="btn icon ghost" title="Refresh from disk" onClick={fetchSessions}>
            <Icon name="refresh" size={11} color={loading ? "var(--accent)" : "var(--fg-3)"} />
          </button>
          <span className="kbd">esc</span>
        </div>

        {/* Scope bar */}
        <div style={{
          display: "flex", alignItems: "center", gap: 8,
          padding: "6px 14px",
          borderBottom: "1px solid var(--line)",
          background: "var(--bg-surface)",
          fontSize: "var(--d-text-xs)",
        }}>
          <span className="mono" style={{ color: "var(--fg-4)", marginRight: 4 }}>filter:</span>
          <button
            className={`btn ${filterScope === "all" ? "accent outlined" : "ghost"}`}
            style={{ height: 22, padding: "0 8px", fontSize: "var(--d-text-xs)" }}
            onClick={() => { setFilterScope("all"); setActiveIdx(0); }}>
            All Projects ({sessions.length})
          </button>
          {activeCwd && (
            <button
              className={`btn ${filterScope === "current" ? "accent outlined" : "ghost"}`}
              style={{ height: 22, padding: "0 8px", fontSize: "var(--d-text-xs)" }}
              onClick={() => { setFilterScope("current"); setActiveIdx(0); }}>
              {currentProjectName} ({currentCount})
            </button>
          )}
          <div style={{ flex: 1 }} />
          <span className="mono" style={{ color: "var(--fg-4)" }}>
            {filtered.length} {filtered.length === 1 ? "session" : "sessions"}
          </span>
        </div>

        {/* List Body */}
        <div ref={listRef} className="bridge-body" style={{ maxHeight: "56vh", padding: "6px 8px" }}>
          {loading && sessions.length === 0 && (
            <div className="bridge-empty">Scanning disk for saved sessions…</div>
          )}

          {!loading && filtered.length === 0 && (
            <div className="bridge-empty">
              {query
                ? `No sessions found matching "${query}"`
                : "No saved sessions found on disk"}
            </div>
          )}

          {filtered.map((s, idx) => {
            const isSelected = idx === clampedIdx;
            const timeStr = formatRelativeTime(s.updated_at || s.timestamp);
            return (
              <div
                key={s.path || s.id || idx}
                className={`bridge-row ${isSelected ? "active" : ""}`}
                style={{
                  display: "flex", flexDirection: "column", alignItems: "stretch", gap: 5,
                  padding: "10px 14px", margin: "2px 0",
                  borderRadius: 10, cursor: "pointer",
                  border: isSelected ? "1px solid color-mix(in oklab, var(--accent) 30%, var(--line))" : "1px solid transparent",
                  background: isSelected ? "var(--bg-hover)" : "transparent",
                  transition: "background 0.12s, border-color 0.12s",
                }}
                onMouseEnter={() => setActiveIdx(idx)}
                onClick={() => {
                  onResume?.(s);
                  onClose();
                }}>
                
                {/* Top line: title + relative time */}
                <div style={{ display: "flex", alignItems: "center", gap: 8, width: "100%" }}>
                  <Icon name="context" size={12} color={isSelected ? "var(--accent)" : "var(--fg-3)"} />
                  <span style={{
                    fontWeight: 550,
                    color: isSelected ? "var(--accent)" : "var(--fg)",
                    fontSize: "var(--d-text-sm)",
                    flex: 1, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap",
                  }}>
                    {s.title}
                  </span>
                  <span className="mono" style={{ color: "var(--fg-4)", fontSize: "var(--d-text-xs)", flexShrink: 0 }}>
                    {timeStr}
                  </span>
                </div>

                {/* Second line: project chip, message count, and cwd */}
                <div style={{ display: "flex", alignItems: "center", gap: 6, width: "100%" }}>
                  <span className="chip" style={{
                    padding: "1px 6px",
                    background: "color-mix(in oklab, var(--cyan) 10%, transparent)",
                    borderColor: "color-mix(in oklab, var(--cyan) 25%, var(--line))",
                    color: "var(--cyan)",
                    fontSize: "var(--d-text-xs)",
                  }}>
                    <Icon name="folder" size={9} color="var(--cyan)" />
                    <span className="mono">{s.project_name}</span>
                  </span>

                  {s.message_count > 0 && (
                    <span className="chip muted mono" style={{ fontSize: "var(--d-text-xs)", padding: "1px 6px" }}>
                      {s.message_count} {s.message_count === 1 ? "turn" : "turns"}
                    </span>
                  )}

                  {s.cwd && (
                    <span className="mono" style={{
                      color: "var(--fg-4)", fontSize: "var(--d-text-xs)",
                      flex: 1, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap",
                    }}>
                      {s.cwd}
                    </span>
                  )}

                  <button
                    className="btn ghost accent"
                    style={{ height: 20, padding: "0 8px", fontSize: "var(--d-text-xs)", marginLeft: "auto", flexShrink: 0 }}
                    onClick={(e) => {
                      e.stopPropagation();
                      onResume?.(s);
                      onClose();
                    }}>
                    Resume ↵
                  </button>
                </div>

                {/* Third line: preview snippet */}
                {s.preview && (
                  <div style={{
                    color: "var(--fg-3)", fontSize: "var(--d-text-xs)",
                    lineHeight: "1.35",
                    paddingLeft: 20,
                    overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap",
                  }}>
                    {s.preview}
                  </div>
                )}
              </div>
            );
          })}
        </div>

        {/* Footer */}
        <div className="bridge-foot mono" style={{ display: "flex", alignItems: "center", gap: 8 }}>
          <span className="kbd">↑↓</span> navigate
          <span className="kbd">↵</span> resume in new tab
          <span className="kbd">esc</span> close
          <div style={{ flex: 1 }} />
          <span style={{ color: "var(--fg-4)" }}>~/.omp/agent/sessions</span>
        </div>
      </div>
    </div>
  );
}

window.HistoryModal = HistoryModal;

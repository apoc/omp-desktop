/* Context inventory is a read-only view of observations, not execution controls. */
const _CI_TABS = [
  ["all", "All context"],
  ["skills", "Skills"],
  ["tools", "Tools"],
  ["calls", "Calls"],
  ["instructions", "Instructions"],
  ["memory", "Memory"],
];

function _CI_details(agent, ctx) {
  const details = agent?.details;
  if (!details) return null;
  if (agent.id === "main") {
    if (ctx?.status === "refreshing") return null;
    if (
      ctx?.modelKey &&
      details.model &&
      `${details.model.provider}/${details.model.id}` !== ctx.modelKey
    )
      return null;
  }
  return details;
}

function _CI_groups(agent, details) {
  if (!agent) return [];
  const groups = [];
  const used = new Map(
    (agent.skills || []).map((skill) => [skill.name, skill]),
  );
  const retained = details?.retainedSkills;
  const skillItem = (entry, historical = false) => {
    const observed = used.get(entry.name);
    return {
      kind: "skill",
      entry,
      typeLabel: "Skill",
      badge: entry.origin?.badge,
      used:
        historical ||
        !!(
          observed &&
          (!observed.path || !entry.path || observed.path === entry.path)
        ),
      retained: Array.isArray(retained) ? retained.includes(entry.name) : null,
    };
  };
  const historical = (agent.skills || []).map((entry) =>
    skillItem(entry, true),
  );
  if (historical.length)
    groups.push({
      id: "skills:used",
      category: "skills",
      label: "Used this session",
      items: historical,
    });
  for (const group of agent.skillGroups || []) {
    const items = (group.entries || []).map((entry) => skillItem(entry));
    if (items.length)
      groups.push({
        id: `skills:${group.id}`,
        category: "skills",
        label: group.label,
        items,
      });
  }
  const byServer = new Map();
  for (const entry of details?.tools || []) {
    const label = entry.server
      ? `MCP · ${entry.server}`
      : entry.source === "mcp"
        ? "MCP · server unknown"
        : "Other tools";
    if (!byServer.has(label)) byServer.set(label, []);
    byServer.get(label).push({
      kind: "tool",
      entry,
      typeLabel: "Tool definition",
      badge: entry.server || entry.source || "Unknown",
    });
  }
  for (const [label, items] of byServer)
    groups.push({ id: `tools:${label}`, category: "tools", label, items });
  const callsByServer = new Map();
  for (const entry of details?.calls || []) {
    const label = entry.server ? `MCP calls · ${entry.server}` : "Other calls";
    if (!callsByServer.has(label)) callsByServer.set(label, []);
    callsByServer
      .get(label)
      .push({ kind: "call", entry, typeLabel: "Call", badge: entry.status });
  }
  for (const [label, items] of callsByServer)
    groups.push({ id: `calls:${label}`, category: "calls", label, items });
  const instructions = (agent.instructions || []).map((entry) => ({
    kind: "instruction",
    entry,
    typeLabel: "Loaded instruction",
    badge: "Instruction",
  }));
  if (instructions.length)
    groups.push({
      id: "instructions:loaded",
      category: "instructions",
      label: "Loaded instructions",
      items: instructions,
    });
  const prompts = (details?.systemPrompt || []).map((entry) => ({
    kind: "prompt",
    entry,
    typeLabel: "System prompt section",
    badge: "System prompt",
  }));
  if (prompts.length)
    groups.push({
      id: "instructions:prompt",
      category: "instructions",
      label: "System prompt",
      items: prompts,
    });
  const blocks = (details?.memory?.blocks || []).map((entry) => ({
    kind: "memory",
    entry,
    typeLabel: "Memory block",
    badge: details.memory.backend || "Memory",
  }));
  if (blocks.length)
    groups.push({
      id: "memory:blocks",
      category: "memory",
      label: "Observed memory blocks",
      items: blocks,
    });
  return groups.map((group) => ({
    ...group,
    items: group.items.map((item, index) => ({
      ...item,
      key: `${group.id}:${item.kind}:${item.entry.id ?? item.entry.name ?? index}`,
    })),
  }));
}

function ContextInspector({
  ctx,
  context,
  readSkill,
  onSelectAgent,
  onOpenSubagents,
  onJumpToCall,
  messages,
  viewState,
  onViewStateChange,
  onClose,
}) {
  const agents = context?.agents || [];
  const agentId =
    viewState.agentId ??
    agents.find((a) => a.id === "main")?.id ??
    agents[0]?.id ??
    "main";
  const tab = viewState.tab || "all";
  const query = viewState.query || "";
  const usedOnly = !!viewState.usedOnly;
  const expanded = viewState.expanded || {};
  const searchExpanded = viewState.searchExpanded || {};
  const [selection, setSelection] = React.useState(null);
  const scrimRef = React.useRef(null);
  const detailRef = React.useRef(null);
  const itemRef = React.useRef(null);
  const downOnScrim = React.useRef(false);
  window.useModalLayer(scrimRef);
  const agent = agents.find((candidate) => candidate.id === agentId);
  const details = _CI_details(agent, ctx);
  const usage = !agent
    ? null
    : agent.id === "main"
      ? {
          tokens: ctx?.status === "ready" ? ctx?.used : null,
          contextWindow: ctx?.total,
        }
      : {
          tokens: details?.usage?.tokens,
          contextWindow:
            details?.usage?.contextWindow ?? details?.model?.contextWindow,
        };
  const formatTokens = (value) =>
    typeof value === "number" && Number.isFinite(value)
      ? value.toLocaleString()
      : "—";
  const groups = _CI_groups(agent, details);
  const allItems = groups.flatMap((group) => group.items);
  const selected = allItems.find((item) => item.key === selection?.key);
  const selectedFingerprint = selected ? JSON.stringify(selected) : null;
  // The pane is never allowed to keep an item from a previous model or observation.
  const currentSelection =
    selectedFingerprint === selection?.fingerprint &&
    selection?.agentId === agentId &&
    selection?.modelKey === ctx?.modelKey &&
    selection?.status === ctx?.status
      ? selected
      : null;
  React.useEffect(() => {
    if (selection && !currentSelection) {
      const hadFocus = detailRef.current?.contains(document.activeElement);
      setSelection(null);
      if (hadFocus)
        requestAnimationFrame(() => {
          const target = itemRef.current;
          if (target?.isConnected && target.getClientRects().length)
            target.focus({ preventScroll: true });
          else scrimRef.current?.focus({ preventScroll: true });
        });
    }
  }, [selection, currentSelection]);
  React.useEffect(() => {
    if (currentSelection) detailRef.current?.focus({ preventScroll: true });
  }, [selection?.key]);
  React.useEffect(() => {
    const onKey = (event) => {
      if (event.key !== "Escape") return;
      event.preventDefault();
      event.stopPropagation();
      onClose();
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [onClose]);
  const needle = query.trim().toLocaleLowerCase();
  const visible = groups
    .filter((group) => tab === "all" || group.category === tab)
    .map((group) => ({
      ...group,
      items: group.items.filter((item) => {
        if (usedOnly && item.kind === "skill" && !item.used) return false;
        if (!needle) return true;
        return [
          item.entry.name,
          item.entry.description,
          item.entry.source,
          item.entry.server,
          item.entry.tool,
          item.entry.path,
          item.entry.origin?.badge,
          item.entry.origin?.label,
          item.entry.origin?.root,
          group.label,
        ].some(
          (value) =>
            typeof value === "string" &&
            value.toLocaleLowerCase().includes(needle),
        );
      }),
    }))
    .filter((group) => group.items.length);
  const unavailable =
    !details &&
    (ctx?.status === "refreshing" && agent?.id === "main"
      ? "Refreshing current model context…"
      : "Detailed context is unavailable for this observation.");
  const toolsUnavailable =
    !!details &&
    (details.toolsAvailable === false ||
      (details.toolsAvailable == null && !details.tools?.length));
  const memory = details?.memory;
  const modalKeyDown = (event) => {
    if (event.key !== "Tab") return;
    const nodes = [
      ...scrimRef.current.querySelectorAll(
        'button:not([disabled]), input:not([disabled]), select:not([disabled]), [tabindex]:not([tabindex="-1"])',
      ),
    ].filter((node) => node.getClientRects().length);
    if (!nodes.length) {
      event.preventDefault();
      scrimRef.current.focus();
      return;
    }
    const first = nodes[0],
      last = nodes[nodes.length - 1];
    if (
      event.shiftKey &&
      (document.activeElement === first ||
        document.activeElement === scrimRef.current)
    ) {
      event.preventDefault();
      last.focus();
    } else if (
      !event.shiftKey &&
      (document.activeElement === last ||
        document.activeElement === scrimRef.current)
    ) {
      event.preventDefault();
      first.focus();
    }
  };
  return ReactDOM.createPortal(
    <div
      ref={scrimRef}
      className="fp-scrim ci-scrim"
      role="dialog"
      aria-modal="true"
      aria-label="Context inspector"
      tabIndex={-1}
      onKeyDown={modalKeyDown}
      onMouseDown={(event) => {
        downOnScrim.current = event.target === event.currentTarget;
      }}
      onClick={(event) => {
        if (downOnScrim.current && event.target === event.currentTarget)
          onClose();
        downOnScrim.current = false;
      }}
    >
      <div className="fp-panel ci-panel">
        <header className="ci-header">
          <div>
            <span className="ci-eyebrow">Read-only inventory</span>
            <h1>Context inspector</h1>
          </div>
          <div className="ci-header-usage">
            <span>{agent?.label || "Agent"} · usage / capacity</span>
            <strong className="mono">
              {formatTokens(usage?.tokens)} /{" "}
              {formatTokens(usage?.contextWindow)}
            </strong>
            <span>
              tokens
              {agent?.id === "main" && ctx?.status === "refreshing"
                ? " · refreshing"
                : ""}
            </span>
          </div>
          <button type="button" className="btn ghost" onClick={onClose}>
            Close
          </button>
        </header>
        <div className="ci-controls">
          <label>
            Agent{" "}
            <select
              value={agent?.id || ""}
              onChange={(event) => {
                const agentId = event.target.value;
                onViewStateChange((prev) => ({ ...prev, agentId }));
                setSelection(null);
              }}
            >
              {!agent && <option value="">Agent unavailable</option>}
              {agents.map((entry) => (
                <option key={entry.id} value={entry.id}>
                  {entry.label}
                  {entry.id !== "main" ? " · subagent" : ""}
                </option>
              ))}
            </select>
          </label>
          {agent?.id !== "main" &&
            agent &&
            typeof onSelectAgent === "function" && (
              <button
                type="button"
                className="btn ghost"
                onClick={() => {
                  onClose();
                  onSelectAgent(agent.id);
                }}
              >
                Open subagent
              </button>
            )}
          {typeof onOpenSubagents === "function" && (
            <button
              type="button"
              className="btn ghost"
              onClick={() => {
                onClose();
                onOpenSubagents();
              }}
            >
              Open Subagents
            </button>
          )}
          <label className="ci-search">
            Search{" "}
            <input
              type="search"
              value={query}
              onChange={(event) => {
                const query = event.target.value;
                onViewStateChange((prev) => ({
                  ...prev,
                  query,
                  ...(!query.trim() ? { searchExpanded: {} } : {}),
                }));
                setSelection(null);
              }}
              placeholder="Name, description or source"
            />
          </label>
        </div>
        <nav className="ci-tabs" aria-label="Context categories">
          {_CI_TABS.map(([id, label]) => (
            <button
              key={id}
              type="button"
              aria-pressed={tab === id}
              onClick={() => {
                onViewStateChange((prev) => ({ ...prev, tab: id }));
                setSelection(null);
              }}
            >
              {label}
            </button>
          ))}
        </nav>
        <div
          className={`ci-columns${currentSelection ? " ci-has-detail" : ""}`}
        >
          <div className="ci-list" aria-label="Context items">
            {agent?.note && <p className="ci-state">{agent.note}</p>}
            {unavailable && (
              <p className="ci-state" role="status">
                {unavailable}
              </p>
            )}
            {toolsUnavailable && (tab === "all" || tab === "tools") && (
              <p className="ci-state" role="status">
                Tool definitions are unavailable in this observation.
              </p>
            )}
            {(tab === "skills" || tab === "all") && (
              <label className="ci-filter">
                <input
                  type="checkbox"
                  checked={usedOnly}
                  onChange={(event) => {
                    const usedOnly = event.target.checked;
                    onViewStateChange((prev) => ({ ...prev, usedOnly }));
                    setSelection(null);
                  }}
                />{" "}
                Skills used this session only
              </label>
            )}
            {(tab === "memory" || tab === "all") && (
              <p className="ci-state">
                Memory:{" "}
                {!memory
                  ? "unavailable"
                  : memory.status === "off"
                    ? "off"
                    : memory.status === "unavailable"
                      ? "unavailable"
                      : `ready${memory.backend ? ` · ${memory.backend}` : ""}`}
                {memory?.note ? ` — ${memory.note}` : ""}
              </p>
            )}
            {visible.map((group) => {
              const open = needle
                ? searchExpanded[group.id] !== false
                : expanded[group.id] !== false;
              return (
                <section className="ci-group" key={group.id}>
                  <button
                    type="button"
                    className="ci-group-title"
                    aria-expanded={open}
                    onClick={() => {
                      const field = needle ? "searchExpanded" : "expanded";
                      onViewStateChange((prev) => ({
                        ...prev,
                        [field]: { ...prev[field], [group.id]: !open },
                      }));
                    }}
                  >
                    <span>
                      {open ? "▾" : "▸"} {group.label}
                    </span>
                    <span className="mono">{group.items.length}</span>
                  </button>
                  {open && (
                    <ul>
                      {group.items.map((item) => (
                        <li key={item.key}>
                          <button
                            type="button"
                            className={`ci-item${currentSelection?.key === item.key ? " selected" : ""}`}
                            onClick={(event) => {
                              itemRef.current = event.currentTarget;
                              setSelection({
                                key: item.key,
                                fingerprint: JSON.stringify(item),
                                agentId,
                                modelKey: ctx?.modelKey,
                                status: ctx?.status,
                              });
                            }}
                          >
                            <span className="ci-item-copy">
                              <strong>{item.entry.name}</strong>
                              {item.entry.description && (
                                <small>{item.entry.description}</small>
                              )}
                            </span>
                            {item.badge && (
                              <span className="ci-badge">{item.badge}</span>
                            )}
                            {item.kind === "skill" && item.used && (
                              <span
                                className="ci-used"
                                title="Used this session"
                              >
                                used
                              </span>
                            )}
                          </button>
                        </li>
                      ))}
                    </ul>
                  )}
                </section>
              );
            })}
            {!visible.length &&
              !(tab === "tools" && toolsUnavailable && !needle) && (
                <p className="ci-state">
                  {needle
                    ? "No matching context items."
                    : agent?.status === "loading"
                      ? "Loading context…"
                      : !details &&
                          (tab === "tools" ||
                            tab === "calls" ||
                            tab === "memory")
                        ? "Items are not available in this observation."
                        : "No observed items in this view."}
                </p>
              )}
          </div>
          <div
            className="ci-detail"
            ref={detailRef}
            tabIndex={-1}
            aria-live="polite"
          >
            <window.ContextDetail
              item={currentSelection}
              agentId={agentId}
              readSkill={readSkill}
              messages={messages}
              onJumpToCall={onJumpToCall}
              onClose={onClose}
              onBack={() => {
                setSelection(null);
                requestAnimationFrame(() =>
                  itemRef.current?.focus({ preventScroll: true }),
                );
              }}
            />
          </div>
        </div>
      </div>
    </div>,
    document.body,
  );
}
Object.assign(window, { ContextInspector, OMP_CONTEXT_DETAILS: _CI_details });

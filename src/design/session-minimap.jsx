// Transcript heatmap; scrolls after three rows, independent of rail height.
// ── Minimap of the session: dense grid, one cell per message ─────────
// Hue encodes role/tool color (same palette as the chat). For assistant
// messages, opacity is log-scaled by tokens used so expensive turns pop
// against cheap ones. Click scrolls the chat to that message; hover
// highlights it via shared hoveredIdx state.
function _MM_ToolLegend() {
  const { StatusDetail, TOOL_META } = window;
  const { tools, swatch } = React.useMemo(() => {
    const tools = Object.entries(TOOL_META).map(([name, meta]) => ({
      name:
        name === "ask"
          ? "ask tool"
          : name === "approval"
            ? "auto-approved"
            : name,
      color: meta.color,
    }));
    tools.push({ name: "other tools", color: "var(--fg-4)" });
    const colors = [...new Set(tools.map((tool) => tool.color))];
    const stops = colors.map(
      (color, i) =>
        `${color} ${(i * 100) / colors.length}% ${((i + 1) * 100) / colors.length}%`,
    );
    return { tools, swatch: `conic-gradient(${stops.join(", ")})` };
  }, [TOOL_META]);

  return (
    <StatusDetail
      className="minimap-legend-item"
      text={`Tool and event colors: ${tools.map((tool) => tool.name).join(", ")}.`}
      detail={
        <>
          <strong className="minimap-color-key-title">
            Tool &amp; event colors
          </strong>
          <span className="minimap-color-key">
            {tools.map((tool) => (
              <span className="minimap-color-key-item" key={tool.name}>
                <i aria-hidden="true" style={{ background: tool.color }} />
                {tool.name}
              </span>
            ))}
          </span>
        </>
      }
    >
      <i
        aria-hidden="true"
        className="minimap-tool-swatch"
        style={{ background: swatch }}
      />
      tool
    </StatusDetail>
  );
}

function SessionMinimap({ messages, hoveredIdx, onHover, onClick }) {
  const { Icon, TOOL_META } = window;
  // Log-scaled max across assistant messages so heatmap variance is
  // visible even when one compaction turn dwarfs the rest.
  const { maxTokens, shown } = React.useMemo(() => {
    let max = 0;
    let n = 0;
    for (const m of messages) {
      if (window.OMP_TURN_STATUS.isHidden(m)) continue; // the chat hides it too
      n++;
      if (m.kind === "assistant" && m.tokens && m.tokens > max) max = m.tokens;
    }
    return { maxTokens: max, shown: n };
  }, [messages]);
  const logMax = Math.log10(maxTokens + 1) || 1;

  return (
    <div className="minimap">
      <div className="minimap-head">
        <Icon name="minimap" size={11} color="var(--fg-3)" />
        <span className="mono" style={{ color: "var(--fg-3)" }}>
          session
        </span>
        <span
          className="mono"
          style={{ marginLeft: "auto", color: "var(--fg-4)" }}
        >
          {shown}
        </span>
      </div>
      <div className="minimap-grid">
        {messages.map((m, i) => {
          if (window.OMP_TURN_STATUS.isHidden(m)) return null;
          let hue = "var(--fg-5)";
          if (m.kind === "user") hue = "var(--fg-2)";
          else if (m.kind === "assistant")
            hue = m.failure ? "var(--rose)" : "var(--accent)";
          else if (m.kind === "ask") hue = "var(--amber)";
          else if (m.kind === "retry") hue = TOOL_META.retry.color;
          else if (m.kind === "tool")
            hue = TOOL_META[m.tool]?.color || "var(--fg-4)";
          else if (m.kind === "job") hue = TOOL_META.job.color;
          else if (m.kind === "goal") hue = TOOL_META.goal.color;
          else if (m.kind === "approval") hue = TOOL_META.approval.color;

          // Brightness: assistant cells modulate by log(tokens), others flat.
          let opacity = 0.7;
          if (m.kind === "assistant" && m.tokens && maxTokens > 0) {
            const t = Math.log10(m.tokens + 1) / logMax;
            opacity = 0.4 + 0.6 * Math.max(0, Math.min(1, t));
          }

          // Per-kind tooltip — tools don't carry their own tokens (the
          // LLM cost lives on the assistant message that invoked them),
          // so they get tool-specific info instead of a token chip.
          let title;
          if (m.kind === "assistant" && m.failure) {
            title = `request failed${m.failure.httpStatus != null ? ` · HTTP ${m.failure.httpStatus}` : ""}${m.time ? " · " + m.time : ""}`;
          } else if (m.kind === "assistant") {
            const tok = m.tokens ? `${m.tokens.toLocaleString()} tok` : "—";
            const inOut =
              m.tokensIn != null || m.tokensOut != null
                ? ` (${(m.tokensIn ?? 0).toLocaleString()} in · ${(m.tokensOut ?? 0).toLocaleString()} out)`
                : "";
            title = `assistant · ${tok}${inOut}${m.time ? " · " + m.time : ""}`;
          } else if (m.kind === "tool") {
            const dur = m.duration
              ? ` · ${(m.duration / 1000).toFixed(1)}s`
              : "";
            const status =
              m.status === "running"
                ? " · running"
                : m.status === "ok"
                  ? ""
                  : ` · ${m.status}`;
            title = `${m.tool ?? "tool"}${m.title ? " " + m.title : ""}${dur}${status}`;
          } else if (m.kind === "user") {
            const preview = m.text
              ? ` · ${m.text.slice(0, 80)}${m.text.length > 80 ? "…" : ""}`
              : "";
            title = `you${preview}`;
          } else if (m.kind === "job") {
            title = `${m.jobId} finished${m.label ? " · " + m.label : ""}`;
          } else if (m.kind === "retry") {
            title = `retrying · attempt ${m.attempt}${m.maxAttempts ? " of " + m.maxAttempts : ""}`;
          } else if (m.kind === "goal") {
            title = window.OMP_GOAL.rowView(m).title;
          } else if (m.kind === "approval") {
            title = `auto-approved · ${m.tool || "tool"}`;
          } else {
            title = m.kind;
          }
          const cls =
            `minimap-cell ${m.kind} ${m.streaming ? "live" : ""} ${hoveredIdx === i ? "hot" : ""}`.trim();

          return (
            <button
              type="button"
              key={m._id ?? i}
              className={cls}
              style={{ background: hue, opacity }}
              title={title}
              aria-label={title}
              onMouseEnter={() => onHover?.(i)}
              onMouseLeave={() => onHover?.(null)}
              onFocus={() => onHover?.(i)}
              onBlur={() => onHover?.(null)}
              onClick={() => onClick?.(i)}
            />
          );
        })}
      </div>
      <div className="minimap-legend">
        <span className="minimap-legend-item">
          <i aria-hidden="true" style={{ background: "var(--fg-2)" }} />
          you
        </span>
        <span className="minimap-legend-item">
          <i
            aria-hidden="true"
            className="minimap-assistant-swatch"
            style={{ background: "var(--accent)" }}
          />
          assistant
        </span>
        <span className="minimap-legend-item">
          <i aria-hidden="true" style={{ background: "var(--amber)" }} />
          ask
        </span>
        <_MM_ToolLegend />
      </div>
    </div>
  );
}

window.SessionMinimap = SessionMinimap;

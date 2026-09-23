/* subagents/subagent-inspector.jsx — one agent, in depth. Rendered inside
   SubagentPane's column. Three views:
     activity   — what it was asked, what it is doing now, metrics, tool timeline
     output     — progress.recentOutput plus the `subagent_event` stream
                  (populated only while the RPC subscription is "events")
     transcript — the agent's persisted session, via `get_subagent_messages`
   Transcript loading is owned by the caller (`transcript` / `onLoadTranscript`). */

const { Icon: _SAI_Icon, OMP_SUBAGENTS: _SAI, SaToolChip: _SAI_ToolChip, SaStatusChip: _SAI_StatusChip,
  SaContextTube: _SAI_Tube, SaGlyph: _SAI_Glyph, saHueStyle: _SAI_hue, saModelName: _SAI_model } = window;

function SaMetric({ k, v }) {
  return <div className="sa-stat"><span className="sa-stat-k">{k}</span><span className="sa-stat-v" title={String(v)}>{v}</span></div>;
}

// omp sends both `recentTools` and `recentOutput` newest-first (unshift /
// slice(-8).reverse()). Tools read best newest-first (a "what just
// happened" list); output reads as a log, so it is flipped to chronological.
function SaActivity({ agent: a, now }) {
  const p = a.progress;
  const recent = p?.recentTools ?? [];
  return (
    <>
      {a.description && <div><div className="sa-block-k">task</div><div className="sa-desc">{a.description}</div></div>}
      {a.assignment && <div><div className="sa-block-k">assignment</div><pre className="sa-assign selectable">{a.assignment}</pre></div>}

      {a.status === "running" && p?.currentTool && (
        <div className="card sa-now">
          <div className="sa-block-k"><span className="dot live" /> now</div>
          <div className="sa-now-row">
            <_SAI_ToolChip tool={p.currentTool} running />
            <span className="sa-args">{p.currentToolArgs}</span>
            <span className="sa-elapsed" style={{ marginLeft: "auto" }}>
              {p.currentToolStartMs ? _SAI.fmtDuration(now - p.currentToolStartMs) : ""}
            </span>
          </div>
          {p.lastIntent && <span className="sa-intent shimmer-text">{p.lastIntent}</span>}
        </div>
      )}

      <div className="sa-metrics">
        <SaMetric k="tokens" v={window.formatTokens(p?.tokens ?? 0)} />
        <SaMetric k="cost" v={_SAI.fmtCost(p?.cost ?? 0)} />
        <SaMetric k="wall" v={_SAI.fmtDuration(_SAI.elapsedMs(a, now))} />
        <SaMetric k="tools" v={p?.toolCount ?? 0} />
        <SaMetric k="requests" v={p?.requests ?? 0} />
        <SaMetric k="model" v={_SAI_model(p?.resolvedModel)} />
        {p?.contextTokens && p?.contextWindow ? (
          <div className="sa-ctx">
            <span>context</span><_SAI_Tube progress={p} />
            <span>{window.formatTokens(p.contextTokens)} / {window.formatTokens(p.contextWindow)}</span>
          </div>
        ) : null}
      </div>

      <div>
        <div className="sa-block-k">recent tools</div>
        {recent.length === 0 ? <div className="sa-empty">No tool calls yet.</div> : (
          <div className="sa-timeline">
            {recent.map(r => (
              <div key={`${r.endMs}:${r.tool}:${r.args}`} className="sa-tl-row">
                <span className="sa-tl-t">{_SAI.fmtAgo(now - r.endMs)}</span>
                <_SAI_ToolChip tool={r.tool} />
                <span className="sa-args" title={r.args}>{r.args}</span>
              </div>
            ))}
          </div>
        )}
      </div>
    </>
  );
}

function SaOutput({ agent: a, level }) {
  const lines = [...(a.progress?.recentOutput ?? [])].reverse();
  return (
    <>
      <div>
        <div className="sa-block-k">recent output</div>
        {lines.length === 0 ? <div className="sa-empty">No output yet.</div> : (
          <div className="sa-out selectable">
            {lines.map((l, i) => <div key={i} className="ta-stream-line">{l || "\u00a0"}</div>)}
          </div>
        )}
      </div>
      <div>
        <div className="sa-block-k">event stream <span className={`chip muted mono sa-level ${level}`}>{level}</span></div>
        {a.stream.length === 0 ? (
          <div className="sa-empty">{level === "events" ? "Waiting for events…" : "Events stream while an agent is inspected."}</div>
        ) : (
          <div className="sa-out selectable">
            {a.stream.map((l, i) => (
              <div key={i} className={`ta-stream-line ${l.kind}`}>
                {l.kind === "tool" ? `→ ${l.tool} ${l.text}` : l.kind === "error" ? `✗ ${l.tool}: ${l.text}` : l.text}
              </div>
            ))}
          </div>
        )}
      </div>
    </>
  );
}

const saBlocks = content => (typeof content === "string" ? [{ type: "text", text: content }] : content ?? []);

// Memoised on the transcript object alone: the pane ticks `now` four times
// a second while agents run, and re-walking a long transcript's tool
// results on every tick is pure waste. `onRefresh` is recreated per render
// but always loads the same agent (the inspector is keyed by agent id).
const SaTranscript = React.memo(function SaTranscript({ transcript, onRefresh }) {
  const messages = transcript?.messages ?? [];
  const loading = !transcript || transcript.status === "loading";
  if (loading && messages.length === 0) {
    return <div className="sa-empty"><span className="shimmer-text">loading transcript…</span></div>;
  }
  return (
    <div>
      <div className="sa-block-k">
        {messages.length} messages
        <button className="btn ghost" style={{ marginLeft: "auto", height: 18, padding: "0 6px" }} onClick={onRefresh} disabled={loading}>
          <_SAI_Icon name="refresh" size={10} /> {loading ? "loading…" : "refresh"}
        </button>
      </div>
      {transcript.status === "error" && <div className="sa-empty" style={{ color: "var(--rose)" }}>{transcript.error}</div>}
      {messages.map((m, i) => (
        <div key={i} className="sa-msg">
          <span className={`sa-msg-role ${m.role}`}>{m.role === "toolResult" ? `result · ${m.toolName}` : m.role}</span>
          {m.role === "toolResult" ? (
            <div className={`sa-msg-result${m.isError ? " err" : ""}`}>
              {saBlocks(m.content).filter(b => b.type === "text").map(b => b.text).join("\n").split("\n").slice(0, 4).join("\n")}
            </div>
          ) : saBlocks(m.content).map((b, j) => (
            b.type === "text" ? <div key={j} className="sa-msg-text selectable">{b.text}</div>
            : b.type === "toolCall" ? (
              <div key={j} className="sa-msg-call"><_SAI_ToolChip tool={b.name} /><span className="sa-args">{_SAI.formatArgs(b.arguments)}</span></div>
            ) : null
          ))}
        </div>
      ))}
    </div>
  );
}, (prev, next) => prev.transcript === next.transcript);

/** Keyed by agent id in SubagentPane, so tab/copied state start fresh per agent.
 *  `callId` is the main-chat task call (the root agent's, for nested agents). */
function SubagentInspector({ agent, callId, now, level, transcript, onBack, onLoadTranscript, onJumpToCall, onCopy }) {
  const [tab, setTab] = React.useState("activity");
  const p = agent.progress;
  // Which footer copy button just succeeded — onCopy resolves true/false.
  const [copied, setCopied] = React.useState(null);
  React.useEffect(() => {
    if (!copied) return undefined;
    const id = setTimeout(() => setCopied(null), 1200);
    return () => clearTimeout(id);
  }, [copied]);
  const copy = (key, text) => Promise.resolve(onCopy(text)).then(ok => ok && setCopied(key));
  // Entering the transcript tab loads it when absent or after a failure;
  // an already-loaded one waits for an explicit refresh.
  React.useEffect(() => {
    if (tab === "transcript" && (!transcript || transcript.status === "error")) onLoadTranscript(agent.id);
  }, [tab]);

  const tabs = [
    ["activity", "activity", p?.toolCount],
    ["output", "output", (p?.recentOutput?.length ?? 0) + agent.stream.length],
    ["transcript", "transcript", transcript?.messages?.length],
  ];
  return (
    <div className="sa-insp" style={_SAI_hue(agent)}>
      <div className="sa-insp-head">
        <button className="btn icon ghost" onClick={onBack} title="back to all agents"><_SAI_Icon name="back" size={11} /></button>
        <_SAI_Glyph agent={agent} />
        <div className="sa-insp-title">
          <span className="sa-name">{agent.id}</span>
          <span className="sa-insp-meta">{[agent.agent, agent.agentSource, p?.resolvedModel].filter(Boolean).join(" · ")}</span>
        </div>
        <div style={{ flex: 1 }} />
        <_SAI_StatusChip agent={agent} />
      </div>
      <div className="sa-tabs">
        {tabs.map(([key, label, count]) => (
          <button key={key} className={`sa-tab${tab === key ? " on" : ""}`} onClick={() => setTab(key)}>
            {label}{count ? <span className="sa-count">{count}</span> : null}
          </button>
        ))}
      </div>
      <div className="sa-insp-body">
        {tab === "activity" && <SaActivity agent={agent} now={now} />}
        {tab === "output" && <SaOutput agent={agent} level={level} />}
        {tab === "transcript" && <SaTranscript transcript={transcript} onRefresh={() => onLoadTranscript(agent.id)} />}
      </div>
      <div className="sa-insp-foot">
        {callId && (
          <button className="btn ghost outlined" onClick={() => onJumpToCall(callId)}>
            <_SAI_Icon name="arrowUp" size={10} /> task call
          </button>
        )}
        <button className="btn ghost outlined" onClick={() => copy("uri", `agent://${agent.id}`)} title={`agent://${agent.id}`}>
          <_SAI_Icon name={copied === "uri" ? "check" : "copy"} size={10} />
          {copied === "uri" ? "copied" : `agent://${agent.id.length > 14 ? "…" : agent.id}`}
        </button>
        {agent.sessionFile && (
          <button className="btn ghost outlined" onClick={() => copy("file", agent.sessionFile)} title={agent.sessionFile}>
            <_SAI_Icon name={copied === "file" ? "check" : "file"} size={10} /> {copied === "file" ? "copied" : "session file"}
          </button>
        )}
      </div>
    </div>
  );
}

Object.assign(window, { SubagentInspector });

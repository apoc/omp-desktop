/* app/use-subagent-manager.jsx — UI state for the subagent manager
   (design/subagents/). The pane *is* the tweaks `layout: "split"` column,
   so opening/closing it goes through setTweak and persists like any other
   layout choice. Owns: which agent is inspected, the list filter, the RPC
   subscription level that follows inspection, jump-to-task-call and copy. */

function useSubagentManager({ bridge, layout, setTweak, activeSessionId, subagents, messages, setHoveredMsgIdx }) {
  const paneOpen = layout === "split";
  const [selectedId, setSelectedId] = React.useState(null);
  const [filter, setFilter] = React.useState("all");

  // The selection is only meaningful while the manager holds that agent: a
  // tab switch, `/new` or a profile respawn (same tab id, fresh process)
  // all drop it. Everything downstream keys off `selected`, never the id.
  const selected = selectedId != null ? window.OMP_SUBAGENTS.getAgent(subagents, selectedId) ?? null : null;
  React.useEffect(() => { setSelectedId(null); }, [activeSessionId]);
  React.useEffect(() => { if (selectedId != null && !selected) setSelectedId(null); }, [selectedId, selected]);

  // The full event stream ("events") is only worth paying for while an
  // agent is actually on screen in the inspector.
  const inspecting = paneOpen && selected != null;
  React.useEffect(() => { bridge?.setSubagentInspecting(inspecting); }, [bridge, inspecting]);

  // Stable (handed to memoised tool cards as their "inspect" action), so it
  // reads the latest agent map through a ref. A task card also lists agents
  // omp has not started yet (queued on the concurrency limit, or aborted
  // before running) — those open the manager's list, not an empty inspector.
  const subagentsRef = React.useRef(subagents);
  subagentsRef.current = subagents;
  const open = React.useCallback(id => {
    setTweak("layout", "split");
    setSelectedId(id != null && window.OMP_SUBAGENTS.getAgent(subagentsRef.current, id) ? id : null);
  }, [setTweak]);
  const closePane = () => { setTweak("layout", "rail"); setSelectedId(null); };
  const togglePane = () => (paneOpen ? closePane() : setTweak("layout", "split"));

  // Scroll the chat to the task call that spawned an agent and flash it via
  // the same highlight the minimap hover uses. A call already trimmed out of
  // the live window (live.js MINIMAP_MAX) has nothing to scroll to.
  const flashRef = React.useRef(null);
  React.useEffect(() => () => clearTimeout(flashRef.current), []);
  const jumpToCall = callId => {
    const idx = messages.findIndex(m => m.kind === "tool" && m._toolCallId === callId);
    if (idx < 0) return;
    document.querySelector(`[data-msg-idx="${idx}"]`)?.scrollIntoView({ block: "center", behavior: "smooth" });
    setHoveredMsgIdx(idx);
    clearTimeout(flashRef.current);
    flashRef.current = setTimeout(() => setHoveredMsgIdx(h => (h === idx ? null : h)), 1600);
  };

  /** Resolves true once the text is on the clipboard. */
  const copy = text => (navigator.clipboard
    ? navigator.clipboard.writeText(text).then(() => true, err => { console.warn("[subagents] copy failed:", err); return false; })
    : Promise.resolve(false));

  return {
    paneOpen, selected, select: setSelectedId, filter, setFilter,
    level: window.OMP_SUBAGENTS.subscriptionLevelFor({ inspecting }),
    open, closePane, togglePane, jumpToCall, copy,
  };
}

Object.assign(window, { useSubagentManager });

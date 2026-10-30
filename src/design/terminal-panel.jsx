/* ═════════════════════════════════════════════════════════════════════
   design/terminal-panel.jsx — one tab's terminal panel: a head (shell,
   folder, exit state; the toolbar's terminal button hides the panel), the
   node xterm mounts into, and a drag handle on the top edge. Hidden tabs
   and collapsed panels stay mounted
   (`hidden`), so the xterm keeps its output; app/use-terminal.jsx owns
   the xterm and hands over `mountRef`; `onContextMenu` is the body's
   right-click (copy the selection). A drag (left button) starts from the
   height the panel is rendered at — CSS caps it at 70 % of the column,
   which may be less than the saved tweak after the window shrank — and
   reports the final height once (`onHeight`, ui/use-edge-drag.js). `TerminalPanels` renders the panels of every tab for app-live.jsx.
   ═════════════════════════════════════════════════════════════════════ */

const { Icon: _TP_Icon } = window;
const {
  clampHeight: _TP_clamp, isExited: _TP_isExited, entryOf: _TP_entryOf, shellLabel: _TP_shellLabel,
} = window.OMP_TERMINAL;

function TerminalPanel({ entry, height, hidden, onHeight, mountRef, onContextMenu, shellLabel, cwd }) {
  const drag = window.useEdgeDrag({
    begin: (e) => {
      const column = e.currentTarget.closest(".session");
      return {
        start: Math.round(e.currentTarget.parentElement.getBoundingClientRect().height),
        startY: e.clientY,
        columnHeight: column ? column.getBoundingClientRect().height : window.innerHeight,
      };
    },
    measure: (e, d) => _TP_clamp(d.start + d.startY - e.clientY, d.columnHeight),
    commit: onHeight,
  });

  return (
    <section className="term-panel" hidden={hidden} style={{ height: drag.size ?? height }}>
      <div className="term-handle" {...drag.handlers} />
      <div className="term-head">
        <_TP_Icon name="terminal" size={11} color="var(--fg-3)" />
        <span className="term-head-shell">{shellLabel}</span>
        {cwd && <span className="term-head-cwd" title={cwd}>{cwd}</span>}
        {_TP_isExited(entry) && (
          <span className="term-head-exited" title={entry.error ?? undefined}>
            {entry.error != null ? "failed to start"
              : `exited${entry.status.exitCode == null ? "" : ` (${entry.status.exitCode})`}`}
          </span>
        )}
      </div>
      <div className="term-body" ref={mountRef} onContextMenu={onContextMenu} />
    </section>
  );
}

/**
 * One panel per tab that has ever opened its terminal (`created`; a pending
 * or failed first spawn included). Only the active tab's open panel shows;
 * the others stay mounted but hidden, so a shell's output keeps arriving
 * off-screen and its xterm survives a hide. `terminal` is useTerminal's
 * return value, `activeId` the active tab's id.
 */
function TerminalPanels({ sessions, activeId, terminal }) {
  return (
    <>
      {sessions.map((s) => {
        const entry = _TP_entryOf(terminal.state, s.id);
        if (!entry.created) return null;
        return (
          <TerminalPanel key={s.id}
            entry={entry}
            height={terminal.height}
            hidden={s.id !== activeId || !entry.open}
            onHeight={terminal.setHeight}
            mountRef={terminal.mountFor(s.id)}
            onContextMenu={(e) => { if (terminal.copySelection(s.id)) e.preventDefault(); }}
            shellLabel={_TP_shellLabel(entry.status?.shell)}
            cwd={s.path}
          />
        );
      })}
    </>
  );
}

Object.assign(window, { TerminalPanels });

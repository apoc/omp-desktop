/* chat/eval-cell.jsx — one kernel cell inside an `eval` tool card.
   Applies hljs syntax highlighting once the cell is complete. While the
   cell is running the code is a partial string; highlighting it
   mid-stream produces malformed spans, so we stay with plain monospace
   until status flips to complete or error. */

const { CopyButton: _EvalCopy } = window;

function EvalCell({ cell }) {
  const done = cell.status === "complete" || cell.status === "error";
  const lang = cell.language === "py" ? "python" : "javascript";

  const codeHtml = React.useMemo(() => {
    if (!done || !cell.code || !window.hljs) return null;
    try {
      return window.hljs.highlight(cell.code.trimEnd(), { language: lang }).value;
    } catch (_) { return null; }
  }, [done, cell.code, lang]);

  return (
    <div className={`eval-cell eval-${cell.status}`}>
      <div className="eval-cell-head mono">
        <span className="eval-lang">{cell.language}</span>
        {cell.title && <span className="eval-title">{cell.title}</span>}
        {cell.durationMs != null
          ? <span className="eval-dur" style={{ marginLeft: "auto" }}>{cell.durationMs}ms</span>
          : cell.status === "running" && <span className="shimmer-text" style={{ marginLeft: "auto", fontSize: 10 }}>running…</span>
        }
      </div>
      {cell.code && (
        <div className="copy-host">
          {codeHtml
            ? <pre className="eval-code selectable"><code className={`hljs language-${lang}`}
                dangerouslySetInnerHTML={{ __html: codeHtml }} /></pre>
            : <pre className="eval-code selectable mono">{cell.code.trimEnd()}</pre>}
          {done && <_EvalCopy className="is-floating" label="Copy code" getText={() => cell.code.trimEnd()} />}
        </div>
      )}
      {cell.output && (
        <div className="copy-host">
          <pre className={`eval-output selectable mono${cell.status === "error" ? " eval-error" : ""}`}>
            {cell.output.trimEnd()}
          </pre>
          {done && <_EvalCopy className="is-floating" label="Copy output" getText={() => cell.output.trimEnd()} />}
        </div>
      )}
    </div>
  );
}

Object.assign(window, { EvalCell });

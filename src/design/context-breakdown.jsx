/* Approximate attribution belongs in the inspector, not the working rail. */
function ContextBreakdown({ details, total, refreshing = false }) {
  const rows = refreshing ? [] : details?.breakdown || [];
  const number = (value) =>
    typeof value === "number" && Number.isFinite(value)
      ? value.toLocaleString()
      : "—";
  return (
    <details className="ci-breakdown">
      <summary>Token breakdown</summary>
      {rows.length ? (
        <div className="context-breakdown">
          {rows.map((part) => (
            <div className="context-breakdown-row" key={part.id}>
              <div>
                <span>{part.label}</span>
                <span
                  className="mono"
                  aria-label={
                    part.tokens == null
                      ? "Unavailable"
                      : `${part.estimated ? "Approximately " : ""}${number(part.tokens)} tokens`
                  }
                >
                  {part.estimated && typeof part.tokens === "number" ? "≈" : ""}
                  {number(part.tokens)}
                </span>
              </div>
              {typeof part.tokens === "number" &&
                Number.isFinite(part.tokens) &&
                typeof total === "number" &&
                total > 0 && (
                  <div className="context-breakdown-track" aria-hidden="true">
                    <span
                      style={{
                        width: `${Math.min(100, Math.max(0, (part.tokens / total) * 100))}%`,
                      }}
                    />
                  </div>
                )}
            </div>
          ))}
        </div>
      ) : (
        <p className="ci-state">
          {refreshing ? "Refreshing context…" : "Breakdown unavailable."}
        </p>
      )}
      {rows.some((part) => part.estimated) && (
        <p className="ci-state">
          ≈ Local text estimates (UTF-8 bytes ÷ 4), not provider attribution.
          Skills counts the prompt catalog, not loaded files; Messages is the
          remainder of the native total. Estimates can exceed that total.
        </p>
      )}
    </details>
  );
}
window.ContextBreakdown = ContextBreakdown;

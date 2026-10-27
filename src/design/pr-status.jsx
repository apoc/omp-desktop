/* Shared lifecycle, CI and actionable-review indicators for PR surfaces. */
function PrStatusGlyph({ glyph }) {
  return (
    <svg
      className="pr-status-glyph"
      viewBox="0 0 16 16"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.5"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      {glyph === "merged" ? (
        <>
          <circle cx="4" cy="3" r="1.5" />
          <circle cx="12" cy="3" r="1.5" />
          <circle cx="4" cy="13" r="1.5" />
          <path d="M4 4.5v7M12 4.5v1a3 3 0 0 1-3 3H4" />
        </>
      ) : glyph === "closed" ? (
        <>
          <circle cx="4" cy="3" r="1.5" />
          <circle cx="4" cy="13" r="1.5" />
          <path d="M4 4.5v7M9 8l5 5m0-5-5 5" />
        </>
      ) : glyph === "draft" ? (
        <>
          <circle cx="4" cy="3" r="1.5" />
          <circle cx="4" cy="13" r="1.5" />
          <circle cx="12" cy="13" r="1.5" />
          <path d="M4 4.5v7M12 11.5V10M12 7.5V6M10 3.2l-1.5-.2" />
        </>
      ) : glyph === "mixed" ? (
        <>
          <circle cx="3.5" cy="3" r="1.3" />
          <circle cx="3.5" cy="13" r="1.3" />
          <circle cx="12.5" cy="13" r="1.3" />
          <path d="M3.5 4.5v7M12.5 11.5V7a3 3 0 0 0-3-3H8M10 2 8 4l2 2" />
        </>
      ) : glyph === "error" ? (
        <>
          <path d="M8 1.5 15 14H1L8 1.5ZM8 5.5v4" />
          <path d="M8 11.5h.01" />
        </>
      ) : (
        <>
          <circle cx="4" cy="3" r="1.5" />
          <circle cx="4" cy="13" r="1.5" />
          <circle cx="12" cy="13" r="1.5" />
          <path d="M4 4.5v7M12 11.5V6a3 3 0 0 0-3-3H8m2-2L8 3l2 2" />
        </>
      )}
    </svg>
  );
}

// mode separates the card's glyph and metadata while navigation uses both.
function PrStatus({ status, model: suppliedModel, mode = "all", onReview }) {
  const model =
    suppliedModel === undefined
      ? window.OMP_PR_STATUS.present(status)
      : suppliedModel;
  if (!model) return null;
  const glyph = mode !== "badges";
  const badges = mode !== "icon";
  const ci =
    badges &&
    model.glyph !== "merged" &&
    model.glyph !== "closed" &&
    model.glyph !== "error" &&
    model.checksState;
  const failed = ci && (ci === "failure" || model.failedCount > 0);
  const review = badges && model.threadCount > 0;
  const summary = (
    <>
      {glyph && <PrStatusGlyph glyph={model.glyph} />}
      {badges && model.prCount > 1 && (
        <span className="pr-status-multiple" aria-hidden="true">
          {model.prCount}
        </span>
      )}
      {badges && model.glyph === "mixed" && model.prCount === 1 && (
        <span className="pr-status-multiple" aria-hidden="true">
          ≠
        </span>
      )}
      {failed && (
        <span className="pr-status-ci failure" aria-hidden="true">
          !{model.failedCount || ""}
        </span>
      )}
      {ci && ci !== "failure" && (
        <span className={`pr-status-ci ${ci}`} aria-hidden="true">
          {ci === "pending"
            ? "…"
            : ci === "success"
              ? "✓"
              : ci === "unknown"
                ? "?"
                : "–"}
        </span>
      )}
      {badges && model.stale && (
        <span className="pr-status-stale" aria-hidden="true">
          !
        </span>
      )}
    </>
  );
  const bubble = (
    <>
      <svg
        viewBox="0 0 16 16"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.5"
        strokeLinejoin="round"
        aria-hidden="true"
      >
        <path d="M2 2.5h12v8.5H7l-3.5 2v-2H2z" />
      </svg>
      <span>{model.threadCount}</span>
    </>
  );
  return (
    <span
      className={`pr-status pr-status-${model.tone}${model.stale ? " is-stale" : ""}`}
      title={model.description}
      role={onReview ? undefined : "img"}
      aria-label={onReview ? undefined : model.description}
    >
      {onReview ? (
        <span
          className="pr-status-summary"
          role="img"
          aria-label={model.description}
        >
          {summary}
        </span>
      ) : (
        summary
      )}
      {review &&
        (onReview ? (
          <button
            type="button"
            className="pr-status-review"
            onClick={onReview}
            title="Open review discussion"
            aria-label={`${model.threadCount} unresolved review ${model.threadCount === 1 ? "thread" : "threads"}; open review discussion`}
          >
            {bubble}
          </button>
        ) : (
          <span className="pr-status-review" aria-hidden="true">
            {bubble}
          </span>
        ))}
    </span>
  );
}
window.PrStatus = PrStatus;

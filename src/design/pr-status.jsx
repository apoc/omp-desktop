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

// Details live outside clipped navigation and rail containers. Static details
// receive their own tab stop; an action child keeps its native button focus.
// Rich detail may differ visually; text remains the accessible name.
function StatusDetail({ text, detail = text, className = "", children }) {
  const ref = React.useRef(null);
  const timer = React.useRef(null);
  const hovering = React.useRef(false);
  const focused = React.useRef(false);
  const [position, setPosition] = React.useState(null);
  const id = React.useId();
  const action = React.isValidElement(children) && children.type === "button";
  const place = () => {
    if (!ref.current) return;
    const rect = ref.current.getBoundingClientRect();
    const below = window.innerHeight - rect.bottom;
    const above = rect.top;
    setPosition({
      left: Math.max(8, Math.min(rect.left, window.innerWidth - 328)),
      ...(below < 120 && above > below
        ? { bottom: window.innerHeight - rect.top + 4, maxHeight: Math.max(40, above - 12) }
        : { top: rect.bottom + 4, maxHeight: Math.max(40, below - 12) }),
    });
  };
  const enter = () => {
    clearTimeout(timer.current);
    hovering.current = true;
    place();
  };
  const leave = () => {
    hovering.current = false;
    clearTimeout(timer.current);
    timer.current = setTimeout(() => {
      if (!hovering.current && !focused.current) setPosition(null);
    }, 120);
  };
  React.useEffect(() => {
    if (!position) return undefined;
    window.addEventListener("resize", place);
    document.addEventListener("scroll", place, true);
    return () => {
      window.removeEventListener("resize", place);
      document.removeEventListener("scroll", place, true);
    };
  }, [!!position]);
  React.useEffect(() => () => clearTimeout(timer.current), []);
  const child = action
    ? React.cloneElement(children, { "aria-describedby": position ? id : undefined })
    : children;
  return (
    <span
      ref={ref}
      className={`status-detail ${className}`}
      data-no-reorder
      tabIndex={action ? undefined : 0}
      role={action ? undefined : "img"}
      aria-label={action ? undefined : text}
      aria-describedby={!action && position ? id : undefined}
      title=""
      onMouseEnter={enter}
      onMouseLeave={leave}
      onFocus={() => { focused.current = true; place(); }}
      onBlur={() => {
        focused.current = false;
        if (!hovering.current) setPosition(null);
      }}
      onPointerDown={(event) => event.stopPropagation()}
      onMouseDown={(event) => event.stopPropagation()}
      onAuxClick={(event) => event.stopPropagation()}
      onClick={(event) => event.stopPropagation()}
      onDoubleClick={(event) => event.stopPropagation()}
      onKeyDown={(event) => {
        if (event.key === "Escape" && position) {
          setPosition(null);
          event.stopPropagation();
        } else if (event.key === "Enter" || event.key === " ") {
          event.stopPropagation();
          if (!action) event.preventDefault();
        }
      }}
    >
      {child}
      {position && ReactDOM.createPortal(
        <span id={id} role="tooltip" className="status-detail-tooltip" style={position}
          onMouseEnter={enter} onMouseLeave={leave}>
          {detail}
        </span>,
        document.body,
      )}
    </span>
  );
}

// mode separates the identity from feedback for descriptive surfaces.
function PrStatus({ status, model: suppliedModel, mode = "all", onReview }) {
  const model =
    suppliedModel === undefined
      ? window.OMP_PR_STATUS.present(status)
      : suppliedModel;
  if (!model) return null;
  const identity = mode !== "badges";
  const badges = mode !== "icon";
  const ci = badges && model.glyph !== "merged" && model.glyph !== "closed" && model.checksState;
  const failed = ci && (ci === "failure" || model.failedCount > 0);
  const descriptive = mode === "badges";
  const bubble = (
    <>
      <svg viewBox="0 0 16 16" fill="none" stroke="currentColor"
        strokeWidth="1.5" strokeLinejoin="round" aria-hidden="true">
        <path d="M2 2.5h12v8.5H7l-3.5 2v-2H2z" />
      </svg>
      <span>{model.threadCount}</span>
    </>
  );
  return (
    <span className={`pr-status${model.stale ? " is-stale" : ""}`}>
      {identity && (
        <StatusDetail className={`pr-status-identity pr-status-${model.glyph}`} text={model.lifecycleDescription}>
          <PrStatusGlyph glyph={model.glyph} />
          <span>{model.glyph === "mixed"
            ? model.prCount > 1 ? `${model.prCount} PRs` : "Mixed PR"
            : `#${model.number}`}</span>
        </StatusDetail>
      )}
      {failed && (
        <StatusDetail className="pr-status-ci failure" text={model.checksDescription}>
          <span aria-hidden="true">×{model.failedCount || ""}</span>
          {descriptive && <span>{model.checksDescription}</span>}
        </StatusDetail>
      )}
      {ci && !failed && (
        <StatusDetail className={`pr-status-ci ${ci}`} text={model.checksDescription}>
          <span aria-hidden="true">{ci === "pending" ? "◷" : ci === "success" ? "✓" : ci === "unknown" ? "?" : "–"}</span>
          {descriptive && <span>{ci === "pending" ? "Checks pending" : ci === "success" ? "Checks passed" : ci === "unknown" ? "Checks unknown" : "No checks"}</span>}
        </StatusDetail>
      )}
      {badges && model.threadCount > 0 && (
        <StatusDetail text={onReview ? `${model.reviewDescription}; open review discussion` : model.reviewDescription}>
          {onReview ? (
            <button type="button" className="pr-status-review" onClick={onReview}
              aria-label={`${model.reviewDescription}; open review discussion`}>
              {bubble}
            </button>
          ) : <span className="pr-status-review">{bubble}</span>}
        </StatusDetail>
      )}
      {badges && model.stale && (
        <StatusDetail className="pr-status-stale" text={model.refreshDescription}>
          <span aria-hidden="true">↻!</span>
        </StatusDetail>
      )}
    </span>
  );
}
window.StatusDetail = StatusDetail;
window.PrStatus = PrStatus;

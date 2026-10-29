/* Stateless display surfaces; the gauge owns the draft and native mutation. */
function ContextPolicyCollapsed({
  trigger,
  begin,
  available,
  usage,
  used,
  total,
  target,
  policy,
  loading,
  number,
  percent,
  source,
}) {
  return (
    <button
      ref={trigger}
      type="button"
      className="context-policy-gauge"
      aria-expanded="false"
      aria-disabled={!available || undefined}
      onClick={begin}
    >
      <window.ContextPolicyRing usage={usage} target={target?.percent} />
      <span className="context-policy-gauge-copy">
        <span className="context-policy-usage">
          <strong>
            {number(used)} / {number(total)}
          </strong>
          <small>tokens used / window</small>
        </span>
        <span
          className="context-policy-target"
          title={target ? `${number(target.tokens)} tokens` : undefined}
        >
          {target ? (
            <>
              {policy?.enabled === false
                ? policy.idleEnabled
                  ? "Threshold off · idle on · "
                  : "Auto-compact off · "
                : "Auto compact at "}
              {percent(target.percent)} · {window.formatTokens(target.tokens)}
            </>
          ) : (
            "Auto-compaction unavailable"
          )}
        </span>
        <span className="context-policy-source">
          {target
            ? source(target)
            : loading
              ? "Loading policy…"
              : policy?.reason || "Policy unavailable"}
        </span>
      </span>
    </button>
  );
}

function ContextPolicySurface({
  view,
  surfaceRef,
  savedDrag,
  onLatest,
  onPercent,
  onRestoreDrag,
  onReset,
  onEdit,
  onSave,
  onClose,
  number,
}) {
  const {
    policy,
    draft,
    usage,
    used,
    total,
    target,
    preview,
    previewPercent,
    previewTokens,
    bounds,
    stale,
    available,
    pending,
    disabled,
    dirty,
    optionsChanged,
    exceeded,
    shadowed,
    profile,
    canApply,
    helpDismissal,
  } = view;
  return (
    <div className="context-policy-surface" ref={surfaceRef}>
      <div className="context-policy-surface-header">
        <span className="context-policy-surface-usage">
          <strong>
            {number(used)} / {number(total)}
          </strong>{" "}
          tokens used / window
        </span>
        <button
          type="button"
          className="context-policy-link"
          disabled={pending}
          onClick={onClose}
        >
          {dirty ? "Cancel" : "Close"}
        </button>
      </div>
      {stale && (
        <div className="context-policy-stale" role="status">
          Policy, conversation or model changed. This draft cannot be saved to
          the new context.
          <button
            type="button"
            className="context-policy-link"
            disabled={!available || pending}
            onClick={onLatest}
          >
            Use latest
          </button>
        </div>
      )}
      {!stale && (
        <>
          <div className="context-policy-adjust">
            <window.ContextPolicyRing
              editing
              usage={usage}
              target={
                Number.isFinite(previewPercent)
                  ? previewPercent
                  : target?.percent
              }
              bounds={bounds}
              disabled={disabled}
              onStart={() => {
                savedDrag.current = draft;
              }}
              onPercent={onPercent}
              onCancel={onRestoreDrag}
            />
            <div className="context-policy-adjust-copy">
              <div className="context-policy-option">
                <span>Target percentage</span>
                <window.ContextPolicyHelp
                  label="About the target"
                  dismissToken={helpDismissal}
                >
                  The marker is the target; the inner arc shows measured usage.
                  Drag or tap the outer track, use the arrow keys, or enter an
                  exact percentage.
                  {bounds && (
                    <>
                      {" "}
                      Allowed: {bounds.min}%–{bounds.max}%.
                    </>
                  )}
                  {draft.targetChange === "untouched" &&
                    target?.mode !== "percent" && (
                      <>
                        {" "}
                        The current{" "}
                        {target?.mode === "tokens" ? "token" : "native"} rule is
                        preserved until you change the target.
                      </>
                    )}
                </window.ContextPolicyHelp>
              </div>
              <label className="context-policy-percent-label">
                <span className="context-policy-visually-hidden">
                  Target percentage
                </span>
                <span className="context-policy-percent-input">
                  <input
                    type="number"
                    inputMode="decimal"
                    step="any"
                    min={bounds?.min}
                    max={bounds?.max}
                    value={
                      draft.targetChange === "reset"
                        ? String(preview?.percent ?? "")
                        : draft.percent
                    }
                    disabled={disabled}
                    onChange={(event) => onPercent(event.target.value)}
                  />
                  <span>%</span>
                </span>
              </label>
              <span className="context-policy-note">
                {number(previewTokens)} tokens
              </span>
              {target?.conversationOverride && (
                <button
                  type="button"
                  className="context-policy-link"
                  disabled={disabled || draft.targetChange === "reset"}
                  onClick={onReset}
                >
                  Use profile setting
                </button>
              )}
              {draft.targetChange === "reset" && (
                <span className="context-policy-note">
                  Preview from {preview?.source || "inherited settings"}. Save
                  for this conversation to remove its model target.
                </span>
              )}
            </div>
          </div>
          <window.ContextPolicyOptions
            policy={policy}
            values={draft.values}
            disabled={disabled}
            onChange={onEdit}
            helpDismissal={helpDismissal}
          />
          {optionsChanged && (
            <p className="context-policy-note">
              These options apply across models in the chosen conversation or
              profile; the target applies only to this model.
            </p>
          )}
          {exceeded && (
            <p className="context-policy-warning" role="status">
              Current usage is already at or above this target; auto-compaction
              may run when eligible.
            </p>
          )}
          {shadowed && (
            <p className="context-policy-warning">
              A profile default may be shadowed in this conversation by its
              existing target.
            </p>
          )}
        </>
      )}
      {dirty && (
        <div className="context-policy-actions">
          <button
            type="button"
            className="context-policy-apply"
            disabled={disabled || !canApply}
            onClick={() => onSave("conversation")}
          >
            Save for this conversation
          </button>
          <button
            type="button"
            className="context-policy-apply"
            disabled={disabled || !canApply || draft.targetChange === "reset"}
            onClick={() => onSave("profile")}
          >
            {optionsChanged
              ? draft.targetChange === "percent"
                ? `Save model target and profile settings in ${profile}`
                : `Save profile settings in ${profile}`
              : `Set default for this model in ${profile}`}
          </button>
        </div>
      )}
    </div>
  );
}
Object.assign(window, { ContextPolicyCollapsed, ContextPolicySurface });

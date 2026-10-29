/* One in-place target editor is shared by the Context card and Settings. */
const _CP_finite = (n) => typeof n === "number" && Number.isFinite(n);
const _CP_number = (n) =>
  _CP_finite(n) ? Math.round(n).toLocaleString() : "—";
const _CP_percent = (n) => (_CP_finite(n) ? `${Number(n.toFixed(2))}%` : "—");
const _CP_message = (error) =>
  typeof error === "string" ? error : error?.message || String(error || "");
function _CP_source(target) {
  const source = target?.source || "unavailable";
  if (source === "conversation") return "Session";
  if (source === "profile") return "Profile default";
  return `Inherited · ${source}`;
}

function ContextPolicyGauge({
  policy,
  ctx,
  loading = false,
  saving = false,
  error = null,
  onRefresh,
  onApply,
  profileName,
}) {
  const T = window.OMP_CONTEXT_TARGET;
  const [open, setOpen] = React.useState(false);
  const [draft, setDraft] = React.useState(null);
  const [busy, setBusy] = React.useState(false);
  const [localError, setLocalError] = React.useState(null);
  const [notice, setNotice] = React.useState(null);
  const [helpDismissal, setHelpDismissal] = React.useState(0);
  const trigger = React.useRef(null);
  const surfaceRef = React.useRef(null);
  const savedDrag = React.useRef(null);
  const latest = React.useRef({ policy, ctx });
  const busyRef = React.useRef(false);
  latest.current = { policy, ctx };
  const bounds = T.bounds(policy);
  const mismatch = !!ctx?.modelKey && ctx.modelKey !== T.modelKey(policy);
  const available = !!T.createDraft(policy) && !mismatch;
  const stale = open && T.stale(draft, policy, ctx?.modelKey);
  React.useEffect(() => {
    if (!open) return;
    requestAnimationFrame(() => {
      const surface = surfaceRef.current;
      (
        surface?.querySelector('[role="slider"]:not([aria-disabled="true"])') ||
        surface?.querySelector("button:not(:disabled)")
      )?.focus();
    });
  }, [open, stale]);
  const pending = busy || loading || saving;
  const disabled = pending || stale || !available;
  const dirty = T.dirty(draft);
  const optionsChanged =
    !!draft &&
    ["enabled", "method", "asyncEnabled", "midTurnEnabled"].some(
      (id) => !Object.is(draft.values[id], draft.initial[id]),
    );
  const modelUsage =
    !policy?.model || !ctx?.modelKey || ctx.modelKey === T.modelKey(policy);
  const usage =
    ctx?.status === "ready" && modelUsage && _CP_finite(ctx?.pct)
      ? ctx.pct
      : null;
  const used = ctx?.status === "ready" && modelUsage ? ctx?.used : null;
  const total = modelUsage
    ? (ctx?.total ?? policy?.model?.contextWindow)
    : null;
  const target = mismatch ? null : policy?.target;
  const preview = draft?.targetChange === "reset" ? target?.inherited : target;
  const numericDraft = draft?.percent !== "" ? Number(draft?.percent) : NaN;
  const previewPercent =
    draft?.targetChange === "percent" && Number.isFinite(numericDraft)
      ? numericDraft
      : preview?.percent;
  const previewTokens =
    draft?.targetChange === "percent" &&
    Number.isFinite(numericDraft) &&
    _CP_finite(policy?.model?.contextWindow)
      ? Math.floor((policy.model.contextWindow * numericDraft) / 100)
      : preview?.tokens;
  const exceeded =
    usage != null &&
    _CP_finite(previewPercent) &&
    usage >= previewPercent &&
    (draft ? draft.values.enabled : policy?.enabled);
  const shadowed =
    !!target?.conversationOverride && draft?.targetChange === "percent";
  const profile = profileName || policy?.profileId || "this profile";
  const close = () => {
    setOpen(false);
    setDraft(null);
    setLocalError(null);
    requestAnimationFrame(() => trigger.current?.focus());
  };
  const begin = () => {
    const next = T.createDraft(policy);
    if (!next || mismatch || pending) return;
    setDraft(next);
    setLocalError(null);
    setNotice(null);
    setOpen(true);
  };
  const edit = (id, value) => {
    setLocalError(null);
    setNotice(null);
    setDraft(
      (old) => old && { ...old, values: { ...old.values, [id]: value } },
    );
  };
  const setPercent = (value) => {
    setLocalError(null);
    setNotice(null);
    setDraft(
      (old) =>
        old && { ...old, percent: String(value), targetChange: "percent" },
    );
  };
  const refresh = async () => {
    if (!onRefresh || busyRef.current || pending) return;
    busyRef.current = true;
    setBusy(true);
    setLocalError(null);
    try {
      await onRefresh();
    } catch (failure) {
      setLocalError(_CP_message(failure));
    } finally {
      busyRef.current = false;
      setBusy(false);
    }
  };
  const save = async (scope) => {
    if (
      !onApply ||
      busyRef.current ||
      disabled ||
      !dirty ||
      (scope === "profile" && draft.targetChange === "reset")
    )
      return;
    let values;
    try {
      values = T.requestValues(draft, policy);
    } catch (failure) {
      setLocalError(_CP_message(failure));
      return;
    }
    const owner = draft.owner,
      revision = draft.revision;
    const model = { provider: policy.model.provider, id: policy.model.id };
    busyRef.current = true;
    setBusy(true);
    setLocalError(null);
    setNotice(null);
    try {
      const returned = await onApply({ scope, values, revision, model });
      if (
        T.owner(latest.current.policy) !== owner ||
        (latest.current.ctx?.modelKey &&
          latest.current.ctx.modelKey !== draft.modelKey)
      )
        return;
      if (
        !returned?.supported ||
        T.owner(returned) !== owner ||
        !returned.target
      )
        throw new Error(
          "The updated policy could not be confirmed. Refresh before trying again.",
        );
      const result = returned.target;
      const targetSaved = Object.hasOwn(values, "targetPercent");
      const shadowed =
        scope === "profile" && targetSaved && result.source !== "profile";
      const requestedTokens =
        typeof values.targetPercent === "number"
          ? Math.floor(
              (policy.model.contextWindow * values.targetPercent) / 100,
            )
          : null;
      const targetDiffers =
        requestedTokens != null && requestedTokens !== result.tokens;
      setNotice(
        (scope === "profile"
          ? `Default saved in ${profile}.`
          : "Saved for this conversation.") +
          (shadowed ? ` ${_CP_source(result)} still takes precedence.` : "") +
          (targetDiffers
            ? ` Effective target remains ${_CP_percent(result.percent)}.`
            : ""),
      );
      setOpen(false);
      setDraft(null);
      requestAnimationFrame(() => trigger.current?.focus());
    } catch (failure) {
      if (T.owner(latest.current.policy) === owner)
        setLocalError(_CP_message(failure));
    } finally {
      busyRef.current = false;
      setBusy(false);
    }
  };
  const visibleError = localError || (error && _CP_message(error));
  return (
    <section
      className="context-policy-editor"
      aria-label="Context usage and auto-compaction"
      data-st-esc={open ? "" : undefined}
      onKeyDown={(event) => {
        if (event.key === "Escape" && open) {
          event.preventDefault();
          event.stopPropagation();
          const tips = event.currentTarget.querySelectorAll(
            ".context-policy-help-wrap.is-open .context-policy-help-text",
          );
          if (Array.from(tips).some((tip) => tip.getClientRects().length))
            setHelpDismissal((value) => value + 1);
          else close();
        }
      }}
    >
      {!open && (
        <window.ContextPolicyCollapsed
          trigger={trigger}
          begin={begin}
          available={available && !pending}
          usage={usage}
          used={used}
          total={total}
          target={target}
          policy={policy}
          loading={loading}
          number={_CP_number}
          percent={_CP_percent}
          source={_CP_source}
        />
      )}
      {!open && exceeded && (
        <p className="context-policy-warning" role="status">
          Current usage is already at or above the auto-compaction target.
        </p>
      )}
      {open && draft && (
        <window.ContextPolicySurface
          surfaceRef={surfaceRef}
          savedDrag={savedDrag}
          view={{
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
            canApply: !!onApply,
            helpDismissal,
          }}
          number={_CP_number}
          onLatest={() => {
            setDraft(T.createDraft(policy));
            setLocalError(null);
          }}
          onPercent={setPercent}
          onRestoreDrag={() => {
            if (savedDrag.current) setDraft(savedDrag.current);
            savedDrag.current = null;
          }}
          onReset={() => {
            setDraft((old) => ({ ...old, targetChange: "reset" }));
            setLocalError(null);
          }}
          onEdit={edit}
          onSave={save}
          onClose={close}
        />
      )}
      {visibleError && (
        <p className="context-policy-error" role="alert">
          {visibleError}
        </p>
      )}
      {notice && (
        <p className="context-policy-notice" role="status">
          {notice}
        </p>
      )}
      {!available && !open && onRefresh && (
        <button
          type="button"
          className="context-policy-link context-policy-close"
          disabled={pending}
          onClick={refresh}
        >
          Refresh policy
        </button>
      )}
    </section>
  );
}

function ContextPolicyEditor(props) {
  return <ContextPolicyGauge {...props} />;
}
Object.assign(window, { ContextPolicyGauge, ContextPolicyEditor });

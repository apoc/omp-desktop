/* Native context policy: the snapshot is authoritative; edits are scoped. */
const _CP_IDS = new Set([
  "threshold",
  "budget",
  "enabled",
  "method",
  "asyncEnabled",
  "midTurnEnabled",
]);
const _CP_PRIMARY = new Set(["threshold", "budget", "enabled"]);

function _CP_owner(policy) {
  return policy?.supported
    ? JSON.stringify([
        policy.profileId,
        policy.model?.provider,
        policy.model?.id,
        policy.sessionId,
        policy.sessionFile,
      ])
    : null;
}

function _CP_controls(policy, scope = "conversation") {
  const controls =
    scope === "profile" && Array.isArray(policy?.profileControls)
      ? policy.profileControls
      : policy?.controls || [];
  return controls.filter(
    (control) =>
      _CP_IDS.has(control.id) &&
      ["boolean", "number", "select"].includes(control.type),
  );
}

function _CP_values(policy, scope) {
  return Object.fromEntries(
    _CP_controls(policy, scope).map((control) => [
      control.id,
      control.type === "number"
        ? control.value == null
          ? ""
          : String(control.value)
        : control.value,
    ]),
  );
}

function _CP_snapshot(policy, scope) {
  const values = _CP_values(policy, scope);
  return {
    owner: _CP_owner(policy),
    revision: policy.revision,
    values,
    draft: { ...values },
    key: JSON.stringify(values),
  };
}

function _CP_dirty(state) {
  return !!state && JSON.stringify(state.draft) !== state.key;
}

function _CP_message(error) {
  return typeof error === "string"
    ? error
    : error?.message || String(error || "");
}

function ContextPolicyEditor({
  policy,
  loading = false,
  saving = false,
  error = null,
  onRefresh,
  onApply,
  profileName,
}) {
  const owner = _CP_owner(policy);
  const [scope, setScope] = React.useState("profile");
  const controls = _CP_controls(policy, scope);
  const profileKey = JSON.stringify(_CP_values(policy, "profile"));
  const conversationKey = JSON.stringify(_CP_values(policy, "conversation"));
  const valuesKey = scope === "profile" ? profileKey : conversationKey;
  const [drafts, setDrafts] = React.useState(() =>
    owner
      ? {
          profile: _CP_snapshot(policy, "profile"),
          conversation: _CP_snapshot(policy, "conversation"),
        }
      : {},
  );
  const state = drafts[scope];
  const [busy, setBusy] = React.useState(false);
  const [localError, setLocalError] = React.useState(null);
  const [notice, setNotice] = React.useState(null);
  const [ack, setAck] = React.useState(null);
  const busyRef = React.useRef(false);
  const latest = React.useRef(policy);
  const previousOwner = React.useRef(owner);
  latest.current = policy;
  const scopeId = React.useId();

  React.useEffect(() => {
    if (!owner) return;
    if (previousOwner.current !== owner) {
      previousOwner.current = owner;
      setScope("profile");
      setNotice(null);
      setLocalError(null);
    }
    const confirmed =
      ack && ack.owner === owner && policy.revision === ack.revision;
    if (ack && (confirmed || ack.owner !== owner)) {
      setAck(null);
      if (confirmed) setNotice("Policy refreshed.");
    }
    setDrafts((previous) => {
      const next = { ...previous };
      let changed = false;
      for (const target of ["profile", "conversation"]) {
        const old = previous[target];
        const key = target === "profile" ? profileKey : conversationKey;
        if (
          !old ||
          old.owner !== owner ||
          (confirmed && ack.scope === target) ||
          (!_CP_dirty(old) &&
            (old.revision !== policy.revision || old.key !== key))
        ) {
          next[target] = _CP_snapshot(policy, target);
          changed = true;
        }
      }
      return changed ? next : previous;
    });
  }, [owner, policy?.revision, profileKey, conversationKey, ack]);

  const dirty = _CP_dirty(state);
  const stale =
    !!state &&
    !!owner &&
    (state.owner !== owner ||
      state.revision !== policy.revision ||
      state.key !== valuesKey ||
      (!!ack && ack.owner === owner && ack.revision !== policy.revision));
  const pending = loading || saving || busy;
  const disabled = pending || !state || state.owner !== owner || !!ack;
  const edit = (id, value) => {
    setNotice(null);
    setLocalError(null);
    setDrafts((previous) =>
      previous[scope]
        ? {
            ...previous,
            [scope]: {
              ...previous[scope],
              draft: { ...previous[scope].draft, [id]: value },
            },
          }
        : previous,
    );
  };
  const useLatest = () => {
    if (!policy?.supported) return;
    setAck(null);
    setDrafts((previous) => ({
      ...previous,
      [scope]: _CP_snapshot(policy, scope),
    }));
    setLocalError(null);
    setNotice(null);
  };
  const refresh = async () => {
    if (!onRefresh || busyRef.current || loading || saving) return;
    busyRef.current = true;
    setBusy(true);
    setLocalError(null);
    setNotice(null);
    try {
      await onRefresh();
    } catch (failure) {
      setLocalError(_CP_message(failure));
    } finally {
      busyRef.current = false;
      setBusy(false);
    }
  };
  const apply = async (reset) => {
    if (
      !onApply ||
      busyRef.current ||
      pending ||
      disabled ||
      stale ||
      (!reset && !dirty)
    )
      return;
    const values = {};
    if (!reset) {
      const thresholdChanged = !Object.is(
        state.draft.threshold,
        state.values.threshold,
      );
      const budgetChanged = !Object.is(state.draft.budget, state.values.budget);
      const thresholdTouched = thresholdChanged || budgetChanged;
      if (
        scope === "profile" &&
        policy.conversationOverride &&
        !Array.isArray(policy.profileControls) &&
        thresholdTouched
      ) {
        setLocalError(
          "Saved profile threshold values are unavailable. Reload before changing the profile threshold.",
        );
        return;
      }
      for (const control of controls) {
        const bounds =
          control.id === "budget"
            ? policy.budgetBounds?.[state.draft.threshold]
            : null;
        const min = bounds?.min ?? control.min,
          max = bounds?.max ?? control.max;
        const value = state.draft[control.id];
        const coupled =
          thresholdTouched &&
          (control.id === "threshold" ||
            (control.id === "budget" && state.draft.threshold !== "inherit"));
        if (!coupled && Object.is(value, state.values[control.id])) continue;
        if (
          control.id === "budget" &&
          state.draft.threshold === "inherit" &&
          thresholdTouched
        )
          continue;
        if (control.type === "number") {
          const parsed = Number(value);
          if (
            value === "" ||
            !Number.isFinite(parsed) ||
            (min != null && parsed < min) ||
            (max != null && parsed > max)
          ) {
            setLocalError(
              `Enter a valid value for ${control.label}${min != null ? ` (minimum ${min})` : ""}${max != null ? ` (maximum ${max})` : ""}.`,
            );
            return;
          }
          values[control.id] = parsed;
        } else {
          values[control.id] = value;
        }
      }
    }
    busyRef.current = true;
    setBusy(true);
    setLocalError(null);
    setNotice(null);
    try {
      const refreshed = await onApply({
        scope,
        reset,
        values,
        revision: state.revision,
        model: { provider: policy.model?.provider, id: policy.model?.id },
      });
      const returned =
        refreshed?.supported &&
        Array.isArray(refreshed.controls) &&
        _CP_owner(refreshed) === owner;
      if (returned && _CP_owner(latest.current) === owner) {
        setAck({ owner, scope, revision: refreshed.revision });
      }
    } catch (failure) {
      if (_CP_owner(latest.current) === owner)
        setLocalError(_CP_message(failure));
    } finally {
      busyRef.current = false;
      setBusy(false);
    }
  };
  const visibleError = localError || (error && _CP_message(error));
  const primary = controls.filter((control) => _CP_PRIMARY.has(control.id));
  const advanced = controls.filter((control) => !_CP_PRIMARY.has(control.id));
  const missingProfileBudget =
    scope === "profile" &&
    policy?.conversationOverride &&
    !Array.isArray(policy.profileControls);
  const field = (control) => {
    const bounds =
      control.id === "budget"
        ? policy?.budgetBounds?.[state?.draft.threshold]
        : null;
    return (
      <window.ContextPolicyField
        key={control.id}
        control={bounds ? { ...control, ...bounds } : control}
        value={state?.draft[control.id]}
        methods={policy?.methods}
        disabled={
          disabled ||
          (control.id === "budget" && state?.draft.threshold === "inherit") ||
          (missingProfileBudget &&
            (control.id === "threshold" || control.id === "budget"))
        }
        onChange={(value) => edit(control.id, value)}
      />
    );
  };

  return (
    <section
      className="context-policy-editor"
      aria-label="Context policy editor"
      onKeyDown={(event) => {
        if (event.key === "Escape") event.stopPropagation();
      }}
    >
      <window.ContextPolicySummary
        policy={policy}
        loading={loading}
        error={error}
        profileName={profileName}
      />
      <div className="context-policy-toolbar">
        <span className="context-policy-kicker">edit policy</span>
        {onRefresh && (
          <button
            type="button"
            className="context-policy-link"
            onClick={refresh}
            disabled={pending}
          >
            Refresh
          </button>
        )}
      </div>
      {!policy?.supported ? (
        <p className="context-policy-note">
          Editing is unavailable for this snapshot.
        </p>
      ) : (
        <>
          <fieldset className="context-policy-scope" disabled={disabled}>
            <legend>Apply to</legend>
            <label>
              <input
                type="radio"
                name={scopeId}
                value="profile"
                checked={scope === "profile"}
                onChange={() => {
                  setScope("profile");
                  setNotice(null);
                }}
              />{" "}
              Profile default
            </label>
            <label>
              <input
                type="radio"
                name={scopeId}
                value="conversation"
                checked={scope === "conversation"}
                onChange={() => {
                  setScope("conversation");
                  setNotice(null);
                }}
              />{" "}
              This conversation
            </label>
          </fieldset>
          <p className="context-policy-note">
            {scope === "profile"
              ? `Changes apply to conversations inheriting ${profileName || policy.profileId || "this profile"}. A conversation override can still take precedence.`
              : "Changes apply only to this conversation; the profile default is unchanged."}{" "}
            {scope === "profile" && Array.isArray(policy.profileControls)
              ? "Fields show the saved profile values."
              : "Fields show the current effective policy."}{" "}
            Threshold and budget are applied together unless inherited.
          </p>
          {missingProfileBudget && (
            <p className="context-policy-note">
              Saved profile threshold values are unavailable. Threshold editing
              is disabled to avoid copying the conversation override.
            </p>
          )}
          {stale && (
            <div className="context-policy-stale" role="status">
              <span>
                {ack
                  ? "Waiting for the refreshed policy. Refresh or use the latest available settings."
                  : "Policy changed externally. Reload the latest settings before applying; your draft will be discarded."}
              </span>
              <button
                type="button"
                className="context-policy-link"
                disabled={pending}
                onClick={useLatest}
              >
                Use latest
              </button>
            </div>
          )}
          <div className="context-policy-fields">{primary.map(field)}</div>
          {advanced.length > 0 && (
            <details className="context-policy-advanced">
              <summary>Advanced options</summary>
              <div className="context-policy-fields">{advanced.map(field)}</div>
            </details>
          )}
          {controls.length === 0 && (
            <p className="context-policy-note">
              No editable controls are available.
            </p>
          )}
          <div className="context-policy-actions">
            <button
              type="button"
              className="context-policy-apply"
              disabled={disabled || stale || !dirty || !onApply}
              onClick={() => apply(false)}
            >
              {pending ? "Working…" : "Apply changes"}
            </button>
            <button
              type="button"
              className="context-policy-reset"
              disabled={disabled || stale || !onApply}
              onClick={() => apply(true)}
            >
              {scope === "profile"
                ? "Reset profile default"
                : "Reset conversation override"}
            </button>
          </div>
          {dirty && !stale && (
            <p className="context-policy-note">Unsaved changes</p>
          )}
        </>
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
    </section>
  );
}

window.ContextPolicyEditor = ContextPolicyEditor;

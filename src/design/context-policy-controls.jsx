function _CPC_message(error) {
  return typeof error === "string"
    ? error
    : error?.message || String(error || "");
}

function _CPC_number(value) {
  return typeof value === "number" && Number.isFinite(value)
    ? value.toLocaleString()
    : "—";
}

function ContextPolicySummary({
  policy,
  loading = false,
  error = null,
  profileName,
}) {
  if (!policy?.supported) {
    return (
      <div className="context-policy-summary" aria-live="polite">
        <span className="context-policy-kicker">context policy</span>
        <p className="context-policy-note">
          {loading
            ? "Loading policy…"
            : policy?.reason ||
              (error ? _CPC_message(error) : "Policy unavailable.")}
        </p>
      </div>
    );
  }
  const maintenance = policy.lastMaintenance;
  return (
    <div className="context-policy-summary" aria-live="polite">
      <div className="context-policy-summary-head">
        <span className="context-policy-kicker">context policy</span>
        <span className="context-policy-status">
          {policy.enabled ? "enabled" : "disabled"}
        </span>
      </div>
      <dl className="context-policy-metrics">
        <div>
          <dt>Effective threshold</dt>
          <dd>
            {_CPC_number(policy.thresholdTokens)} <span>tokens</span>
          </dd>
        </div>
        <div>
          <dt>Model capacity</dt>
          <dd>
            {_CPC_number(policy.model?.contextWindow)} <span>tokens</span>
          </dd>
        </div>
        <div>
          <dt>Source</dt>
          <dd>{policy.source || "Unavailable"}</dd>
        </div>
        {Array.isArray(policy.methodOrder) && (
          <div>
            <dt>Method order</dt>
            <dd>{policy.methodOrder.join(" → ")}</dd>
          </div>
        )}
      </dl>
      <p className="context-policy-note">
        {policy.conversationOverride
          ? "This conversation has an override; the profile default may differ."
          : `Defaults belong to ${profileName || policy.profileId || "the selected profile"}; native overrides are shown above.`}
      </p>
      {maintenance && (
        <p className="context-policy-note">
          Last maintenance: {maintenance.status}
          {maintenance.method ? ` · ${maintenance.method}` : ""}
          {maintenance.error ? ` · ${maintenance.error}` : ""}
        </p>
      )}
    </div>
  );
}

function ContextPolicyField({ control, value, disabled, onChange, methods }) {
  const id = React.useId();
  const descriptionId = `${id}-description`;
  const options =
    control.type === "select"
      ? Array.isArray(control.options)
        ? control.options
        : control.id === "method" && Array.isArray(methods)
          ? methods.map((method) => ({ value: method, label: method }))
          : []
      : [];
  const selected = options.findIndex((option) =>
    Object.is(option.value, value),
  );
  const selectedDescription =
    selected >= 0 ? options[selected].description : null;
  const description = [control.description, selectedDescription]
    .filter(Boolean)
    .join(" ");
  return (
    <div
      className={`context-policy-field${control.type === "boolean" ? " is-boolean" : ""}`}
    >
      <div className="context-policy-field-label">
        <label htmlFor={id}>{control.label}</label>
        {description && (
          <span id={descriptionId} className="context-policy-help">
            {description}
          </span>
        )}
      </div>
      {control.type === "boolean" ? (
        <input
          id={id}
          type="checkbox"
          checked={!!value}
          disabled={disabled}
          aria-describedby={description ? descriptionId : undefined}
          onChange={(event) => onChange(event.target.checked)}
        />
      ) : control.type === "number" ? (
        <input
          id={id}
          type="number"
          step="any"
          min={control.min}
          max={control.max}
          value={value ?? ""}
          disabled={disabled}
          aria-describedby={description ? descriptionId : undefined}
          onChange={(event) => onChange(event.target.value)}
        />
      ) : (
        <select
          id={id}
          value={selected < 0 ? "" : String(selected)}
          disabled={disabled || !options.length}
          aria-describedby={description ? descriptionId : undefined}
          onChange={(event) => {
            const index = Number(event.target.value);
            if (event.target.value !== "" && options[index])
              onChange(options[index].value);
          }}
        >
          {selected < 0 && (
            <option value="">{`Current: ${String(value ?? "unavailable")}${options.length ? "" : " · options unavailable"}`}</option>
          )}
          {options.map((option, index) => (
            <option key={index} value={String(index)}>
              {option.label}
            </option>
          ))}
        </select>
      )}
    </div>
  );
}

Object.assign(window, { ContextPolicyField, ContextPolicySummary });

function ContextPolicyHelp({ label, children, dismissToken }) {
  const [open, setOpen] = React.useState(false);
  const [hovered, setHovered] = React.useState(false);
  const [focused, setFocused] = React.useState(false);
  const [dismissed, setDismissed] = React.useState(false);
  const id = React.useId();
  const lastDismiss = React.useRef(dismissToken);
  React.useEffect(() => {
    if (lastDismiss.current !== dismissToken) {
      setDismissed(true);
      setOpen(false);
      lastDismiss.current = dismissToken;
    }
  }, [dismissToken]);
  const visible = !dismissed && (open || hovered || focused);
  return (
    <span
      className={`context-policy-help-wrap${visible ? " is-open" : ""}`}
      onMouseEnter={() => {
        setHovered(true);
        setDismissed(false);
      }}
      onMouseLeave={() => setHovered(false)}
      onFocus={() => {
        setFocused(true);
        setDismissed(false);
      }}
      onBlur={(event) => {
        if (!event.currentTarget.contains(event.relatedTarget)) {
          setFocused(false);
          setOpen(false);
        }
      }}
    >
      <button
        type="button"
        className="context-policy-help-button"
        aria-label={label}
        aria-describedby={id}
        aria-expanded={visible}
        onClick={() => {
          setDismissed(false);
          setOpen(!open);
        }}
      >
        ?
      </button>
      <span id={id} role="tooltip" className="context-policy-help-text">
        {children}
      </span>
    </span>
  );
}

function ContextPolicyOptions({
  policy,
  values,
  disabled,
  onChange,
  helpDismissal,
}) {
  const controls = policy.controls || [];
  const get = (id) => controls.find((control) => control.id === id);
  const method = get("method");
  const options = method?.options || [];
  const order =
    Array.isArray(policy.methodOrder) && policy.methodOrder.length
      ? policy.methodOrder.join(" → ")
      : "the native fallback order";
  const boolean = (id, label, help) =>
    get(id) && (
      <div className="context-policy-option">
        <label>
          <input
            type="checkbox"
            checked={!!values[id]}
            disabled={disabled}
            onChange={(event) => onChange(id, event.target.checked)}
          />{" "}
          {label}
        </label>
        <ContextPolicyHelp
          label={`About ${label}`}
          dismissToken={helpDismissal}
        >
          {help}
        </ContextPolicyHelp>
      </div>
    );
  return (
    <>
      {boolean(
        "enabled",
        "Auto-compact",
        "Turning this off also disables idle auto-compaction at the chosen scope. It retains the target and does not stop work already running or affect manual compaction or ordinary pruning. Turning it on does not re-enable idle compaction.",
      )}
      <details className="context-policy-advanced">
        <summary>Advanced options</summary>
        <div className="context-policy-options">
          {method && (
            <div className="context-policy-method">
              <div className="context-policy-option">
                <span>Preferred method</span>
                <ContextPolicyHelp
                  label="About preferred method"
                  dismissToken={helpDismissal}
                >
                  The preferred method is tried first, followed by native
                  fallbacks. Current full order: {order}.
                </ContextPolicyHelp>
              </div>
              <ContextPolicyMethodSelect
                method={method}
                value={values.method}
                disabled={disabled}
                onChange={(value) => onChange("method", value)}
                options={options}
              />
            </div>
          )}
          {boolean(
            "asyncEnabled",
            "Background preparation",
            get("asyncEnabled")?.description ||
              "Prepare compaction in the background when supported.",
          )}
          {boolean(
            "midTurnEnabled",
            "Safe mid-turn checks",
            get("midTurnEnabled")?.description ||
              "Allow safe compaction checks during a turn when supported.",
          )}
        </div>
      </details>
    </>
  );
}

function ContextPolicyMethodSelect({
  method,
  value,
  disabled,
  onChange,
  options,
}) {
  const id = React.useId();
  return (
    <label className="context-policy-method-select">
      <span className="context-policy-visually-hidden">
        {method.label || "Preferred method"}
      </span>
      <select
        id={id}
        value={value ?? ""}
        disabled={disabled}
        onChange={(event) => onChange(event.target.value)}
      >
        {!options.some((option) => option.value === value) && (
          <option value={value ?? ""}>
            Current: {String(value ?? "unavailable")}
          </option>
        )}
        {options.map((option) => (
          <option key={option.value} value={option.value}>
            {option.value === "native" ? "Native default" : option.label}
          </option>
        ))}
      </select>
    </label>
  );
}

Object.assign(window, { ContextPolicyHelp, ContextPolicyOptions });

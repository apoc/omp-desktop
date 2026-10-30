/* Shared evidence controls. Ledger data remains owned by the native controller. */
(function () {
  const kinds = [
    "any",
    "image",
    "video",
    "test",
    "runtime",
    "code",
    "ci",
    "build",
    "other",
  ];
  function Field({ label, children }) {
    return (
      <label className="ev-field">
        <span>{label}</span>
        {children}
      </label>
    );
  }
  function KindSelect({ value, onChange, any = true }) {
    return (
      <select value={value} onChange={(e) => onChange(e.target.value)}>
        {kinds
          .filter((k) => any || k !== "any")
          .map((k) => (
            <option key={k} value={k}>
              {k}
            </option>
          ))}
      </select>
    );
  }
  function ErrorMessage({ error }) {
    return error ? (
      <p className="ev-error" role="alert">
        {String(error?.message || error)}
      </p>
    ) : null;
  }
  function useAction() {
    const [error, setError] = React.useState("");
    const [busy, setBusy] = React.useState(false);
    const pending = React.useRef(false);
    const mounted = React.useRef(true);
    React.useEffect(() => {
      mounted.current = true;
      return () => {
        mounted.current = false;
      };
    }, []);
    const run = async (fn, success) => {
      if (pending.current) return undefined;
      pending.current = true;
      setError("");
      setBusy(true);
      try {
        const value = await fn();
        if (mounted.current && success) success(value);
        return value;
      } catch (e) {
        if (mounted.current) setError(e?.message || String(e));
      } finally {
        pending.current = false;
        if (mounted.current) setBusy(false);
      }
    };
    return { error, busy, run };
  }
  function Status({ status }) {
    return (
      <span
        className={`ev-status ev-${status?.state || "missing"}`}
        title={status?.reason || ""}
      >
        {status?.label || "Unknown"}
      </span>
    );
  }
  function When({ at }) {
    if (!at) return null;
    const date = new Date(at);
    return (
      <time
        dateTime={Number.isNaN(date.getTime()) ? undefined : date.toISOString()}
      >
        {Number.isNaN(date.getTime()) ? String(at) : date.toLocaleString()}
      </time>
    );
  }
  Object.assign(window, {
    EvidenceField: Field,
    EvidenceKindSelect: KindSelect,
    EvidenceError: ErrorMessage,
    useEvidenceAction: useAction,
    EvidenceStatus: Status,
    EvidenceWhen: When,
  });
})();

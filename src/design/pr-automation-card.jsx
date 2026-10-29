// Shows local changes and the checked-out branch's known PR.
function PrAutomationCard({ automation, available = true, bridge, onOpenChanges }) {
  const [collapsed, setCollapsed] = React.useState(false);
  const [menu, setMenu] = React.useState(null);
  const [actionError, setActionError] = React.useState(null);
  const triggerRef = React.useRef(null);
  const popRef = React.useRef(null);
  const rootRef = React.useRef(null);
  const menuId = React.useId();
  const descriptionId = React.useId();
  const autoFixDescription = "Fix CI and review feedback. May commit, push and resolve addressed threads; tool approvals still apply.";
  const pr = automation.snapshot;
  // The menu is portaled out of the rail's scroll container.
  rootRef.current = {
    contains: (node) =>
      triggerRef.current?.contains(node) || popRef.current?.contains(node),
  };
  const close = (refocus = true) => {
    setMenu(null);
    if (refocus) triggerRef.current?.focus();
  };
  window.usePopoverDismiss(!!menu, rootRef, () => close(false), close);
  React.useEffect(() => {
    setMenu(null);
    setActionError(null);
  }, [pr?.url]);
  React.useEffect(() => {
    if (!menu) return undefined;
    popRef.current?.querySelector('[role="menuitem"]')?.focus();
    const dismiss = (e) => {
      if (e.type === "resize" || !popRef.current?.contains(e.target))
        close(false);
    };
    window.addEventListener("resize", dismiss);
    document.addEventListener("scroll", dismiss, true);
    return () => {
      window.removeEventListener("resize", dismiss);
      document.removeEventListener("scroll", dismiss, true);
    };
  }, [menu]);

  const openMenu = () => {
    if (menu) {
      close();
      return;
    }
    const rect = triggerRef.current.getBoundingClientRect();
    const below = window.innerHeight - rect.bottom - 12;
    const above = rect.top - 12;
    const position =
      below < 280 && above > below
        ? {
            bottom: window.innerHeight - rect.top + 4,
            maxHeight: Math.max(0, above),
          }
        : { top: rect.bottom + 4, maxHeight: Math.max(0, below) };
    setMenu({
      right: Math.max(
        8,
        Math.min(window.innerWidth - rect.right, window.innerWidth - 258),
      ),
      ...position,
    });
    setActionError(null);
  };
  const openUrl = async (suffix, refocus = true) => {
    setActionError(null);
    try {
      const result = await bridge.openExternalUrl(pr.url + suffix);
      if (!result?.ok)
        throw new Error(result?.error || "Could not open GitHub.");
      close(refocus);
    } catch (error) {
      setActionError(error?.message || String(error));
    }
  };
  const copyLink = async () => {
    if (await window.copyText(pr.url)) close();
    else setActionError("Could not copy the PR link.");
  };
  const localCount = automation.localChanges?.changed || 0;
  const localSummary = `${automation.localError ? "Last known · " : ""}${automation.localChanges?.truncated ? "At least " : ""}${localCount} changed ${localCount === 1 ? "file" : "files"}`;
  if (!pr && localCount <= 0) return null;

  const status = pr ? window.OMP_PR_STATUS.present(automation) : null;
  const showAutoFix = pr?.state === "OPEN" && (automation.enabled
    || status.tone === "failure" || status.threadCount > 0);

  return (
    <section className="rail-card glass pr-changes" aria-label="Changes">
      <div className="pr-changes-head">
        <button
          className="pr-changes-heading"
          aria-expanded={!collapsed}
          onClick={() => setCollapsed((v) => !v)}
        >
          Changes <window.Icon name={collapsed ? "chevR" : "chev"} size={11} />
        </button>
      </div>
      {!collapsed && pr && (
        <div className="pr-changes-row">
          <window.PrStatus model={status} mode="icon" />
          <button
            className="pr-changes-title"
            title={pr.title}
            onClick={() => openUrl("")}
          >
            {pr.title}
          </button>
          <button
            ref={triggerRef}
            className={`pr-changes-more${menu ? " active" : ""}`}
            onClick={openMenu}
            aria-label={`PR actions for pull request #${pr.number}`}
            aria-haspopup="menu"
            aria-expanded={!!menu}
            aria-controls={menu ? menuId : undefined}
          >
            PR actions
          </button>
          <div className="pr-changes-meta">
            <span className="pr-changes-repo" title={pr.repository}>
              {pr.repository?.split("/").at(-1)}
            </span>
            <span className="pr-changes-lifecycle">{status.stale ? "Last known · " : ""}{status.label}</span>
            <span className="pr-changes-added">+{pr.additions}</span>
            <span className="pr-changes-deleted">−{pr.deletions}</span>
            <window.PrStatus model={status} mode="badges" onReview={() => openUrl("#discussion_bucket", false)} />
          </div>
          {showAutoFix && (
            <window.StatusDetail className="pr-changes-autofix-inline"
              text={`${automation.status}\n${autoFixDescription}\nThis tab only. Stop also turns Auto-fix off.`}>
              <button type="button" className="pr-changes-autofix-toggle"
                aria-label={automation.enabled ? "Turn off Auto-fix" : "Enable Auto-fix for CI and review feedback"}
                aria-pressed={automation.enabled}
                disabled={!automation.enabled && (!available || !automation.canEnable)}
                onClick={automation.toggle}>
                Auto-fix{automation.enabled ? " on" : ""}
              </button>
            </window.StatusDetail>
          )}
        </div>
      )}
      {!collapsed && localCount > 0 && (
        <div className="pr-changes-local">
          {onOpenChanges ? (
            <button className="pr-changes-local-link" onClick={onOpenChanges}>
              {localSummary}
            </button>
          ) : (
            <span>{localSummary}</span>
          )}
        </div>
      )}
      {!collapsed && pr && automation.discoveryError && (
        <p className="pr-changes-error" role="alert">
          PR refresh failed: {automation.discoveryError}
        </p>
      )}
      {!collapsed && automation.localError && (
        <p className="pr-changes-error" role="alert">
          Local changes refresh failed: {automation.localError}
        </p>
      )}
      {!collapsed && pr && automation.enabled && automation.error && (
        <p className="pr-changes-error" role="alert">
          Auto-fix error: {automation.error}
        </p>
      )}
      {pr && actionError && !menu && (
        <p className="pr-changes-error" role="alert">
          {actionError}
        </p>
      )}
      {menu &&
        pr &&
        ReactDOM.createPortal(
          <div
            ref={popRef}
            id={menuId}
            className="pr-changes-menu"
            style={menu}
            role="menu"
            aria-label={`Pull request #${pr.number}`}
            onKeyDown={(e) =>
              window.menuKeyNav(e, popRef.current, '[role^="menuitem"]', close)
            }
          >
            <button role="menuitem" onClick={() => openUrl("")}>
              Open on GitHub
            </button>
            <button role="menuitem" onClick={copyLink}>
              Copy link
            </button>
            <div className="pr-changes-separator" role="separator" />
            <button role="menuitem" onClick={() => openUrl("/files")}>
              View changes
            </button>
            <button
              role="menuitem"
              onClick={() => openUrl("#discussion_bucket")}
            >
              Open review comments
            </button>
            {pr.state === "OPEN" && (
              <>
                <div className="pr-changes-separator" role="separator" />
                <p className="pr-changes-menu-heading">Automation</p>
                <button
                  className="pr-changes-autofix"
                  role="menuitemcheckbox"
                  aria-checked={automation.enabled}
                  disabled={!automation.enabled && (!available || !automation.canEnable)}
                  aria-describedby={descriptionId}
                  onClick={automation.toggle}
                >
                  <span className="pr-changes-checkbox" aria-hidden="true">
                    {automation.enabled && <window.Icon name="check" size={10} />}
                  </span>
                  Auto-fix
                </button>
                <p id={descriptionId} className="pr-changes-menu-note">
                  {autoFixDescription}
                </p>
                <p className="pr-changes-menu-status" role="status">
                  {automation.status}
                </p>
                <p className="pr-changes-menu-note">
                  This tab only. Stop also turns Auto-fix off.
                </p>
              </>
            )}
            {actionError && (
              <p className="pr-changes-error" role="alert">
                {actionError}
              </p>
            )}
          </div>,
          document.body,
        )}
    </section>
  );
}
window.PrAutomationCard = PrAutomationCard;

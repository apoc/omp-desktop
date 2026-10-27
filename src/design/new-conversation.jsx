// The bridge owns the pending request; this dialog owns inspection and choices.
// Neither opening the dialog nor editing defaults starts a conversation.
const { OMP_CONVERSATION_WORKSPACE: _NC_Workspace } = window;

function NewConversationDialog({ request, bridge, suspended = false }) {
  const panelRef = React.useRef(null);
  const mountedRef = React.useRef(false);
  const inspectionRef = React.useRef(0);
  const busyRef = React.useRef(false);
  const [mode, setMode] = React.useState(
    request.configure ? "defaults" : "launch",
  );
  const [info, setInfo] = React.useState(null);
  const [status, setStatus] = React.useState(null);
  const [statusError, setStatusError] = React.useState(null);
  const [refName, setRefName] = React.useState(null);
  const [worktree, setWorktree] = React.useState(false);
  const [defaultRef, setDefaultRef] = React.useState(null);
  const [defaultWorktree, setDefaultWorktree] = React.useState(false);
  const [acknowledge, setAcknowledge] = React.useState(false);
  const [loading, setLoading] = React.useState(true);
  const [busy, setBusy] = React.useState(false);
  const [error, setError] = React.useState(null);
  window.useModalFocus(panelRef, !suspended);

  const inspect = React.useCallback(async () => {
    const serial = ++inspectionRef.current;
    const current = () =>
      mountedRef.current && serial === inspectionRef.current;
    setLoading(true);
    setError(null);
    setStatusError(null);
    setInfo(null);
    setStatus(null);
    setAcknowledge(false);
    let preview;
    try {
      const result = await bridge.inspectConversationWorkspace(
        request.path,
        request.profile,
      );
      if (!current()) return;
      if (!result?.ok || !result.value) {
        setError(String(result?.error || "Could not inspect this folder."));
        setLoading(false);
        return;
      }
      preview = result.value;
      const initial = _NC_Workspace.initialSelection(preview);
      const defaults = _NC_Workspace.defaultSelection(preview);
      setInfo(preview);
      setRefName(initial.refName);
      setWorktree(!!preview.repoRoot && initial.worktree);
      setDefaultRef(defaults.refName);
      setDefaultWorktree(defaults.worktree);
      // Metadata is enough to choose a branch or start an isolated worktree.
      setLoading(false);
    } catch (err) {
      if (current()) {
        setError(String(err?.message || err));
        setLoading(false);
      }
      return;
    }
    if (request.configure) return; // Editing project defaults never needs a checkout scan.
    try {
      const result = await bridge.conversationWorkspaceStatus(preview.path);
      if (!current()) return;
      if (!result?.ok || !_NC_Workspace.statusKnown(result.value)) {
        setStatusError(
          String(result?.error || "Could not check workspace status."),
        );
      } else {
        setStatus(result.value);
      }
    } catch (err) {
      if (current()) setStatusError(String(err?.message || err));
    }
  }, [bridge, request.path, request.profile, request.configure]);

  React.useEffect(() => {
    mountedRef.current = true;
    inspect();
    return () => {
      mountedRef.current = false;
      inspectionRef.current++;
    };
  }, [inspect, request.id]);

  React.useEffect(() => {
    if (suspended) return undefined;
    const onKey = (e) => {
      e.stopPropagation();
      const panel = panelRef.current;
      if (e.key === "Escape") {
        e.preventDefault();
        if (!busyRef.current) bridge.cancelConversationSetup(request.id);
        return;
      }
      if (e.key === "Tab") {
        e.preventDefault();
        const controls = [
          ...(panel?.querySelectorAll(
            'button:not([disabled]), select:not([disabled]), input:not([disabled]), [tabindex]:not([tabindex="-1"])',
          ) || []),
        ];
        if (!controls.length) {
          panel?.focus();
          return;
        }
        const index = controls.indexOf(document.activeElement);
        const next =
          index < 0
            ? e.shiftKey
              ? controls.length - 1
              : 0
            : (index + (e.shiftKey ? controls.length - 1 : 1)) %
              controls.length;
        controls[next].focus();
        return;
      }
      if (!panel?.contains(e.target)) {
        e.preventDefault();
        panel?.focus();
      } else if (
        e.ctrlKey ||
        e.metaKey ||
        (e.altKey &&
          !(
            e.target.tagName === "SELECT" &&
            (e.key === "ArrowDown" || e.key === "ArrowUp")
          ))
      ) {
        e.preventDefault();
      }
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [bridge, request.id, suspended]);

  const configuring = mode === "defaults";
  const branches = _NC_Workspace.choices(info);
  const shownRef = configuring ? defaultRef : refName;
  const shownWorktree = configuring ? defaultWorktree : worktree;
  const branchChoices = configuring
    ? branches.filter((branch) => branch.refName !== "HEAD")
    : branches;
  const selected = branches.find((branch) => branch.refName === shownRef);
  const missing =
    shownRef && !branchChoices.some((branch) => branch.refName === shownRef);
  const decision = configuring
    ? _NC_Workspace.defaultsDecision(info, defaultRef, defaultWorktree)
    : _NC_Workspace.selection(info, refName, worktree, acknowledge, status);
  const folder = info?.projectPath || info?.path || request.path;
  const cancel = () => {
    if (!busyRef.current) bridge.cancelConversationSetup(request.id);
  };
  const start = async () => {
    if (busyRef.current || loading || decision.error || !decision.options)
      return;
    busyRef.current = true;
    setBusy(true);
    setError(null);
    try {
      const result = await bridge.startConversationSetup(
        request.id,
        decision.options,
      );
      if (mountedRef.current && !result?.ok)
        setError(String(result?.error || "Could not start the conversation."));
    } catch (err) {
      if (mountedRef.current) setError(String(err?.message || err));
    } finally {
      busyRef.current = false;
      if (mountedRef.current) setBusy(false);
    }
  };
  const save = async () => {
    if (busyRef.current || loading || decision.error || !decision.options)
      return;
    busyRef.current = true;
    setBusy(true);
    setError(null);
    try {
      const result = await bridge.setProjectWorkspaceDefaults(
        info.path,
        request.profile,
        decision.options,
      );
      if (!mountedRef.current) return;
      if (!result?.ok) {
        setError(String(result?.error || "Could not save project defaults."));
      } else if (request.configure) {
        bridge.cancelConversationSetup(request.id);
      } else {
        setInfo(
          (previous) =>
            previous && {
              ...previous,
              defaults: decision.options.baseRef ? decision.options : null,
            },
        );
        setMode("launch");
      }
    } catch (err) {
      if (mountedRef.current) setError(String(err?.message || err));
    } finally {
      busyRef.current = false;
      if (mountedRef.current) setBusy(false);
    }
  };

  if (suspended) return null;

  return (
    <div
      className="bridge-scrim nc-scrim"
      onClick={(e) => {
        if (e.target === e.currentTarget) cancel();
      }}
    >
      <div
        className="nc-panel"
        ref={panelRef}
        tabIndex={-1}
        role="dialog"
        aria-modal="true"
        aria-labelledby="nc-title"
        aria-describedby="nc-folder"
      >
        <div className="nc-head">
          <span id="nc-title">
            {configuring ? "Project workspace defaults" : "New conversation"}
          </span>
          <span className="nc-profile mono">{request.profile}</span>
        </div>
        <div className="nc-body">
          <div className="nc-caption">Project folder</div>
          <div
            className="nc-path mono selectable"
            id="nc-folder"
            title={folder}
          >
            {folder}
          </div>
          {info?.path && info.path !== folder && (
            <div className="nc-detail mono">Workspace: {info.path}</div>
          )}
          {configuring ? (
            <div className="nc-explainer">
              Defaults apply to new conversations for this project and profile.
              Saving stores a branch, not a commit; it does not move existing
              conversations or change files.
            </div>
          ) : (
            <div className="nc-explainer">
              These choices apply only to this conversation; starting does not
              save project defaults.
            </div>
          )}
          <div className="nc-row">
            <label className="nc-branch">
              {configuring ? "Default base:" : "Start from:"}
              <select
                value={shownRef || ""}
                disabled={
                  busy ||
                  loading ||
                  !info ||
                  (!info.repoRoot && !shownRef && !configuring)
                }
                onChange={(e) => {
                  const value = e.target.value || null;
                  if (configuring) {
                    setDefaultRef(value);
                    if (!value) setDefaultWorktree(false);
                  } else {
                    setRefName(value);
                    setAcknowledge(false);
                  }
                }}
              >
                {configuring && (
                  <option value="">Use current branch (no default)</option>
                )}
                {!configuring && (!info?.head || !info?.repoRoot) && (
                  <option value="">
                    {info?.repoRoot
                      ? "No current commit"
                      : "Use folder directly"}
                  </option>
                )}
                {missing && (
                  <option value={shownRef}>{shownRef} · unavailable</option>
                )}
                {branchChoices.map((branch) => (
                  <option key={branch.refName} value={branch.refName}>
                    {branch.name}
                    {branch.refName === _NC_Workspace.defaultRef(info)
                      ? " · current"
                      : ""}
                    {branch.refName === "HEAD"
                      ? ""
                      : branch.remote
                        ? " · remote"
                        : " · local"}
                  </option>
                ))}
              </select>
            </label>
            <label className="nc-worktree">
              <input
                type="checkbox"
                checked={shownWorktree}
                disabled={
                  busy ||
                  loading ||
                  !info?.repoRoot ||
                  (configuring && !defaultRef)
                }
                onChange={(e) => {
                  if (configuring) setDefaultWorktree(e.target.checked);
                  else {
                    setWorktree(e.target.checked);
                    setAcknowledge(false);
                  }
                }}
              />
              Worktree
            </label>
          </div>
          {loading && (
            <div className="nc-detail" role="status">
              Inspecting folder…
            </div>
          )}
          {info && !info.repoRoot && (
            <div className="nc-detail">
              Not a git repository. Conversations use this folder directly.
            </div>
          )}
          {info?.repoRoot && (
            <div className="nc-detail mono">
              {selected ? (
                <>
                  <span>{selected.refName}</span>
                  <span title={selected.commit}> · {selected.commit}</span>
                </>
              ) : configuring && !shownRef ? (
                "No saved branch; use the current branch at launch."
              ) : missing ? (
                "Branch unavailable"
              ) : (
                "No commit yet"
              )}
              {info.repoRoot !== info.path && (
                <div>Repository: {info.repoRoot}</div>
              )}
            </div>
          )}
          {!configuring && info?.repoRoot && worktree && (
            <div className="nc-note">
              A separate worktree will be created from the selected commit.
              Uncommitted source changes are not copied.
            </div>
          )}
          {!configuring &&
            info?.repoRoot &&
            !worktree &&
            !decision.needsAcknowledgement &&
            !decision.error && (
              <div className="nc-detail">Uses the existing project files.</div>
            )}
          {!configuring && decision.needsAcknowledgement && (
            <label className="nc-ack">
              <input
                type="checkbox"
                checked={acknowledge}
                disabled={busy}
                onChange={(e) => setAcknowledge(e.target.checked)}
              />
              <span>
                I understand this conversation shares the existing files
                {status.dirty ? ", including uncommitted changes" : ""}
                {status.owners > 0
                  ? `, with ${status.owners} open ${status.owners === 1 ? "tab" : "tabs"}`
                  : ""}
                .
              </span>
            </label>
          )}
          {!configuring && info && !status && !statusError && (
            <div className="nc-detail" role="status">
              Checking workspace status…
            </div>
          )}
          {!configuring && statusError && (
            <div className="nc-warning" role="status">
              Status check failed: {statusError} Refresh to retry. Worktree off
              cannot start until status is known.
            </div>
          )}
          {!loading && info && decision.error && (
            <div className="nc-warning">{decision.error}</div>
          )}
          {error && (
            <div className="nc-error" role="alert">
              {error}
            </div>
          )}
        </div>
        <div className="nc-foot">
          <button
            type="button"
            className="btn ghost"
            disabled={busy || loading}
            onClick={inspect}
          >
            Refresh
          </button>
          {!configuring && (
            <button
              type="button"
              className="btn ghost"
              disabled={busy || loading || !info}
              onClick={() => {
                const defaults = _NC_Workspace.defaultSelection(info);
                setDefaultRef(defaults.refName);
                setDefaultWorktree(defaults.worktree);
                setError(null);
                setMode("defaults");
              }}
            >
              Project defaults
            </button>
          )}
          <span className="nc-spacer" />
          {configuring && !request.configure && (
            <button
              type="button"
              className="btn ghost"
              disabled={busy}
              onClick={() => {
                setError(null);
                setMode("launch");
              }}
            >
              Back
            </button>
          )}
          <button
            type="button"
            className="btn ghost"
            disabled={busy}
            onClick={cancel}
          >
            Cancel
          </button>
          <button
            type="button"
            className="btn outlined"
            disabled={busy || loading || !info || !!decision.error}
            onClick={configuring ? save : start}
          >
            {busy
              ? configuring
                ? "Saving…"
                : "Starting…"
              : configuring
                ? "Save defaults"
                : "Start conversation"}
          </button>
        </div>
      </div>
    </div>
  );
}

window.NewConversationDialog = NewConversationDialog;

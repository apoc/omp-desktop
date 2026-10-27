// Pure selection and safety rules for the new-conversation workspace dialog.
// Rust rechecks the ref, commit and ownership when starting a session.
(function () {
  function choices(info) {
    if (!info?.repoRoot) return [];
    const branches = (info.branches || []).map((branch) => ({
      refName: branch.refName,
      commit: branch.commit,
      name: branch.name,
      remote: branch.remote,
    }));
    if (!info.currentBranch && info.head) {
      branches.unshift({
        refName: "HEAD",
        commit: info.head,
        name: "HEAD (detached)",
        remote: false,
      });
    }
    return branches;
  }

  function defaultRef(info) {
    if (!info?.repoRoot) return null;
    if (!info.currentBranch) return info.head ? "HEAD" : null;
    const current = choices(info).find(
      (branch) => !branch.remote && branch.name === info.currentBranch,
    );
    return current?.refName || null;
  }

  // Defaults store a ref, never a commit. Keep a missing saved ref selected
  // so the user must choose another rather than silently launching elsewhere.
  function initialSelection(info) {
    return {
      refName: info?.defaults?.baseRef ?? defaultRef(info),
      worktree: !!info?.defaults?.worktree,
    };
  }

  function defaultSelection(info) {
    return {
      refName: info?.defaults?.baseRef ?? null,
      worktree: !!info?.defaults?.worktree,
    };
  }

  function defaultsDecision(info, refName, worktree) {
    if (!info)
      return { error: "Inspect the folder before saving.", options: null };
    if (!refName)
      return { error: null, options: { baseRef: null, worktree: false } };
    const branch = choices(info).find((choice) => choice.refName === refName);
    if (refName === "HEAD")
      return {
        error:
          "Detached HEAD can only be used for a single conversation. Choose a branch for defaults.",
        options: null,
      };
    if (!branch?.commit)
      return {
        error:
          "The saved branch is unavailable. Choose another branch or use the current branch.",
        options: null,
      };
    return {
      error: null,
      options: { baseRef: branch.refName, worktree: !!worktree },
    };
  }

  function statusKnown(status) {
    return (
      typeof status?.dirty === "boolean" &&
      Number.isInteger(status?.owners) &&
      status.owners >= 0
    );
  }

  function statusPending() {
    return {
      error:
        "Workspace status is unknown. Worktree off requires a successful status check.",
      options: null,
      needsAcknowledgement: false,
    };
  }

  function selection(info, refName, worktree, acknowledgeShared, status) {
    if (!info)
      return {
        error: "Inspect the folder before starting.",
        options: null,
        needsAcknowledgement: false,
      };
    if ((!info.repoRoot || !worktree) && !statusKnown(status))
      return statusPending();
    if (!info.repoRoot && refName)
      return {
        error:
          "The selected branch is unavailable. Use this folder directly or choose another branch.",
        options: null,
        needsAcknowledgement: false,
      };
    if (!info.repoRoot) {
      const needsAcknowledgement = status.dirty || status.owners > 0;
      return {
        error:
          needsAcknowledgement && !acknowledgeShared
            ? "Acknowledge the shared existing files before starting."
            : null,
        options: {
          baseRef: null,
          baseCommit: null,
          worktree: false,
          acknowledgeShared: needsAcknowledgement && !!acknowledgeShared,
        },
        needsAcknowledgement,
      };
    }
    const branch = choices(info).find((choice) => choice.refName === refName);
    // An unborn repository can still be used in place, but has no commit
    // from which to create a worktree or switch to another branch.
    if (!info.head && !refName) {
      const needsAcknowledgement =
        !worktree && (status.dirty || status.owners > 0);
      return {
        error: worktree
          ? "Create a commit before starting a worktree, then refresh."
          : needsAcknowledgement && !acknowledgeShared
            ? "Acknowledge the shared existing files before starting."
            : null,
        needsAcknowledgement,
        options: {
          baseRef: null,
          baseCommit: null,
          worktree: !!worktree,
          acknowledgeShared: needsAcknowledgement && !!acknowledgeShared,
        },
      };
    }
    if (!branch?.commit)
      return {
        error: refName
          ? "The selected branch is unavailable or has no commit. Choose another branch or refresh."
          : "No committed base is available. Create a commit and refresh.",
        options: null,
        needsAcknowledgement: false,
      };
    const currentRef = defaultRef(info);
    const same = branch.refName === currentRef;
    const needsAcknowledgement =
      !worktree && same && (status.dirty || status.owners > 0);
    let error = null;
    if (!worktree && branch.remote) {
      error =
        "Remote branches require a worktree. Enable Worktree to start from this branch.";
    } else if (!worktree && !same && (status.dirty || status.owners > 0)) {
      error =
        "Cannot switch branches while this folder has uncommitted changes or is used by an open tab. Use a worktree instead.";
    } else if (needsAcknowledgement && !acknowledgeShared) {
      error = "Acknowledge the shared existing files before starting.";
    }
    return {
      error,
      needsAcknowledgement,
      options: {
        baseRef: branch.refName,
        baseCommit: branch.commit,
        worktree: !!worktree,
        acknowledgeShared: needsAcknowledgement && !!acknowledgeShared,
      },
    };
  }

  window.OMP_CONVERSATION_WORKSPACE = {
    choices,
    defaultRef,
    initialSelection,
    defaultSelection,
    defaultsDecision,
    statusKnown,
    selection,
  };
})();

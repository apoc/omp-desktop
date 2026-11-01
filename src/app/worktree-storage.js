/* Presentation only: native storage owns leases, eligibility and cleanup. */
(function () {
  const DAY_MS = 24 * 60 * 60 * 1000;
  const RETENTION_DAYS = 30;

  function validateBudget(maxWorktrees, maxBytes) {
    const parse = (value) => {
      const text = String(value ?? "").trim();
      if (!/^[0-9]+$/.test(text)) return null;
      const number = Number(text);
      return Number.isSafeInteger(number) && number > 0 ? number : null;
    };
    const count = parse(maxWorktrees);
    const bytes = parse(maxBytes);
    if (count === null || bytes === null) {
      return { policy: null, error: "Enter positive whole numbers within the safe integer range for both limits." };
    }
    return { policy: { maxWorktrees: count, maxBytes: bytes, retentionDays: RETENTION_DAYS }, error: null };
  }

  function formatBytes(bytes) {
    if (!Number.isFinite(bytes) || bytes < 0) return "Unknown";
    if (bytes < 1024) return `${bytes} B`;
    const units = ["KiB", "MiB", "GiB", "TiB", "PiB"];
    let value = bytes;
    let unit = -1;
    do { value /= 1024; unit++; } while (value >= 1024 && unit < units.length - 1);
    return `${Number(value.toFixed(1))} ${units[unit]}`;
  }

  function expiryDescription(workspace, now = Date.now()) {
    if (workspace.state === "evicted") return "Restore point saved";
    if (workspace.active) return "Open; protected from removal";
    if (workspace.pinned) return "Pinned; protected from removal";
    if (workspace.closedAtMs == null) return "No removal lease";
    const base = Math.max(workspace.closedAtMs, workspace.lastUsedAtMs);
    if (!Number.isFinite(base) || !Number.isFinite(now) || base < 0) return "Lease time unavailable";
    const due = base + RETENTION_DAYS * DAY_MS;
    if (!Number.isSafeInteger(due)) return "Lease time unavailable";
    if (now >= due) return "Lease elapsed; eligible for a native safety check";
    const date = new Date(due);
    if (!Number.isFinite(date.getTime())) return "Lease time unavailable";
    return `Eligible for a native safety check after ${date.toLocaleString()}`;
  }

  function closePrompt(workspace) {
    const caches = Array.isArray(workspace.excludedCaches) ? workspace.excludedCaches : [];
    return {
      keep: "Keep the checkout for now. After 30 days without reopening or using it, the app may save a verified restore point and remove it. Open or pinned worktrees are protected.",
      preserve: "A restore point preserves tracked, staged, unstaged, untracked and ignored local data, including environment files and databases. Conversation history and evidence remain available separately. If saving or verification fails, the checkout stays in place.",
      caches: caches.length ? `Rebuildable cache paths excluded only when Git-ignored and containing no tracked files: ${caches.join(", ")}.` : "Only known rebuildable cache paths that are Git-ignored and contain no tracked files may be excluded from a restore point.",
      pin: workspace.pinned ? "This worktree is pinned. Unpin it in Settings before removing it." : null,
      canRemove: !workspace.pinned && !workspace.busy,
    };
  }

  function canCloseWith(workspace, action) {
    if (workspace.busy) return false;
    if (action === "cancel" || action === "keep") return true;
    return action === "snapshotRemove" && !workspace.pinned;
  }

  window.OMP_WORKTREE_STORAGE = { DAY_MS, RETENTION_DAYS, validateBudget, formatBytes, expiryDescription, closePrompt, canCloseWith };
})();

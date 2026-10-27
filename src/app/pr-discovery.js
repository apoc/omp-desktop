// One read-only queue for every open checkout. Auto-fix permission lives in
// pr-automation.js; sharing a snapshot never shares an agent grant.
(function () {
  const identity = (s) =>
    JSON.stringify([
      s.id,
      s.path,
      s.branch ?? null,
      s.profile ?? null,
      s.sessionFile ?? null,
      s.processStartedAt ?? null,
      s.conversationVersion ?? 0,
    ]);
  const checkoutKey = (s) =>
    JSON.stringify([window.OMP_PROJECT_NAV.normPath(s.path), s.branch ?? null]);

  function createMonitor({
    getContext,
    onChange,
    onBegin,
    onResult,
    validate,
    setTimer = setTimeout,
    clearTimer = clearTimeout,
    intervalMs = 30_000,
  }) {
    const targets = new Map();
    let running = false,
      timer = null,
      flight = null,
      epoch = 0,
      scope = null;
    const context = () => getContext() || {};
    const available = (c) =>
      c.featureEnabled !== false &&
      c.connected !== false &&
      c.bridge?.isConnected !== false &&
      typeof c.bridge?.prAutomationSnapshot === "function";
    const readable = (c, t) =>
      available(c) &&
      (c.visible !== false || (c.autoFixActive && t.owners.has(c.tabId)));
    const notify = () => {
      if (running) onChange?.();
    };
    const cancelTimer = () => {
      if (timer !== null) clearTimer(timer);
      timer = null;
    };
    const sessions = (c) =>
      c.sessions.filter((s) => s.id && s.path && !s.preparing);

    function reconcile() {
      const c = context();
      const nextScope = [c.bridge, available(c), c.visible !== false];
      const changedScope = !scope || nextScope.some((v, i) => v !== scope[i]);
      if (changedScope) {
        scope = nextScope;
        epoch++;
        cancelTimer();
      }
      const grouped = new Map();
      for (const s of sessions(c)) {
        const key = checkoutKey(s);
        if (!grouped.has(key)) grouped.set(key, new Map());
        grouped.get(key).set(s.id, identity(s));
      }
      for (const key of targets.keys())
        if (!grouped.has(key)) targets.delete(key);
      for (const [key, owners] of grouped) {
        let t = targets.get(key);
        // If no incarnation survived, no old conversation's in-flight result
        // or error is allowed to populate its replacement.
        if (
          !t ||
          ![...owners].some(([id, stamp]) => t.owners.get(id) === stamp)
        ) {
          t = {
            key,
            owners,
            version: 0,
            requested: true,
            loading: false,
            snapshot: null,
            discoveryError: null,
          };
          targets.set(key, t);
        } else {
          t.owners = owners;
        }
        if (changedScope) {
          t.requested = true;
          t.loading = false;
        }
      }
      if (!available(c)) {
        for (const t of targets.values()) t.loading = false;
      }
      return c;
    }

    function nextTarget(c) {
      const pending = [...targets.values()].filter(
        (t) => t.requested && readable(c, t),
      );
      return pending.find((t) => t.owners.has(c.tabId)) || pending[0];
    }

    function schedule() {
      if (!running || timer !== null || flight) return;
      const c = context();
      if (![...targets.values()].some((t) => readable(c, t))) return;
      const immediate = !!nextTarget(c);
      timer = setTimer(
        () => {
          timer = null;
          if (!immediate) {
            for (const t of targets.values())
              if (readable(context(), t)) t.requested = true;
          }
          void poll();
        },
        immediate ? 0 : intervalMs,
      );
    }

    async function poll() {
      if (!running || flight) return;
      const c = reconcile(),
        t = nextTarget(c);
      if (!t) {
        schedule();
        return;
      }
      const id = t.owners.has(c.tabId) ? c.tabId : t.owners.keys().next().value;
      const stamp = t.owners.get(id),
        version = t.version,
        readEpoch = epoch;
      const bridge = c.bridge,
        permission = onBegin?.(id);
      const current = () => {
        const latest = context();
        const owner = latest.sessions.find((s) => s.id === id);
        return (
          running &&
          epoch === readEpoch &&
          targets.get(t.key) === t &&
          t.version === version &&
          latest.bridge === bridge &&
          readable(latest, t) &&
          owner &&
          identity(owner) === stamp &&
          checkoutKey(owner) === t.key
        );
      };
      t.requested = false;
      t.loading = true;
      flight = t;
      notify();
      try {
        const snapshot = await bridge.prAutomationSnapshot(id);
        if (!current()) return;
        if (snapshot !== null) {
          validate(snapshot);
          const owner = context().sessions.find((s) => s.id === id);
          if (owner.branch && snapshot.branch !== owner.branch)
            throw new Error("PR snapshot does not match the current branch.");
        }
        t.snapshot = snapshot;
        t.discoveryError = null;
        t.loading = false;
        notify();
        // Await a possible selected-tab handoff so all native reads remain
        // single-flight, including revalidation immediately before a send.
        await onResult?.({
          id,
          owners: [...t.owners.keys()],
          snapshot,
          permission,
        });
      } catch (error) {
        if (current()) {
          t.discoveryError =
            typeof error === "string"
              ? error
              : error?.message || "PR discovery failed.";
          t.loading = false;
          notify();
          await onResult?.({
            id,
            owners: [...t.owners.keys()],
            error: t.discoveryError,
            permission,
          });
        }
      } finally {
        t.loading = false;
        flight = null;
        reconcile();
        // A replaced owner needs a new request, even if another tab still
        // owns the checkout. Never turn a discarded read into a no-PR result.
        if (targets.get(t.key) === t && !current()) t.requested = true;
        notify();
        schedule();
      }
    }

    function sync() {
      reconcile();
      schedule();
    }
    function refresh(id) {
      reconcile();
      for (const t of targets.values()) {
        if (id && !t.owners.has(id)) continue;
        t.version++;
        t.requested = true;
      }
      cancelTimer();
      notify();
      schedule();
    }
    function statuses() {
      const c = context(),
        result = {};
      if (!available(c)) return result;
      for (const s of sessions(c)) {
        const t = targets.get(checkoutKey(s));
        if (t?.owners.get(s.id) !== identity(s)) continue;
        result[s.id] = {
          snapshot: t.snapshot,
          loading: t.loading || t.requested,
          discoveryError: t.discoveryError,
        };
      }
      return result;
    }
    function start() {
      running = true;
      scope = null;
      sync();
    }
    function stop() {
      running = false;
      epoch++;
      cancelTimer();
      for (const t of targets.values()) t.loading = false;
    }
    return { start, stop, sync, refresh, statuses };
  }
  window.OMP_PR_DISCOVERY = Object.freeze({ createMonitor });
})();

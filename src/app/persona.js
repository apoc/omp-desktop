/* app/persona.js — pure helpers for the Ompy tab: the service status view
   (state label, next wake, token budget bar), the inbox split, settings
   validation, the answer buttons, and the relay cursor a new service
   generation starts from.

   Exposes `window.OMP_PERSONA`; IIFE per the project rule for plain
   <script> tags. Translations are read inside the function bodies
   (`window.OMP_I18N.t`), so a locale change applies on the next call.
   Regression: tests/test-persona.mjs. */

(function () {
  const STATES = ["running", "paused", "budget_exhausted", "error", "starting"];
  const QUIET_TIME = /^([01]\d|2[0-3]):[0-5]\d$/;
  const MIN_INTERVAL_MIN = 5;
  const MAX_INTERVAL_MIN = 1440;
  const MIN_DAILY_TOKENS = 100_000;
  const MAX_DAILY_TOKENS = 1_000_000_000;
  const RESULTS_SHOWN = 5;
  const MINUTE_MS = 60_000;

  /** A token count as the strip says it: one decimal, no trailing ".0". */
  function compact(n) {
    const trim = (text) => text.replace(/\.0$/, "");
    if (n >= 999_950_000) return trim((n / 1_000_000_000).toFixed(1)) + "B";
    if (n >= 999_950) return trim((n / 1_000_000).toFixed(1)) + "M";
    if (n >= 1000) return trim((n / 1000).toFixed(1)) + "k";
    return String(n);
  }

  /** Compact relative time for inbox results and scheduled wakes. */
  function relativeTime(atMs, nowMs) {
    const t = window.OMP_I18N.t;
    const delta = atMs - nowMs;
    const abs = Math.abs(delta);
    if (abs < 60_000) return t("now");
    if (abs > 30 * 86_400_000) return new Date(atMs).toISOString().slice(0, 10);
    const future = delta > 0;
    if (abs < 3_600_000) {
      const n = Math.floor(abs / 60_000);
      return future ? t("in {n} min", { n }) : t("{n} min ago", { n });
    }
    if (abs < 86_400_000) {
      const n = Math.floor(abs / 3_600_000);
      return future ? t("in {n} hr", { n }) : t("{n} hr ago", { n });
    }
    const n = Math.floor(abs / 86_400_000);
    return future ? t("in {n} days", { n }) : t("{n} days ago", { n });
  }

  /** Local `HH:MM` for a wall-clock instant. */
  function clock(ms) {
    const date = new Date(ms);
    return `${String(date.getHours()).padStart(2, "0")}:${String(date.getMinutes()).padStart(2, "0")}`;
  }

  function stateLabel(state) {
    const t = window.OMP_I18N.t;
    switch (state) {
      case "running": return t("Running");
      case "paused": return t("Paused");
      case "budget_exhausted": return t("Budget exhausted");
      case "starting": return t("Starting");
      case "error": return t("Error: {message}", { message: t("unknown error") });
      default: return t("unknown error");
    }
  }

  /**
   * The strip's view of `persona_status`'s `StatusInfo` (`null` = the
   * service is not connected). `nowMs` is the local clock the next wake is
   * shown against.
   */
  function statusView(status, nowMs) {
    const t = window.OMP_I18N.t;
    if (!status) {
      return {
        online: false,
        state: null,
        label: t("Ompy is off"),
        nextWake: "—",
        tokensPct: 0,
        tokensText: "—",
        canPause: false,
        canResume: false,
      };
    }
    const state = STATES.includes(status.state) ? status.state : "error";
    const limit = status.dailyTokenLimit > 0 ? status.dailyTokenLimit : 0;
    const tokens = status.tokensToday ?? 0;
    return {
      online: true,
      state,
      label: state === "error"
        ? t("Error: {message}", { message: status.error || t("unknown error") })
        : stateLabel(state),
      nextWake: status.nextWakeMs == null
        ? state === "budget_exhausted" ? t("resumes tomorrow") : "—"
        : status.nextWakeMs - nowMs > 60 * MINUTE_MS
          ? t("at {time}", { time: clock(status.nextWakeMs) })
          : t("in {n} min", { n: Math.max(0, Math.round((status.nextWakeMs - nowMs) / MINUTE_MS)) }),
      tokensPct: limit > 0 ? Math.min(100, Math.round((tokens / limit) * 100)) : 0,
      tokensText: t("{used} / {total} tokens today", {
        used: compact(tokens),
        total: compact(limit),
      }),
      canPause: state !== "paused",
      canResume: state === "paused",
    };
  }

  const kindRank = (kind) => (kind === "approval" ? 0 : 1);

  /** Open approvals then decisions (oldest first), the newest five results,
   *  and the badge count of everything still waiting for the human. */
  function inboxView(items) {
    const list = Array.isArray(items) ? items : [];
    const open = list
      .filter(i => i?.state === "open" && (i.kind === "approval" || i.kind === "decision"))
      .sort((a, b) => kindRank(a.kind) - kindRank(b.kind) || (a.createdAt ?? 0) - (b.createdAt ?? 0));
    const results = list
      .filter(i => i?.state === "open" && i.kind === "result")
      .sort((a, b) => (b.createdAt ?? 0) - (a.createdAt ?? 0))
      .slice(0, RESULTS_SHOWN);
    return { open, results, badge: open.length };
  }

  /**
   * The Inbox card's "Scheduled" list. `list_schedule`'s reply carries the
   * queued wakes and the interval wake (`nextIntervalMs`); a missing interval
   * falls back to `status.nextWakeMs`, and an instant that is already listed
   * is not repeated. Entries are ordered by time, so a scheduled wake before
   * the interval comes first whatever order the service listed it in.
   *
   * The interval is not shown while the service is held: paused or out of
   * budget reports no `nextWakeMs`, and `nextIntervalMs` is then a stale
   * timestamp that promises a check that will not happen. Queued wakes stay,
   * because they wait for the resume.
   */
  function scheduleView(schedule, status) {
    const t = window.OMP_I18N.t;
    const list = Array.isArray(schedule?.scheduled) ? schedule.scheduled : [];
    const entries = list
      .filter(w => typeof w?.atMs === "number" && Number.isFinite(w.atMs))
      .map(w => ({
        id: String(w.id ?? ""),
        kind: "wake",
        atMs: w.atMs,
        label: typeof w.note === "string" && w.note.trim() ? w.note.trim() : t("Scheduled wake"),
      }));
    const held = !status
      || status.state === "paused"
      || status.state === "budget_exhausted"
      || status.nextWakeMs == null;
    const interval = held
      ? null
      : Number.isFinite(schedule?.nextIntervalMs) && schedule.nextIntervalMs > 0
        ? schedule.nextIntervalMs
        : status.nextWakeMs;
    if (interval !== null && !entries.some(e => e.atMs === interval)) {
      entries.push({ id: "interval", kind: "interval", atMs: interval, label: t("Next check") });
    }
    entries.sort((a, b) => a.atMs - b.atMs);
    return { entries, next: entries[0]?.atMs ?? null };
  }

  function failed(field, message) {
    return { ok: false, field, message };
  }

  const isInteger = (n) => typeof n === "number" && Number.isInteger(n);

  /** `persona_set_settings`' rules, checked before the IPC call: the shape
   *  the service's `PersonaSettings` accepts. */
  function validateSettings(settings) {
    const t = window.OMP_I18N.t;
    if (!settings || typeof settings !== "object") {
      return failed("settings", t("The settings are missing."));
    }
    if (!isInteger(settings.intervalMin)
      || settings.intervalMin < MIN_INTERVAL_MIN
      || settings.intervalMin > MAX_INTERVAL_MIN) {
      return failed("intervalMin", t("The interval must be a whole number of minutes from 5 to 1440."));
    }
    if (typeof settings.quietStart !== "string" || !QUIET_TIME.test(settings.quietStart)) {
      return failed("quietStart", t("Quiet hours must use HH:MM (00:00 to 23:59)."));
    }
    if (typeof settings.quietEnd !== "string" || !QUIET_TIME.test(settings.quietEnd)) {
      return failed("quietEnd", t("Quiet hours must use HH:MM (00:00 to 23:59)."));
    }
    if (!isInteger(settings.dailyTokenLimit)
      || settings.dailyTokenLimit < MIN_DAILY_TOKENS
      || settings.dailyTokenLimit > MAX_DAILY_TOKENS) {
      return failed("dailyTokenLimit", t("The daily limit must be a whole number from 100,000 to 1,000,000,000 tokens."));
    }
    if (typeof settings.quietWeekends !== "boolean") {
      return failed("quietWeekends", t("Quiet weekends must be on or off."));
    }
    return {
      ok: true,
      value: {
        intervalMin: settings.intervalMin,
        quietStart: settings.quietStart,
        quietEnd: settings.quietEnd,
        quietWeekends: settings.quietWeekends,
        dailyTokenLimit: settings.dailyTokenLimit,
      },
    };
  }

  /** The buttons an inbox item offers. `value` is what omp is answered with
   *  (omp's own option labels are never translated); an empty list means
   *  free text or dismiss only. */
  function answerOptions(item) {
    const t = window.OMP_I18N.t;
    if (!item) return [];
    if (item.kind === "approval") {
      return [{ label: t("Approve"), value: "Approve" }, { label: t("Deny"), value: "Deny" }];
    }
    if (item.kind === "decision" && item.requestMethod === "confirm") {
      return [{ label: t("Confirm"), value: "Confirm" }, { label: t("Deny"), value: "Deny" }];
    }
    if (item.kind === "decision") {
      return (item.options ?? []).map(option => ({ label: option, value: option }));
    }
    return [];
  }

  /** Accessible name of the pinned Ompy button. */
  function sidebarLabel(badge) {
    const t = window.OMP_I18N.t;
    return badge > 0 ? t("Ompy, {n} waiting for you", { n: badge }) : t("Ompy");
  }

  /** Neither channel carries an error. */
  const EMPTY_ERRORS = Object.freeze({ connection: null, refresh: null });

  /** Fold one `persona://error` into the two channels. `refresh` is the
   *  app's own sidecar failure, kept apart so a connection error can never
   *  overwrite it (and the reverse); an unknown shape leaves the state. */
  function errorsWith(prev, error) {
    const state = prev && typeof prev === "object" ? prev : EMPTY_ERRORS;
    if (!error || typeof error !== "object") return state;
    return error.kind === "refresh"
      ? { ...state, refresh: error }
      : { ...state, connection: error };
  }

  /** A status means the service answers: the connection error is over. The
   *  refresh warning is app-side and stays until a later refresh succeeds. */
  function statusCleared(prev) {
    const state = prev && typeof prev === "object" ? prev : EMPTY_ERRORS;
    return state.connection === null ? state : { ...state, connection: null };
  }

  /** `persona_error`'s reply (both channels) in the same shape. */
  function errorsFromFetch(value) {
    if (!value || typeof value !== "object") return EMPTY_ERRORS;
    return { connection: value.connection ?? null, refresh: value.refresh ?? null };
  }

  // The user-level sentence per error kind the app can name. The
  // platform's own message is never the line itself, only its tooltip.
  const ERROR_TEXT = {
    io: "Could not reach the Ompy service.",
    protocol: "Update needed: the Ompy service and the app have different versions.",
    owner: "Another account owns the Ompy service name; Ompy stays off.",
    refresh: "Ompy could not update its background service; restart OMP Desktop to retry.",
    control: "Could not change the Ompy service.",
  };

  /** Translate stable Rust error codes; runtime errors stay untouched. */
  function errorText(error) {
    const prefix = "persona.instructions_missing:";
    if (typeof error === "string" && error.startsWith(prefix)) {
      return window.OMP_I18N.t("Start Ompy once to create {path}.", { path: error.slice(prefix.length) });
    }
    return error;
  }

  /**
   * `{ text, detail }` for one error — a `{kind, message}` from
   * `persona://error`, or a command's plain string (`kind: "control"` passed
   * by the caller for enable/disable). `text` is translated and never an OS
   * error string; `detail` is that raw message for a tooltip, or null.
   */
  function errorView(error) {
    if (!error) return null;
    if (typeof error === "string") {
      const translated = errorText(error);
      return { text: translated, detail: translated === error ? null : error };
    }
    const message = typeof error.message === "string" ? error.message : "";
    const translated = errorText(message);
    if (translated !== message) return { text: translated, detail: message || null };
    const known = ERROR_TEXT[error.kind];
    return known
      ? { text: window.OMP_I18N.t(known), detail: message || null }
      : { text: message, detail: null };
  }

  function enableStartError() {
    return window.OMP_I18N.t("Ompy did not start");
  }

  /** Whether a `sessions` entry (or a session registry entry) is Ompy: the
   * window's own chat, not one of the user's project tabs. Ruling B-R6 —
   * `kind: "persona"` is the one marker, so the tab bar, the tab counts, the
   * close/quit guards and the keyboard navigation all ask this instead of
   * repeating the comparison.
   */
  function isPersona(entry) {
    return entry?.kind === "persona";
  }

  /** The user's project tabs from a `sessions`/registry list, in their own
   *  order: everything `isPersona` does not claim. A copy — the caller's
   *  list is never mutated. */
  function realTabs(sessions) {
    return (sessions ?? []).filter(s => !isPersona(s));
  }

  /** The entry the main view renders: the active one while the snapshot
   *  still lists it, else the newest project tab, else `fallback` (the
   *  caller's empty-workspace entry). Ompy is returned only when it *is*
   *  the active session — it is never a fallback (Ruling B-R6). */
  function activeEntry(sessions, activeSessionId, fallback) {
    const list = sessions ?? [];
    return list.find(s => s.id === activeSessionId) ?? realTabs(list)[0] ?? fallback;
  }

  /** Whether the window shows the empty workspace: no project tab is open.
   *  Ompy alone does not fill it (it has its own chat view). */
  function emptyWorkspace(sessions) {
    return realTabs(sessions).length === 0;
  }

  /**
   * The relay cursor after a `persona://status` frame. A new service
   * generation (the process restarted, so the sequence source did) resets
   * the cursor and asks for a fresh attach; the same generation keeps it.
   * `null` status (disconnected) forgets the generation, so the next
   * connection is treated as new — clients never trust a cursor across a
   * socket. Returns `{ gen, lastSeq, reattach }`.
   */
  function cursorAfterStatus(prevGen, status, lastSeq) {
    if (!status || typeof status !== "object") {
      return { gen: null, lastSeq, reattach: false };
    }
    const gen = Number.isInteger(status.generation) ? status.generation : 0;
    if (prevGen == null || gen !== prevGen) {
      return { gen, lastSeq: 0, reattach: true };
    }
    return { gen: prevGen, lastSeq, reattach: false };
  }

  window.OMP_PERSONA = Object.freeze({
    compactTokens: compact,
    relativeTime,
    statusView,
    inboxView,
    scheduleView,
    validateSettings,
    answerOptions,
    sidebarLabel,
    errorText,
    errorView,
    enableStartError,
    EMPTY_ERRORS,
    errorsWith,
    statusCleared,
    errorsFromFetch,
    isPersona,
    realTabs,
    activeEntry,
    emptyWorkspace,
    cursorAfterStatus,
  });
})();

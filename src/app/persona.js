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
        ? "—"
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
      .filter(i => i.kind === "result")
      .sort((a, b) => (b.createdAt ?? 0) - (a.createdAt ?? 0))
      .slice(0, RESULTS_SHOWN);
    return { open, results, badge: open.length };
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

  window.OMP_PERSONA = Object.freeze({
    statusView,
    inboxView,
    validateSettings,
    answerOptions,
  });
})();

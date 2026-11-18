#!/usr/bin/env node
// Regression script for src/app/persona.js — the Ompy tab's pure helpers:
// the status view (state label, next wake, token bar), the inbox split,
// settings validation and the answer buttons.
// Run: node tests/test-persona.mjs  (or: npm run test:persona)

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const win = {};
for (const file of ["src/app/i18n.js", "src/app/i18n-zh.js", "src/app/persona.js"]) {
  // eslint-disable-next-line no-new-func
  new Function("window", readFileSync(join(root, file), "utf8"))(win);
}
const P = win.OMP_PERSONA;

let passed = 0;
function check(label, fn) {
  try {
    fn();
  } catch (err) {
    console.error(`FAILED: ${label}`);
    throw err;
  }
  passed++;
}

// Local wall-clock times, so "at HH:MM" is the same in every timezone.
const at = (h, m) => new Date(2026, 10, 18, h, m, 0, 0).getTime();
const NOW = at(10, 0);

const SETTINGS = {
  intervalMin: 30,
  quietStart: "20:00",
  quietEnd: "07:00",
  quietWeekends: true,
  dailyTokenLimit: 2_000_000,
};

function status(over = {}) {
  return {
    generation: 7,
    state: "running",
    error: null,
    nextWakeMs: null,
    tokensToday: 0,
    dailyTokenLimit: 2_000_000,
    openItems: 0,
    settings: { ...SETTINGS },
    ...over,
  };
}

// ── statusView ───────────────────────────────────────────────────────────
check("status_view_exhausted: capped bar, exhausted label, pausable", () => {
  const view = P.statusView(
    status({ state: "budget_exhausted", tokensToday: 2_100_000 }),
    NOW,
  );
  assert.equal(view.online, true);
  assert.equal(view.state, "budget_exhausted");
  assert.equal(view.label, "Budget exhausted");
  assert.equal(view.tokensPct, 100);
  assert.equal(view.tokensText, "2.1M / 2M tokens today");
  assert.equal(view.canPause, true);
  assert.equal(view.canResume, false);
});

check("status_view_null_is_offline", () => {
  const view = P.statusView(null, NOW);
  assert.equal(view.online, false);
  assert.equal(view.label, "Ompy is off");
  assert.equal(view.nextWake, "—");
  assert.equal(view.tokensPct, 0);
  assert.equal(view.canPause, false);
  assert.equal(view.canResume, false);
});

check("status_view_labels_cover_every_state", () => {
  assert.equal(P.statusView(status(), NOW).label, "Running");
  assert.equal(P.statusView(status({ state: "paused" }), NOW).label, "Paused");
  assert.equal(P.statusView(status({ state: "starting" }), NOW).label, "Starting");
  assert.equal(
    P.statusView(status({ state: "error", error: "socket closed" }), NOW).label,
    "Error: socket closed",
  );
});

check("status_view_next_wake_under_an_hour_counts_minutes", () => {
  const view = P.statusView(status({ nextWakeMs: NOW + 12 * 60_000 }), NOW);
  assert.equal(view.nextWake, "in 12 min");
});

check("status_view_next_wake_over_an_hour_is_a_local_time", () => {
  const view = P.statusView(status({ nextWakeMs: NOW + 90 * 60_000 }), NOW);
  assert.equal(view.nextWake, "at 11:30");
});

check("status_view_next_wake_absent_is_a_dash", () => {
  assert.equal(P.statusView(status({ nextWakeMs: null }), NOW).nextWake, "—");
});

check("status_view_exhausted_without_wake_resumes_tomorrow", () => {
  const view = P.statusView(status({ state: "budget_exhausted", nextWakeMs: null }), NOW);
  assert.equal(view.nextWake, "resumes tomorrow");
});

check("status_view_tokens_pct_uses_the_limit", () => {
  const view = P.statusView(status({ tokensToday: 600_000 }), NOW);
  assert.equal(view.tokensPct, 30);
  assert.equal(view.tokensText, "600k / 2M tokens today");
});

check("status_view_paused_can_resume_not_pause", () => {
  const view = P.statusView(status({ state: "paused" }), NOW);
  assert.equal(view.canPause, false);
  assert.equal(view.canResume, true);
});

// ── inboxView ────────────────────────────────────────────────────────────
const item = (over) => ({
  id: "i1",
  kind: "decision",
  createdAt: 1_000,
  title: "Question",
  body: null,
  options: ["Yes", "No"],
  urgent: false,
  state: "open",
  answer: null,
  rpcRequestId: null,
  ...over,
});

check("inbox_view_badge_counts_open_approvals_and_decisions", () => {
  const items = [
    item({ id: "a", kind: "approval", createdAt: 3_000 }),
    item({ id: "b", kind: "decision", createdAt: 1_000 }),
    item({ id: "c", kind: "result", createdAt: 2_000 }),
    item({ id: "d", kind: "notice", createdAt: 4_000 }),
    item({ id: "e", kind: "approval", state: "answered", createdAt: 5_000 }),
  ];
  const view = P.inboxView(items);
  assert.equal(view.badge, 2);
  assert.deepEqual(view.open.map(i => i.id), ["a", "b"]); // approvals first, oldest first
  assert.deepEqual(view.results.map(i => i.id), ["c"]);    // results only
});

check("inbox_view_hides_dismissed_results", () => {
  const items = [
    item({ id: "open", kind: "result", createdAt: 3_000 }),
    item({ id: "gone", kind: "result", state: "dismissed", createdAt: 2_000 }),
    item({ id: "answered", kind: "result", state: "answered", createdAt: 1_000 }),
  ];
  const view = P.inboxView(items);
  assert.deepEqual(view.results.map(i => i.id), ["open"]);
  assert.equal(view.badge, 0);
});

check("inbox_view_results_newest_first_capped_at_five", () => {
  const items = Array.from({ length: 7 }, (_, i) =>
    item({ id: `r${i}`, kind: "result", createdAt: i }));
  assert.deepEqual(P.inboxView(items).results.map(i => i.id), ["r6", "r5", "r4", "r3", "r2"]);
});

check("inbox_view_empty_is_empty", () => {
  assert.deepEqual(P.inboxView([]), { open: [], results: [], badge: 0 });
  assert.deepEqual(P.inboxView(undefined), { open: [], results: [], badge: 0 });
});

// ── compactTokens ────────────────────────────────────────────────────────
check("compact_tokens_shortens_budget_numbers", () => {
  assert.equal(P.compactTokens(2_000_000), "2M");
  assert.equal(P.compactTokens(1_200_000), "1.2M");
  assert.equal(P.compactTokens(99_000), "99k");
  assert.equal(P.compactTokens(500), "500");
});

// ── scheduleView ─────────────────────────────────────────────────────────
check("schedule_view_orders_queued_wakes_and_the_interval", () => {
  const schedule = {
    nextIntervalMs: NOW + 30 * 60_000,
    scheduled: [
      { id: "late", atMs: NOW + 90 * 60_000, note: "Check mail" },
      { id: "early", atMs: NOW + 5 * 60_000, note: "Review PR" },
    ],
  };
  const view = P.scheduleView(schedule, status({ nextWakeMs: NOW + 5 * 60_000 }));
  assert.deepEqual(view.entries.map(e => [e.kind, e.id, e.atMs]), [
    ["wake", "early", NOW + 5 * 60_000],
    ["interval", "interval", NOW + 30 * 60_000],
    ["wake", "late", NOW + 90 * 60_000],
  ]);
  assert.equal(view.entries[0].label, "Review PR");
  assert.equal(view.entries[1].label, "Next check");
  assert.equal(view.entries[2].label, "Check mail");
});

check("schedule_view_keys_queued_wakes_by_time", () => {
  const schedule = { nextIntervalMs: NOW + 60 * 60_000, scheduled: [
    { id: "b", atMs: NOW + 20 * 60_000, note: "" },
    { id: "a", atMs: NOW + 10 * 60_000, note: "  " },
  ] };
  const view = P.scheduleView(schedule, status({ nextWakeMs: NOW + 10 * 60_000 }));
  assert.deepEqual(view.entries.map(e => e.id), ["a", "b", "interval"]);
  assert.equal(view.entries[0].label, "Scheduled wake");
});

check("schedule_view_hides_the_interval_while_held", () => {
  const schedule = { nextIntervalMs: NOW + 30 * 60_000, scheduled: [] };
  const paused = P.scheduleView(schedule, status({ state: "paused", nextWakeMs: null }));
  assert.deepEqual(paused, { entries: [], next: null });
  const exhausted = P.scheduleView(
    schedule, status({ state: "budget_exhausted", nextWakeMs: null }));
  assert.deepEqual(exhausted, { entries: [], next: null });
  // No wake time to promise: a running status without one hides it too.
  assert.deepEqual(P.scheduleView(schedule, status({ nextWakeMs: null })), { entries: [], next: null });
  assert.deepEqual(P.scheduleView(schedule, null), { entries: [], next: null });
});

check("schedule_view_keeps_queued_wakes_while_held", () => {
  const schedule = {
    nextIntervalMs: NOW + 30 * 60_000,
    scheduled: [{ id: "q", atMs: NOW + 10 * 60_000, note: "Check mail" }],
  };
  const view = P.scheduleView(schedule, status({ state: "paused", nextWakeMs: null }));
  assert.deepEqual(view.entries.map(e => [e.kind, e.id, e.atMs]), [
    ["wake", "q", NOW + 10 * 60_000],
  ]);
  assert.equal(view.next, NOW + 10 * 60_000);
});

check("schedule_view_falls_back_to_the_status_next_wake", () => {
  const view = P.scheduleView(null, status({ nextWakeMs: NOW + 12 * 60_000 }));
  assert.deepEqual(view.entries.map(e => [e.kind, e.atMs]), [["interval", NOW + 12 * 60_000]]);
  assert.equal(view.next, NOW + 12 * 60_000);
  assert.deepEqual(P.scheduleView(null, status(), NOW), { entries: [], next: null });
});

// ── validateSettings ─────────────────────────────────────────────────────
check("validate_settings_accepts_the_defaults", () => {
  const result = P.validateSettings({ ...SETTINGS });
  assert.equal(result.ok, true);
  assert.deepEqual(result.value, SETTINGS);
});

check("validate_settings_interval_bounds_are_5_to_1440", () => {
  for (const bad of [4, 1441, 30.5, "30", NaN]) {
    const result = P.validateSettings({ ...SETTINGS, intervalMin: bad });
    assert.equal(result.ok, false);
    assert.equal(result.field, "intervalMin");
    assert.equal(typeof result.message, "string");
  }
  const edge = [
    P.validateSettings({ ...SETTINGS, intervalMin: 5 }),
    P.validateSettings({ ...SETTINGS, intervalMin: 1440 }),
  ];
  assert.ok(edge.every(r => r.ok));
});

check("validate_settings_quiet_hours_are_HH_MM", () => {
  for (const [field, bad] of [
    ["quietStart", "9:00"], ["quietStart", "24:00"], ["quietStart", ""],
    ["quietEnd", "07:60"], ["quietEnd", "0730"],
  ]) {
    const result = P.validateSettings({ ...SETTINGS, [field]: bad });
    assert.equal(result.ok, false);
    assert.equal(result.field, field);
    assert.equal(typeof result.message, "string");
  }
});

check("validate_settings_daily_limit_is_100k_to_1e9", () => {
  for (const bad of [99_999, 1_000_000_001, 100_000.5, "100000"]) {
    const result = P.validateSettings({ ...SETTINGS, dailyTokenLimit: bad });
    assert.equal(result.ok, false);
    assert.equal(result.field, "dailyTokenLimit");
    assert.equal(typeof result.message, "string");
  }
  const edge = [
    P.validateSettings({ ...SETTINGS, dailyTokenLimit: 100_000 }),
    P.validateSettings({ ...SETTINGS, dailyTokenLimit: 1_000_000_000 }),
  ];
  assert.ok(edge.every(r => r.ok));
});

check("validate_settings_quiet_weekends_is_boolean", () => {
  for (const bad of ["yes", 1, null, undefined]) {
    const result = P.validateSettings({ ...SETTINGS, quietWeekends: bad });
    assert.equal(result.ok, false);
    assert.equal(result.field, "quietWeekends");
    assert.equal(typeof result.message, "string");
  }
});

// ── answerOptions ────────────────────────────────────────────────────────
check("answer_options_approval_is_approve_deny", () => {
  assert.deepEqual(P.answerOptions(item({ kind: "approval" })), [
    { label: "Approve", value: "Approve" },
    { label: "Deny", value: "Deny" },
  ]);
});

check("answer_options_confirm_is_confirm_deny", () => {
  assert.deepEqual(
    P.answerOptions(item({ kind: "decision", requestMethod: "confirm", options: ["Confirm", "Deny"] })),
    [
      { label: "Confirm", value: "Confirm" },
      { label: "Deny", value: "Deny" },
    ],
  );
});

check("answer_options_decision_comes_from_the_item", () => {
  assert.deepEqual(P.answerOptions(item({ options: ["Ship it", "Not yet"] })), [
    { label: "Ship it", value: "Ship it" },
    { label: "Not yet", value: "Not yet" },
  ]);
});

check("answer_options_result_and_notice_have_none", () => {
  assert.deepEqual(P.answerOptions(item({ kind: "result" })), []);
  assert.deepEqual(P.answerOptions(item({ kind: "notice" })), []);
});

// ── persona presentation and navigation helpers ─────────────────────────
check("relative_times_cover_past_future_and_dates", () => {
  assert.equal(P.relativeTime(NOW - 20_000, NOW), "now");
  assert.equal(P.relativeTime(NOW - 5 * 60_000, NOW), "5 min ago");
  assert.equal(P.relativeTime(NOW + 2 * 3_600_000, NOW), "in 2 hr");
  assert.equal(P.relativeTime(NOW - 3 * 86_400_000, NOW), "3 days ago");
  assert.equal(P.relativeTime(Date.UTC(2026, 9, 18, 12), Date.UTC(2026, 10, 18, 12)), "2026-10-18");
});

check("relative_times_and_new_persona_strings_have_chinese", () => {
  win.OMP_I18N.set("zh");
  assert.equal(P.relativeTime(NOW - 5 * 60_000, NOW), "5 分钟前");
  assert.equal(P.sidebarLabel(2), "Ompy，2 项等待你处理");
  assert.equal(P.statusView(status({ state: "budget_exhausted" }), NOW).nextWake, "明天恢复");
  assert.equal(
    P.errorText("persona.instructions_missing:/tmp/persona/instructions.md"),
    "先启动一次 Ompy 以创建 /tmp/persona/instructions.md。",
  );
  assert.equal(P.enableStartError(), "Ompy 未能启动");
  win.OMP_I18N.set("en");
});

check("sidebar_label_only_adds_a_waiting_count", () => {
  assert.equal(P.sidebarLabel(0), "Ompy");
  assert.equal(P.sidebarLabel(3), "Ompy, 3 waiting for you");
});

check("coded_instruction_error_keeps_the_path_and_other_errors", () => {
  assert.equal(
    P.errorText("persona.instructions_missing:/tmp/persona/instructions.md"),
    "Start Ompy once to create /tmp/persona/instructions.md.",
  );
  assert.equal(P.errorText("editor failed"), "editor failed");
});

// ── cursorAfterStatus ────────────────────────────────────────────────────
check("ompy_reattach_resets_cursor", () => {
  assert.deepEqual(P.cursorAfterStatus(7, status({ generation: 7 }), 42),
    { gen: 7, lastSeq: 42, reattach: false });
  assert.deepEqual(P.cursorAfterStatus(7, status({ generation: 8 }), 42),
    { gen: 8, lastSeq: 0, reattach: true });
  assert.deepEqual(P.cursorAfterStatus(null, status({ generation: 42 }), 0),
    { gen: 42, lastSeq: 0, reattach: true });
  // Offline forgets the generation: the next status is a new connection and
  // must not trust the old cursor (the sequence source may have restarted).
  assert.deepEqual(P.cursorAfterStatus(7, null, 42),
    { gen: null, lastSeq: 42, reattach: false });
});

// ── realTabs / isPersona (Ruling B-R6: Ompy is not a tab) ────────────────
check("real_tabs_exclude_the_persona_entry", () => {
  const ompy = { id: "ompy", name: "Ompy", path: null, kind: "persona", pinned: true, runState: "idle" };
  const a = { id: "session-1", name: "a", path: "/tmp/a", runState: "idle" };
  const b = { id: "session-2", name: "b", path: "/tmp/b", runState: "running" };
  assert.deepEqual(P.realTabs([ompy, a, b]).map(s => s.id), ["session-1", "session-2"]);
  assert.deepEqual(P.realTabs([a, b, ompy]).map(s => s.id), ["session-1", "session-2"]);
  assert.deepEqual(P.realTabs([ompy]).map(s => s.id), []);
  assert.deepEqual(P.realTabs([]), []);
  assert.deepEqual(P.realTabs(null), []);
  // A caller's list is never mutated.
  const list = [ompy, a];
  P.realTabs(list);
  assert.equal(list.length, 2);
  assert.equal(P.isPersona(ompy), true);
  assert.equal(P.isPersona(a), false);
  assert.equal(P.isPersona(undefined), false);
});

check("main_view_picks_a_project_tab_never_ompy", () => {
  const ompy = { id: "ompy", name: "Ompy", path: null, kind: "persona", pinned: true };
  const a = { id: "session-1", name: "a", path: "/tmp/a" };
  const b = { id: "session-2", name: "b", path: "/tmp/b" };
  const empty = { id: "", name: "No project", path: null };
  const pick = (sessions, activeSessionId) => P.activeEntry(sessions, activeSessionId, empty).id;
  assert.equal(pick([ompy, a, b], "session-2"), "session-2");
  // A stale or empty active id falls back to the newest project tab.
  assert.equal(pick([ompy, a, b], "session-gone"), "session-1");
  assert.equal(pick([ompy, a, b], ""), "session-1");
  // ... never to Ompy, and with no project tab to the caller's fallback.
  assert.equal(pick([ompy], "session-gone"), "");
  assert.equal(pick([ompy], ""), "");
  assert.equal(pick([], null), "");
  // Ompy is rendered only when the bridge activated it.
  assert.equal(pick([ompy, a], "ompy"), "ompy");
});

check("empty_workspace_needs_no_project_tab", () => {
  const ompy = { id: "ompy", kind: "persona" };
  assert.equal(P.emptyWorkspace([]), true);
  assert.equal(P.emptyWorkspace([ompy]), true);
  assert.equal(P.emptyWorkspace(null), true);
  assert.equal(P.emptyWorkspace([{ id: "session-1", path: "/tmp/a" }]), false);
  assert.equal(P.emptyWorkspace([ompy, { id: "session-1", path: "/tmp/a" }]), false);
});

check("error_channels_keep_the_refresh_warning_apart_from_the_connection", () => {
  const connection = { kind: "protocol", message: "service protocol 2, expected 1" };
  const refresh = { kind: "refresh", message: "cannot replace the service" };
  let state = P.EMPTY_ERRORS;
  assert.deepEqual(state, { connection: null, refresh: null });
  state = P.errorsWith(state, refresh);
  assert.deepEqual(state, { connection: null, refresh });
  // A status clears the connection error only.
  state = P.errorsWith(state, connection);
  assert.equal(state.refresh, refresh);
  state = P.statusCleared(state);
  assert.deepEqual(state, { connection: null, refresh });
  // A later connection error does not replace the refresh warning.
  state = P.errorsWith(state, connection);
  assert.equal(state.connection, connection);
  assert.equal(state.refresh, refresh);
  // ... and the reverse: a new refresh failure leaves the connection error.
  const second = { kind: "refresh", message: "second failure" };
  state = P.errorsWith(state, second);
  assert.equal(state.connection, connection);
  assert.equal(state.refresh, second);
  // Unknown or missing shapes are no-ops, and statusCleared is cheap.
  assert.equal(P.errorsWith(state, null), state);
  assert.equal(P.errorsWith(state, undefined), state);
  assert.equal(P.errorsWith(state, "io"), state);
  const cleared = P.statusCleared(state);
  assert.equal(cleared.connection, null);
  assert.equal(P.statusCleared(cleared), cleared, "an already-clear connection is the same object");
  assert.equal(P.statusCleared(null).connection, null);
  // The boot fetch has the same shape (and tolerates old or missing data).
  assert.deepEqual(P.errorsFromFetch({ connection, refresh }), { connection, refresh });
  assert.deepEqual(P.errorsFromFetch({ connection, refresh: null }), { connection, refresh: null });
  assert.deepEqual(P.errorsFromFetch(null), { connection: null, refresh: null });
  assert.deepEqual(P.errorsFromFetch({}), { connection: null, refresh: null });
});

check("the api is frozen", () => {
  assert.ok(Object.isFrozen(P));
});

console.log(`test-persona: ${passed} checks passed`);

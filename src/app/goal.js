// Goal mode: pure helpers behind the goal strip above the composer and the
// goal rows in the transcript. omp owns the goal (RPC `goal` get / create /
// resume / pause / drop, the `goal_updated` frame, `get_state.goal`, all
// omp ≥ 18.4.11); live.js keeps one tab's view of it and this file decides
// what that view is.
//
// A tab's goal state is `{ known, goal, dismissedId? }`. `goal` is the
// record below or null; `known` says whether this tab has seen omp's goal
// state since its transcript was (re)loaded. Only a `goal_updated` that
// changes a known state is news worth a transcript row: the frames a fresh
// process, a restored tab or a branch replays describe a goal the user
// already had. `dismissedId` is a completed goal whose summary the user
// dismissed (see `dismiss`).
//
// Exposes `window.OMP_GOAL`; IIFE per the project rule for plain <script>
// tags. Regression: test-goal.mjs.
(function () {
  const STATUSES = new Set(["active", "paused", "budget-limited", "complete", "dropped"]);

  const UNKNOWN = Object.freeze({ known: false, goal: null });
  const NONE = Object.freeze({ known: true, goal: null });

  const count = v => (Number.isFinite(v) && v > 0 ? Math.floor(v) : 0);

  /** omp's `Goal` → the record the UI keeps, or null when malformed.
   *  `pausedBy` is "stop" for a goal omp paused because the user aborted
   *  the turn (Esc / Stop), null otherwise — set by `withCause`. */
  function normalize(goal, enabled) {
    if (!goal || typeof goal !== "object") return null;
    if (typeof goal.id !== "string" || !goal.id) return null;
    if (typeof goal.objective !== "string" || !STATUSES.has(goal.status)) return null;
    return Object.freeze({
      id: goal.id,
      objective: goal.objective.trim(),
      status: goal.status,
      tokenBudget: Number.isInteger(goal.tokenBudget) && goal.tokenBudget > 0 ? goal.tokenBudget : null,
      tokensUsed: count(goal.tokensUsed),
      timeUsedSeconds: count(goal.timeUsedSeconds),
      enabled: enabled === true,
      pausedBy: null,
    });
  }

  function sameGoal(a, b) {
    if (a === b) return true;
    if (!a || !b) return false;
    return a.id === b.id && a.objective === b.objective && a.status === b.status
      && a.tokenBudget === b.tokenBudget && a.tokensUsed === b.tokensUsed
      && a.timeUsedSeconds === b.timeUsedSeconds && a.enabled === b.enabled && a.pausedBy === b.pausedBy;
  }

  /** `prev` itself when nothing changed, so a notify does not re-render. */
  function settle(prev, goal) {
    if (prev.known && sameGoal(prev.goal, goal)) return prev;
    return goal ? Object.freeze({ known: true, goal }) : NONE;
  }

  /** `raw` with its pause cause: carried over from the paused record it
   *  replaces, else "stop" while the user's abort is in flight. */
  function withCause(before, raw, stopping) {
    if (raw.status !== "paused") return raw;
    const pausedBy = before?.id === raw.id && before.status === "paused" ? before.pausedBy
      : stopping ? "stop" : null;
    return pausedBy ? Object.freeze({ ...raw, pausedBy }) : raw;
  }

  /** omp reported no goal: a completed record stays (omp forgets it once
   *  the completing turn ends), anything else clears. */
  function keepCompleted(prev) {
    return settle(prev, prev.goal?.status === "complete" ? prev.goal : null);
  }

  /** `get_state.goal`, or the `state` of a `goal` command's response (omp's
   *  `GoalModeState | null`). Never a row: a snapshot only says where the
   *  goal stands, not what just happened. omp forgets a completed goal once
   *  the turn that completed it ends, so a completed record stays until it
   *  is dismissed or another goal starts. A malformed state changes nothing. */
  function fromSnapshot(prev, modeState) {
    if (modeState == null) return keepCompleted(prev);
    if (typeof modeState !== "object") return prev;
    const raw = normalize(modeState.goal, modeState.enabled);
    if (!raw || isDismissed(prev, raw)) return prev;
    if (raw.status === "dropped") return settle(prev, null);
    return settle(prev, withCause(prev.goal, raw, false));
  }

  /** A `goal_updated` frame (`{ goal: Goal | null, state?: GoalModeState }`)
   *  → `{ state, row }`. `stopping`: the user's abort is in flight, which is
   *  the one thing that makes omp pause a goal on its own. `row` describes
   *  the change for the transcript (see `rowFor`), null when there is none
   *  or the previous state was not known. A malformed goal changes nothing. */
  function fromFrame(prev, frame, { stopping = false } = {}) {
    if (!frame || typeof frame !== "object") return { state: prev, row: null };
    if (frame.goal === null) return { state: keepCompleted(prev), row: null };
    const before = prev.goal;
    const enabled = frame.state && typeof frame.state === "object" ? frame.state.enabled : undefined;
    const probe = normalize(frame.goal, enabled);
    if (!probe || isDismissed(prev, probe)) return { state: prev, row: null };
    const raw = withCause(before, probe, stopping);
    const next = raw.status === "dropped" ? null : raw;
    return { state: settle(prev, next), row: prev.known ? rowFor(before, raw) : null };
  }

  /** The transcript row for one goal change, or null:
   *  - `set`: a goal appeared (host `create`, or the agent's own goal tool);
   *  - `paused` (with `cause`), `resumed`, `limit` (budget used up),
   *    `complete`, `dropped`: status moves of the goal already shown.
   *  Accounting updates (same status) and `budget-limited → active` (a
   *  budget change, terminal-only) are not news. */
  function rowFor(before, raw) {
    const same = !!before && before.id === raw.id;
    const row = event => ({
      kind: "goal", event,
      objective: raw.objective,
      tokensUsed: raw.tokensUsed,
      tokenBudget: raw.tokenBudget,
      timeUsedSeconds: raw.timeUsedSeconds,
      cause: event === "paused" ? raw.pausedBy : null,
    });
    if (raw.status === "dropped") return same ? row("dropped") : null;
    if (!same) {
      if (raw.status === "active" || raw.status === "budget-limited") return row("set");
      return raw.status === "complete" ? row("complete") : null;
    }
    if (before.status === raw.status) return null;
    switch (raw.status) {
      case "paused": return row("paused");
      case "active": return before.status === "paused" ? row("resumed") : null;
      case "budget-limited": return row("limit");
      case "complete": return row("complete");
      default: return null;
    }
  }

  /** Dismissing a completed goal's summary. Anything else stays. omp still
   *  reports the completed goal until the turn that completed it ends, so
   *  the dismissed id is remembered and that goal is not taken back. */
  function dismiss(prev) {
    return prev.goal?.status === "complete"
      ? Object.freeze({ known: true, goal: null, dismissedId: prev.goal.id })
      : prev;
  }

  /** A completed goal the user has already dismissed. */
  function isDismissed(prev, raw) {
    return raw.status === "complete" && !!prev.dismissedId && raw.id === prev.dismissedId;
  }

  /** A goal the user still has to finish or drop: blocks plan mode, as in omp. */
  function isOpen(tabGoal) {
    const s = tabGoal?.goal?.status;
    return s === "active" || s === "paused" || s === "budget-limited";
  }

  // omp's hidden prompt for a turn it started on its own to continue the
  // goal (rpc-goal.ts `#scheduleContinuation`).
  const CONTINUATION_TYPE = "goal-continuation";

  /** The `continue` row live.js puts above a turn started by that hidden
   *  prompt, or null for any other message. */
  function continuationRow(message) {
    return message?.role === "custom" && message.customType === CONTINUATION_TYPE
      ? { kind: "goal", event: "continue" }
      : null;
  }

  /** After `goal create`: whether omp already started (or decided to start)
   *  a goal turn by itself — it does with `goal.continuationModes` holding
   *  "rpc" — judged from the `get_state` that follows: streaming, or
   *  unsettled with nothing else to explain it (omp reports a decided
   *  continuation as unsettled). When it did not, the desktop sends the
   *  objective as the first prompt, as omp's own `/goal` does. A pending
   *  background job is not a turn: its wake-up does not carry the goal.
   *  Neither are queued messages (follow-ups an Esc left behind): they keep
   *  omp unsettled while idle, and omp skips a continuation while any wait. */
  function ompStartedTurn(rpcState) {
    if (!rpcState || typeof rpcState !== "object") return false;
    if (rpcState.isStreaming === true) return true;
    return rpcState.isSettled === false
      && rpcState.hasPendingAsyncWork !== true
      && !(rpcState.queuedMessageCount > 0);
  }

  // ── Formatting ──────────────────────────────────────────────────────
  const NUMBER = new Intl.NumberFormat("en-US");
  const fmtTokens = n => NUMBER.format(count(n));

  /** `51 s`, `2 min 5 s`, `1 h 3 min`. */
  function fmtSeconds(seconds) {
    const s = count(seconds);
    if (s < 60) return `${s} s`;
    if (s < 3600) return s % 60 ? `${Math.floor(s / 60)} min ${s % 60} s` : `${s / 60} min`;
    const m = Math.floor((s % 3600) / 60);
    return m ? `${Math.floor(s / 3600)} h ${m} min` : `${s / 3600} h`;
  }

  // ── Token budget ────────────────────────────────────────────────────
  const BUDGET_PRESETS = Object.freeze([100000, 250000, 500000, 1000000]);

  /** `100k`, `1M`, `1.5M`, `12,345`. */
  function budgetLabel(n) {
    if (n >= 1000000 && n % 100000 === 0) return `${n / 1000000}M`;
    if (n >= 1000 && n % 1000 === 0) return `${n / 1000}k`;
    return fmtTokens(n);
  }

  /** A typed budget → `{ ok, value }`: `value` a positive integer, or null
   *  for no limit (empty input). Accepts `300k`, `1.5M`, `250,000`. A comma
   *  only groups thousands: `1,5M` is refused, not read as 15M. */
  function parseBudget(text) {
    const t = String(text ?? "").trim().toLowerCase().replace(/[_\s]/g, "");
    if (!t) return { ok: true, value: null };
    const m = /^(\d{1,3}(?:,\d{3})+|\d+)(\.\d+)?([km]?)$/.exec(t);
    if (!m) return { ok: false, value: null };
    const scaled = Number(m[1].replace(/,/g, "") + (m[2] ?? "")) * (m[3] === "m" ? 1000000 : m[3] === "k" ? 1000 : 1);
    // `4.1M` is 4099999.9999999995 in binary floating point: round, and
    // refuse only a real fraction of a token.
    const value = Math.round(scaled);
    if (Math.abs(scaled - value) > 1e-6 || !Number.isSafeInteger(value) || value <= 0) return { ok: false, value: null };
    return { ok: true, value };
  }

  // ── Goal-mode composer (per tab, desktop-only) ──────────────────────
  // `mode`: the next send starts a goal; `budget`: its token budget, null
  // for none. Leaving goal mode forgets the budget.
  const GOAL_DRAFT_IDLE = Object.freeze({ mode: false, budget: null });
  const toggleGoalDraft = d => (d.mode ? GOAL_DRAFT_IDLE : { ...d, mode: true });
  const enterGoalDraft = d => (d.mode ? d : { ...d, mode: true });
  const withBudget = (d, budget) => (d.budget === budget ? d : { ...d, budget });

  /** The composer's goal mode against the tab's goal and plan mode — they
   *  exclude each other, as in omp (it refuses a goal in its plan mode; its
   *  TUI blocks plan mode while a goal exists). `mode`: the next send
   *  starts a goal; `goalBlocked` / `planBlocked`: why the goal / plan pill
   *  is off ("" when it is not); `tint`: the composer shows goal colours. */
  function composerGate(draft, tabGoal, planMode) {
    const open = isOpen(tabGoal);
    const mode = !!draft?.mode && !open;
    const status = tabGoal?.goal?.status;
    return {
      mode,
      goalBlocked: planMode ? "Exit plan mode first: omp does not start a goal in plan mode."
        : open ? "This tab already has a goal. Drop it, or let it complete, to start another." : "",
      planBlocked: mode || open ? "Plan mode is off while this tab has a goal." : "",
      tint: mode || status === "active" || status === "budget-limited",
    };
  }

  // ── Strip ───────────────────────────────────────────────────────────
  const TONES = { active: "active", paused: "paused", "budget-limited": "limit", complete: "done" };
  const CHIPS = { active: "active", paused: "paused", "budget-limited": "budget reached", complete: "complete" };

  /** What the strip above the composer shows for a tab's goal, or null.
   *  `busy`: the tab is running (or retrying, or waiting on a background
   *  job). `continuation`: omp's auto-continue setting for the tab's
   *  profile — true / false, or null while unknown. */
  function stripView(tabGoal, { busy = false, continuation = null } = {}) {
    const g = tabGoal?.goal;
    if (!g) return null;
    const budget = g.tokenBudget;
    const meter = {
      used: fmtTokens(g.tokensUsed),
      budget: budget == null ? null : fmtTokens(budget),
      pct: budget == null ? null : Math.min(100, Math.round((g.tokensUsed / budget) * 100)),
      left: budget == null || g.tokensUsed >= budget ? null : fmtTokens(budget - g.tokensUsed),
      over: budget != null && g.tokensUsed > budget ? fmtTokens(g.tokensUsed - budget) : null,
      time: fmtSeconds(g.timeUsedSeconds),
    };
    let sub = null;
    if (g.status === "paused" && g.pausedBy === "stop") sub = "you stopped the turn";
    else if (g.status === "budget-limited") sub = busy ? "wrapping up" : "budget used up";
    let waiting = null;
    if (g.status === "active" && !busy) {
      waiting = continuation === true ? "stopped" : continuation === false ? "off" : "unknown";
    }
    const actions = g.status === "complete" ? ["dismiss"]
      : g.status === "paused" ? ["resume", "drop"]
      : ["pause", "drop"];
    return { tone: TONES[g.status], chip: CHIPS[g.status], objective: g.objective, sub, meter, waiting, actions };
  }

  /** What a goal row in the transcript shows (`rowFor`'s rows, plus the
   *  `continue` marker live.js puts above a turn omp started for the goal):
   *  `{ tone, title, detail, chips }`, `detail` and `chips` optional. */
  function rowView(row) {
    const used = fmtTokens(row.tokensUsed);
    const budget = row.tokenBudget == null ? null : fmtTokens(row.tokenBudget);
    const time = row.timeUsedSeconds > 0 ? fmtSeconds(row.timeUsedSeconds) : null;
    const withTime = chips => (time ? [...chips, time] : chips);
    switch (row.event) {
      case "set":
        return { tone: "active", title: "goal set", detail: row.objective, chips: [budget ? `budget ${budget}` : "no budget"] };
      case "paused":
        return { tone: "paused", title: "goal paused", detail: row.cause === "stop" ? "you stopped the turn" : null, chips: withTime([`${used} tokens`]) };
      case "resumed":
        return { tone: "active", title: "goal resumed", detail: row.objective, chips: [`${used} tokens`] };
      case "limit":
        return { tone: "limit", title: "budget reached", detail: "omp asked the agent to wrap up", chips: [`${used} / ${budget ?? "?"} tokens`] };
      case "complete":
        return { tone: "done", title: "goal complete", detail: row.objective, chips: withTime([budget ? `${used} of ${budget} tokens` : `${used} tokens`]) };
      case "dropped":
        return { tone: "paused", title: "goal dropped", detail: row.objective, chips: withTime([`${used} tokens`]) };
      case "continue":
        return { tone: "active", title: "continuing toward the goal", detail: null, chips: [] };
      default:
        return { tone: "paused", title: "goal", detail: null, chips: [] };
    }
  }

  window.OMP_GOAL = Object.freeze({
    UNKNOWN, NONE,
    fromSnapshot, fromFrame, dismiss, isOpen, rowView,
    continuationRow, ompStartedTurn,
    fmtSeconds,
    BUDGET_PRESETS, budgetLabel, parseBudget,
    GOAL_DRAFT_IDLE, toggleGoalDraft, enterGoalDraft, withBudget, composerGate,
    stripView,
  });
})();

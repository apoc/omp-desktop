# Turn outcome and background work

`src/app/turn-status.js` (`window.OMP_TURN_STATUS`, regression `test-turn-status.mjs`) decides, `live.js` holds the state. Everything it reads is omp ≥ 18.3.1, below the floor; the one command it adds is `abort_retry` (in `ALLOWED_COMMAND_TYPES`).

- **Run state** (`runStateOf`): failed > waiting-user > retrying > running > background > idle, shown by `TabRunDot` from each tab's `displayRunState` (tab bar, group chip, sidebar; `groupRunState` ranks the same way). `retrying` = a live retry row (below); the updater counts it busy. `background` = the agent yielded but omp reports background work (an async bash/task/eval job) that will wake it: `state.asyncPending`, per tab (the four snapshot places), set by every `get_state.hasPendingAsyncWork` (each `agent_end` asks for one, and so does an activation), cleared by `session_settled` and by a dead process (`_endDeadProcessState`). The composer footer notes it, and the updater counts it as busy (a restart kills the job). A background tab's dot overlays Rust's tracker (below) on its snapshot, so it follows the real process too; its `runState` — what every guard reads — is the raise-only union of the snapshot and that dot (`guardRunState`, below).
- **Failed requests**: `message_end` keeps a failed message's failure hidden (`pendingFailure`) because omp may still retry that attempt (`agent_end` with `yielded: false`). A yield (`isYield`) whose last assistant message has `stopReason: "error"` shows it on that bubble (`_showFailure`, `chat/assistant-bubble.jsx`). `prompt_result {agentInvoked: true, status: "error"}` follows its `agent_end` and adds omp's cleaned error text and its `retryable` verdict (the "temporary" chip). Ordinary prompts carry no id, so `prompt_result` is matched to the last failure, not correlated. After a tab switch the adapter rebuilds the block from get_messages (`errorMessage`, `errorStatus`, minus omp's `raw-http-request=` lines), but only for a failure that ended its run (`finalFailures`): omp keeps some failed attempts it continued from, and marks recovered/superseded retries `retryRecovery`. `retryable` is never persisted; the merge carries it over from the live bubble its copy replaces. An output-less failure leaves `get_messages` whenever omp rebuilds its context — a resume, a compaction, a tool-output prune at `agent_end` (`buildSessionContext` drops `isEmptyErrorTurn` and `retryRecovery` messages); the merge then keeps its live bubble, so it is gone only where no live transcript exists (a relaunch, a session opened from history).
- **Automatic retries** (measured on omp 18.6.0 against a local provider answering 503): after a failed request omp emits `turn_end`, `auto_retry_start {attempt, maxAttempts, delayMs, errorMessage}`, drops the attempt from its context, sleeps `delayMs` (`retry.baseDelayMs` 500 doubling, capped at 8 s, up to 25 % shorter by jitter — `calculateRetryBackoffDelayMs`; rate limits use their own windows) and starts the next attempt with `agent_start`/`turn_start` — no `agent_end` in between. One attempt can itself take ~30 s while the provider layer retries the HTTP call underneath, invisibly. `retryStarted` keeps one live-only `kind: "retry"` row at the end of the transcript (omp's `attempt`/`maxAttempts` for the title, its own `failed` count — omp's counter restarts after a fallback model and survives an `abort` — `phase` `waiting` → `attempting` at the next `turn_start`, `since`, `delayMs`) and marks the failed bubble `retried`, plus `superseded` (not rendered, not in the minimap or its count) when it showed nothing. The row lives in `messages`, so it is per tab and snapshotted with them; `get_state` reports no retry, so a relaunch loses it. `retryFinished` removes the row and tags the reply `retries: {failed, outcome}` (`recovered` / `failed` / `stopped`, the chip in the reply header) at the `message_end` of the attempt that answered (the run may go on with more turns). A row still there at the run's final yield means no recovery: `retryYielded` uses `agent_end`'s last assistant only when it failed or was aborted (that list may leave out the final attempt, and its last assistant can then be an earlier reply that answered), else the run's last bubble; it shows a `superseded` final attempt again (a cancel between attempts ends on it), reveals its failure without waiting for a `prompt_result` (a run no prompt started gets none), and gives an attempt stopped in flight (`stopReason: "aborted"`, which ends the run with no `auto_retry_end`) the row's failure. `auto_retry_end` only records `ended` (hides the row, ends `retrying`): it precedes the final `agent_end` on a cancel or give-up and follows even that `agent_end` on success. The get_messages merge carries `retries` (and a stopped attempt's failure) onto the persisted copy (`_withLiveFields`). A dead process clears the row (`retryCleared`).
- **Which bubble is which** (all in `turn-status.js`, regression `test-turn-status.mjs`): a retried attempt is the newest bubble with a `pendingFailure` or `aborted` (`message_end` marks `stopReason: "aborted"`: omp also retries a stream that stalled or dropped without content). Only an answer by omp's own rule (`producedOutput`, its `assistantTurnProducedOutput`: actionable content, not an empty stop) ends the retries at its `message_end`; after an empty stop omp keeps retrying. The yield's fallback scan stops only at a user bubble omp accepted (it has a `ts`; a prompt refused during the wait or a local command has none), skips desktop notes (no `ts`), and before the row accepts only the `retried` attempt. The merge keeps a `retried` attempt hidden even when omp kept it in its context (a failed tool-call turn): `superseded`/`retried` survive and the copy's failure stays pending.
- **Stop** (`OMP_BRIDGE.stopRetry`, the row's button): `abort_retry` while the row waits — it only cancels the sleep, so the run ends on the last failure (`prompt_result` error, `retryable: true`) without `abort`'s other effects (goal mode, title generation, compaction, handoff). Sent while an attempt is in flight it is a no-op and omp keeps retrying (measured), so the `attempting` phase sends the id-less `abort`, as Esc does.
- **Job rows**: the `async-result` custom message (the job result that wakes the agent) adds one live-only `kind: "job"` row per job (`finishedJobsOf`) above the reply it triggers. No omp message stands behind a row, so the merge keeps it in place; a relaunch drops it.
- Not used: `prompt_result` for the auto-rename gates (`lastTurnOk` from `message_end` also covers runs no prompt started, such as a job's wake-up) and `get_state.isSettled`. The planned consumer of an id-correlated `prompt_result` plus `session_settled` is #18's on-close routine.

## Remote status for all tabs

`src-tauri/src/remote/tracker.rs` keeps process-level busy, open-dialog and
background-work state independently of the active webview tab. The stdout
reader feeds its already parsed frames to the tracker *before* publishing them
in the journal and before `ext_ui::record`, so a background tab activated in
between cannot replay and answer a question the tracker has not seen yet:
`agent_start` starts timing a turn and clears background work; a yielding
`agent_end` (`yielded`, else `isTerminal`, else yes) clears busy and
unanswered dialogs and reports the elapsed time, while one that continues into
another run changes nothing. `agent_end`'s `awaitingAsyncWork` (measured on
omp 18.6.0) sets the session's `background` flag; `session_settled` clears it,
and so does every `get_state` response's `hasPendingAsyncWork` (the active tab
asks for one on each activation and `agent_end`; a background tab keeps the
last answer until `session_settled` or a yielding end names the flag).
`select`, `confirm`, `input`, `editor` and `ask` requests with string
ids (at most 256 bytes) count as questions, at most 64 open per session;
duplicate ids do not open another one. omp's own `cancel` request (`targetId`)
closes that question. Every opened question also takes the next value of a
process-wide sequence (`asksOpened` in the snapshot): it rises even when
another question in the same batch was answered, without carrying any prompt
content. Auto-approved tool prompts and retired readers are excluded. Details
of the remote consumer: `remote-access.md`.

`AgentBridge::send` and the atomic approval-and-grant path remove an answered id
only after writing and flushing the response successfully. Natural process exit,
explicit stop, and replacement remove the session. Unrelated streaming frames
need no tracker lock or parse.
Question membership uses a hash set; updates never scan other tabs or dialogs.
Clearing a finished turn releases its remaining questions.

### Tab dots (`agent://attention`)

The tracker is also the desktop's source for tabs whose stdout nobody is
listening to. The manager's fan-out worker (created with the manager, whether
or not remote access is enabled) emits `agent://attention` after every
coalesced tracker change: `{revision, sessions}` with one
`{busy, asks, asksOpened, background}` entry per session id. `attention_snapshot`
returns the same shape, so a reloaded page starts correct; the fan-out runs
even with no phone connected. `revision` rises with every committed change.

`live.js` keeps the session entries as `trackerLive`, filtered to the tabs
that are currently registered (a delayed event for a tab closed meanwhile
must not set a dot or bounce), the highest applied revision, and
`_trackerEvidence`: the revision at which each session's entry last changed,
appearance and removal included. A payload at or below the highest applied
revision is ignored, so an event that lands before the initial
`attention_snapshot` answer wins and the slower answer cannot roll the dots
back.

`_sessionsView` gives every tab two run states. The active tab reads live
state for both; a background tab reads its frozen snapshot.

- **`displayRunState`** is what the tab dot shows (and `groupRunState` for
  the group chip and sidebar; the composer's background note reads the
  active tab, where both states are the same). For a background tab it
  overlays the tracker through
  `OMP_TURN_STATUS.displayRunState(cached, live, loaded, fresh)`, where
  `_saveCurrentSession` records the session's evidence revision so `fresh`
  means the tracker reported that tab after it was frozen. `failed` wins
  over everything (the process's own verdict), and before the first tracker
  payload (`loaded` false) the snapshot stands. A fresh report owns the
  dot: no entry means the process is gone (Rust removes it on exit), so a
  frozen ask retires to `idle`; an open ask is `waiting-user`; `busy` is
  `running`; a pending job is `background`; otherwise `idle`. An older
  report may still raise the dot — an ask that opened, a run the tab never
  saw — but not lower it: the busy fan-out for the tab just left can still
  be in flight, and absence alone proves no exit. One exception: a frozen
  `waiting-user` yields to a tracker entry that names no open ask once it
  has stamped an ask (`asksOpened > 0`), because the tracker reads every
  frame before the tab's listener — so the frozen ask is one it already
  closed, typically the `cancel` line the frozen snapshot predates. A retry
  row ends as soon as a busy → idle → busy wake moves the tracker.
- **`runState`** is the guard state every protective consumer reads —
  quit and busy-tab confirmation, Rust's close guard (`armed`),
  `closeSessionGuarded`, approval-mode restarts (the active tab's
  decision), the updater's busy count, PR automation's `busyElsewhere` and
  the branch picker's `busyInRepo` — so none of them needs per-consumer
  code (#89). For a background tab it is
  `OMP_TURN_STATUS.guardRunState(cached, display)`: the stronger of the
  frozen state and the dot, by `RUN_STATE_RANK`, with `failed` staying
  `failed`. A turn the tab started after it was left (a phone, a queued
  prompt, a background job waking it) therefore counts as busy. It is
  raise-only: a frozen busy tab whose dot a report retired stays busy for
  the guards until it is activated — annoying (one extra confirmation) but
  safe; a delayed, misordered or coalesced report can never make a close, a
  quit or a restart treat live work as idle. `_trackerEvidence` only
  shapes the dot.

**Fresh data at decision time.** The tracker reaches the webview as a
coalesced event, so a turn can be under way in Rust before the webview
hears of it. When "Ask before closing a working tab" is on, `closeSessionGuarded`
and `_requestQuit` first re-read `attention_snapshot` and apply it
(`_refreshAttention` → `_applyAttention(snapshot, false)`: no dock bounce),
then compute the confirmation. A failed or empty read keeps the current
view; an older revision is dropped as usual. Rust's close guard covers the
same gap for an OS close on its own (`settings.md`), and an approval restart
leaves the last word to Rust (`approval-mode.md`).

The dots therefore track in both directions: an ask that opens in a
background tab shows the amber dot before the tab is opened, and one
cancelled, answered elsewhere or ended with the turn clears it. A run the
frozen snapshot never saw (a tab left at `idle`) also shows while it goes
on, and the guards see it too.

A question opening anywhere (tracker `asksOpened` rising for any session)
bounces the dock once while the window is not focused, through the same
`app/attention.js` helper rail widget attention uses (`requestUserAttention`,
Informational). The first snapshot after a page load never bounces: its asks
are not new. A focused window already shows the tab dot, so it stays quiet.

Chunked frames: protocol v2 sends oversized stdout objects as `rpc_chunk`
sequences, and the stdout reader reassembles them in Rust (`agent/frames.rs`)
before the tracker, so an oversized `extension_ui_request` (or `get_state`
answer) reaches the tab dot and the phone's `hasAsk` like any other frame.

One replaceable `Arc<dyn TrackerSink>` receives committed changes after both
tracker locks are released. Sinks must only enqueue work; transport and push
fan-out belong to the remote manager, not the stdout reader. The tracker reports
every timed finish; push consumers apply the 30-second notification threshold.

## Streaming replies (delta frames)

Every omp process runs with `set_event_filter { events: null, messageUpdates:
"delta" }`, written by `start_session` (`agent/mod.rs` `DELTA_EVENT_FILTER`)
right after the spawn, before the frontend sends anything; omp 18.13.2 is the
first whose delta frames can be rebuilt. A `message_update` then
carries `message: { role }` and the event without its `partial` snapshot:
`*_start` the empty block, `*_delta` the increment, `text_end` /
`thinking_end` the final text (`content`) plus the block's metadata (a
signature), `toolcall_end` the whole call, `image_end` the image block
(`content`), `start` (a restarted message) the message whole. A
whole-snapshot frame grows with the reply, so streaming one
cost bytes quadratic in its length.

- **Frontend**: `app/stream-delta.js` (`window.OMP_STREAM_DELTA`, regression
  `test-stream-delta.mjs`) applies an event to the message's blocks
  (`applyEvent`, in place) and projects them onto the bubble (`view`).
  `live.js` keeps the blocks in `streamAcc` (`{ mid, blocks, seed }`, per tab
  in the snapshot places), not on the bubble, which the transcript and the
  phone carry. `applyEvent` reports whether text or thinking changed, so a
  tool call's streamed arguments (its card comes from `tool_execution_*`)
  never cost a render. Which accumulator a frame streams into, and whether it
  is skipped, is `accFor`: an update for another `messageId` than
  `streamAcc`'s restarts the bubble's content on that message — from the
  backend's copy when `streamSnapshot` names it (and with its `ts`), otherwise
  empty (only what streams from there on, the bubble's `ts` unchanged until
  `message_end`).
- **Dropped replay**: a frame the frontend never saw cannot be made up by a
  later one, and a long reply overflows a background tab's journal. The stdout
  reader applies every assistant message frame to `agent/inflight.rs` as well
  (after the journal push, like `ext_ui`), and a reactivated tab whose replay
  came back `dropped` loads it (`streaming_message`: `{ messageId, seq,
  message }`, `streamSnapshot`, assigned only if the switch is still current).
  The bubble of that `messageId` starts from the copy — a `message_start` in
  the replay, an update whose start was evicted, or a bubble that was
  streaming when the tab was left — and that message's frames at or below
  `seq` are skipped. `seed` is the copy object itself, so every new dropped
  replay reseeds, a tab restored with an older seed too. `message_end` still
  carries the whole message and settles the bubble as before. The reader
  hands its parsed frame to `inflight.rs`, which moves blocks out of it
  rather than copying them.

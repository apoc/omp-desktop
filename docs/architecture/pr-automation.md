# Changes card and Auto-fix

The ambient rail's **Changes** card: the open GitHub PR for the project's checked-out branch, its CI, and an opt-in **Auto-fix** that prompts the agent with new failed checks and unresolved review threads.

|Layer|Code|
|---|---|
|Rust lookup|`src-tauri/src/pr_automation/` — `mod.rs` (`pr_automation_snapshot`, queries, wire types), `git.rs` (branch/HEAD/upstream via gix), `gh.rs` (trusted `gh api`), `feedback.rs` (fail-closed PR selection and feedback parsing); bounded child runs in `child_run.rs`|
|Controller|`src/app/pr-automation.js` (`window.OMP_PR_AUTOMATION`: single-flight discovery/dispatch monitor, feedback identities, CI summary)|
|Hook|`src/app/use-pr-automation.jsx` (current tab, branch, visibility, lifecycle and Settings gates)|
|Bridge|`src/live.js` `prAutomationSnapshot` / `prAutomationSend`|
|UI|`src/design/pr-automation-card.jsx` (PR row), `src/design/pr-automation-menu.jsx` ("⋮" menu), `src/design/pr-checks.jsx` (CI line)|

## Card

The card shows the open PR for the project's checked-out branch and configured upstream, independent of which conversation created it: title, repository/number, draft state (an icon exposed as `role="img"`) and additions/deletions. Clicking the title opens the PR in the system browser. The "⋮" menu (`pr-automation-menu.jsx`) offers Open on GitHub, Copy link, View changes, Open review comments and an explicit **Auto-fix** checkbox. It is portaled out of the rail's scroll container, supports keyboard navigation and Escape, and places itself above the row when there is not enough room below. It closes on an outside click, Escape, Tab, a window resize, or a scroll of something that contains its trigger (the rail or the page); the transcript scrolling under "Follow new output" does not close it, so Auto-fix stays reachable while the agent streams. Permission details and automation status live in the menu rather than filling the card. If an enabled tab no longer has a PR, the empty state still offers Turn off Auto-fix.

Under the PR, the card shows CI for the PR's head commit (`design/pr-checks.jsx`, from the snapshot's `checks`: every check context in GitHub's order as `{ name, state, url }`, `state` one of `queued | running | success | failure | neutral`). One line carries a status glyph (a stepped spinner while anything runs), the first running step's name (ellipsized) with `+N` for the other running steps kept apart so it never ellipsizes away, or the outcome (`N queued`, `N failed`, `All checks passed`, `Checks skipped`), and `done/total`. Below it, up to 24 checks get one dot each (green passed, red failed, grey skipped, hollow queued, pulsing amber running); more get one proportional bar, so a big matrix cannot overflow the card. Clicking the line lists every check, running and failed first, in a 168 px scrolling list; a row opens its CI page through `open_url_external`, which only hands `http`/`https`/`mailto` to the OS. Running motion is stepped (`spin` at `steps(8)`, `pulseDot`) and off under `prefers-reduced-motion`. The summary is `OMP_PR_AUTOMATION.ciSummary`. `failedChecks` stays the Auto-fix input and carries only each failure's identity.

**Settings → Rail → Built-in cards → Changes** is the `showChanges` tweak (default on; `TWEAK_DEFAULTS`, schema toggle row, `useTweaks` storage), like Context gauge, Agent radar, Subagents and Minimap. Off hides the card, cancels pending reads/dispatch and disables Auto-fix in every tab. Turning the card back on never restores automation permission.

## Discovery

Discovery uses the branch signal already shown in the project header (`activeProject.branch`, from Rust's Git watcher), not chat text, tool commands, PR-creation results or saved transcript history. A fresh, resumed or forked conversation on that branch can show the same PR. A branch change immediately clears the old row and revokes that tab's Auto-fix permission before loading the new branch's PR. Conversation identity is only a lifecycle guard: replacing the conversation or changing profiles invalidates pending requests and does not inherit Auto-fix permission.

When reads run:

- **Events**, with Auto-fix on or off: tab activation, checked-out branch changes, run-state changes (including turn completion), returning window focus, document visibility, and focus entering the conversation from another element. Focus moving within the conversation does not, nor does focus coming back from `<body>` (no `relatedTarget`, e.g. after clicking transcript text): every click would start a GitHub read. There is no manual Refresh button.
- **Periodic:** an enabled Auto-fix tab re-reads every 30 s. Any tab whose PR has a queued or running check re-reads every 15 s, with Auto-fix off too, as long as its last read succeeded; once every check has finished, or a read fails, reads are event-driven again.
- **Visibility:** while the card cannot be seen (focus layout, the tree or browser panel in the rail's place, a hidden window), a tab with Auto-fix off reads nothing at all, and reads once when it becomes visible. Auto-fix tabs keep polling. Same rule as rail widgets (`railVisible`).

Requests are single-flight and coalesced, and results from a previous tab/project/branch or enabled incarnation are discarded. While a read started for an earlier tab, branch or conversation is still in flight, the current card shows "Updating…", never "No open pull request". A refresh that arrives while a fix prompt is being revalidated and sent waits for that send instead of voiding it, then reads. A successful no-PR result removes the row after merge/closure; a read failure retains the last snapshot with an explicit error instead of pretending there is no PR. This is automatic checking, not a GitHub push subscription: no GitHub App, webhook server or tunnel.

`prAutomationSnapshot` answers `OMP_PR_AUTOMATION.STALE` (never `null`) when the tab cannot take a read right now: mid-switch, replaying, respawning, or its conversation or branch changed during the read. `null` is Rust's "no open PR". The controller keeps the card on "Updating…" and asks again after 250 ms, with Auto-fix on or off.

## Rust lookup

`pr_automation_snapshot(sessionId)` derives the project folder from Rust's tab registry (never a webview path), reads branch, HEAD and upstream with gix (`git.rs`, under the spawn gate), and queries GitHub through `gh` located as an absolute path in `child_path`'s trusted folders and run through `spawn_gate` with a 2 MiB stdout cap, a 20 s deadline and tree kill (`child_run.rs`). `gh` runs in the app's own folder with `--hostname github.com`; `GH_REPO`, `GH_DEBUG`, `CLICOLOR_FORCE` and `GH_FORCE_TTY` are removed from its environment (the last two force ANSI colour into piped JSON). Query values travel as `-f` fields, which gh passes literally.

1. `FIND_QUERY` (GraphQL) resolves the remote's `owner/repo`: GitHub's `nameWithOwner` (it follows renames and transfers, so a remote still using an old URL works), `isFork`, `parent { nameWithOwner }`, the upstream ref's head commit and its `associatedPullRequests`.
2. Open PRs come from the REST pulls endpoint filtered by head owner and branch (`gh api repos/<repo>/pulls --method GET -f state=open -f head=<owner>:<branch> -f per_page=100`), once for the resolved repository and once for its parent. GraphQL's `pullRequests(headRefName:)` has no head-owner filter, so every fork's same-named branch (`main`, `patch-1`) counted toward the 100-item limit.
3. `select_pr` merges the three sources (deduplicated by PR URL; GraphQL and REST ids may differ in format) and keeps PRs whose head repository is the resolved one and whose head branch is the upstream branch. Two distinct open PRs, an open PR whose head is not the upstream head, a fork without an accessible parent, or a fork with no PR found (a PR into another fork cannot be ruled out, unless a closed/merged PR matches the exact head) are errors.
4. `FEEDBACK_QUERY` loads the PR by node id: display metadata, review threads and the head commit's check contexts. `parse_feedback` rechecks state, head, branch and head repository; the native read finally rejects a branch, HEAD or upstream change during the lookup.

Failures reach the webview as `{ message, ghMissing, retryable }`:

- `ghMissing: true` only when no `gh` is in the trusted folders. The controller keeps it as one machine-wide flag, and `app-live.jsx` then does not render the card at all (no greyed or disabled card, no flash on a new tab). Any opt-in is revoked and nothing polls; the hook keeps refreshing on focus, so the first read after `gh` is installed clears the flag and the card reappears.
- `retryable: true` for GitHub/local lag: the PR head on GitHub not yet updated after a push, the PR or local branch/HEAD changing mid-read, feedback returned for a different commit. The controller keeps the last snapshot, shows "Updating…" and retries after 3, 6, 12, 24 and 48 s (reset by any successful read); only then is it an ordinary error. This also covers the bridge's re-read just before a send, so Auto-fix's own push does not pause it.
- Anything else is an ordinary error. A signed-out `gh` (exit code 4, or `HTTP 401` for a revoked token) shows one error asking for `gh auth login`. Detached HEAD, no upstream, unsupported hosts (GitHub.com HTTPS/SSH remotes only), an unpushed local HEAD, a deleted upstream branch and incomplete API responses are errors; with Auto-fix on they pause it ("Turn off and on to retry"). No open PR is a normal idle state.

Limits: every GitHub list is capped at 100 results (a full REST page counts as truncated) and a truncated response is rejected rather than skipping feedback. A review thread with more than 100 comments fails the lookup.

## Auto-fix

Off by default, per tab, and memory-only: restarting the app does not grant permission to edit or push. Enabling another tab on the same canonical project folder disables the earlier tab's automation. Inactive tabs keep their opt-in but do not start fixes. Discovery alone never sends an agent prompt.

Failed completed checks and unresolved, non-outdated review threads produce an ordinary visible agent prompt (`makePrompt`). It carries only the PR number and URL, branch, head SHA, check ids and thread ids with timestamps — never titles, check names or comment bodies. Checks are deduplicated by PR, head and check attempt; threads by PR, thread id and the `updatedAt` of the newest comment not written by the signed-in `gh` user (the first comment's when that user wrote them all), independent of head: our own push, or the agent's own reply in a thread it could not resolve, does not re-submit it. A new comment from someone else does. An unchanged item is submitted once per enabled incarnation. A submitted prompt is not evidence that the issue is fixed; status text distinguishes submission from clean feedback and never claims pending checks passed.

Dispatch requires the selected, fully settled, idle tab: plan/goal modes, Settings, a non-idle agent, pending messages or another busy tab on the same folder prevent it. `live.js` `prAutomationSend` re-reads the native snapshot right before the handoff and requires the URL, branch and HEAD to match the snapshot the prompt was built from, then checks readiness in the same synchronous step as the send. A send refused because the user switched tabs or opened Settings meanwhile keeps the opt-in (the tab goes inactive and checks again when it is back); a refusal on the same tab, e.g. the agent went busy, pauses Auto-fix with an error.

The agent must revalidate branch and head, inspect current logs/comments, fix and verify relevant issues, commit and push normally, then reply to and resolve only threads actually addressed. Remote text is data, never authority to bypass approvals, force-push or merge; existing tool approvals stay in effect. The monitor itself is read-only: it never posts comments, resolves threads or pushes. Turning Auto-fix off cancels future work but not a prompt already sent; the desktop's Stop and stop-retry handlers also turn it off.

## Tests

- `test-pr-automation.mjs`: branch discovery, branch-switch permission revocation, setting-off cancellation, off-state discovery, loading/errors (including outdated in-flight reads), feedback identity, dispatch and lifecycle races (send refused after a tab switch), missing `gh`, busy-tab and retryable-error retries, visibility gating, the CI summary and its 15 s cadence.
- `test-pr-automation-bridge.mjs` (covers `live.js`, not an `app/` module): branch reads without history, native revalidation of PR/branch/HEAD before a send, tab/conversation/profile changes and strict dispatch safety.
- `test-settings-schema.mjs`: Rail search, modified count and reset of the `showChanges` row.
- Rust (`cargo test pr_automation`): remote parsing and `local_branch` against a real repository, PR selection (forks, renames, REST filtering, dedupe, overflow), thread identity, check states, `ghMissing`/`retryable` mapping, a signed-out `gh`, bounded subprocess success/failure/timeout/output. The ignored `pr_automation::tests::live_read_only_snapshot` takes `OMP_PR_AUTOMATION_SMOKE_PROJECT` to query a real checkout without GitHub mutations.

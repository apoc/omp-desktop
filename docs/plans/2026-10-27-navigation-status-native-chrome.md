# Navigation status and native macOS chrome

Status: implementation approved on 2026-10-27 and implemented. Regression/runtime evidence and the remaining native-gesture verification limit are recorded below.

## Overview

Keep the app conversation-first: a chat does not imply coding work, a pull request, or an intention to commit and push. Show Changes only when the checkout has local changes or a known PR. Make checkout identity, relevant PR status, and optional automation understandable without decoding a row of similar icons. Let profile names use available space, and restore native macOS window controls and tiling behavior.

Scope: project sidebar, project tabs and member dropdowns, Changes card, profile labels, and macOS title bar. Preserve conversation/worktree bindings, read-only PR discovery, existing automation safeguards, and Windows/Linux window behavior.

## Approach

Treat Git/PR information as contextual metadata, not a required chat workflow. A repository, branch, or worktree does not establish that the conversation is about a PR. Do not infer intent from the transcript or introduce automatic chat modes.

Separate three concepts instead of styling everything around Auto-fix:

1. **Checkout identity:** project, branch, and whether the conversation uses an isolated worktree.
2. **PR status:** PR identity/lifecycle, CI, review feedback, and discovery freshness.
3. **Automation:** a separate, explicitly enabled per-tab feature for an open PR.

Reuse the existing shared PR presentation model. Give branch, worktree, and PR distinct representations, consistent spacing, and individual explanations. Keep navigation compact; use words in the title bar and Changes card rather than requiring users to learn more symbols.

Current code confirms these sources of confusion:

- Branch and worktree both use the branch icon; PR lifecycle adds another similar branching glyph.
- The grey triangle means PR status lookup is unavailable. The boxed amber `!` means status is stale/unavailable. One failed lookup can display both for the same problem.
- CI also uses `!` for failure and `…` for pending checks. Most status marks share one combined tooltip.
- The Changes card has a separate three-dot actions menu, visually competing with the pending-check notation.
- The Changes card is mounted whenever its setting is enabled, without a local-change/known-PR visibility condition. The reported screenshot shows an automation upstream requirement presented as a PR-refresh error in an ordinary chat.
- Profile badges have a fixed 84px maximum width, even when their container has room.
- macOS uses a frameless window and HTML traffic lights. The custom green control toggles maximization; it is not the native green-button tiling control. Native snapping still requires runtime verification after changing the window configuration.

## Key steps

### 1. Make Changes contextual, not a permanent PR dashboard

| Checkout context | Changes card |
| --- | --- |
| No project folder or not a Git repository | Hidden |
| No known PR and no local changes | Hidden |
| Local changes, no PR | Local-change summary and access to the existing Git browser; no PR placeholder or Auto-fix controls |
| Known PR, clean working tree | PR information only |
| Known PR and local changes | PR information plus a separate local-change summary |

- Reuse native Git status for staged, unstaged, and untracked non-ignored changes in the conversation's actual checkout. Do not use PR diff counts as evidence of local changes or add a competing status implementation.
- No upstream, no GitHub remote, no matching PR, and non-Git folders are ordinary local-only/not-applicable states, not automatic warnings. Neither chatting nor viewing local changes requires a published branch or GitHub authentication.
- Keep automation prerequisite validation separate from read-only discovery. Do not display “Auto-fix requires a configured upstream branch” unless it concerns an explicit automation request; never present it as a generic chat error.
- Loading or discovery failure alone must not create an otherwise irrelevant card. Do not equate unknown status with a confirmed clean checkout or confirmed absence of a PR.
- Preserve a relevant existing card when a known PR or known local-change state cannot refresh. Per the subsequent user-approved failure policy, missed PR fetches and rejected whole reads are quiet skipped attempts, not warning/last-known transitions; keep the cached display unchanged and block automation until a fresh valid read. Independent local-status and malformed-data errors remain explicit, and local-change content is not replaced by a PR failure.
- No PR badges, CI placeholders, or PR-related warning icons on chats with no established PR context. Revoke stale Auto-fix permission when that context is lost; do not show an automation-only empty card.
- Recompute visibility on checkout/status changes and tab switches without leaking another conversation's PR or local changes. Keep the existing Changes setting as an overall opt-out.

### 2. Group checkout and PR metadata

- Use one branch icon beside the branch name. Represent isolation with a `Worktree` label, not a second branch glyph.
- Give the PR its own compact segment: recognizable lifecycle glyph plus `#number`, with Open/Draft/Merged/Closed text where space permits.
- Use the same ordering across surfaces: checkout identity, PR identity, then CI/review status. Keep agent-running indicators separate.
- Use compact variants in navigation and descriptive variants in the title bar/Changes card; do not repeat full branch names on every sidebar row.
- Preserve exact per-conversation checkout status. Collapsed groups with different PRs show an explicit multiple-PR summary, not one misleading branch/lifecycle.

Illustrative hierarchy, not final artwork:

```text
Project  [branch-name · Worktree]  [PR #72 · Draft]
         Checks pending · 2 review threads
```

### 3. Make each status understandable

- Replace the bare CI ellipsis with an unmistakable pending-check indicator and `Checks pending` text in descriptive views. Distinguish queued from running only if the underlying data supports it.
- Distinguish CI failure, unresolved review threads, and inability to refresh PR status. Do not reuse one generic exclamation mark for all three.
- Collapse duplicate unavailable/stale warnings into one refresh-warning indicator. Preserve last-known lifecycle when available and label it as last known.
- Give each semantic item its own hover tooltip and keyboard-accessible explanation: full branch, worktree folder/base, PR lifecycle, CI outcome/count, unresolved-thread count, or refresh error.
- Keep no-checks/unknown states neutral, never falsely successful. Meaning must not depend on color alone.
- Keep actions explicit: label the Changes menu `PR actions` rather than an unexplained three-dot button. Preserve Open on GitHub, Copy link, View changes, and Open review comments.
- Keep metadata controls outside the row's primary navigation button; preserve selection, focus, rename, and drag/reorder behavior without nested buttons.

### 4. Treat Auto-fix as secondary

- Keep ordinary PR/CI/review status visible regardless of whether Auto-fix is enabled, subject to the existing Changes visibility setting.
- Put the opt-in control in a clearly labelled automation section of PR actions.
- Show a small `Auto-fix on` indicator beside PR details only when enabled; no default automation decoration throughout navigation.
- Require a positively identified, current open PR before enabling. Disable enablement for no PR, merged/closed PRs, and unverified lookups. Preserve explicit opt-in for open drafts.
- Hide Auto-fix controls entirely in local-only and ordinary-chat contexts; do not ask users to configure an upstream or create a PR just to clear the interface.
- Preserve per-tab grants, approval/busy-state checks, fresh validation before prompt handoff, and revocation when a PR merges/closes. Reopening must not silently restore permission.

### 5. Correct profile-label sizing

- Replace the unconditional 84px badge cap with available-space-based sizing in the sidebar and tabs; review the title-bar profile selector's independent limits too.
- Let labels grow to their full text when space exists. Truncate only under real width pressure, with a full-name tooltip.
- Define shrink priorities so titles and profiles share space without hiding essential controls or causing overflow. Check hover actions, grouped rows, long names, and narrow widths.

### 6. Restore native macOS window behavior

- Use macOS-only native decorations and real traffic lights, retaining the app toolbar through Tauri's supported overlay title-bar configuration.
- Remove the macOS HTML traffic-light imitation and custom maximize handler. Reserve space for native controls and keep profile/menu/button interactions out of drag regions.
- Verify green-button hover tiling, edge-drag snapping, native full-screen/minimize/restore, and the system-configured title-bar double-click behavior.
- Preserve busy-session close/quit confirmation and child-process cleanup. Keep Windows/Linux on their existing paths.
- Prove native movement/tiling early; do not build a custom snapping algorithm to imitate macOS.

### 7. Verify before delivery

- Exercise real frontend layouts at normal/minimum widths, expanded/collapsed groups, long profiles/branches, light/dark themes, hover, keyboard focus, and zoom.
- Cover no PR, open, draft, pending/successful/failed CI, unresolved reviews, merged/closed, stale/unavailable status, and mixed-PR groups.
- Cover plain/pathless chats, non-Git folders, clean repositories without PRs, unpublished branches, local-only staged/unstaged/untracked changes, PR-only and PR-plus-local-change states, and switching between them. Assert no empty card, irrelevant warnings, or Auto-fix controls in ordinary-chat contexts; verify clean-to-dirty-to-clean visibility transitions.
- Add behavioral regressions for status distinctions, group deduplication, and open-PR-only Auto-fix enablement/handoff. Run the existing JavaScript suite and release frontend build.
- Build and run the actual macOS app to verify snapping and native controls; browser screenshots cannot prove AppKit behavior. Exercise busy-close cancellation/confirmation without risking real conversations.
- Run modified-file formatting plus Rust tests and strict Clippy for native changes. Update architecture notes and the Unreleased changelog after runtime proof.

## Risks

- **Crowding:** replacing icons with text can consume sidebar width. Use compact navigation variants and descriptive detail views; avoid adding another permanent metadata row to every conversation.
- **Misleading status:** simplifying warnings must not hide failed CI, stale data, or last-known lifecycle. Keep those facts separate in the presentation model and explanations.
- **Absence versus failure:** missing upstream/no PR is not an error, but failed reads are not proof that nothing changed. Preserve relevant last-known data and distinguish not-applicable, loading, absent, and failed states.
- **Automation permission:** moving controls must never enable Auto-fix, share grants between tabs, or weaken open-PR validation.
- **Interaction regressions:** independent tooltips/actions must not steal row selection, interfere with reordering, or create nested interactive elements.
- **Native integration:** overlay geometry, full-screen transitions, and macOS version/settings can affect tiling. Validate on the actual app and display setup; preserve native close guards and other platforms.

## Verification record

- `npm test` passed, including the release frontend build. Native tests passed with Chromium required: 1,168 tests; one opt-in live-GitHub probe remained ignored. Modified Rust files were formatted, and nightly pedantic/nursery Clippy passed with warnings denied.
- The rebuilt frontend was exercised in Chromium at 1440px and 480px widths, dark/light themes and 200% zoom. Checks covered empty/non-Git/no-PR cards, local-only and combined PR/local content, errors without established PR context, terminal PR action eligibility, independent focused tooltips, PR actions, local-change navigation, sidebar reorder, and full profile labels when space exists. No nested buttons were present in the exercised navigation.
- A macOS release app bundle was built and its code signature verified. A disposable inspection copy used a separate bundle identity and HOME; the installed application was not replaced. AppKit inspection confirmed titled/resizable/full-size overlay flags and three enabled native traffic-light controls, with no HTML traffic lights. Native fullscreen entry/exit and minimize were observed during the window probe.
- An actual local-only conversation was opened against a disposable Git checkout without an upstream. `changes_snapshot` returned one changed file and no PR/error, the real card rendered “1 changed file” without PR actions, and a native close request reached the armed Rust close guard before the normal idle quit completed.
- The background WKWebView reported itself hidden, so its visible-page event was emulated for the native monitor/UI portion of the smoke run. Native edge-drag snapping and green-button tiling-menu gestures were not automated; they still require manual confirmation on the user's display setup. No claim is made that those gestures were exercised.
- Subsequent fetch-failure policy: the complete frontend suite and release frontend build passed, including 50 automation, 22 bridge and 29 presentation checks. A rendered controller/card/navigation smoke injected startup offline, timeout, disconnect and recovery: no fetch-warning icons or alerts, no stale-data fix prompts, automatic recovery, preserved real CI failures and a later merged lifecycle. Failed final native validation skipped publication without inserting a bubble or marking feedback handled.

Architecture notes and the Unreleased changelog describe the implemented contextual visibility, status/tooltips, permission boundaries, profile sizing and native window policy.

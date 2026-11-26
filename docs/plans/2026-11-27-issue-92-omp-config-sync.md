# Issue #92: Settings shows omp's own compaction/retry config

Decision record for `fix/config-sync`. Base: master `88206e0`.

## Problem (verified)

Settings → Agent → "omp behaviour" has two switches, **Auto-compact context** and **Retry failed requests**. They are desktop-only `localStorage` tweaks (`autoCompaction` / `autoRetry`, default `true`, `src/app/constants.js`). They never read omp's value:

- With omp's `compaction.enabled: false`, the switch still shows on.
- At spawn, the desktop sends `set_auto_compaction` / `set_auto_retry` `{enabled:false}` only when a switch is off (`live.js` `_initFetch`).
- On a change it pushes the new value to every tab (`setSessionPrefs` → `_sendToAll`). That is a per-process override that omp's config cannot undo afterwards.

The "max" thinking level the reporter saw is omp's choice, not the desktop's:

- the desktop sends no level at startup;
- a resumed conversation keeps its last picked level (omp `sdk.ts` `pickInitialThinkingLevel`), and `auto` shows what it resolved to.

One desktop bug was found next to it: `src/app/use-bridge-snapshot.jsx` updates the thinking level only when the snapshot's is truthy. A new tab (`null` until its first `get_state`) therefore keeps showing the previous tab's level.

omp facts:

- `compaction.enabled` and `retry.enabled` default to `true`.
- `omp config get <key> --json` prints `{key, value, type, description}`.
- `omp config set <key> <value>` writes the profile's `config.yml`.
- An `omp --mode rpc-ui` process polls its config files and applies edits live (`oh-my-pi/packages/coding-agent/src/main.ts` 3043-3047, `Settings.startWatching`, since v18.3.1; the floor is 18.20.0).

## Decisions

- **D92-1 omp's config owns both switches**, the same way the Goals row owns `goal.continuationModes` (`design/settings/rows-agent.jsx` `useGoalContinuation`, `src-tauri/src/goal_config.rs`, commands `goal_continuation_get` / `_set`).
  - Each switch reads `compaction.enabled` / `retry.enabled` from omp's config of the same profile the goal row uses (`ctx.goal.profileId`), and writes it back on toggle.
  - Running tabs of that profile pick the change up through omp's config watcher. The desktop sends no `set_auto_*` frame.
  - Each row's description names the profile, using the goal row's scope sentence.
  - Loading and error states work like the goal row's.
- **D92-2 One `omp config` primitive in Rust.**
  - Move the generic `omp config get --json` / `omp config set` plumbing out of `goal_config.rs` into one module: profile flag placement, the `omp_cli` run, `--json` value parsing, the serialising lock and error snippets.
  - `goal_config.rs` keeps only its array logic on top of it.
  - Add two commands for boolean omp settings, a get and a set. Their `setting` argument is a closed enum (`autoCompaction` → `compaction.enabled`, `autoRetry` → `retry.enabled`). The webview never sends a raw key.
  - Profile handling is identical to the goal commands (`profiles::resolve_owned` before any `--profile`), off the IPC thread the same way.
  - Register both in `generate_handler!`.
- **D92-3 Remove the desktop copies (clean cutover).** Remove:
  - the `autoCompaction` / `autoRetry` tweaks (`TWEAK_DEFAULTS`, comments, `session-prefs.js` `KEYS`);
  - their `settings-schema.js` tweak rows, replaced by custom rows (`OMP_SETTINGS_ROWS`, the goal row's pattern) that keep labels, descriptions and search keywords;
  - the `_initFetch` sends and the `setSessionPrefs` pushes;
  - `set_auto_compaction` / `set_auto_retry` from `ALLOWED_COMMAND_TYPES`, once nothing sends them (grep first).

  A previously stored desktop "off" is not migrated. The CHANGELOG says so.
- **D92-4 Stale thinking pill.** `use-bridge-snapshot.jsx` applies the snapshot's thinking level even when it is `null`. The composer's thinking pill and menu (`design/composer.jsx`, `design/thinking-menu.jsx`) then render with no level, with no crash and no previous-tab level, until omp reports one. No other thinking behaviour changes (AGENTS.md "Thinking levels are omp's").
- **D92-5 i18n.** Every new interface string goes through `OMP_TR`, with entries in `src/app/i18n-zh.js` (`tests/test-i18n.mjs` enforces this).
- **D92-6 Docs.**
  - `docs/architecture/settings.md`: the autoCompaction/autoRetry paragraph, the `live.js` prefs list and the storage table.
  - `goal-mode.md`, if it describes the module that moved.
  - The AGENTS.md repo map (`goal_config.rs` line and the new module).
  - CHANGELOG `[Unreleased]`: `### Fixed` (the switches show omp's config; a new tab's thinking pill no longer shows the previous tab's level) and `### Changed` (the switches now change omp's config for the profile; an earlier desktop-only "off" is not carried over).

## Tests (required)

- Rust: the moved primitive's parsing tests, kept or moved from `goal_config.rs`; boolean value parsing (true, false, non-bool, malformed JSON); the enum → key mapping.
- JS:
  - `test-session-prefs.mjs` and any test asserting the removed keys are updated;
  - the custom rows' pure logic, if any is extracted;
  - the snapshot hook applying a `null` thinking level, if a harness reaches `use-bridge-snapshot.jsx` (otherwise state why in the report);
  - `tests/test-i18n.mjs` passes.

## Amendments (review round 1)

- **D92-1a Auto-compaction is two keys.** omp's effective auto-compaction is `compaction.enabled && compaction.methodOrder` non-empty (`session-maintenance.ts` 7107-7112; legacy `compaction.strategy: "off"` migrates to `methodOrder: []`). The switch reads both under one lock and shows `enabled && !methodOrder.is_empty()`. Turning it on sets `enabled: true` when needed and runs `omp config reset compaction.methodOrder` when the order is empty, which is what omp's own setter does. Turning it off sets only `enabled: false`. Retry stays one key.
- **D92-7 Scope is the profile's config.** `omp config` runs in the desktop's own working directory, so a tab project's `.omp/config.yml` is neither read nor shown. The docs and CHANGELOG say "the profile's config" and name this limit. Per-project values are out of scope.
- **D92-8 Hook placement.** The generic omp-config hook moves out of `use-goal-mode.jsx` into its own `src/app/use-omp-setting.jsx`, loaded before `use-goal-mode.jsx` in `src/index.html`. The goal hook builds on it.

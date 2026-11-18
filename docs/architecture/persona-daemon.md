# Persona daemon (Ompy)

`omp-desktopd` is the standalone, always-on persona service. It hosts one background `omp` session, wakes it for mail triage and other scheduled work, keeps the user's inbox, and exposes a local socket for the desktop app and the Ompy extension. Shared protocol and approval/storage helpers live in `crates/omp-desktop-core`; service code is in `crates/omp-desktopd`.

## Process model and CLI

`omp-desktopd run` (also the default with no command) resolves `omp`, creates the persona directory, starts the socket server and runs the core event loop. `install` writes and starts the per-user autostart entry; `uninstall` stops and removes it. Entries are a macOS LaunchAgent (`dev.ohMyPi.desktop.persona`), a Linux systemd user service with `Restart=on-failure`, and a Windows logon Scheduled Task (`OMP Desktop Ompy`, `IgnoreNew`). `status` connects as an app client and prints the service status JSON.

A second `run` first probes the local socket and exits successfully when a service answers. On Unix a stale socket file is replaced. This is socket-based single-instance detection, not a lock file.

## Files

State lives under `<app config>/persona/` for app identifier `dev.ohMyPi.desktop`:

|Path|Contents|
|---|---|
|`daemon.sock`|Unix local socket (`0600`); Windows uses a per-user named pipe instead|
|`inbox.json`|Approvals, decisions, results and notices, atomically persisted|
|`schedule.json`|Pending self-scheduled wake-ups|
|`budget.json`|Local day, token use, warning state and daily limit|
|`settings.json`|Interval, quiet hours, weekend quiet and token-limit settings|
|`sessions/`|The hosted omp session's files|
|`approval-rules/`|Ompy-scoped tool-approval rules|
|`instructions.md`|Persona instructions, created from the embedded default only when absent|
|`extension.mjs`|Ompy tools, rewritten from the embedded version on each service start|

The persona directory is private (`0700` on Unix). Socket messages and persisted state use the types in `omp-desktop-core/src/persona_protocol.rs`.

## Socket protocol

The transport is newline-delimited JSON, one object per line, capped at 16 MiB excluding the newline. A client first sends `hello` with `protocol: 1` and `client: "app" | "extension"`; the service answers with its own `hello`. Requests carry an optional `req`, answered by a `reply` with the same id and `ok`, plus `data` or `error`. A malformed or oversized first line is refused; after the handshake, errors do not implicitly close the connection.

Client messages are `status`, `attach` (`afterSeq`), `detach`, `rpc`, `pause`, `resume`, `wake_now`, `set_settings`, `inbox_resolve`, `schedule_wake`, `list_schedule`, `cancel_wake` and `notify`. Attached app clients receive sequenced `rpc` frames (replayable from `afterSeq`), `inbox` snapshots and `status`. The extension uses one connection per tool call and exposes only schedule and notify operations to the model.

## Wake-ups and budget

The scheduler (`scheduler.rs`) is a pure state machine driven by the core's clock. Defaults are a 30-minute interval, quiet hours 20:00–07:00, and quiet weekends. Quiet hours suppress interval wakes only; scheduled and manual wakes still run. Ompy may queue at most 50 wakes, at most 30 days ahead, by absolute or relative time. After sleep, every due scheduled wake is caught up oldest-first, while a missed interval produces at most one catch-up turn.

A turn is held while omp is busy, an approval is open, the user paused the service, the omp session is down, or today's budget is exhausted. Held scheduled wakes remain due; a held interval is dropped rather than accumulated.

Assistant usage counts `input + output + cacheWrite`; `cacheRead` is excluded. The default daily limit is 2,000,000 tokens, with a warning at 80% and a hold at 100%. Usage resets on a forward local-date change at midnight; moving the clock backwards does not grant another budget.

## Inbox and session lifecycle

The inbox retains settled items for 14 days and at most 200 items overall; open items are always kept. Decisions wait for an answer, while results and notices are informational. Requests from omp retain their method so `select`, `input` and `editor` answers return `value`, `confirm` answers return `confirmed`, and `ask` answers return one structured answer per question. A single pick-one `ask` accepts either an exact option label or free text. For a multi-question `ask`, the inbox answer is a JSON array of per-question strings in question order, each mapped to an exact option label or `customInput`; malformed or wrong-length arrays are rejected and leave the item open.

If omp exits or cannot spawn, restart backoff starts at 1 second and doubles to 5 minutes; a session that stayed up for at least 60 seconds resets the delay to 1 second. Open approvals and decisions bound to an omp RPC request expire on an unexpected stop and any bound items left by a previous process expire at startup, with a notice in the inbox.

## Known gaps

- `attach` can duplicate frames because replayed ring entries overlap already queued live events, and sequence numbers restart with each session generation (`src/core/inbound.rs`, `src/session.rs`).
- Results and notices are created open and are never pruned until the user dismisses them, so the inbox can grow without bound (`src/core/inbound.rs`, `src/inbox.rs`).
- Secret `input` answers are persisted in `inbox.json` and broadcast with the rest of the item (`src/core/inbound.rs`, `src/inbox.rs`).
- A missing `omp` at service start exits the process instead of retrying with an inbox notice (`src/main.rs`).
- Windows starts `omp` without `CREATE_NO_WINDOW` or `windows_subsystem`, and the named pipe is named from `USERNAME` with the default DACL (Everyone read) rather than a hardened private descriptor (`src/session.rs`, `src/paths.rs`).
- Outbound per-connection channels and the accepted-connection count are unbounded, as is the core event channel (`src/server.rs`, `src/core/lifecycle.rs`).
- A `schedule.json` or `settings.json` read error preserves the file, but the next write of that state overwrites it; inbox and budget files are moved aside instead (`src/core/store.rs`).
- A corrupted `budget.json` starts a fresh counter, so the day's spent allowance can be regained (`src/core/store.rs`).
- The systemd `ExecStart` quotes the executable but does not reject embedded newlines (`src/autostart.rs`).
- Notified results bypass the inbox retention rule, and the persona extension's tools omit `loadMode: "essential"` (`src/core/inbound.rs`, `persona/extension.mjs`).
- Instance detection is check-then-bind without a lock file, so two simultaneous starts can both bind (`src/server.rs`).
- `omp` tool children are not killed as a process group (`src/session.rs`).
- The macOS LaunchAgent has no `StandardErrorPath`, so service stderr has no persistent log (`src/autostart.rs`).
- Desktop app integration is Plan B; this service is currently standalone.

# Persona daemon (Ompy)

`omp-desktopd` is the standalone, always-on persona service. It hosts one background `omp` session, wakes it for mail triage and other scheduled work, keeps the user's inbox, and exposes a local socket for the desktop app and the Ompy extension. Shared protocol and approval/storage helpers live in `crates/omp-desktop-core`; service code is in `crates/omp-desktopd`.

## Process model and CLI

`omp-desktopd run` (also the default with no command) creates the persona directory, starts the socket server and runs the core event loop. The core resolves `omp` on every spawn, so a missing or moved binary follows the same spawn-failure path as a crash instead of exiting: status `error`, one inbox notice per outage and the restart backoff. `install` writes and starts the per-user autostart entry; `uninstall` stops and removes it; `stop` ends a running service without touching the entry, and is a no-op when nothing runs. The desktop copies the bundled executable to `dirs::data_local_dir()/dev.ohMyPi.desktop/bin` (`dirs::data_dir()` on macOS) and runs `install` from that stable copy, never from an AppImage mount or translocated app bundle. App startup refreshes a changed copy and restarts only a service that was already running; on Windows the service is stopped first, because a running `.exe` cannot be replaced, and started again after the copy and its digest check; disable leaves the copy dormant. Entries are a macOS LaunchAgent (`dev.ohMyPi.desktop.persona`), a Linux systemd user service with `Restart=on-failure`, and a Windows logon Scheduled Task (`OMP Desktop Ompy`, `IgnoreNew`). Every rendered entry rejects an executable path containing a control character, because systemd would split `ExecStart` on a newline and XML cannot represent it. `status` connects through the same owner-verified helper as the app and prints the service status JSON; the whole handshake and reply are bounded at 5 s, so a hung or foreign server cannot stall the refresh probe.

A second `run` first probes the local socket and exits successfully when a service answers; on Windows the probe also verifies that the answering server runs as the current user (see below), so a pipe created by another account is a hard error rather than a silent second instance. On Unix a stale socket file is replaced. This is socket-based single-instance detection, not a lock file.

## Files

State lives under `<app config>/persona/` for app identifier `dev.ohMyPi.desktop`:

|Path|Contents|
|---|---|
|`daemon.sock`|Unix local socket (`0600`); Windows uses the named pipe `omp-desktopd-<user SID>` with a DACL for that user only|
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

Client messages are `status`, `attach` (`afterSeq`), `detach`, `rpc`, `pause`, `resume`, `wake_now`, `set_settings`, `inbox_resolve`, `schedule_wake`, `list_schedule`, `cancel_wake` and `notify`. Attached app clients receive sequenced `rpc` frames (replayable from `afterSeq`), `inbox` snapshots and `status`. The generation starts at the service process start time in Unix milliseconds and increments for each omp session; sequence numbers remain strictly increasing across those omp session generations, and status reports the current `generation`. Clients must reset their sequence cursor whenever `generation` changes and on every new connection. Each app connection initializes its last-sent watermark from `afterSeq`, then advances it through replay and live relay, so skipped or already-replayed frames are not sent again when their live events were already queued. The extension uses one connection per tool call and exposes only schedule and notify operations to the model.

Admission happens in the accept loop, before any connection thread or handshake buffer exists: at most 16 connections hold a slot, including clients that connect and never send `hello`. On Unix a connection beyond the cap is answered on the accept thread with `reply` `ok: false, error: "too many connections"` (bounded by a short write timeout) and closed without a thread. On Windows it is disconnected immediately without a reply: writing would make interprocess 2.4.8 drop a dirty pipe into its `FlushFileBuffers` linger pool, so the service instead calls `DisconnectNamedPipe` and drops the never-written stream without lingering. On Unix the handshake deadline is absolute - 10 s in total across all reads - so a client that trickles bytes cannot extend it; Windows named-pipe streams have no receive timeout, and the pipe DACL keeps such a client within the same user.

Each connection's outbound queue is bounded at 32 MiB of serialized messages; when a client stops reading and its queue would exceed that, the core logs it, closes the socket and drops the connection instead of blocking. All connections also share one server-wide 32 MiB inbound budget: the reader reserves each line's serialized size before handing it to the core, the reservation travels with the message, and its guard releases the bytes when the core finishes handling it (or when an unhandled message is dropped). A line that would exceed the global budget is not queued; that reader sends a best-effort `inbound queue full` reply, shuts its connection down and stops reading. Reconnecting therefore cannot obtain a fresh inbound allowance. A parse error whose reply the outbound queue refuses closes the connection for the same reason: a client that does not read its errors is no longer read either.

When the reader exits - client EOF or half-close, refused reply, or inbound overflow - the socket is shut down so a writer blocked on a client that stopped reading returns, and the admission slot is released only after both the reader and the writer have finished. The core event channel itself stays unbounded: client traffic is byte-bounded before it is queued, session events are not (see Known gaps), and blocking the channel could stall the `omp` stdout reader.

On Windows the service derives the pipe name from the current user's SID and installs a DACL that grants full access to that SID only, with nothing inherited; the name and descriptor both fail rather than fall back when the SID cannot be read. Because any account may pre-create `\\.\pipe\omp-desktopd-<victim SID>`, a successful probe connect is not trusted by name: the service asks the pipe for its server process (`GetNamedPipeServerProcessId`), opens that process with `PROCESS_QUERY_LIMITED_INFORMATION`, compares its token user SID with its own, and treats only a match as already running. A mismatch is the hard error `another account owns the persona pipe name`; a probe that cannot be verified is an error too, never a silent exit. The listener is created with `FILE_FLAG_FIRST_PIPE_INSTANCE` (interprocess sets it for the first instance), so a racing second bind fails instead of sharing the name. `run` detaches from a console it owns alone and spawns `omp` with `CREATE_NO_WINDOW`, so the logon task leaves no console window behind; `status` and `install` keep their console output. A desktop-app client for this protocol (Plan B, not implemented here) must repeat the same server-owner check before trusting the pipe: the DACL protects the service's listener, not a squatter's.

## Wake-ups and budget

The scheduler (`scheduler.rs`) is a pure state machine driven by the core's clock. Defaults are a 30-minute interval, quiet hours 20:00–07:00, and quiet weekends. Quiet hours suppress interval wakes only; scheduled and manual wakes still run. Ompy may queue at most 50 wakes, at most 30 days ahead, by absolute or relative time. After sleep, every due scheduled wake is caught up oldest-first, while a missed interval produces at most one catch-up turn.

A turn is held while omp is busy, an approval is open, the user paused the service, the omp session is down, or today's budget is exhausted. Held scheduled wakes remain due; a held interval is dropped rather than accumulated.

Assistant usage counts `input + output + cacheWrite`; `cacheRead` is excluded. The default daily limit is 2,000,000 tokens, with a warning at 80% and a hold at 100%. Usage resets on a forward local-date change at midnight; moving the clock backwards does not grant another budget.

## Inbox and session lifecycle

The inbox retains settled items for 14 days and at most 200 items overall; open items are always kept. Decisions wait for an answer, while results and notices are informational. Requests from omp retain their method so `select`, `input` and `editor` answers return `value`, `confirm` answers return `confirmed`, and `ask` answers return one structured answer per question. Secret `input` requests are marked `secret`; their answers still return to omp but are never persisted in `inbox.json` or included in inbox broadcasts. A single pick-one `ask` accepts either an exact option label or free text. For a multi-question `ask`, the inbox answer is a JSON array of per-question strings in question order, each mapped to an exact option label or `customInput`; malformed or wrong-length arrays are rejected and leave the item open.

If omp exits or cannot spawn, restart backoff starts at 1 second and doubles to 5 minutes; a session that stayed up for at least 60 seconds resets the delay to 1 second. `omp` is resolved on the child PATH before every spawn, so a missing binary is only one kind of spawn failure (one notice per outage) and installing it while the service runs is enough to recover. Open approvals and decisions bound to an omp RPC request expire on an unexpected stop and any bound items left by a previous process expire at startup, with a notice in the inbox.

## App integration

The desktop app (`src-tauri/src/persona/`, `src/app/persona.js`) is an ordinary app-kind client of the service. A background Rust thread owns the one connection, reconnects with 0.5 s doubling to 5 s backoff, and keeps a snapshot of the status, inbox and last terminal connection error so the webview can fetch state without a service round trip. A protocol mismatch or another account's Windows pipe is terminal: retrying stops until Enable or an app restart. The error state is also cached as a snapshot (`persona_error`) because `setup` can emit it before the webview subscribes. It has two channels: the connection's last terminal error, which a successful status clears (event and snapshot), and an app-side `refresh` failure in its own field, which a status, an `io` outage or a reconnect never touches and only a later successful refresh clears. The strip shows both together (`app/persona.js` `errorsWith`/`statusCleared`). A failure is named in the user's language (`errorView`: `io` is "Could not reach the Ompy service." and Enable/Disable failures are one sentence), with the platform tool's own text only in the tooltip. A successful Disable makes the service's absence the expected state — the client reports no `io` error for it, and the strip hides one that predates it (`live.js` `personaExpectedOff`).

The client surfaces:

- events `persona://status`, `persona://inbox`, `persona://line/ompy` (an omp frame after the same credential redaction as the agent reader), `persona://error` (`kind` `io`, `protocol` or `owner`, plus the app-side `refresh`) and `persona://error/cleared` (`{ kind }`: that channel's warning no longer applies, emitted when a later sidecar refresh succeeds so a mounted strip drops it without a reload);
- commands `persona_status`, `persona_inbox`, `persona_error`, `persona_schedule`, `persona_attach`, `persona_detach`, `persona_send` (the normal RPC allowlist), `persona_resolve`, `persona_set_settings` (the complete settings object), `persona_pause`, `persona_resume`, `persona_wake_now`, `persona_enable`, `persona_disable` and `persona_open_instructions`.

`live.js` models Ompy as a session with id `ompy` and `kind: "persona"`, not a project tab: it never enters `open-tabs.json`, tab counts, drag reorder, close guards or Ctrl+Tab stops, and closing it is a no-op. Status generations drive the relay cursor: a new service process resets the cursor and transcript and re-attaches at sequence 0; `attach` replays the ring in order and live frames follow without duplicates. Ompy's own chat has no Rust tab, so the browser, files, terminal and conversation-tree panels are disabled while it is shown; Settings can sit above it without marking its sidebar entry current.

The UI pieces are the pinned sidebar entry with an inbox badge, the status strip above Ompy's chat (`design/persona-strip.jsx`: service state, next wake, token bar, Pause/Resume, Wake now, Enable), the rail Inbox card (`design/persona-inbox-card.jsx`: open approvals/decisions, recent results, queued wakes) and Settings → Persona (`design/settings/rows-persona.jsx`: Enable, interval, quiet hours/weekends, daily token limit, instructions). `app/persona.js` holds the pure status/inbox/schedule views, settings validation, translated relative times, stable-error translation and the persona predicate shared by all of them. Interface strings use `OMP_TR` with Chinese entries.

While the app runs, each new open approval or decision in an inbox snapshot is offered to Web Push; quiet hours keep only urgent items, and the phone's notification deep-links to `?tab=ompy`. The push worker uses the ordinary settings and 30 s throttle.

Enable copies the bundled `omp-desktopd` into the stable per-user location, verifies its SHA-256 and runs `<stable copy> install`; Disable runs `<bundled copy> uninstall` and leaves the stable copy dormant. App startup refreshes a changed copy and restarts only a service that was already running. The sidecar, path and signing details are in `docs/architecture/sidecar.md`.

## Known gaps

- On Windows a client refused by the 16-connection admission cap sees an immediate disconnect without the `too many connections` reply; avoiding interprocess's dirty-pipe linger pool takes precedence over delivering that error (`src/server.rs`). Unix clients still receive the reply.
- Results and notices are created open and are never pruned until the user dismisses them, so the inbox can grow without bound (`src/core/inbound.rs`, `src/inbox.rs`).
- A `schedule.json` or `settings.json` read error preserves the file, but the next write of that state overwrites it; inbox and budget files are moved aside instead (`src/core/store.rs`).
- A corrupted `budget.json` starts a fresh counter, so the day's spent allowance can be regained (`src/core/store.rs`).
- Notified results bypass the inbox retention rule, and the persona extension's tools omit `loadMode: "essential"` (`src/core/inbound.rs`, `persona/extension.mjs`).
- On Unix, instance detection is check-then-bind without a lock file, so two simultaneous starts can both bind; the Windows first-instance pipe flag prevents that case (`src/server.rs`).
- The session-to-core event channel is unbounded: queued session events keep their frames alive, so replay-ring eviction cannot free them, and memory follows `omp`'s own output rate (`src/core/mod.rs`, `src/session.rs`).
- `omp` tool children are not killed as a process group (`src/session.rs`).
- The macOS LaunchAgent has no `StandardErrorPath`, so service stderr has no persistent log (`src/autostart.rs`).
- An `ask` with a single pick-any (`multi`) question rejects every inbox answer, so the user can only dismiss it; an empty answer to a single pick-one `ask` is sent as `customInput: ""`, which omp treats as a cancel (`src/core/inbound.rs`).
- The phone's Ompy tab chip shows `busy: false` and `hasAsk: false`.
- All Ompy notifications share the single `ompy` push key, so the 30 s throttle permits one Ompy push per app across every inbox item.
- Existing user-owned symlinked ancestors above the app data directory are followed by design; only the app-named directory, `bin` and the executable are rejected when symlinked (`src/persona/sidecar.rs`).
- The credential sanitizer replaces every `secret`-named value, including the `secret: true` flag of an omp `input` request, with a placeholder string; the chat and phone input prompts therefore never mask that answer, and the answer stays in the tab's message state (`src-tauri/src/redaction.rs`, `src-tauri/src/agent/reader.rs`, `src/live.js`).
- A protocol mismatch makes the startup refresh probe treat the service as stopped: any failed `status` is read as "not running", so a stale service is not restarted (`src/persona/sidecar.rs`, `crates/omp-desktopd/src/main.rs`).
- Ompy's chat offers "Approve and remember" for tool prompts, but the grant command only knows prompts a Rust-owned tab process forwarded, so the grant is always refused there (`src/live.js`, `src-tauri/src/agent/approvals.rs`).

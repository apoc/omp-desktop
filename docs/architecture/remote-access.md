# Remote access (phone)

A phone on the user's network (LAN or VPN) opens `https://<host>:7470`, sees the desktop's tabs, reads the active tab live, answers the agent's questions, sends, steers and stops, and gets Web Push for open questions and finished turns. Off by default; nothing listens until Settings → Remote access enables it.

Code: `src-tauri/src/remote/` (Rust: server, auth, tracker, push), `src/remote/` (the phone page), `src/app/remote-view.js` + `src/app/use-remote.jsx` (the webview's publisher and action executor), `src/design/settings/rows-remote-{shared,server,phones}.jsx` (Settings rows), `src/live.js` `remote*` bridge methods.

## Module boundaries

- Rust: `http.rs` reads bounded requests; `http/admission.rs` checks Host/Origin and `http/response.rs` writes replies. `server.rs` owns the accept/connection lifecycle, `server/routes.rs` handles static assets and pairing, and `server/transport.rs` owns TLS deadlines and connection slots.
- Rust: `hub.rs` publishes views and push state; `hub/state.rs` owns caches and bounded outboxes, `hub/connections.rs` owns registration/revocation, and `hub/actions.rs` correlates requests. `ws.rs` coordinates authentication and the pump, `ws/frames.rs` handles frame deadlines/control writes, and `ws/messages.rs` validates incoming messages.
- Rust: `manager.rs` exposes the manager API; `manager/core.rs` owns lifecycle/rebind monitoring, `manager/status.rs` builds/emits status, and `manager/phones.rs` handles pairing/device/certificate operations.
- Phone: `scanner.js` owns camera generations and stream teardown; `sessions.js` owns the header and modal sheet; `transcript.js` owns messages, asks, drafts and scroll pinning. `remote.js` coordinates these factories with transport, pairing, composer and push state. The factories do not own a desktop bridge.
- Settings: `rows-remote-shared.jsx` owns one status listener, one serialized settings queue and shared controls. `rows-remote-server.jsx` registers server/certificate rows; `rows-remote-phones.jsx` registers pairing/devices/push rows. They share the same Babel lexical scope; never instantiate a store per row family.

## Data flow

```
phone page ⇄ TLS/WebSocket ⇄ Rust hub ⇄ Tauri events/commands ⇄ webview (publisher + executor) ⇄ OMP_BRIDGE ⇄ omp
                                  ▲
        agent stdout reader → tracker (busy / open questions, all tabs) → push
```

- The desktop webview stays the single source of truth. It publishes the **active** tab's view (`remote_publish`) and executes phone actions through the existing bridge (`send`/`steer`/`abort`/`answerAsk`/`answerConfirm`/`answerAskDialog`/`cancelAsk`). A phone tab **is** the desktop tab: selecting a tab on the phone activates it on the desktop, and the desktop user sees the switch.
- Rust owns transport, auth, certificates, settings (`remote.json`) and devices (`remote-devices.json`, mode 0600 on Unix). The webview never sees a token or a key.
- Events Rust → webview: `remote://watch` (tab ids phones need, empty while no phone is connected), `remote://action`, `remote://status` (`Status`). The webview calls `remote_ready(true)` only after its listeners exist; Rust resets readiness on page load and closes phone sockets with 4503 while the webview is not ready.

## Commands and `Status`

`remote_status`, `remote_interfaces`, `remote_apply_settings` (always the **complete** `RemoteSettings`: enabled, interface name, port, host name, cert `generated | files{cert,key}`, push{enabled, questions, finished, onlyWhenLocked, contact}), `remote_pair_start` (→ `{url, svg, expiresAt}`), `remote_pair_cancel`, `remote_device_rename`, `remote_device_revoke`, `remote_regenerate_cert`, `remote_push_test`, `remote_default_contact` (global git `user.email`), `remote_publish`, `remote_action_result`, `remote_ready`.

`Status` carries `enabled`, `listening`, `url`, `ip`, `error`, `fingerprint`, `pushError`, `lockDetection` (whether this platform can tell a locked desktop: macOS, Windows, Linux), `devices[{id,name,pairedAt,lastSeen,connected,pushSubscribed}]` and the saved `settings`, so the Settings rows prefill from it and refresh on every `remote://status`.

## Pairing and auth

- Settings → "Pair a phone…" calls `remote_pair_start`: a 128-bit random code, one use, valid 5 minutes, in memory only; a new code replaces the old. The QR (SVG, shown as `<img src="data:image/svg+xml;base64,…">`, never injected HTML) encodes `https://<host>:<port>/#pair=<code>`. The fragment never reaches the server logs; the page POSTs it to `/pair` (body ≤ 4 KiB) and removes it from the URL.
- iOS gives a home-screen web app its own storage, so a token paired in Safari is not visible in the installed app. When the installed app has no token, it shows a **"Pair with your desktop"** button that opens the rear camera (`navigator.mediaDevices.getUserMedia({ video: { facingMode: "environment" } })`), streams into a muted, `playsinline` `<video>`, samples frames to a `<canvas>` ~8 times per second and decodes them with the vendored **jsQR** library. Only a URL whose `origin` equals `location.origin` and whose fragment is `#pair=<code>` is accepted; other QR codes show "This code is for another server". Accepted codes stop the camera tracks and run the same `POST /pair` flow as the Safari link path. **Cancel**, the page being hidden (`visibilitychange`) and `pagehide` stop the camera too. Each stop bumps a scan generation: a `getUserMedia`/`play()` that resolves afterwards stops its own tracks and returns silently, so a late camera never leaks and a cancel never shows "camera denied"; a second tap replaces the running scan.
- The jsQR file is `src/remote/jsQR.js`, served at `/jsQR.js`, with a license/provenance header noting version and SHA-256.
- Failed pairing attempts: 5 per minute per peer IP, then HTTP 429.
- The device token is 32 random bytes (base64url), returned once; only its SHA-256 hex is stored and it is compared in constant time. The phone keeps it in `localStorage`.
- WebSocket `/ws`: the first frame must be `{"t":"auth","token":…}` within 5 s, else close 4401. A revoked token closes with 4401 and the page forgets it. Max 4 sockets per device (4429), 8 in total.
- DNS-rebinding guard: `Host` must equal `<ip>:<port>` or `<host name>:<port>`; a WebSocket `Origin` must equal the matching `https://…`. An `http://` origin is always refused. Anything else is 403 before any handler runs.
- The server binds only the IPv4 of the interface chosen **by name**, never `0.0.0.0`/`::`; a changed or vanished interface IP rebinds or stops it. Unix uses `getifaddrs`; Windows uses `GetAdaptersAddresses(AF_INET)` and its UTF-16 friendly names (for example, `Ethernet` or `Wi-Fi`). Both list only up, non-loopback interfaces with non-loopback, non-wildcard IPv4 addresses; Windows also excludes tentative, duplicate and invalid addresses. VPN/tunnel adapters remain eligible. Renaming the selected adapter requires selecting its new name in Settings.

## TLS and certificates

- **Generated** (default): `rcgen`, SAN = current IP + host name (if set), 2 years, `serverAuth` extended key usage (iOS and Android refuse a leaf without it), stored as `remote/cert.pem` + `key.pem` (0600) with a `cert.json` recording the SAN set; regenerated when IP or host name changes, shortly before expiry, or on "Regenerate". A generated certificate is self-signed: a phone has to accept it, and a home-screen web app with Web Push will not work with it.
- **Own files**: PEM certificate + private key paths (Settings has text fields; there is no file picker). The certificate must cover the host name (carrying `serverAuth` is recommended; phones may refuse a leaf without it, but it is not checked), else the server refuses to start with that reason.
- The SHA-256 fingerprint of the served leaf shows under Settings → Certificate.
- Recipe used by the maintainer: a mkcert wildcard certificate for `*.home.lan` (the mkcert CA is installed and trusted on the phone), a DNS record `omp.home.lan` → the Mac (AdGuard DNS rewrite), host name `omp.home.lan` in Settings, "own files" with the wildcard cert and key. The phone then opens the page without warnings and push works.
- There is no plain-HTTP mode: the server always speaks TLS, so pairing codes and tokens never cross the network unencrypted. A legacy `allowHttp` setting is ignored when loading `remote.json` and omitted on the next save; it cannot enable plaintext.

## Tracker (`tracker.rs`)

Per omp session, independent of the active webview tab: `busy`, `turn_started`, and the set of open question ids. The stdout reader hands its already parsed frame to `tracker().on_frame` before publishing it in the journal or recording extension UI, so replay cannot expose a question before the tracker knows it.

- `agent_start` sets busy and starts the turn clock (a continuation keeps the first start).
- `agent_end` counts only when it yields control: `yielded`, else `isTerminal`, else yes. An `agent_end` that continues into another run changes nothing. A yielding end clears busy and every open question and reports the turn's duration.
- `extension_ui_request` with `select`, `confirm`, `input`, `editor` **or `ask`** and a string id (≤ 256 bytes) opens a question; a duplicate id opens nothing. At most 64 open questions per session.
- `extension_ui_request` with `method: "cancel"` and a `targetId` (omp itself withdrawing a dialog) closes that question.
- An answer written and flushed by `AgentBridge::send` / the approval-and-grant path removes the id (`on_answered`); process exit, stop and replacement remove the session. Auto-approved tool prompts and retired readers are excluded.
- **The hook must stay O(1) and non-blocking**: stream deltas and non-dialog traffic classify to `None` and take no lock; question membership is a hash set; the sink is called with both mutexes released and must only enqueue (transport and push belong to the manager's worker).

## Publisher (webview)

`use-remote.jsx` subscribes to `OMP_BRIDGE.onUpdate` and the `remote://` events and publishes through `remote_publish`:

- `tabs` (id, title, project = the folder's basename only, never the full path, plus `busy`/`hasAsk`) whenever the server is listening; `view` only while at least one device is connected, otherwise `view: null`; `theme` (`{id, tone, accent}` from the active tweaks) on every publish and whenever tweaks change. They are compared separately; an equal payload is not sent.
- Throttle: at most 4 publishes per second, full replacement each time. A publish that Rust rejects is not remembered, so the next change sends again (no retry loop).
- `buildView` (`remote-view.js`) maps the UI transcript (not omp's raw shapes): last 100 messages, tool output cut at 2 000 characters (never inside a surrogate pair), thinking dropped, a user message omp echoes back later (a steer) flagged `echo`, rows hidden by `OMP_TURN_STATUS.isHidden` and empty notices skipped, a text-less assistant bubble with a `failure` shown as a notice (`headline ?? raw`), open asks as cards. No active tab → `view: null`.
- The executor (`makeActionHandler`) serialises actions, activates the tab first (failure → "tab not available"), waits up to 5 s for an ask to appear after a switch ("question no longer open" otherwise), validates the phone's value (confirm boolean; select one of the options; input/editor string; dialog an array of objects with array `selectedOptions`; prompt/steer a non-blank string; else "invalid answer" / "invalid text") and reports with `remote_action_result`. A prompt while the agent streams is a steer.

## Protocol and limits

Server → phone: `hello {deviceId,name}`, `tabs`, `view`, `theme {id,tone,accent}`, `ack {reqId,ok,error?}`, `push-key {key}`. Phone → server: `auth`, `select {tabId}`, `action {reqId,tabId,kind,…}` (`prompt`, `steer`, `abort`, `answer`), `push-subscribe {sub}`, `push-unsubscribe`.

- Frames ≤ 1 MiB, text ≤ 32 KiB, binary refused (1003); outbound queue of 64 per socket (a full queue closes 1013).
- An action the desktop does not answer within 15 s gets `ack {ok:false, error:"desktop did not answer"}`.
- Static assets are embedded, `Cache-Control: no-store`, CSP `default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; connect-src 'self'; frame-ancestors 'none'`. The phone's capabilities are limited to prompt, steer, abort, answer and tab select.
- The phone page loads `marked.min.js`, then `highlight.min.js`, then `marked-setup.js`, then `accent.js`, `scroll-pin.js`, `jsQR.js`, `client.js`, `scanner.js`, `sessions.js`, `transcript.js` and `remote.js`. It also loads the desktop's `styles.css` plus `chat.css`, `ask.css` and `composer.css`; `remote.css` only supplies mobile layout. The page applies the desktop theme class and accent tokens when it receives the `theme` frame, so it looks like the desktop. Only assistant markdown reaches `innerHTML`; everything else is `textContent`. `marked-setup.js` installs its HTML escaping only when `window.hljs` exists, so a page without highlight.js would render raw HTML (and the page holds the device token): `client.renderMarkdown` throws instead.
- `?tab=<id>` (from a push tap) selects once on the first connection; later reconnects follow the current selection. Tool `<details>` stay open by message id across view updates. `dialog` asks render per question with option buttons and a custom input and answer `[{id, selectedOptions, customInput?}]` like `answerAskDialog`.
- **Layout, header and session sheet**: the page is a column: a fixed header, the scrolling transcript, the fixed composer (safe-area insets, `viewport-fit=cover`, height follows `visualViewport` under the keyboard). The header is one button (`aria-haspopup="dialog"`, `aria-expanded`): the active tab's title, its folder name, the desktop's run dot (accent pulse running, amber `?` question), a count badge of *other* tabs with open questions, ▾ and a connection dot. Tapping it opens a bottom sheet (`role="dialog"`, `aria-modal`, focus moves in and back) listing all tabs with folder and dot, the active one highlighted; it closes on backdrop tap, handle tap or swipe down, Esc, or selecting a tab (which sends `select` with a `reqId`). Its footer holds the "OMP Remote" label, the connection text and the notifications control. Helpers `projectName`/`otherQuestionCount` live in `client.js`.
- **Scroll pinning**: the page serves and uses the desktop's `app/scroll-pin.js` (`/scroll-pin.js`, loaded after `accent.js`). Opening a tab (a view for a different tab id) or sending a prompt jumps to the end; while pinned, new content keeps the end in view; scrolling up unpins, keeps the offset across transcript rebuilds and shows a "↓ Newest" button that pins and jumps back. The decisions are the desktop's `OMP_SCROLL_PIN.nextPinned`/`shouldRepin`/`afterOutput` (tested in `tests/test-scroll-pin.mjs`); a steer echoed back by omp (`echo` on the view's user message) does not move a reader. `transcript.js` only measures and scrolls. Only rows not on screen before play the fade-in (messages keyed by `id`, else role plus a text hash; open asks keyed `ask:<id>`), so streaming and ask rebuilds do not blink the transcript.
- **Composer and resize**: a messenger bar (`.remote-composer`): one rounded field growing from one line to about five (then it scrolls) and one round button, about 52 px high when empty plus the safe-area inset. Return inserts a newline (`enterkeyhint="enter"`, no send on Enter). `C.composerAction({ busy, draft })` picks the button: idle → `send` (↑, `prompt`; disabled while the draft is blank); running with a non-blank draft → `steer` (↑, accent); running with an empty or whitespace-only draft → `stop` (■, red, `abort`). The placeholder is "Message…" or "Steer…" and the `aria-label` follows the state. A `ResizeObserver` on the scroll box keeps a pinned reader at the newest message when the box shrinks (keyboard, growing draft, rotation). `buildView` flags `idSynthetic: true` only on a message with neither a real id nor a `ts` (its id is derived from the list index, which shifts); such rows are keyed by role plus text hash for the fade-in. A row with a `ts` keeps its stable `<kind>:<ts>` id as key, so a streaming reply does not replay the fade on each update.

## Web Push

- Triggers (Settings): a question opened (immediately) and a turn finished (only if it ran ≥ 30 s). At most one push per tab per 30 s; the notification `tag` is the tab id. Title `OMP · <tab title>`, body `Question waiting` / `Finished`; no transcript text. `TTL 3600`, urgency high (question) / normal (finished).
- **Only while locked** (`PushSettings.onlyWhenLocked`, default off; `Status.lockDetection` tells the Settings page whether to show the switch — macOS, Windows and Linux): the push worker asks `lock::screen_locked()` right before it delivers a question or finished push, not when it is queued. Locked → send; unlocked → drop silently (no retry, and the tab's 30 s throttle slot is given back, so a later push for the same tab is not held off); unknown (`None`, other platforms) → send. "Send test notification" ignores the setting. The probe per platform:
  - macOS: `CGSessionCopyCurrentDictionary` carries `CGSSessionScreenIsLocked` only while the session is locked.
  - Windows: `WTSQuerySessionInformationW(WTSSessionInfoEx)` for the app's own session; `SessionFlags` `WTS_SESSIONSTATE_LOCK` → locked, `…_UNLOCK` → unlocked, `…_UNKNOWN` → unknown.
  - Linux: systemd-logind's (or elogind's) `LockedHint` of `/org/freedesktop/login1/session/auto` over the system bus (zbus, 2 s call timeout; a new connection per probe). No logind or no session → unknown. The hint is set by the screen locker (GNOME, KDE Plasma, and others that call `SetLockedHint`); a locker that never sets it leaves `false`, so with such a locker every push is dropped — the switch only makes sense with a locker that reports to logind. Check with `loginctl show-session auto -p LockedHint` while locked.
- Needs the VAPID key (generated in the app config dir) and a **real contact** (`mailto:` or `https:`) in Settings; Apple rejects placeholders with 403 `BadJwtToken`. A bare email becomes `mailto:`; the validator checks the complete local part and domain. The Settings row prefills it from global git `user.email`. Without a valid contact nothing is sent and `Status.pushError` says why.
- Subscriptions come from the page (`push-subscribe`, after a user gesture in the home-screen app); the page registers `/sw.js`, which shows the notification and on tap focuses or opens `/?tab=<id>` (`clients.claim()` on activate; `navigate` rejecting falls back to `openWindow`).
- **Endpoint allowlist**: a subscription is only stored for `https` endpoints on `fcm.googleapis.com`, `updates.push.services.mozilla.com`, `*.push.apple.com` and `*.notify.windows.com`, so a paired phone cannot make the desktop send requests to arbitrary hosts. 404/410 from the push service deletes the subscription.
- Earlier spike evidence (not feature acceptance): push delivery worked once with a certificate the phone trusts (the mkcert wildcard above, iOS 18.7 home-screen app). Real-phone acceptance of this feature is still pending. `PushManager` exists only in the home-screen app, not in a normal Safari tab.

## Security model

- A paired phone is trusted with the capabilities above and nothing more; it never gets a Tauri bridge. Without a token, network clients can fetch the static phone page and attempt pairing, which requires the one-use code and is rate-limited per peer. Unauthenticated WebSockets close with 4401; Host/Origin checks and connection, frame, body and deadline limits apply before privileged actions.
- Tokens: hashed at rest, constant-time compare, revocable per device (Settings → Paired phones; revoking drops its sockets and push subscriptions).
- Attack surface limits: one interface, bounded connections, bounded frames, rate-limited pairing, DNS-rebinding checks, CSP, no inline script.
- Secrets (`remote.json`, `remote-devices.json`, `cert.pem`, `key.pem`, VAPID key) are written with mode 0600 on Unix; on Windows they inherit the per-user app config directory's ACLs.
- Phone actions run serially in the desktop webview. Each carries its device id and Rust dispatch timestamp; age uses the earlier of that timestamp and the frontend enqueue time. Before running, and again after every wait (tab switch, the 5 s ask wait), the executor requires the server to listen, the device to be paired and connected, and the action to be at most 15 s old (the Rust ack timeout). Otherwise it acks `ok:false` (`remote access disabled`, `device revoked`, `expired`). At most 16 actions wait; more are acked `busy`. The ack reports the IPC hand-off: `send`, `steer`, `abort` and the answer methods resolve to a boolean, and `false` or a rejection acks `desktop could not deliver`.

## Limits

- Supported on Windows, Linux and macOS. Windows Firewall may need permission for the app's incoming connections on the chosen network; the app does not add firewall rules or request elevation.
- The phone tab is the desktop tab: only the desktop's active tab has a live view, and a phone selecting a tab switches the desktop.
- Push has only been verified with a certificate the phone trusts.
- The phone page has no file picker, attachments, model switching or settings.

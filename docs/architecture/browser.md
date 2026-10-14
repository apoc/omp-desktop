# Browser panel

One desktop tab owns one headless Chromium, shared by its omp agent and the browser panel. Rust owns the process, CDP connections, page selection, screencast and annotation overlay. The app webview only paints images and forwards input: browser pages never load in it.

## Modules and data flow

| File | Responsibility |
|---|---|
| `src-tauri/src/browser/mod.rs` | `BrowserManager`, per-tab placeholder ports, settings overlays, lazy launch slots and teardown |
| `browser/locate.rs`, `browser/launch.rs` | Find Chromium; launch and supervise its process tree and throwaway profile |
| `browser/proxy.rs`, `browser/tap.rs`, `browser/ws_frames.rs` | Agent-facing CDP proxy, read-only intent observer and bounded WebSocket decoding |
| `browser/cdp.rs` | Browser-level CDP client, flattened page sessions, request/reply matching and disconnect notification |
| `browser/view*.rs`, `browser/emit.rs` | Page discovery, agent-follow, viewport, screencast, ordered input and event payloads |
| `browser/annotate.rs`, `browser/overlay.js` | Isolated-world overlay, validated picks, clean PNG capture and document-coordinate scrolling |
| `browser/commands.rs`, `src-tauri/src/lib.rs` | Tauri commands; session allocation and app shutdown integration |
| `src/live.js` | Browser command/event bridge and release on desktop-tab close |
| `src/app/browser.js` | Pure URL, input, coordinate, chip, message-merge and width helpers |
| `src/app/browser-screen.js`, `src/app/use-browser.jsx` | Canvas decoding/painting and DOM input; view lifecycle, events and per-tab chips |
| `src/design/browser-{dock,panel,toolbar,chips}.jsx`, `src/design/layout/browser.css` | Resizable/full-view dock, page tabs, controls, annotation popover and chips |

```text
start_session -> BrowserManager.allocate -> private settings overlay
             -> omp --config=<overlay> (browser.cdpUrl = placeholder URL)

omp browser tool -> loopback placeholder proxy -> Chromium CDP
                            |
                     read-only tap -> last agent target -> panel view

app controls -> live.js -> Tauri browser_* commands -> view -> Chromium CDP
Chromium screencast / state / picks -> browser:// events -> useBrowser
                                   -> canvas / toolbar / annotation chips
chips + draft -> app-live.jsx -> omp prompt (text + captured images)
```

The panel connects directly to Chromium's own debugging port, not through the proxy. Its own input and screenshots therefore do not look like agent intent to the tap.

## Placeholder port and lazy launch

`start_session` allocates a browser entry before spawning omp. Allocation binds `127.0.0.1:0` and exclusively creates `<app cache>/browser/<pid>/<session_id>.yml` containing only:

```yaml
browser:
  cdpUrl: "http://127.0.0.1:<placeholder port>"
```

`agent/spawn.rs::omp_args` appends the single token `--config=<path>` **last**, after profile/resume/cwd and `--approval-mode=write`. Preserve this overlay order and its browser-only contents: the tab must use the managed endpoint without replacing its normal profile settings or changing approval policy.

Allocation does not launch Chromium. The first proxy request or `browser_open_panel` calls the tab's `Slot::ensure`. Its per-tab lock prevents duplicate launches without blocking other tabs. The placeholder port stays stable across Chromium restarts; `/json*` discovery replies rewrite upstream loopback WebSocket URLs to that port. WebSocket upgrades and traffic are otherwise spliced byte for byte. Launch failure returns HTTP 503; an upstream connection failure returns 502.

Before lazy launch or forwarding, `/json*` requests require exactly one well-formed `Host` naming `127.0.0.1`, `localhost` (case-insensitive), or `[::1]`, with an optional numeric port. Missing, duplicate, malformed or foreign authorities and absolute-form request targets return HTTP 403 without launching Chromium. Only validated discovery requests may have their Host rewritten to Chromium's port; WebSocket upgrade heads are forwarded unchanged.

Binary lookup tries the configured path, native-platform Chrome for Testing builds under `~/.omp/puppeteer/chrome` (newest first), then installed Chrome/Chromium/Edge candidates. The app does not download Chromium. Tweaks → Browser passes the preferred path with the next `start_session`; a running Chromium is not replaced by a preference change. If manager allocation fails, omp still starts without the overlay and uses its own browser configuration; the desktop panel has no managed browser for that tab.

## Launch flags

`launch.rs` starts Chromium with:

- `--headless=new`: rendering without a separate browser window.
- `--remote-debugging-port=0`: Chromium chooses a free loopback CDP port, read from the fresh profile's `DevToolsActivePort` (10-second startup timeout).
- `--user-data-dir=<private throwaway profile>`: no reuse of the user's normal browser profile.
- `--no-first-run`, `--no-default-browser-check`, `--disable-background-networking`: suppress first-run/default-browser flows and background browser networking, not page networking.
- `--window-size=1280,800`: initial size; opening/resizing the panel applies CDP device metrics with its CSS width, height and DPR.
- `--use-mock-keychain --password-store=basic`: keep this disposable profile away from the OS keychain/keyring, avoiding repeated macOS “Chromium Safe Storage” prompts. This is not an encrypted persistent credential store.
- `about:blank`: initial page.

Child PATH resolution uses `child_path::apply_child_path`; process-tree supervision uses the same process-group/Windows Job Object machinery as agent children. No `--no-sandbox` flag is added.

## Agent-follow: intent, not attachment

Each agent proxy connection has a read-only tap. For a page-level WebSocket it knows the target from `/devtools/page/<id>`; for a browser-level connection it maps flattened `sessionId` values to page `targetId` values from attach replies/events. Non-page sessions are excluded when identified by the event.

Follow signals are `Target.activateTarget`, successful `Target.createTarget`, `Page.navigate`, `Page.reload`, `Page.navigateToHistoryEntry`, `Page.bringToFront`, `Page.captureScreenshot` and `Input.*`. **Attachment is bookkeeping, not intent**: Puppeteer can remain attached to every page, so following `Target.attachedToTarget` or an attach reply would pick arbitrary pages rather than the page the agent actually uses.

The entry remembers the last reported target even while the panel is closed. Opening starts there if it still exists, otherwise on the newest discovered page (creating `about:blank` if needed). A user's page-tab selection/new/close holds their choice for five seconds before agent-follow resumes. Pending follow reports coalesce to the latest target and can wait for discovery.

The splice queues observed chunks before forwarding them to preserve command/reply causality, but **never waits for parsing or the follow callback**. A bounded `try_send` feeds a separate observer thread. A full queue, malformed framing, failed upgrade, negotiated WebSocket extension (including permessage-deflate), or observer failure disables tapping for that connection and logs why; forwarding continues unchanged. The tap must never block or alter the splice.

## View, frames and input

A view uses one browser-level CDP socket with `Target.attachToTarget { flatten: true }`. It discovers page targets and attaches to the page being shown. A switch releases the old overlay, stops its screencast and detaches it, then enables the new page and installs its overlay. Viewport changes restart JPEG screencasting (quality 70). Every frame is acknowledged promptly so Chromium keeps sending. Rust keeps the latest queued frame; activation generations reject old-page frames and queued input after a page switch.

`browser-screen.js` decodes JPEGs with `createImageBitmap`, drops superseded frames and paints on a DPR-sized canvas. Events carry both image pixel dimensions and page CSS dimensions; marker geometry is published with the bitmap actually painted. Resizes are debounced; pointer coordinates map through frame CSS dimensions rather than canvas backing pixels. Mouse moves are coalesced and flushed before a press/release. Rust's synchronous `browser_input` only queues work, preserving IPC input order; other commands run blocking CDP work off the IPC thread.

The page receives mouse, wheel, key and plain-text paste input. Logical letter keys determine virtual key codes on non-US layouts. Desktop-bound shortcuts remain app actions; Esc leaves annotate mode when its comment popover is not open. `useBrowser` installs event listeners before opening the view, queues initial URL/resize requests until opening settles, and disposes listeners, bitmaps and the view when leaving the panel or switching desktop tabs.

## Annotation overlay and binding contract

`annotate.rs` installs `overlay.js` **per attached page session**, not just once per browser. `Runtime.addBinding` exposes `__ompAnnotate` only in the isolated execution-context world named `omp-annotate`. `Page.addScriptToEvaluateOnNewDocument` uses that world and `runImmediately: true` for the existing document and future navigations. Context-created events apply the current annotate flag; release forgets contexts and turns the overlay off before detach.

The script ignores subframes, uses a closed-shadow overlay host and installs capture-phase pointer/mouse listeners. Annotate mode suppresses page click/hover handling but leaves scrolling and keys available. A left click picks an element; a drag over four CSS pixels picks an area. Rendering must stay **CSSOM-only** (`element.style`, `textContent`): no style elements, inline-style attributes or HTML strings. This keeps the overlay working with strict page CSP and Trusted Types.

`__ompAnnotate(JSON.stringify(payload))` carries:

- `kind`: `element` or `area`.
- `rect`: viewport CSS pixels `{ x, y, w, h }`; `docRect`: the same box plus page scroll at pick time.
- `url`: page URL.
- Element-only `selector`, `tag`, `html`, `text`; areas carry null element fields.

Selectors prefer a unique escaped id, then unique `data-testid`, then at most six ancestor segments. Tags and classes are CSS-escaped; `:nth-of-type` disambiguates same-tag siblings still matched by the tag/class segment. HTML/text are bounded to 20,000/500 UTF-16 units without splitting surrogate pairs. Rust accepts only the named binding from a tracked isolated-world context of the active page, bounds the JSON payload to 256 KiB and fields, and rejects invalid/non-finite rectangles or unknown kinds. Page scripts cannot directly call the isolated binding, but DOM content remains untrusted.

`browser_capture` takes the viewport rect, adds current page scroll and requests a PNG clip. It hides the overlay for capture and restores it even on a screenshot error, unless a newer user toggle or close superseded it. Captures require sides from 1 to 8192 CSS pixels. A failed capture still permits a text annotation and shows a failure note. Chips retain `docRect` for scrolling back to the pick when the panel still shows the same URL.

## Commands and events

Every command identifies the desktop tab with `sessionId` (not the Chromium page `targetId`). Commands are registered in `lib.rs`; panel commands live in `browser/commands.rs`.

| Command | Additional arguments / result |
|---|---|
| `browser_open_panel` | `width`, `height`, `dpr`; ensure Chromium, discover pages, start view |
| `browser_close_panel` | Stop/detach view; leave Chromium alive |
| `browser_resize` | `width`, `height`, `dpr` |
| `browser_navigate` | `url` (toolbar reload navigates to the current URL) |
| `browser_history` | Signed `delta` |
| `browser_tab_new` | No additional arguments; opens `about:blank` |
| `browser_tab_close`, `browser_tab_activate` | `targetId` |
| `browser_input` | Tagged `event`: `mouse`, `wheel`, `key`, or `text` |
| `browser_annotate` | Boolean `on` |
| `browser_capture` | Viewport `rect`; returns `{ data, mimeType: "image/png" }` |
| `browser_scroll_to` | Document `rect` |

| Event | Payload |
|---|---|
| `browser://frame/{sessionId}` | `{ b64, w, h, cssW, cssH }`, base64 JPEG |
| `browser://tabs/{sessionId}` | `{ tabs: [{ targetId, title, url, active }] }` |
| `browser://state/{sessionId}` | `{ status, error, url, loading, canBack, canForward }`; status `idle`, `starting`, `running`, `stopped`, or `error` |
| `browser://pick/{sessionId}` | Pick payload above |

Saved chips are per desktop tab. `app-live.jsx` merges their comment, URL, selector and bounded HTML into send/steer/follow-up/goal prompts and adds their PNGs subject to the shared eight-image cap. Excess screenshots are reported, while annotation text still goes out. Submission reserves chip ids synchronously, excluding them from concurrent sends; prompt acknowledgement spends exactly those chips, and refusal, timeout or missing connection releases them. New chips made during a send remain available.

Page-derived fields are labeled as untrusted data and wrapped with `OMP_MARKDOWN.fenceCode`, using a backtick fence longer than any run inside those fields. Page `/skill:` tokens and line-leading slash commands are escaped because omp's command parser does not honor Markdown fences. The user's comment remains outside that block, and command classification uses only the user's typed text before annotations are merged.

## Lifecycle

- Startup prepares `<app cache>/browser/<pid>/`. Unix directories are created with `0700`, overlay files with `0600` and exclusive creation; session ids are restricted before becoming filenames. The cache root and instance path must be real directories, not symlinks. Each launch uses `profiles/<session_id>-<launch number>` and records its browser PID next to the profile as `<profile>.pid`, created exclusively with `0600` on Unix and removed after reaping.
- Best-effort stale cleanup on macOS/Linux first kills orphaned browser process groups of dead instances, then deletes their instance directories. A recorded PID is targeted only if it is alive, leads its own process group, and its command line contains `--user-data-dir=<profile path>` bounded by start/end, NUL or ASCII whitespace. Linux reads `/proc/<pid>/cmdline`, accepting both NUL-separated argv and Chromium's rewritten space-joined process title; macOS reads `/bin/ps -o command= -p <pid>`. Nonmatching commands and live desktop instances are not signaled. Cleanup sends `SIGKILL` to the verified group and waits up to two seconds for its leader to disappear; if it remains alive, the directory is retained rather than deleted under a running browser. Windows skips orphan reaping and cannot currently prune dead instances because its PID-liveness check conservatively treats every PID as live. Graceful desktop quit already kills/reaps browsers before removing their profiles and PID files.
- Closing the panel or switching desktop tabs ends only the view. Browser pages continue running; panel-open state and chips remain per tab in React memory.
- An omp profile switch respawns the agent with the same tab overlay and browser. `stop_session` must not release Chromium.
- After a Chromium crash the view reports stopped. Panel reload/reopen or the next agent connection launches a fresh throwaway profile behind the existing placeholder port; old page state is lost.
- Desktop-tab close calls `live.js::_closeTab` / `close_tab`; reload cleanup uses `close_all_tabs`. Both release each tab's browser as well as its agent, widgets, git watcher and terminal. Only `close_tab` / `close_all_tabs` and app-wide `kill_child_processes` end a tab's browser. Release marks the slot closed, closes the view and proxy sockets, waits out an in-flight launch, kills/reaps Chromium's process tree, and removes its profile and overlay. Concurrent release callers wait for teardown; shutdown includes releases already in flight.
- `BrowserManager::Drop` calls `shutdown_all`, which waits for every entry's teardown and removes this process's `<root>/<pid>` directory, including empty profile containers. App exit and updater relaunch explicitly call `kill_child_processes`, killing agent trees first, browsers second, widget plugins third and terminal shells last; these paths cannot rely on managed-state destructors running.

## Security model and known limits

The proxy and Chromium CDP endpoint are loopback-only, not network services. **Any local process of the same user can reach the CDP port.** There is no CDP authentication or per-process authorization; loopback is not a boundary against other local processes. Private files/profiles protect their filesystem contents, not socket access. Do not expose or tunnel either debugging port.

Agent actions still go through omp's normal tool approval flow (`--approval-mode=write`); the desktop proxy does not approve, filter or reinterpret tool calls. Manual panel controls are direct user actions, not agent tool calls. Chromium executes remote pages separately from the Tauri app webview: the webview receives image frames and bounded pick metadata, never page scripts. Pick HTML is prompt text, not app markup. Screenshots, DOM snippets and URLs may contain sensitive page data; sending an annotation intentionally includes that data in the agent prompt.

Limits:

- Requires a compatible installed Chromium; real-browser Rust tests skip when none is found. No bundled browser or downloader.
- Fresh profiles mean no normal-browser cookies/logins/extensions and no browser-state persistence across tab close, crash or app restart. Pending annotation chips and panel-open state are in-memory only.
- Headless screencast/input is not a native browser surface: no native browser chrome, file-picker/download management, audio forwarding or full IME composition path. Paste forwards plain text only.
- Annotation targets are the top-level DOM, not elements inside iframes or shadow roots. Selectors are bounded best-effort hints; page mutation can invalidate them.
- Saved boxes are snapshots, not live DOM tracking. Markers use pick-time viewport coordinates and match by URL; chip scrolling uses pick-time document coordinates only on the currently shown matching URL, without reopening a page or selecting its original target.
- Follow is limited to observed intent commands through the proxy. WebSocket extensions, overload or unsupported framing can disable it for a connection without affecting agent traffic. Local processes using the proxy are indistinguishable from the agent to the tap.
- Orphan identity checks cannot recover original argument boundaries from Linux's rewritten process title or macOS `ps` output. `--user-data-dir=.../s1-0 x` matches `.../s1-0` because space is a delimiter, unlike `.../s1-01` or `.../s1-0-other`. Generated session/profile basenames contain no spaces, but the OS-provided cache root (including a macOS home directory) can contain spaces; there is no enforced space-free full-path invariant. Matching includes any spaces inside the requested full path, but cannot distinguish a separate argument from a different profile path with an appended whitespace suffix. Reaping remains best-effort, not a guarantee of exact argv identity.

Regression coverage: `browser::annotate` (including strict CSP, navigation/tab switching, clean/scrolled capture, Unicode boundaries and namespaced-looking tag siblings), the browser proxy/tap/view Rust suites, and `tests/test-browser*.mjs` in `npm test`.

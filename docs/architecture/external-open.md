# OS folder opens ("Open with OMP Desktop")

`src-tauri/src/external_open.rs` + `src-tauri/packaging/`. Three delivery paths, one queue:

|Platform|Delivery|Registration|
|---|---|---|
|macOS|`RunEvent::Opened { urls }` (hence `run()` ends in `build().run(cb)`, not `Builder::run` — `RunEvent` needs a callback)|`src-tauri/packaging/Info.plist`: `CFBundleDocumentTypes` / `LSItemContentTypes = public.folder`, rank `Alternate`|
|Windows|Executable launched with the folder in argv; forwarded to the running instance by `tauri-plugin-single-instance`|`src-tauri/packaging/windows-folder-verb.nsh` (NSIS) + `.wxs` (MSI): `Directory\shell` and `Directory\Background\shell` verbs, command `"<exe>" "%V"`|
|Linux|Same as Windows|`src-tauri/packaging/omp-desktop.desktop`: `MimeType=inode/directory` + `%F` on `Exec`|

`bundle.fileAssociations` cannot express any of this — it is keyed by file extension (`ext` is required) and a folder has none.

Requests land in `OpenProjectState` (capped at 32) and are announced with a payload-free `open://project` event. The **queue is the source of truth**: `take_pending_open_projects` empties it, so `live.js` treats the startup drain and the event handler as the same idempotent call — no request ids, no acknowledgement. `_drainExternalOpens` serialises drains (each open switches the active tab) and isolates each open so one failure cannot discard the rest of an already-taken batch. An event that arrives while the guard is up sets `_externalOpenWake` instead of being dropped, and the drain owes one more `take` before it may stop: the lossy window is *not* synchronous — Rust empties the queue when `take_pending` releases its mutex, but the guard clears only once the IPC response is back in JS, and an event travelling the other channel can overtake that response. A failed `take` round-trip is distinguished from an empty queue (`null` fallback) and leaves the folders queued for the next event. The drain is armed only after the profile list has settled (`_refreshProfiles().finally(_setupExternalOpens)`): earlier, a cold-start open would spawn under the provisional built-in profile instead of the ticked startup one. A failed open files its note in the empty workspace when no tab exists.

Paths are canonicalised in Rust (`canonical_folder`) before they reach the frontend: they arrive from argv/LaunchServices and become an omp `--cwd`, a git-watch root and a tab label. Non-directories and missing paths are logged and dropped; the Windows verbatim `\\?\` prefix is stripped (`gix` and omp choke on it). A *relative* argv path is joined onto the directory its argv was produced in — the single-instance plugin's `cwd` for a forwarded open, this process' own for a cold start — because `canonicalize` alone resolves against the running instance's cwd, so `omp-desktop .` in another shell would open the wrong folder.

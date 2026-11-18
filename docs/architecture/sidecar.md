# Persona sidecar (`omp-desktopd`)

The desktop app enables Ompy by running the persona service as an installed login entry and talking to it over its local socket (`docs/architecture/persona-daemon.md`). Release bundles ship that service as a Tauri **external binary**, so `OMP Desktop.app` is self-contained and `Settings → Persona` works on a machine that has no Rust toolchain.

## Build and staging

`scripts/build-sidecar.mjs` (npm: `npm run build:sidecar`):

1. resolves the target triple — `--target <triple>`, else `TAURI_ENV_TARGET_TRIPLE` (the Tauri CLI exports it to `beforeBuildCommand`; a release matrix job cross-building macOS x64 on an arm runner must stage the x64 file), else the `host:` line of `rustc -vV`;
2. runs `cargo build --release -p omp-desktopd` in `src-tauri/` (`--target <triple>` only when a target was given, so the profile directory matches);
3. copies the built binary to `src-tauri/binaries/omp-desktopd-<triple>` (`.exe` appended on Windows), which is Tauri's externalBin naming.

`src-tauri/binaries/` is gitignored: it holds build output, not sources. `src-tauri/tauri.dist.conf.json` declares `bundle.externalBin: ["binaries/omp-desktopd"]` and runs the script from `beforeBuildCommand` (after `scripts/build-frontend.mjs`), so `npm run build` and `release.yml` (both pass `--config src-tauri/tauri.dist.conf.json`) stage the right binary before the bundle is assembled. CI needs no extra step: the workflow's Rust toolchain builds the workspace member as part of the app build anyway.

## Runtime installation and updates

`persona::sidecar::path()` locates the bundled source beside the running app executable (`std::env::current_exe()`):

- **bundled** (`OMP Desktop.app/Contents/MacOS/`, the Windows install folder, the Linux `bin/`): `tauri build` copies the staged external binary into that directory under its plain name, `omp-desktopd[.exe]`, next to `omp-desktop[.exe]`;
- **`tauri dev`**: the app runs from `src-tauri/target/debug/`, so the same lookup resolves `src-tauri/target/debug/omp-desktopd`. Build it once with `cargo build -p omp-desktopd` (or `cargo build --workspace`); `tauri dev` does not build the sidecar itself.

Enabling Ompy does **not** register that bundle path: AppImage mount directories and macOS App Translocation paths disappear or change. The app atomically copies the binary through a temporary file in the destination directory into the stable per-user location, verifies its SHA-256 against the bundle, then runs `<stable copy> install`, so the login entry points at the copy. Missing data-root ancestors are created with mode `0700` on Unix; pre-existing data roots are left untouched, and existing user-owned symlinked ancestors above the app data directory are followed by design. The app-named directory, `bin`, and the temporary/final executable are mode `0700`; existing app/bin directories are accepted only when they are non-symlinked and owned by the effective uid, and are chmod'ed to `0700` before use. `OpenOptions::create_new` plus mode `0700` makes the temp file private from creation, with no umask-dependent window. On Windows the app-named directory, `bin` and the temporary/final executable carry an explicit protected DACL that grants the current user full access, inherits into children, and has nothing inherited (`D:P(A;OICI;FA;;;<SID>)`); the directories are created with it and an existing owned directory is converted to it. A reparse point (symlink or junction) at any of the three paths is refused, and a `bin` directory or executable owned by another account is an error — the path is then not evidence of what it points at. `create_new` and the security attributes make a new temp file private from creation.

- Linux: `dirs::data_local_dir()/dev.ohMyPi.desktop/bin/omp-desktopd`, normally `~/.local/share/dev.ohMyPi.desktop/bin/omp-desktopd`;
- macOS: `dirs::data_dir()/dev.ohMyPi.desktop/bin/omp-desktopd`, normally `~/Library/Application Support/dev.ohMyPi.desktop/bin/omp-desktopd`;
- Windows: `dirs::data_local_dir()\dev.ohMyPi.desktop\bin\omp-desktopd.exe`, normally `%LOCALAPPDATA%\dev.ohMyPi.desktop\bin\omp-desktopd.exe`.

On every app start a background thread validates and secures the app/bin directories, then checks that an existing stable copy is a non-symlinked regular file (and, on Unix, current-user-owned without group/world write permission; on Windows, not a reparse point, owned by the current user and carrying the private DACL) before comparing its SHA-256 with the bundled binary. An invalid file is treated as mismatching. If the digests differ, the trusted **bundled** copy runs `status`; the pre-existing stable copy is never executed. The app atomically refreshes and verifies the stable copy, then runs `<stable copy> restart` only when status showed a running service. A disabled service is not started. On Windows a running `.exe` cannot be replaced, so the refresh runs `<bundled copy> stop` (an idempotent `schtasks /End`) before the copy and the digest check. Restart re-executes the new image on every platform: Linux probes `systemctl --user is-active` and runs `systemctl --user restart` only for an active unit; macOS uses the existing `launchctl bootout` + `bootstrap`; Windows ends the task again, recreates it, and runs it. A replacement that still fails because the file is locked surfaces in the status strip as a `refresh` error instead of only in the log.

Disabling Ompy runs `<bundled copy> uninstall` (never an unverified stable executable) and leaves the stable copy in place, dormant, for a later enable. The socket client always talks to the installed service, regardless of which one-shot CLI operation the app last ran.

## Signing

The macOS bundle is ad-hoc signed today (`bundle.macOS.signingIdentity: "-"` in `src-tauri/tauri.conf.json`). Tauri signs the external binaries of a macOS bundle with the same identity as the app — the staged file must exist before bundling, which the `beforeBuildCommand` ordering guarantees. With a real identity (`APPLE_SIGNING_IDENTITY` in `release.yml`), the sidecar is signed and notarised with the app; nothing extra is needed here. On Windows the sidecar is not Authenticode-signed separately; it ships inside the signed installer.

## Known limits

- Universal macOS builds are not supported: the script stages one target triple, so build separate arm64 and x86_64 bundles instead of a universal binary.
- `beforeDevCommand` is not set, so a dev checkout without `cargo build -p omp-desktopd` gets the app's `cannot run …` error when Ompy is enabled; build the workspace first.
- A plain `tauri build` without `--config src-tauri/tauri.dist.conf.json` embeds `src/` and has no `externalBin`, so its bundle has no sidecar; only the configured release build is meant to ship Ompy.

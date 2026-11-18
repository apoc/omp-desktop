# Persona sidecar (`omp-desktopd`)

The desktop app enables Ompy by running the persona service as an installed login entry and talking to it over its local socket (`docs/architecture/persona-daemon.md`). Release bundles ship that service as a Tauri **external binary**, so `OMP Desktop.app` is self-contained and `Settings → Persona` works on a machine that has no Rust toolchain.

## Build and staging

`scripts/build-sidecar.mjs` (npm: `npm run build:sidecar`):

1. resolves the target triple — `--target <triple>`, else `TAURI_ENV_TARGET_TRIPLE` (the Tauri CLI exports it to `beforeBuildCommand`; a release matrix job cross-building macOS x64 on an arm runner must stage the x64 file), else the `host:` line of `rustc -vV`;
2. runs `cargo build --release -p omp-desktopd` in `src-tauri/` (`--target <triple>` only when a target was given, so the profile directory matches);
3. copies the built binary to `src-tauri/binaries/omp-desktopd-<triple>` (`.exe` appended on Windows), which is Tauri's externalBin naming.

`src-tauri/binaries/` is gitignored: it holds build output, not sources. `src-tauri/tauri.dist.conf.json` declares `bundle.externalBin: ["binaries/omp-desktopd"]` and runs the script from `beforeBuildCommand` (after `scripts/build-frontend.mjs`), so `npm run build` and `release.yml` (both pass `--config src-tauri/tauri.dist.conf.json`) stage the right binary before the bundle is assembled. CI needs no extra step: the workflow's Rust toolchain builds the workspace member as part of the app build anyway.

## Where the app finds it

`persona::sidecar::path()` looks beside the running executable (`std::env::current_exe()`):

- **bundled** (`OMP Desktop.app/Contents/MacOS/`, the Windows install folder, the Linux `bin/`): `tauri build` copies the staged external binary into that directory under its plain name, `omp-desktopd[.exe]`, next to `omp-desktop[.exe]`;
- **`tauri dev`**: the app runs from `src-tauri/target/debug/`, so the same lookup resolves `src-tauri/target/debug/omp-desktopd`. Build it once with `cargo build -p omp-desktopd` (or `cargo build --workspace`); `tauri dev` does not build the sidecar itself.

The app only uses this path for the one-shot `install` / `uninstall` CLI calls behind the Persona enable switch; the socket connection then reaches the running service.

## Signing

The macOS bundle is ad-hoc signed today (`bundle.macOS.signingIdentity: "-"` in `src-tauri/tauri.conf.json`). Tauri signs the external binaries of a macOS bundle with the same identity as the app — the staged file must exist before bundling, which the `beforeBuildCommand` ordering guarantees. With a real identity (`APPLE_SIGNING_IDENTITY` in `release.yml`), the sidecar is signed and notarised with the app; nothing extra is needed here. On Windows the sidecar is not Authenticode-signed separately; it ships inside the signed installer.

## Known limits

- `beforeDevCommand` is not set, so a dev checkout without `cargo build -p omp-desktopd` gets the app's `cannot run …` error when Ompy is enabled; build the workspace first.
- A plain `tauri build` without `--config src-tauri/tauri.dist.conf.json` embeds `src/` and has no `externalBin`, so its bundle has no sidecar; only the configured release build is meant to ship Ompy.

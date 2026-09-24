//! In-app update check and install (issue #19), over `tauri-plugin-updater`.
//!
//! The feed is `latest.json` on the newest *published*, non-prerelease
//! GitHub release (endpoint and minisign public key: `plugins.updater` in
//! `tauri.conf.json`; the release workflow signs and uploads it). The
//! frontend drives everything through two commands:
//!
//! - [`check`] asks the feed, parks the resulting [`Update`] in
//!   [`UpdaterState`] and returns a serialisable [`UpdateInfo`]. The
//!   download URL never crosses IPC, so the webview can only ever install
//!   what the signed feed announced.
//! - [`install`] downloads the parked update (progress as
//!   [`PROGRESS_EVENT`]), verifies and installs it, then relaunches.
//!
//! Only bundles the plugin can replace in place self-install — see
//! [`can_self_install`]. Everything else (a `.deb`/`.rpm` owned by the
//! system package manager, a source or `tauri dev` build) is notify-only:
//! the frontend links to the release page instead.
//!
//! Both relaunch paths end in `std::process::exit`, so managed state is
//! never dropped and `AgentBridge`'s `Drop` never runs. The omp children
//! are therefore killed explicitly ([`AgentBridge::shutdown_all`]) first —
//! on Unix each sits in its own process group and would outlive us.

use std::path::Path;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Mutex;
use std::time::Duration;

use tauri::utils::config::BundleType;
use tauri::utils::platform::bundle_type;
use tauri::{AppHandle, Emitter, Manager};
use tauri_plugin_updater::{Update, UpdaterExt};

use crate::agent::AgentBridge;

/// Event carrying [`Progress`] while an update downloads.
pub const PROGRESS_EVENT: &str = "update://progress";

/// Where a notify-only install sends the user, and what "release notes"
/// links to. `/tag/v{version}` matches the release workflow's tag format.
const RELEASES_URL: &str = "https://github.com/apoc/omp-desktop/releases";

/// Upper bound for the feed request. The check runs in the background on
/// a timer; a stalled connection must fail rather than pin the command.
const CHECK_TIMEOUT: Duration = Duration::from_secs(30);

/// Minimum bytes between two progress events. The plugin reports every
/// network chunk (a few KiB each); forwarding them all would flood IPC
/// with thousands of events for one installer.
const PROGRESS_STEP: u64 = 256 * 1024;

/// The update announced by the last successful [`check`], held for
/// [`install`], plus a guard against overlapping installs.
#[derive(Default)]
pub struct UpdaterState {
    pending: Mutex<Option<Update>>,
    installing: AtomicBool,
}

/// What the frontend needs to render an available update.
#[derive(Debug, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct UpdateInfo {
    version: String,
    current_version: String,
    /// Release notes as published in the feed (markdown source).
    notes: Option<String>,
    /// RFC 3339 publish date, verbatim from the feed.
    date: Option<String>,
    /// `false` → notify-only; the frontend offers `release_url` instead.
    can_install: bool,
    release_url: String,
}

#[derive(Clone, serde::Serialize)]
#[serde(rename_all = "camelCase")]
struct Progress {
    downloaded: u64,
    /// `None` when the server sent no `Content-Length`.
    total: Option<u64>,
}

/// Whether this build can replace itself in place. Deliberately narrower
/// than what the plugin attempts: it would also `pkexec dpkg -i` over a
/// `.deb`/`.rpm` (falling back to a password prompt, then a TTY `sudo` a
/// GUI app does not have), and would overwrite a `tauri dev` binary. Those
/// installs belong to the package manager or the developer, not to us.
///
/// macOS needs `exe` as well: tauri-utils' `bundle_type()` reports `App`
/// for *every* macOS binary whose bundle marker was never patched —
/// `tauri dev`, `cargo build` included. For such a binary the plugin's
/// install target is the directory holding it (`target/debug`), which it
/// moves away and deletes. Only a binary running from inside a `.app`
/// bundle is the bundle it claims to be.
pub fn can_self_install(bundle: Option<&BundleType>, exe: Option<&Path>) -> bool {
    match bundle {
        Some(BundleType::AppImage | BundleType::Msi | BundleType::Nsis) => true,
        Some(BundleType::App | BundleType::Dmg) => exe.is_some_and(in_app_bundle),
        _ => false,
    }
}

/// `<name>.app/Contents/MacOS/<exe>` — the layout the plugin's macOS
/// install walks up from.
fn in_app_bundle(exe: &Path) -> bool {
    exe.parent().is_some_and(|dir| {
        dir.ends_with("Contents/MacOS")
            && dir
                .parent()
                .and_then(Path::parent)
                .and_then(Path::extension)
                .is_some_and(|ext| ext == "app")
    })
}

/// [`can_self_install`] for the running process.
fn self_installable() -> bool {
    can_self_install(
        bundle_type().as_ref(),
        std::env::current_exe().ok().as_deref(),
    )
}

fn release_url(version: &str) -> String {
    format!("{RELEASES_URL}/tag/v{version}")
}

/// Whether a download that has reached `downloaded` bytes should emit a
/// progress event, given the last emitted count. The final chunk always
/// emits so the bar reaches 100%.
const fn should_emit(last_emitted: u64, downloaded: u64, total: Option<u64>) -> bool {
    if let Some(total) = total {
        if downloaded >= total {
            return true;
        }
    }
    downloaded.saturating_sub(last_emitted) >= PROGRESS_STEP
}

fn info_for(update: &Update, can_install: bool) -> UpdateInfo {
    // Copied, not moved: the `Update` stays parked whole in
    // `UpdaterState::pending` for `install`, and a command can't return
    // data borrowed from managed state.
    UpdateInfo {
        version: update.version.clone(),
        current_version: update.current_version.clone(),
        notes: update.body.clone(),
        // The feed's own string rather than re-formatting `update.date`:
        // formatting an `OffsetDateTime` needs `time`'s `formatting`
        // feature, a direct dependency this would add for one field.
        date: update
            .raw_json
            .get("pub_date")
            .and_then(serde_json::Value::as_str)
            .map(str::to_owned),
        can_install,
        release_url: release_url(&update.version),
    }
}

/// Ask the feed for a newer release. `Ok(None)` = up to date.
///
/// # Errors
/// Network/TLS failure, a malformed or missing `latest.json`, or no entry
/// for this platform in it.
pub async fn check(app: &AppHandle, state: &UpdaterState) -> Result<Option<UpdateInfo>, String> {
    if state.installing.load(Ordering::Acquire) {
        return Err("an update is already being installed".into());
    }
    let builder = app.updater_builder().timeout(CHECK_TIMEOUT);
    // Windows only: `Update::install` hands off to the installer and then
    // calls this hook right before `std::process::exit(0)`. It replaces the
    // plugin's default hook, so `cleanup_before_exit` is repeated here.
    #[cfg(windows)]
    let builder = {
        // Owned by the `'static` hook; `AppHandle` is not an `Arc`, so
        // `Arc::clone` does not apply.
        let handle = app.clone();
        builder.on_before_exit(move || {
            handle.state::<AgentBridge>().shutdown_all();
            handle.cleanup_before_exit();
        })
    };
    let update = builder
        .build()
        .map_err(|e| e.to_string())?
        .check()
        .await
        .map_err(|e| e.to_string())?;
    let info = update.as_ref().map(|u| info_for(u, self_installable()));
    *state
        .pending
        .lock()
        .map_err(|_| "updater lock poisoned".to_string())? = update;
    Ok(info)
}

/// Download, verify and install the update parked by the last [`check`],
/// then relaunch into it.
///
/// On Windows a successful install never returns: the installer takes over
/// through the `on_before_exit` hook and the process exits. Elsewhere
/// `Ok(())` means installed, omp children stopped and a relaunch already
/// requested; `installing` stays set until the process goes.
///
/// # Errors
/// Nothing pending, an install already running, a notify-only build, or a
/// download/verification/install failure. A failed attempt re-parks the
/// update so the user can retry without checking again.
pub async fn install(app: &AppHandle, state: &UpdaterState) -> Result<(), String> {
    if !self_installable() {
        return Err("this installation can't update itself — download the new version from the release page".into());
    }
    if state.installing.swap(true, Ordering::AcqRel) {
        return Err("an update is already being installed".into());
    }
    let taken = state
        .pending
        .lock()
        .map_err(|_| "updater lock poisoned".to_string())
        .map(|mut pending| pending.take());
    let result = match taken {
        Ok(Some(update)) => {
            let (unused, outcome) = download_and_install(app, update).await;
            if let Some(update) = unused {
                if let Ok(mut pending) = state.pending.lock() {
                    // A check that finished meanwhile knows better.
                    pending.get_or_insert(update);
                }
            }
            outcome
        }
        Ok(None) => Err("no update pending — check for updates again".into()),
        Err(e) => Err(e),
    };
    if result.is_err() {
        state.installing.store(false, Ordering::Release);
    }
    result
}

/// Returns the update back when it is still installable (download or
/// install failed), for re-parking.
async fn download_and_install(
    app: &AppHandle,
    update: Update,
) -> (Option<Update>, Result<(), String>) {
    let mut downloaded: u64 = 0;
    let mut last_emitted: u64 = 0;
    let bytes = match update
        .download(
            |chunk, total| {
                downloaded += chunk as u64;
                if should_emit(last_emitted, downloaded, total) {
                    last_emitted = downloaded;
                    // Progress is cosmetic; a dropped event must not fail
                    // the download.
                    let _ = app.emit(PROGRESS_EVENT, Progress { downloaded, total });
                }
            },
            || {},
        )
        .await
    {
        Ok(bytes) => bytes,
        Err(e) => return (Some(update), Err(e.to_string())),
    };
    // Blocking from here on: `install` writes the whole bundle to disk (and
    // on macOS may wait on an admin password prompt), and `shutdown_all`
    // kills and waits on every omp child. Owned by that task; `AppHandle`
    // is not an `Arc`, so `Arc::clone` does not apply.
    let handle = app.clone();
    tauri::async_runtime::spawn_blocking(move || {
        if let Err(e) = update.install(bytes) {
            return (Some(update), Err(e.to_string()));
        }
        // Windows never gets here: `install` exited through the hook set
        // in `check`.
        handle.state::<AgentBridge>().shutdown_all();
        handle.request_restart();
        (None, Ok(()))
    })
    .await
    // Only a panic in the task lands here; the update went with it.
    .unwrap_or_else(|e| (None, Err(format!("install task failed: {e}"))))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn only_bundles_replaceable_in_place_self_install() {
        let exe = Path::new("/opt/whatever/omp-desktop");
        for bundle in [BundleType::AppImage, BundleType::Msi, BundleType::Nsis] {
            assert!(
                can_self_install(Some(&bundle), Some(exe)),
                "{bundle:?} should self-install"
            );
        }
        // Package-manager-owned installs and unbundled (`tauri dev`, source)
        // builds on Linux/Windows are notify-only.
        for bundle in [BundleType::Deb, BundleType::Rpm] {
            assert!(
                !can_self_install(Some(&bundle), Some(exe)),
                "{bundle:?} must be notify-only"
            );
        }
        assert!(
            !can_self_install(None, Some(exe)),
            "an unbundled build must be notify-only"
        );
    }

    /// tauri-utils reports `App` for every unpatched macOS binary, so the
    /// executable's location is what separates a real bundle from
    /// `target/debug` — which the plugin would otherwise delete.
    #[test]
    fn macos_self_installs_only_from_inside_an_app_bundle() {
        let bundled = Path::new("/Applications/OMP Desktop.app/Contents/MacOS/omp-desktop");
        for bundle in [BundleType::App, BundleType::Dmg] {
            assert!(can_self_install(Some(&bundle), Some(bundled)));
            for exe in [
                "/Users/dev/omp-desktop/src-tauri/target/debug/omp-desktop",
                "/Users/dev/build/Contents/MacOS/omp-desktop", // not in a `.app`
            ] {
                assert!(
                    !can_self_install(Some(&bundle), Some(Path::new(exe))),
                    "{bundle:?} from {exe} must be notify-only"
                );
            }
            assert!(!can_self_install(Some(&bundle), None));
        }
    }

    #[test]
    fn release_url_points_at_the_workflow_tag() {
        assert_eq!(
            release_url("0.4.0"),
            "https://github.com/apoc/omp-desktop/releases/tag/v0.4.0"
        );
    }

    #[test]
    fn progress_is_throttled_but_always_reports_completion() {
        // Small chunks below the step stay quiet…
        assert!(!should_emit(0, 16 * 1024, Some(10 * 1024 * 1024)));
        // …until a full step has accumulated since the last event.
        assert!(should_emit(0, PROGRESS_STEP, Some(10 * 1024 * 1024)));
        assert!(!should_emit(
            PROGRESS_STEP,
            PROGRESS_STEP + 1,
            Some(10 * 1024 * 1024)
        ));
        // The last chunk emits even when it is smaller than a step.
        assert!(should_emit(9_999_000, 10_000_000, Some(10_000_000)));
        // Unknown length: step-throttled only.
        assert!(!should_emit(0, 1024, None));
        assert!(should_emit(0, PROGRESS_STEP, None));
    }
}

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
//! The non-Windows relaunch (`request_restart`) ends the process without
//! dropping managed state, so `AgentBridge`'s `Drop` never runs; the omp
//! children are killed explicitly ([`AgentBridge::shutdown_all`]) first —
//! on Unix each sits in its own process group and would outlive us. On
//! Windows the plugin launches the installer and then exits; every omp
//! tree sits in a `KILL_ON_JOB_CLOSE` job object and dies with us. Killing
//! them earlier (in `on_before_exit`, which runs *before* the installer is
//! launched) would strand every tab if that launch then failed.

use std::path::Path;
use std::sync::{Mutex, MutexGuard};
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

const BUSY: &str = "an update is already being installed";

/// Where the updater is: nothing known, an update announced by the last
/// [`check`] and held for [`install`], or an install under way (terminal on
/// success — the process is replaced). One enum under one lock, so "parked
/// while installing" can't be represented.
#[derive(Default)]
enum Slot {
    #[default]
    Empty,
    // Boxed: an `Update` is several hundred bytes, the other variants none.
    Parked(Box<Update>),
    Installing,
}

#[derive(Default)]
pub struct UpdaterState {
    slot: Mutex<Slot>,
}

impl UpdaterState {
    fn slot(&self) -> Result<MutexGuard<'_, Slot>, String> {
        self.slot
            .lock()
            .map_err(|_| "updater lock poisoned".to_string())
    }

    /// Hold `update` (or forget the last one) unless an install owns the
    /// slot.
    fn park(&self, update: Option<Update>) -> Result<(), String> {
        let mut slot = self.slot()?;
        if matches!(*slot, Slot::Installing) {
            return Err(BUSY.into());
        }
        *slot = update.map_or(Slot::Empty, |u| Slot::Parked(Box::new(u)));
        drop(slot);
        Ok(())
    }

    /// Take the parked update for installing; the slot stays `Installing`
    /// (an empty slot stays empty).
    fn claim(&self) -> Result<Update, String> {
        let previous = {
            let mut slot = self.slot()?;
            let next = if matches!(*slot, Slot::Empty) {
                Slot::Empty
            } else {
                Slot::Installing
            };
            std::mem::replace(&mut *slot, next)
        };
        match previous {
            Slot::Parked(update) => Ok(*update),
            Slot::Installing => Err(BUSY.into()),
            Slot::Empty => Err("no update pending — check for updates again".into()),
        }
    }
}

/// What the frontend needs to render an available update.
#[derive(Debug, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct UpdateInfo {
    version: String,
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
    // `UpdaterState` for `install`, and a command can't return data
    // borrowed from managed state.
    UpdateInfo {
        version: update.version.clone(),
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
    // Refuse up front (no pointless network round-trip) and again after the
    // await, which an install may have started during.
    if matches!(*state.slot()?, Slot::Installing) {
        return Err(BUSY.into());
    }
    let update = app
        .updater_builder()
        .timeout(CHECK_TIMEOUT)
        .build()
        .map_err(|e| e.to_string())?
        .check()
        .await
        .map_err(|e| e.to_string())?;
    let info = update.as_ref().map(|u| info_for(u, self_installable()));
    state.park(update)?;
    Ok(info)
}

/// Download, verify and install the update parked by the last [`check`],
/// then relaunch into it.
///
/// On Windows a successful install never returns: the plugin launches the
/// installer and exits the process. Elsewhere `Ok(())` means installed,
/// omp children stopped and a relaunch already requested; the slot stays
/// `Installing` until the process goes.
///
/// # Errors
/// Nothing pending, an install already running, a notify-only build, or a
/// download/verification/install failure. A failed attempt re-parks the
/// update so the user can retry without checking again.
pub async fn install(app: &AppHandle, state: &UpdaterState) -> Result<(), String> {
    if !self_installable() {
        return Err("this installation can't update itself — download the new version from the release page".into());
    }
    let update = state.claim()?;
    let (unused, result) = download_and_install(app, update).await;
    if result.is_err() {
        // Back to what it was — nothing else wrote the slot meanwhile:
        // `park` never overwrites `Installing`.
        let mut slot = state.slot()?;
        *slot = unused.map_or(Slot::Empty, |u| Slot::Parked(Box::new(u)));
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
        // Windows never gets here: the plugin exited the process after
        // launching the installer.
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

    /// An install owns the slot: a check finishing mid-install must not
    /// replace it (a failed install re-parks its own update), and a second
    /// install is refused. With nothing parked, claiming leaves the slot
    /// usable for the next check.
    #[test]
    fn installing_slot_is_exclusive_and_empty_claim_is_harmless() {
        let state = UpdaterState::default();
        let claimed = state.claim().err();
        assert!(claimed.is_some_and(|e| e.contains("no update pending")));
        assert!(
            state.park(None).is_ok(),
            "an empty claim must not wedge the slot"
        );

        *state.slot().unwrap() = Slot::Installing;
        assert_eq!(state.park(None).unwrap_err(), BUSY);
        assert_eq!(state.claim().err().as_deref(), Some(BUSY));
        assert!(matches!(*state.slot().unwrap(), Slot::Installing));
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

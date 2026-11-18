//! Autostart entries for the persona service, one per platform. The text
//! builders are pure (tested); install/uninstall run the platform tool.

use std::path::Path;
use std::process::Command;

pub const LABEL: &str = "dev.ohMyPi.desktop.persona";
pub const TASK_NAME: &str = "OMP Desktop Ompy";

fn xml(s: &str) -> String {
    s.replace('&', "&amp;")
        .replace('<', "&lt;")
        .replace('>', "&gt;")
        .replace('"', "&quot;")
}

/// The executable path as text, refusing control characters.
///
/// `ExecStart` is line based (a newline would add a second command) and XML
/// 1.0 cannot represent most control characters at all, so an entry built
/// from such a path would be broken or misleading. Rejecting it is the only
/// safe answer.
fn checked_path(exe: &Path) -> Result<String, String> {
    let text = exe.display().to_string();
    if let Some(control) = text.chars().find(|c| c.is_control()) {
        return Err(format!(
            "executable path contains the control character {control:?}: {text:?}"
        ));
    }
    Ok(text)
}

/// The macOS `LaunchAgent` plist for `exe`.
///
/// # Errors
///
/// Returns a message when the executable path contains a control character.
pub fn launch_agent_plist(exe: &Path) -> Result<String, String> {
    let exe = checked_path(exe)?;
    Ok(format!(
        r#"<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
    <key>Label</key>
    <string>{LABEL}</string>
    <key>ProgramArguments</key>
    <array>
        <string>{}</string>
        <string>run</string>
    </array>
    <key>RunAtLoad</key>
    <true/>
    <key>KeepAlive</key>
    <dict>
        <key>SuccessfulExit</key>
        <false/>
    </dict>
    <key>ProcessType</key>
    <string>Background</string>
</dict>
</plist>
"#,
        xml(&exe)
    ))
}

/// The systemd user unit for `exe`.
///
/// # Errors
///
/// Returns a message when the executable path contains a control character.
pub fn systemd_unit(exe: &Path) -> Result<String, String> {
    let exe = checked_path(exe)?
        .replace('%', "%%")
        .replace('$', "$$")
        .replace('\\', "\\\\")
        .replace('"', "\\\"");
    Ok(format!(
        "[Unit]\nDescription=OMP Desktop persona (Ompy)\n\n[Service]\nExecStart=\"{exe}\" run\nRestart=on-failure\n\n[Install]\nWantedBy=default.target\n",
    ))
}

/// The Windows Task Scheduler XML for `exe` and `user`.
///
/// # Errors
///
/// Returns a message when the executable path contains a control character.
pub fn task_xml(exe: &Path, user: &str) -> Result<String, String> {
    let exe = checked_path(exe)?;
    Ok(format!(
        r#"<?xml version="1.0" encoding="UTF-16"?>
<Task version="1.2" xmlns="http://schemas.microsoft.com/windows/2004/02/mit/task">
  <Triggers>
    <LogonTrigger>
      <Enabled>true</Enabled>
      <UserId>{u}</UserId>
    </LogonTrigger>
  </Triggers>
  <Principals>
    <Principal id="Author">
      <UserId>{u}</UserId>
      <LogonType>InteractiveToken</LogonType>
      <RunLevel>LeastPrivilege</RunLevel>
    </Principal>
  </Principals>
  <Settings>
    <MultipleInstancesPolicy>IgnoreNew</MultipleInstancesPolicy>
    <DisallowStartIfOnBatteries>false</DisallowStartIfOnBatteries>
    <StopIfGoingOnBatteries>false</StopIfGoingOnBatteries>
    <ExecutionTimeLimit>PT0S</ExecutionTimeLimit>
    <Hidden>true</Hidden>
  </Settings>
  <Actions Context="Author">
    <Exec>
      <Command>{c}</Command>
      <Arguments>run</Arguments>
    </Exec>
  </Actions>
</Task>
"#,
        u = xml(user),
        c = xml(&exe)
    ))
}

#[allow(dead_code)] // also exercised by unit tests on other host platforms
fn launchctl_not_loaded(code: Option<i32>, stderr: &str) -> bool {
    code == Some(3) || stderr.contains("No such process")
}

#[allow(dead_code)] // also exercised by unit tests on other host platforms
fn schtasks_missing(stderr: &str) -> bool {
    stderr.to_ascii_lowercase().contains("does not exist")
}

/// `schtasks /End` on a task with no running instance is a no-op for `stop`.
#[allow(dead_code)] // also exercised by unit tests on other host platforms
fn schtasks_not_running(stderr: &str) -> bool {
    stderr.to_ascii_lowercase().contains("not running")
}

/// `systemctl stop` on wiped state reports the unit as not loaded.
#[allow(dead_code)] // also exercised by unit tests on other host platforms
fn systemctl_unit_missing(stderr: &str) -> bool {
    let stderr = stderr.to_ascii_lowercase();
    stderr.contains("not loaded") || stderr.contains("not found")
}

fn run_tool(command: &mut Command) -> Result<(), String> {
    run_tool_or(command, |_, _| false)
}

#[allow(clippy::disallowed_methods)] // one-shot platform tool; no Chromium in this process
fn run_tool_or(
    command: &mut Command,
    acceptable: impl FnOnce(Option<i32>, &str) -> bool,
) -> Result<(), String> {
    let output = command.output().map_err(|e| e.to_string())?;
    let stderr = String::from_utf8_lossy(&output.stderr);
    if output.status.success() || acceptable(output.status.code(), &stderr) {
        return Ok(());
    }
    let detail = stderr.trim();
    if detail.is_empty() {
        Err(format!("platform tool exited with {}", output.status))
    } else {
        Err(detail.to_owned())
    }
}

#[cfg(any(target_os = "macos", target_os = "linux"))]
fn home() -> Result<std::path::PathBuf, String> {
    dirs::home_dir().ok_or_else(|| "no home directory".to_owned())
}

/// Writes an autostart entry, creating its directory first. `build` runs
/// after that, keeping the directory → entry text → file order both installs
/// already had.
#[cfg(any(target_os = "macos", target_os = "linux"))]
fn write_entry(
    path: &Path,
    missing_parent: &str,
    build: impl FnOnce() -> Result<String, String>,
) -> Result<(), String> {
    let parent = path.parent().ok_or(missing_parent)?;
    std::fs::create_dir_all(parent).map_err(|e| e.to_string())?;
    std::fs::write(path, build()?).map_err(|e| e.to_string())
}

/// Removes an autostart entry; a missing file is already the wanted state.
#[cfg(any(target_os = "macos", target_os = "linux"))]
fn remove_entry(path: &Path) -> Result<(), String> {
    match std::fs::remove_file(path) {
        Ok(()) => Ok(()),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(()),
        Err(e) => Err(e.to_string()),
    }
}

/// Installs and starts the autostart entry for `exe`.
///
/// # Errors
///
/// Returns file-system, environment or platform-tool failures.
#[cfg(target_os = "macos")]
pub fn install(exe: &Path) -> Result<(), String> {
    let plist = home()?
        .join("Library/LaunchAgents")
        .join(format!("{LABEL}.plist"));
    write_entry(&plist, "LaunchAgents path has no parent", || {
        launch_agent_plist(exe)
    })?;
    // SAFETY: getuid has no preconditions.
    let uid = unsafe { libc::getuid() };
    run_tool_or(
        Command::new("launchctl")
            .arg("bootout")
            .arg(format!("gui/{uid}/{LABEL}")),
        launchctl_not_loaded,
    )?;
    run_tool(
        Command::new("launchctl")
            .arg("bootstrap")
            .arg(format!("gui/{uid}"))
            .arg(&plist),
    )
}

/// Stops and removes the autostart entry.
///
/// # Errors
///
/// Returns file-system, environment or platform-tool failures.
#[cfg(target_os = "macos")]
pub fn uninstall() -> Result<(), String> {
    let plist = home()?
        .join("Library/LaunchAgents")
        .join(format!("{LABEL}.plist"));
    // SAFETY: getuid has no preconditions.
    let uid = unsafe { libc::getuid() };
    let bootout = run_tool_or(
        Command::new("launchctl")
            .arg("bootout")
            .arg(format!("gui/{uid}/{LABEL}")),
        launchctl_not_loaded,
    );
    let removed = remove_entry(&plist);
    bootout?;
    removed
}

/// Unloads the agent without removing its plist; a job that is not loaded is
/// not an error, so this is safe to call before a replacement.
///
/// # Errors
///
/// Returns an environment or platform-tool failure.
#[cfg(target_os = "macos")]
pub fn stop() -> Result<(), String> {
    // SAFETY: getuid has no preconditions.
    let uid = unsafe { libc::getuid() };
    run_tool_or(
        Command::new("launchctl")
            .arg("bootout")
            .arg(format!("gui/{uid}/{LABEL}")),
        launchctl_not_loaded,
    )
}

/// Installs and starts the autostart entry for `exe`.
///
/// # Errors
///
/// Returns file-system, environment or platform-tool failures.
#[cfg(target_os = "linux")]
pub fn install(exe: &Path) -> Result<(), String> {
    let unit = home()?
        .join(".config/systemd/user")
        .join("omp-desktopd.service");
    write_entry(&unit, "systemd unit path has no parent", || {
        systemd_unit(exe)
    })?;
    run_tool(Command::new("systemctl").args(["--user", "enable", "--now", "omp-desktopd.service"]))
}

#[allow(dead_code)] // pure command data is tested on every host platform
fn linux_restart_args(active: bool) -> Option<[&'static str; 3]> {
    active.then_some(["--user", "restart", "omp-desktopd.service"])
}

/// Restarts a running service after its executable is replaced. Inactive or
/// disabled Linux services stay stopped; macOS re-bootstraps its loaded agent
/// and Windows ends then recreates/runs its task so the new image is loaded.
///
/// # Errors
///
/// Returns environment or platform-tool failures.
#[cfg(target_os = "linux")]
pub fn restart(_exe: &Path) -> Result<(), String> {
    #[allow(clippy::disallowed_methods)] // one-shot platform tool; no Chromium in this process
    let probe = Command::new("systemctl")
        .args(["--user", "is-active", "--quiet", "omp-desktopd.service"])
        .output()
        .map_err(|e| e.to_string())?;
    if probe.status.success() {
        run_tool(Command::new("systemctl").args(linux_restart_args(true).unwrap()))?;
    } else if !matches!(probe.status.code(), Some(3 | 4)) {
        return Err(format!(
            "systemctl --user is-active exited with {}",
            probe.status
        ));
    }
    Ok(())
}

/// Restarts the loaded agent with the replacement executable.
///
/// # Errors
///
/// Returns file-system, environment or platform-tool failures.
#[cfg(target_os = "macos")]
pub fn restart(exe: &Path) -> Result<(), String> {
    install(exe)
}

/// Ends any running instance, then recreates and runs the replacement.
///
/// # Errors
///
/// Returns file-system, environment or platform-tool failures.
#[cfg(windows)]
pub fn restart(exe: &Path) -> Result<(), String> {
    stop()?;
    install(exe)
}

/// Ends the running task instance; a task that does not exist or is not
/// running is not an error, so `stop` is idempotent.
///
/// # Errors
///
/// Returns platform-tool failures other than the two idempotent cases.
#[cfg(windows)]
pub fn stop() -> Result<(), String> {
    run_tool_or(
        Command::new("schtasks").args(["/End", "/TN", TASK_NAME]),
        |_, stderr| schtasks_missing(stderr) || schtasks_not_running(stderr),
    )
}

/// Stops and removes the autostart entry.
///
/// # Errors
///
/// Returns file-system, environment or platform-tool failures.
#[cfg(target_os = "linux")]
pub fn uninstall() -> Result<(), String> {
    let unit = home()?
        .join(".config/systemd/user")
        .join("omp-desktopd.service");
    if !unit.exists() {
        return Ok(());
    }
    run_tool(Command::new("systemctl").args([
        "--user",
        "disable",
        "--now",
        "omp-desktopd.service",
    ]))?;
    remove_entry(&unit)
}

/// Stops the unit without disabling it; an absent unit is not an error.
///
/// # Errors
///
/// Returns environment or platform-tool failures.
#[cfg(target_os = "linux")]
pub fn stop() -> Result<(), String> {
    run_tool_or(
        Command::new("systemctl").args(["--user", "stop", "omp-desktopd.service"]),
        |_, stderr| systemctl_unit_missing(stderr),
    )
}

#[cfg(windows)]
fn task_file() -> std::path::PathBuf {
    std::env::temp_dir().join("omp-desktopd-task.xml")
}

#[cfg(windows)]
fn write_task_xml(path: &Path, exe: &Path) -> Result<(), String> {
    let domain = std::env::var("USERDOMAIN").map_err(|e| format!("USERDOMAIN: {e}"))?;
    let name = std::env::var("USERNAME").map_err(|e| format!("USERNAME: {e}"))?;
    let text = task_xml(exe, &format!(r"{domain}\{name}"))?;
    let mut bytes = Vec::with_capacity(2 + text.len() * 2);
    bytes.extend_from_slice(&[0xff, 0xfe]);
    for unit in text.encode_utf16() {
        bytes.extend_from_slice(&unit.to_le_bytes());
    }
    std::fs::write(path, bytes).map_err(|e| e.to_string())
}

/// Installs and starts the autostart entry for `exe`.
///
/// # Errors
///
/// Returns file-system, environment or platform-tool failures.
#[cfg(windows)]
pub fn install(exe: &Path) -> Result<(), String> {
    let file = task_file();
    write_task_xml(&file, exe)?;
    let created = run_tool(
        Command::new("schtasks")
            .args(["/Create", "/TN", TASK_NAME, "/XML"])
            .arg(&file)
            .arg("/F"),
    );
    let _ = std::fs::remove_file(&file);
    created?;
    run_tool(Command::new("schtasks").args(["/Run", "/TN", TASK_NAME]))
}

/// Stops and removes the autostart entry.
///
/// # Errors
///
/// Returns platform-tool failures.
#[cfg(windows)]
pub fn uninstall() -> Result<(), String> {
    let _ = run_tool(Command::new("schtasks").args(["/End", "/TN", TASK_NAME]));
    run_tool_or(
        Command::new("schtasks").args(["/Delete", "/TN", TASK_NAME, "/F"]),
        |_, stderr| schtasks_missing(stderr),
    )
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::path::Path;

    #[test]
    fn plist_runs_exe_with_run_and_escapes() {
        let p = launch_agent_plist(Path::new(
            "/Applications/OMP Desktop.app/Contents/MacOS/omp-desktopd&x",
        ))
        .unwrap();
        assert!(p.contains("<string>dev.ohMyPi.desktop.persona</string>"));
        assert!(p.contains(
            "<string>/Applications/OMP Desktop.app/Contents/MacOS/omp-desktopd&amp;x</string>\n        <string>run</string>"
        ));
        assert!(p.contains("<key>RunAtLoad</key>\n    <true/>"));
    }

    #[test]
    fn systemd_unit_quotes_spaces() {
        let u = systemd_unit(Path::new("/opt/OMP Desktop/omp-desktopd")).unwrap();
        assert!(u.contains("ExecStart=\"/opt/OMP Desktop/omp-desktopd\" run"));
        assert!(u.contains("WantedBy=default.target"));
    }

    #[test]
    fn systemd_unit_escapes_specifiers_and_expansion() {
        let u = systemd_unit(Path::new("/opt/100%-$USER/omp-desktopd")).unwrap();
        assert!(u.contains("ExecStart=\"/opt/100%%-$$USER/omp-desktopd\" run"));
    }

    #[test]
    fn entries_reject_paths_with_control_characters() {
        // A newline would end `ExecStart` and inject a second command, and XML
        // cannot carry it either.
        let newline = Path::new("/opt/omp-desktopd\nExecStart=/bin/sh");
        for result in [
            launch_agent_plist(newline),
            systemd_unit(newline),
            task_xml(newline, r"PC\sam"),
        ] {
            let error = result.unwrap_err();
            assert!(error.contains("control character"), "{error}");
        }
        // A normal path stays accepted.
        assert!(systemd_unit(Path::new("/opt/omp-desktopd")).is_ok());
    }

    #[test]
    fn linux_restart_only_targets_an_active_service() {
        assert_eq!(
            linux_restart_args(true),
            Some(["--user", "restart", "omp-desktopd.service"])
        );
        assert_eq!(linux_restart_args(false), None);
    }

    #[cfg(any(target_os = "macos", target_os = "linux"))]
    #[test]
    fn removing_a_missing_entry_is_not_an_error() {
        let dir = std::env::temp_dir().join(format!("omp-autostart-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let entry = dir.join("entry");
        assert!(remove_entry(&entry).is_ok());
        std::fs::write(&entry, "unit").unwrap();
        assert!(remove_entry(&entry).is_ok());
        assert!(!entry.exists());
        std::fs::remove_dir_all(&dir).unwrap();
    }

    #[test]
    fn launchctl_absent_job_is_not_an_error() {
        assert!(launchctl_not_loaded(Some(3), ""));
        assert!(launchctl_not_loaded(
            Some(113),
            "Boot-out failed: 3: No such process"
        ));
        assert!(!launchctl_not_loaded(
            Some(5),
            "Boot-out failed: 5: Input/output error"
        ));
    }

    #[test]
    fn schtasks_absent_task_is_not_an_error() {
        assert!(schtasks_missing(
            "ERROR: The specified task name does not exist."
        ));
        assert!(schtasks_missing("ERROR: Task DOES NOT EXIST."));
        assert!(!schtasks_missing("ERROR: Access is denied."));
    }

    #[test]
    fn a_stopped_task_and_an_absent_unit_are_idempotent_stops() {
        assert!(schtasks_not_running(
            "ERROR: The operation cannot be performed for the specified task because the task is not running."
        ));
        assert!(!schtasks_not_running("ERROR: Access is denied."));
        assert!(systemctl_unit_missing(
            "Failed to stop omp-desktopd.service: Unit omp-desktopd.service not loaded."
        ));
        assert!(systemctl_unit_missing(
            "Failed to stop omp-desktopd.service: Unit omp-desktopd.service not found."
        ));
        assert!(!systemctl_unit_missing("Failed to stop: Access denied"));
    }

    #[test]
    fn task_xml_has_logon_trigger_for_user() {
        let x = task_xml(
            Path::new(r"C:\Program Files\OMP Desktop\omp-desktopd.exe"),
            r"PC\sam",
        )
        .unwrap();
        assert!(x.contains("<LogonTrigger>") && x.contains(r"<UserId>PC\sam</UserId>"));
        assert!(x.contains(r"<Command>C:\Program Files\OMP Desktop\omp-desktopd.exe</Command>"));
        assert!(x.contains("<Arguments>run</Arguments>"));
    }
}

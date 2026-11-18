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

#[must_use]
pub fn launch_agent_plist(exe: &Path) -> String {
    format!(
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
        xml(&exe.display().to_string())
    )
}

#[must_use]
pub fn systemd_unit(exe: &Path) -> String {
    format!(
        "[Unit]\nDescription=OMP Desktop persona (Ompy)\n\n[Service]\nExecStart=\"{}\" run\nRestart=on-failure\n\n[Install]\nWantedBy=default.target\n",
        exe.display()
            .to_string()
            .replace('%', "%%")
            .replace('$', "$$")
            .replace('\\', "\\\\")
            .replace('"', "\\\"")
    )
}

#[must_use]
pub fn task_xml(exe: &Path, user: &str) -> String {
    format!(
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
        c = xml(&exe.display().to_string())
    )
}

#[allow(dead_code)] // also exercised by unit tests on other host platforms
fn launchctl_not_loaded(code: Option<i32>, stderr: &str) -> bool {
    code == Some(3) || stderr.contains("No such process")
}

#[allow(dead_code)] // also exercised by unit tests on other host platforms
fn schtasks_missing(stderr: &str) -> bool {
    stderr.to_ascii_lowercase().contains("does not exist")
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
    let parent = plist.parent().ok_or("LaunchAgents path has no parent")?;
    std::fs::create_dir_all(parent).map_err(|e| e.to_string())?;
    std::fs::write(&plist, launch_agent_plist(exe)).map_err(|e| e.to_string())?;
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
    let removed = match std::fs::remove_file(&plist) {
        Ok(()) => Ok(()),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(()),
        Err(e) => Err(e.to_string()),
    };
    bootout?;
    removed
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
    let parent = unit.parent().ok_or("systemd unit path has no parent")?;
    std::fs::create_dir_all(parent).map_err(|e| e.to_string())?;
    std::fs::write(&unit, systemd_unit(exe)).map_err(|e| e.to_string())?;
    run_tool(Command::new("systemctl").args(["--user", "enable", "--now", "omp-desktopd.service"]))
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
    match std::fs::remove_file(&unit) {
        Ok(()) => Ok(()),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(()),
        Err(e) => Err(e.to_string()),
    }
}

#[cfg(windows)]
fn task_file() -> std::path::PathBuf {
    std::env::temp_dir().join("omp-desktopd-task.xml")
}

#[cfg(windows)]
fn write_task_xml(path: &Path, exe: &Path) -> Result<(), String> {
    let domain = std::env::var("USERDOMAIN").map_err(|e| format!("USERDOMAIN: {e}"))?;
    let name = std::env::var("USERNAME").map_err(|e| format!("USERNAME: {e}"))?;
    let text = task_xml(exe, &format!(r"{domain}\{name}"));
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
        ));
        assert!(p.contains("<string>dev.ohMyPi.desktop.persona</string>"));
        assert!(p.contains(
            "<string>/Applications/OMP Desktop.app/Contents/MacOS/omp-desktopd&amp;x</string>\n        <string>run</string>"
        ));
        assert!(p.contains("<key>RunAtLoad</key>\n    <true/>"));
    }

    #[test]
    fn systemd_unit_quotes_spaces() {
        let u = systemd_unit(Path::new("/opt/OMP Desktop/omp-desktopd"));
        assert!(u.contains("ExecStart=\"/opt/OMP Desktop/omp-desktopd\" run"));
        assert!(u.contains("WantedBy=default.target"));
    }

    #[test]
    fn systemd_unit_escapes_specifiers_and_expansion() {
        let u = systemd_unit(Path::new("/opt/100%-$USER/omp-desktopd"));
        assert!(u.contains("ExecStart=\"/opt/100%%-$$USER/omp-desktopd\" run"));
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
    fn task_xml_has_logon_trigger_for_user() {
        let x = task_xml(
            Path::new(r"C:\Program Files\OMP Desktop\omp-desktopd.exe"),
            r"PC\sam",
        );
        assert!(x.contains("<LogonTrigger>") && x.contains(r"<UserId>PC\sam</UserId>"));
        assert!(x.contains(r"<Command>C:\Program Files\OMP Desktop\omp-desktopd.exe</Command>"));
        assert!(x.contains("<Arguments>run</Arguments>"));
    }
}

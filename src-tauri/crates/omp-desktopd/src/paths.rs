//! Where the persona service keeps its state. Mirrors Tauri's
//! `app_config_dir()` for identifier `dev.ohMyPi.desktop`, so the app and
//! the service agree without talking.
use interprocess::local_socket::Name;
use std::io;
use std::path::{Path, PathBuf};

pub const IDENTIFIER: &str = "dev.ohMyPi.desktop";

#[derive(Debug, Clone)]
pub struct Paths {
    pub config: PathBuf,
    pub persona: PathBuf,
    /// Unix socket path. On Windows the server uses a namespaced pipe
    /// instead; the field stays for diagnostics.
    pub socket: PathBuf,
    pub inbox: PathBuf,
    pub schedule: PathBuf,
    pub budget: PathBuf,
    pub settings: PathBuf,
    pub sessions: PathBuf,
    pub rules: PathBuf,
    pub instructions: PathBuf,
}

impl Paths {
    /// Resolves the per-user config directory, e.g. `~/Library/Application
    /// Support/dev.ohMyPi.desktop` on macOS.
    ///
    /// # Errors
    ///
    /// Returns a message when the platform has no config directory for the
    /// current user.
    pub fn resolve() -> Result<Self, String> {
        let base = dirs::config_dir().ok_or("no config directory for this user")?;
        Ok(Self::under(&base.join(IDENTIFIER)))
    }

    /// The service's paths under an explicit config root (tests).
    #[must_use]
    pub fn under(config: &Path) -> Self {
        let persona = config.join("persona");
        Self {
            config: config.to_path_buf(),
            socket: persona.join("daemon.sock"),
            inbox: persona.join("inbox.json"),
            schedule: persona.join("schedule.json"),
            budget: persona.join("budget.json"),
            settings: persona.join("settings.json"),
            sessions: persona.join("sessions"),
            rules: persona.join("approval-rules"),
            instructions: persona.join("instructions.md"),
            persona,
        }
    }
}

/// Creates `dir` and limits access to the current user (0700 on unix).
///
/// # Errors
///
/// Returns the underlying I/O error when creating the directory or setting
/// its permissions fails.
pub fn ensure_private_dir(dir: &Path) -> io::Result<()> {
    std::fs::create_dir_all(dir)?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        std::fs::set_permissions(dir, std::fs::Permissions::from_mode(0o700))?;
    }
    Ok(())
}

/// The socket name for [`Paths::socket`]: a filesystem path on unix, a
/// per-user namespaced pipe on Windows.
///
/// # Errors
///
/// Returns an I/O error when the unix socket path cannot be converted into a
/// socket name (for example because it is empty).
pub fn socket_name(paths: &Paths) -> io::Result<Name<'static>> {
    #[cfg(unix)]
    {
        use interprocess::local_socket::{GenericFilePath, ToFsName};
        paths.socket.clone().to_fs_name::<GenericFilePath>()
    }
    #[cfg(windows)]
    {
        use interprocess::local_socket::{GenericNamespaced, ToNsName};
        let _ = paths;
        let user = std::env::var("USERNAME").unwrap_or_else(|_| "user".into());
        format!("omp-desktopd-{user}").to_ns_name::<GenericNamespaced>()
    }
    #[cfg(not(any(unix, windows)))]
    {
        let _ = paths;
        Err(io::Error::other("local sockets are not supported here"))
    }
}

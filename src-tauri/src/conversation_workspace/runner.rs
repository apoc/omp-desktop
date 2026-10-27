use super::{process, Admission, WorkspaceManager};
use std::ffi::OsString;
use std::path::Path;
use std::process::Command;
use std::time::Duration;

const CHECKOUT_TIMEOUT: Duration = Duration::from_secs(300);

pub(super) trait Runner {
    fn switch(&self, root: &Path, branch: &str) -> Result<(), String>;
    fn worktree(&self, root: &Path, branch: &str, dest: &Path, commit: &str) -> Result<(), String>;
}

#[derive(Default)]
pub(super) struct Native<'a> {
    cancellation: Option<(&'a WorkspaceManager, &'a Admission)>,
    profile: Option<&'a str>,
}

impl<'a> Native<'a> {
    pub const fn for_start(
        manager: &'a WorkspaceManager,
        ticket: &'a Admission,
        profile: Option<&'a str>,
    ) -> Self {
        Self {
            cancellation: Some((manager, ticket)),
            profile,
        }
    }

    fn execute(&self, command: &mut Command, label: &str) -> Result<(), String> {
        let output = process::run(
            command,
            || {
                self.cancellation
                    .is_some_and(|(manager, ticket)| manager.check_ticket(ticket).is_err())
            },
            CHECKOUT_TIMEOUT,
        )?;
        if output.status.success() {
            return Ok(());
        }
        Err(format!(
            "{label} failed (including any checkout hook failure): {} {}",
            String::from_utf8_lossy(&output.stderr).trim(),
            String::from_utf8_lossy(&output.stdout).trim()
        ))
    }
}

impl Runner for Native<'_> {
    fn switch(&self, root: &Path, branch: &str) -> Result<(), String> {
        let program =
            crate::child_path::locate_program(&crate::child_path::child_path_dirs(), "git")?;
        let mut command = Command::new(program.binary);
        command.env("PATH", program.path).current_dir(root).args([
            "--no-optional-locks",
            "switch",
            "--no-guess",
            "--no-overwrite-ignore",
            "--no-recurse-submodules",
            "--",
            branch,
        ]);
        // Never allow an inherited Git environment to redirect the mutation to
        // a different index, work tree or repository from the one inspected.
        for name in [
            "GIT_DIR",
            "GIT_WORK_TREE",
            "GIT_INDEX_FILE",
            "GIT_COMMON_DIR",
            "GIT_OBJECT_DIRECTORY",
            "GIT_ALTERNATE_OBJECT_DIRECTORIES",
            "GIT_NAMESPACE",
        ] {
            command.env_remove(name);
        }
        self.execute(&mut command, "git switch")
    }

    fn worktree(&self, root: &Path, branch: &str, dest: &Path, commit: &str) -> Result<(), String> {
        let args = worktree_args(root, branch, dest, commit, self.profile);
        let mut command = crate::agent::spawn::omp_command_in(root, &args)?;
        self.execute(&mut command, "omp worktree add")
    }
}

fn worktree_args(
    root: &Path,
    branch: &str,
    dest: &Path,
    commit: &str,
    profile: Option<&str>,
) -> Vec<OsString> {
    let mut args = Vec::with_capacity(9);
    if let Some(flag) = crate::agent::spawn::profile_flag(profile) {
        args.push(OsString::from(flag));
    }
    args.extend([
        OsString::from("worktree"),
        OsString::from("add"),
        OsString::from("--cwd"),
        root.as_os_str().to_owned(),
        OsString::from("-b"),
        OsString::from(branch),
        dest.as_os_str().to_owned(),
        OsString::from(commit),
    ]);
    args
}

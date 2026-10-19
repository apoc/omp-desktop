//! What a plugin learns about the session it runs for: project path, git
//! branch, default-remote fetch URL, session id and trigger.
//!
//! [`session_ctx`] reads the repository once per session (start, branch
//! change); [`plugin_context`] turns that into the per-run [`PluginContext`]
//! that `run.rs` passes through env vars and stdin.
//!
//! Every [`PluginContext`] string except `project` is bounded to
//! [`CONTEXT_FIELD_MAX_BYTES`]. Each value is also exported as an
//! environment variable, and Linux limits one env string to 128 KiB, so an
//! unbounded value would fail `spawn` with E2BIG. `project` is left intact: it
//! is the plugin's working directory, so truncating it would change where the
//! plugin runs, and the OS path limit already bounds it. The stdin payload is
//! therefore at most `PATH_MAX` + 4 x 2048 bytes plus keys, far below any exec
//! limit and the pipe buffer.

use std::path::Path;

use crate::widgets::config::Trigger;
use crate::widgets::schedule::SessionCtx;

/// Upper bound for every [`PluginContext`] string, see the module docs.
pub const CONTEXT_FIELD_MAX_BYTES: usize = 2048;

#[derive(Debug, Clone, PartialEq, Eq, serde::Serialize)]
pub struct PluginContext {
    pub project: String,
    pub branch: String,
    pub remote: String,
    pub session: String,
    pub trigger: String,
}

/// Branch and default-remote fetch URL of the repository containing
/// `project`. `None` or an empty path (a tab without a project) yields an
/// all-empty context without touching git: an empty path would otherwise be
/// discovered as the app's own working directory, a foreign repository.
///
/// The repository is discovered once, under the spawn gate (gix may run
/// `git` to find its installation config). The remote URL never carries a
/// password (`https://user:pw@host` → `https://user@host`): it reaches the
/// plugin and the webview, which only need it for matching.
pub fn session_ctx(project: Option<&Path>) -> SessionCtx {
    let Some(project) = project.filter(|p| !p.as_os_str().is_empty()) else {
        return SessionCtx::default();
    };
    let Ok((_gate, repo)) = crate::spawn_gate::discover(project) else {
        return SessionCtx {
            project: project.to_string_lossy().into_owned(),
            ..SessionCtx::default()
        };
    };
    let branch = repo
        .head_name()
        .ok()
        .flatten()
        .map(|name| name.shorten().to_string())
        .unwrap_or_default();
    // Bound to a local: in edition 2021 the temporaries of a tail expression
    // would outlive `repo`.
    let remote = repo
        .find_default_remote(gix::remote::Direction::Fetch)
        .and_then(Result::ok)
        .and_then(|r| {
            r.url(gix::remote::Direction::Fetch)
                .map(url_without_password)
        })
        .unwrap_or_default();
    SessionCtx {
        project: project.to_string_lossy().into_owned(),
        branch,
        remote,
    }
}

/// Serialise `url` without its password. Clones only when there is one.
fn url_without_password(url: &gix::Url) -> String {
    if url.password().is_none() {
        return url.to_bstring().to_string();
    }
    let mut url = url.clone(); // `set_password` needs an owned URL; rare path
    url.set_password(None);
    url.to_bstring().to_string()
}

/// The per-run context: `ctx` plus the session id and trigger, with every
/// field except `project` bounded to [`CONTEXT_FIELD_MAX_BYTES`].
pub fn plugin_context(ctx: &SessionCtx, session: &str, trigger: Trigger) -> PluginContext {
    PluginContext {
        project: ctx.project.clone(), // the run owns its context; `ctx` stays in the scheduler
        branch: bounded(&ctx.branch),
        remote: bounded(&ctx.remote),
        session: bounded(session),
        trigger: trigger.as_str().to_owned(),
    }
}

/// `field` cut to at most [`CONTEXT_FIELD_MAX_BYTES`] on a char boundary,
/// copied once.
fn bounded(field: &str) -> String {
    crate::text::prefix_within(field, CONTEXT_FIELD_MAX_BYTES).to_owned()
}

#[cfg(test)]
mod tests {
    use super::*;

    struct TmpRepo(std::path::PathBuf);

    impl TmpRepo {
        fn new(tag: &str, remote_url: &str) -> Self {
            let dir =
                std::env::temp_dir().join(format!("omp-widgets-ctx-{tag}-{}", std::process::id()));
            let _ = std::fs::remove_dir_all(&dir);
            std::fs::create_dir_all(&dir).expect("tmp dir");
            gix::init(&dir).expect("git init");
            let config = dir.join(".git/config");
            let mut text = std::fs::read_to_string(&config).expect("read config");
            text.push_str("[remote \"origin\"]\n\turl = ");
            text.push_str(remote_url);
            text.push('\n');
            std::fs::write(&config, text).expect("write config");
            Self(dir)
        }
    }

    impl Drop for TmpRepo {
        fn drop(&mut self) {
            let _ = std::fs::remove_dir_all(&self.0);
        }
    }

    #[test]
    fn plugin_context_bounds_all_but_project() {
        let long = "x".repeat(100 * 1024);
        // Longer than the field bound: the path is carried through unchanged.
        let ctx = SessionCtx {
            project: "p".repeat(3 * CONTEXT_FIELD_MAX_BYTES),
            branch: long.clone(),
            remote: long.clone(),
        };
        let c = plugin_context(&ctx, &long, Trigger::TurnEnd);
        assert_eq!(c.project, ctx.project, "project is untouched");
        for (name, field) in [
            ("branch", &c.branch),
            ("remote", &c.remote),
            ("session", &c.session),
        ] {
            assert_eq!(field.len(), CONTEXT_FIELD_MAX_BYTES, "{name} bounded");
        }
        assert_eq!(c.trigger, "turn_end");
    }

    #[test]
    fn no_project_yields_empty_context() {
        // The test process runs inside the omp-desktop checkout: an empty path
        // must not be discovered as that repository.
        assert_eq!(session_ctx(None), SessionCtx::default());
        assert_eq!(session_ctx(Some(Path::new(""))), SessionCtx::default());
    }

    #[test]
    fn outside_repo_has_project_but_empty_branch_and_remote() {
        // Its own tag: tests run in parallel threads of one process, so a name
        // shared with a `TmpRepo` would make this directory a repository.
        let dir =
            std::env::temp_dir().join(format!("omp-widgets-ctx-norepo-{}", std::process::id()));
        std::fs::create_dir_all(&dir).expect("tmp dir");
        let c = session_ctx(Some(&dir));
        let _ = std::fs::remove_dir_all(&dir);
        assert_eq!(c.project, dir.to_string_lossy());
        assert_eq!(c.branch, "");
        assert_eq!(c.remote, "");
    }

    #[test]
    fn repo_has_branch_and_fetch_url() {
        let repo = TmpRepo::new("plain", "https://example.test/o/r.git");
        let c = session_ctx(Some(&repo.0));
        assert_eq!(c.remote, "https://example.test/o/r.git");
        assert!(!c.branch.is_empty(), "{c:?}");
    }

    #[test]
    fn remote_password_is_stripped() {
        let repo = TmpRepo::new("pw", "https://u:secret@example.test/x");
        let c = session_ctx(Some(&repo.0));
        assert_eq!(c.remote, "https://u@example.test/x");
        assert!(!c.remote.contains("secret"), "{c:?}");
    }
}

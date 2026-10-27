//! Git branch and upstream remote identity, read under the spawn gate.
use std::path::Path;

#[derive(Debug, PartialEq, Eq)]
pub(super) struct LocalBranch {
    pub(super) branch: String,
    pub(super) head: String,
    pub(super) owner: String,
    pub(super) repo: String,
    pub(super) remote_ref: String,
}

pub(super) fn local_branch(folder: &Path) -> Result<LocalBranch, String> {
    let (_gate, repo) = crate::spawn_gate::discover(folder)
        .map_err(|e| format!("Could not open Git repository: {e}"))?;
    let name = repo
        .head_name()
        .map_err(|e| format!("Could not read Git branch: {e}"))?
        .ok_or_else(|| "Auto-fix requires a checked-out branch, not detached HEAD".to_string())?;
    let short = name.shorten();
    let branch = std::str::from_utf8(short.as_ref())
        .map_err(|_| "Git branch name is not UTF-8".to_string())?
        .to_owned();
    let head = repo
        .head_id()
        .map_err(|e| format!("Could not read Git HEAD: {e}"))?
        .to_string();
    let upstream = repo
        .branch_remote_ref_name(name.as_ref(), gix::remote::Direction::Fetch)
        .ok_or_else(|| "Auto-fix requires a configured upstream branch".to_string())?
        .map_err(|e| format!("Invalid upstream branch: {e}"))?;
    let remote_ref = std::str::from_utf8(upstream.as_bstr().as_ref())
        .map_err(|_| "Upstream branch name is not UTF-8".to_string())?
        .to_owned();
    if !remote_ref.starts_with("refs/heads/") {
        return Err("Auto-fix requires an upstream branch under refs/heads".into());
    }
    let remote = repo
        .branch_remote(short, gix::remote::Direction::Fetch)
        .ok_or_else(|| "Auto-fix requires a configured upstream remote".to_string())?
        .map_err(|_| "Could not read upstream remote configuration".to_string())?;
    let url = remote
        .url(gix::remote::Direction::Fetch)
        .ok_or_else(|| "Upstream remote has no fetch URL".to_string())?;
    let (owner, repo_name) = github_repo(url)?;
    Ok(LocalBranch {
        branch,
        head,
        owner,
        repo: repo_name,
        remote_ref,
    })
}

/// Read-only discovery permits ordinary absence, but never converts malformed
/// Git configuration or a failed repository read into "no PR".
pub(super) fn contextual_branch(folder: &Path) -> Result<Option<LocalBranch>, String> {
    let Some((_gate, repo)) = crate::git_browser::discover_optional(folder)? else {
        return Ok(None);
    };
    if repo.workdir().is_none() {
        return Ok(None);
    }
    let head = repo
        .head()
        .map_err(|e| format!("Could not read Git branch: {e}"))?;
    if head.is_unborn() || head.is_detached() {
        return Ok(None);
    }
    let name = head
        .referent_name()
        .ok_or_else(|| "Could not read Git branch".to_string())?;
    let short = name.shorten();
    let branch = std::str::from_utf8(short.as_ref())
        .map_err(|_| "Git branch name is not UTF-8".to_string())?
        .to_owned();
    let head = repo
        .head_id()
        .map_err(|e| format!("Could not read Git HEAD: {e}"))?
        .to_string();
    let Some(upstream) = repo.branch_remote_ref_name(name, gix::remote::Direction::Fetch) else {
        return Ok(None);
    };
    let upstream = upstream.map_err(|e| format!("Invalid upstream branch: {e}"))?;
    let remote_ref = std::str::from_utf8(upstream.as_bstr().as_ref())
        .map_err(|_| "Upstream branch name is not UTF-8".to_string())?
        .to_owned();
    if !remote_ref.starts_with("refs/heads/") {
        return Err("Auto-fix requires an upstream branch under refs/heads".into());
    }
    if repo
        .branch_remote_name(short, gix::remote::Direction::Fetch)
        .is_none()
    {
        return Ok(None);
    }
    let remote = repo
        .branch_remote(short, gix::remote::Direction::Fetch)
        .ok_or_else(|| "Configured upstream remote was not found".to_string())?
        .map_err(|e| format!("Could not read upstream remote configuration: {e}"))?;
    let url = remote
        .url(gix::remote::Direction::Fetch)
        .ok_or_else(|| "Upstream remote has no fetch URL".to_string())?;
    if !supported_github_remote(url) {
        return Ok(None);
    }
    let (owner, repo_name) = github_repo(url)?;
    Ok(Some(LocalBranch {
        branch,
        head,
        owner,
        repo: repo_name,
        remote_ref,
    }))
}

fn supported_github_remote(url: &gix::Url) -> bool {
    url.host()
        .is_some_and(|h| h.eq_ignore_ascii_case("github.com"))
        && matches!(url.scheme, gix::url::Scheme::Https | gix::url::Scheme::Ssh)
        && url
            .port
            .is_none_or(|p| Some(p) == url.scheme.default_port())
}

pub(super) fn github_repo(url: &gix::Url) -> Result<(String, String), String> {
    if !supported_github_remote(url) {
        return Err("Auto-fix supports GitHub.com HTTPS or SSH remotes only; GitHub Enterprise and other hosts are unsupported".into());
    }
    let path = std::str::from_utf8(url.path.as_ref())
        .map_err(|_| "GitHub remote path is not UTF-8".to_string())?;
    let path = path.strip_prefix('/').unwrap_or(path);
    let path = path.strip_suffix(".git").unwrap_or(path);
    let mut parts = path.split('/');
    let owner = parts.next().unwrap_or_default();
    let repo = parts.next().unwrap_or_default();
    if parts.next().is_some() || !valid_component(owner) || !valid_component(repo) {
        return Err("GitHub remote must identify one owner and repository".into());
    }
    Ok((owner.into(), repo.into()))
}

fn valid_component(s: &str) -> bool {
    !s.is_empty()
        && s.len() <= 100
        && s.bytes()
            .all(|b| b.is_ascii_alphanumeric() || matches!(b, b'-' | b'_' | b'.'))
        && s != "."
        && s != ".."
}

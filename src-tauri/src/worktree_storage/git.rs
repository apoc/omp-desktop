//! Git object preservation and no-checkout worktree mutations for recovery.
//! Repository inspection stays in gix; subprocesses are used only to export,
//! verify, import, add, or remove a worktree.

use crate::supervisor::ProcessSupervisor;
use gix::bstr::ByteSlice as _;
use ring::rand::{SecureRandom, SystemRandom};
use sha2::{Digest, Sha256};
use std::collections::HashMap;
use std::fs::{self, File, OpenOptions};
use std::io::{Read, Seek, SeekFrom, Write};
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::time::{Duration, Instant};

const MAX_PACK: u64 = 20 * 1024 * 1024 * 1024;
const MAX_OBJECT_IDS: usize = 1_000_000;
const MAX_PACK_FILES: usize = 100_000;
const TIMEOUT: Duration = Duration::from_secs(300);
const POLL: Duration = Duration::from_millis(25);

fn random_hex() -> Result<String, String> {
    let mut bytes = [0; 16];
    SystemRandom::new()
        .fill(&mut bytes)
        .map_err(|_| "cannot generate a recovery identifier".to_string())?;
    Ok(crate::json_store::hex_lower(&bytes))
}

fn object_id(value: &str) -> Result<gix::ObjectId, String> {
    gix::ObjectId::from_hex(value.as_bytes()).map_err(|_| "invalid Git object id".to_string())
}

fn validate_ids(head: &str, index_ids: &[String], extra_ids: &[String]) -> Result<(), String> {
    let head_id = object_id(head)?;
    if head_id.is_null() || index_ids.len().saturating_add(extra_ids.len()) > MAX_OBJECT_IDS {
        return Err("invalid or excessively large Git object list".to_string());
    }
    for id in index_ids.iter().chain(extra_ids) {
        let parsed = object_id(id)?;
        if parsed.is_null() || parsed.kind() != head_id.kind() {
            return Err("invalid Git object id".to_string());
        }
    }
    Ok(())
}

fn private_file(path: &Path) -> Result<File, String> {
    let mut options = OpenOptions::new();
    options.read(true).write(true).create_new(true);
    #[cfg(unix)]
    std::os::unix::fs::OpenOptionsExt::mode(&mut options, 0o600);
    let file = options
        .open(path)
        .map_err(|e| format!("cannot create private Git snapshot file: {e}"))?;
    #[cfg(target_os = "macos")]
    if let Err(error) = super::files::check_private_storage(path) {
        drop(file);
        let _ = fs::remove_file(path);
        return Err(error);
    }
    Ok(file)
}

fn open_pack(path: &Path) -> Result<File, String> {
    let path_meta =
        fs::symlink_metadata(path).map_err(|e| format!("cannot inspect Git snapshot: {e}"))?;
    if !path_meta.is_file() {
        return Err("Git snapshot is not a regular file".to_string());
    }
    let mut options = OpenOptions::new();
    options.read(true);
    #[cfg(unix)]
    std::os::unix::fs::OpenOptionsExt::custom_flags(&mut options, libc::O_NOFOLLOW);
    let file = options
        .open(path)
        .map_err(|e| format!("cannot open Git snapshot: {e}"))?;
    #[cfg(target_os = "macos")]
    super::files::check_private_storage(path)?;
    let meta = file
        .metadata()
        .map_err(|e| format!("cannot inspect Git snapshot: {e}"))?;
    if !meta.is_file() || meta.len() > MAX_PACK {
        return Err("Git snapshot is not a regular file or exceeds its size limit".to_string());
    }
    Ok(file)
}

fn hash_file(file: &mut File) -> Result<(String, u64), String> {
    file.seek(SeekFrom::Start(0))
        .map_err(|e| format!("cannot seek Git snapshot: {e}"))?;
    let mut hash = Sha256::new();
    let mut total = 0u64;
    let mut bytes = [0u8; 16 * 1024];
    loop {
        let n = match file.read(&mut bytes) {
            Ok(n) => n,
            Err(e) if e.kind() == std::io::ErrorKind::Interrupted => continue,
            Err(e) => return Err(format!("cannot read Git snapshot: {e}")),
        };
        if n == 0 {
            break;
        }
        total = total
            .checked_add(n as u64)
            .ok_or_else(|| "Git snapshot is too large".to_string())?;
        if total > MAX_PACK {
            return Err("Git snapshot exceeds its size limit".to_string());
        }
        hash.update(&bytes[..n]);
    }
    Ok((crate::json_store::hex_lower(&hash.finalize()), total))
}

pub(super) fn digest(path: &Path) -> Result<(String, u64), String> {
    hash_file(&mut open_pack(path)?)
}

fn git(dir: &Path) -> Result<Command, String> {
    if !dir.is_absolute() {
        return Err("Git repository path must be absolute".to_string());
    }
    let program = crate::child_path::locate_program(&crate::child_path::child_path_dirs(), "git")?;
    let mut command = Command::new(program.binary);
    command.current_dir(dir).env("PATH", program.path);
    for (name, _) in std::env::vars_os() {
        if name
            .to_string_lossy()
            .to_ascii_uppercase()
            .starts_with("GIT_")
        {
            command.env_remove(name);
        }
    }
    let null = if cfg!(windows) { "NUL" } else { "/dev/null" };
    command
        .env("GIT_CONFIG_NOSYSTEM", "1")
        .env("GIT_CONFIG_GLOBAL", null)
        .env("GIT_ATTR_NOSYSTEM", "1")
        .env("GIT_TERMINAL_PROMPT", "0")
        .env("GIT_NO_REPLACE_OBJECTS", "1")
        .args(["--no-optional-locks", "-c", "core.fsmonitor=false", "-c"])
        .arg(format!("core.hooksPath={null}"))
        .args([
            "-c",
            "init.templateDir=",
            "-c",
            "maintenance.auto=false",
            "-c",
            "gc.auto=0",
        ])
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null());
    Ok(command)
}

// No pipe or diagnostic capture: neither a hook nor a descendant can keep an
// output reader alive, and repository contents never enter error messages.
fn run(
    command: &mut Command,
    label: &str,
    mut check: impl FnMut() -> Result<(), String>,
) -> Result<(), String> {
    ProcessSupervisor::prepare(command);
    let mut child =
        crate::spawn_gate::spawn(command).map_err(|e| format!("cannot start {label}: {e}"))?;
    let supervisor = ProcessSupervisor::attach(&child);
    let deadline = Instant::now() + TIMEOUT;
    loop {
        let checked = check();
        if let Err(error) = checked {
            supervisor.kill_tree();
            let _ = child.kill();
            let _ = child.wait();
            return Err(error);
        }
        match child.try_wait() {
            Ok(Some(status)) => {
                supervisor.kill_tree();
                check()?;
                return if status.success() {
                    Ok(())
                } else {
                    Err(format!("{label} failed"))
                };
            }
            Ok(None) if Instant::now() < deadline => std::thread::sleep(POLL),
            Ok(None) => {
                supervisor.kill_tree();
                let _ = child.kill();
                let _ = child.wait();
                return Err(format!("{label} timed out"));
            }
            Err(e) => {
                supervisor.kill_tree();
                let _ = child.kill();
                let _ = child.wait();
                return Err(format!("cannot wait for {label}: {e}"));
            }
        }
    }
}

#[cfg(unix)]
fn limit_file_size(command: &mut Command, limit: u64) {
    use std::os::unix::process::CommandExt;
    // SAFETY: setrlimit is async-signal-safe and the closure touches no shared
    // state in the forked child. This limits each output file, including Git's
    // own temporary pack, even between monitor polls.
    unsafe {
        command.pre_exec(move || {
            let limits = libc::rlimit {
                rlim_cur: limit as libc::rlim_t,
                rlim_max: limit as libc::rlim_t,
            };
            if libc::setrlimit(libc::RLIMIT_FSIZE, &raw const limits) == 0 {
                Ok(())
            } else {
                Err(std::io::Error::last_os_error())
            }
        });
    }
}
#[cfg(not(unix))]
fn limit_file_size(_command: &mut Command, _limit: u64) {}

pub(super) fn export(
    root: &Path,
    snapshot: &Path,
    head: &str,
    index_ids: &[String],
    extra_ids: &[String],
) -> Result<(String, u64), String> {
    validate_ids(head, index_ids, extra_ids)?;
    if !snapshot.is_absolute() {
        return Err("snapshot path must be absolute".to_string());
    }
    let input_path = snapshot.join(format!("revisions-{}", random_hex()?));
    let pack_path = snapshot.join("objects.pack");
    let mut input = private_file(&input_path)?;
    let result = (|| {
        for id in std::iter::once(head).chain(index_ids.iter().chain(extra_ids).map(String::as_str))
        {
            writeln!(input, "{id}").map_err(|e| format!("cannot write Git revision list: {e}"))?;
        }
        input
            .seek(SeekFrom::Start(0))
            .map_err(|e| format!("cannot seek Git revision list: {e}"))?;
        let pack = private_file(&pack_path)?;
        let written = (|| {
            let mut command = git(root)?;
            command
                .args(["pack-objects", "--revs", "--stdout"])
                .stdin(Stdio::from(
                    input
                        .try_clone()
                        .map_err(|e| format!("cannot open Git revision list: {e}"))?,
                ))
                .stdout(Stdio::from(
                    pack.try_clone()
                        .map_err(|e| format!("cannot open Git snapshot output: {e}"))?,
                ));
            limit_file_size(&mut command, MAX_PACK);
            run(&mut command, "Git snapshot export", || {
                let len = pack
                    .metadata()
                    .map_err(|e| format!("cannot inspect Git snapshot output: {e}"))?
                    .len();
                if len > MAX_PACK {
                    Err("Git snapshot exceeds its size limit".to_string())
                } else {
                    Ok(())
                }
            })?;
            pack.sync_all()
                .map_err(|e| format!("cannot sync Git snapshot: {e}"))?;
            digest(&pack_path)
        })();
        drop(pack);
        if written.is_err() {
            let _ = fs::remove_file(&pack_path);
        }
        written
    })();
    drop(input);
    if let Err(e) = fs::remove_file(&input_path) {
        return Err(format!("cannot remove private revision list: {e}"));
    }
    result
}

fn open_repo(path: &Path) -> Result<(crate::spawn_gate::Shared, gix::Repository), String> {
    let gate = crate::spawn_gate::shared();
    let repo = gix::open_opts(path, gix::open::Options::isolated().strict_config(true))
        .map_err(|_| "cannot inspect Git repository".to_string())?;
    Ok((gate, repo))
}

// Bound the additional files index-pack creates, without counting or deleting
// existing packs owned by the repository or by another process.
fn pack_sizes(dir: &Path) -> Result<HashMap<PathBuf, u64>, String> {
    let mut result = HashMap::new();
    let entries = match fs::read_dir(dir) {
        Ok(entries) => entries,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(result),
        Err(e) => return Err(format!("cannot inspect Git pack directory: {e}")),
    };
    for entry in entries {
        let entry = entry.map_err(|e| format!("cannot inspect Git pack directory: {e}"))?;
        let kind = entry
            .file_type()
            .map_err(|e| format!("cannot inspect Git pack file: {e}"))?;
        if !kind.is_file() {
            return Err("unsupported entry in Git pack directory".to_string());
        }
        let metadata = entry
            .metadata()
            .map_err(|e| format!("cannot inspect Git pack file: {e}"))?;
        result.insert(entry.path(), metadata.len());
        if result.len() > MAX_PACK_FILES {
            return Err("Git pack directory has too many files".to_string());
        }
    }
    Ok(result)
}

fn index_pack(repo_dir: &Path, pack_dir: &Path, pack: &mut File) -> Result<(), String> {
    let before = pack_sizes(pack_dir)?;
    pack.seek(SeekFrom::Start(0))
        .map_err(|e| format!("cannot seek Git snapshot: {e}"))?;
    let mut command = git(repo_dir)?;
    command
        .args(["index-pack", "--strict", "--stdin"])
        .arg(format!("--max-input-size={MAX_PACK}"))
        .stdin(Stdio::from(
            pack.try_clone()
                .map_err(|e| format!("cannot open Git snapshot: {e}"))?,
        ));
    limit_file_size(&mut command, MAX_PACK);
    run(&mut command, "Git snapshot import", || {
        let mut growth = 0u64;
        for (path, size) in pack_sizes(pack_dir)? {
            growth =
                growth.saturating_add(size.saturating_sub(before.get(&path).copied().unwrap_or(0)));
            if growth > MAX_PACK.saturating_mul(2) {
                return Err("Git snapshot import exceeds its disk limit".to_string());
            }
        }
        Ok(())
    })
}

pub(super) fn verify(
    snapshot: &Path,
    pack_hash: &str,
    head: &str,
    index_ids: &[String],
    extra_ids: &[String],
) -> Result<(), String> {
    validate_ids(head, index_ids, extra_ids)?;
    if !snapshot.is_absolute() {
        return Err("snapshot path must be absolute".to_string());
    }
    let mut pack = open_pack(&snapshot.join("objects.pack"))?;
    if hash_file(&mut pack)?.0 != pack_hash {
        return Err("Git snapshot digest does not match".to_string());
    }
    let scratch = snapshot.join(format!("verify-{}", random_hex()?));
    crate::private_fs::private_dirs(false)
        .create(&scratch)
        .map_err(|e| format!("cannot create private verification directory: {e}"))?;
    let result = (|| {
        #[cfg(target_os = "macos")]
        super::files::check_private_storage(&scratch)?;
        let mut init = git(&scratch)?;
        let format = if head.len() == 64 { "sha256" } else { "sha1" };
        init.args([
            "init",
            "--bare",
            "--template=",
            &format!("--object-format={format}"),
            ".",
        ]);
        run(&mut init, "Git verification initialization", || Ok(()))?;
        #[cfg(target_os = "macos")]
        {
            use std::os::unix::fs::PermissionsExt as _;
            // Git creates these with its default mode; they belong solely to
            // this scratch repository and must be private before pack import.
            for dir in [scratch.join("objects"), scratch.join("objects/pack")] {
                fs::set_permissions(&dir, fs::Permissions::from_mode(0o700))
                    .map_err(|e| format!("cannot secure verification directory: {e}"))?;
                super::files::check_private_storage(&dir)?;
            }
        }
        index_pack(&scratch, &scratch.join("objects/pack"), &mut pack)?;
        let mut fsck = git(&scratch)?;
        fsck.args(["fsck", "--full", "--no-reflogs", "--no-dangling", head]);
        run(&mut fsck, "Git snapshot verification", || Ok(()))?;
        let (_gate, repo) = open_repo(&scratch)?;
        let header = repo
            .find_header(object_id(head)?)
            .map_err(|_| "snapshot HEAD object is missing".to_string())?;
        if header.kind() != gix::object::Kind::Commit {
            return Err("snapshot HEAD is not a commit".to_string());
        }
        for id in index_ids {
            let header = repo
                .find_header(object_id(id)?)
                .map_err(|_| "snapshot index object is missing".to_string())?;
            if header.kind() != gix::object::Kind::Blob {
                return Err("snapshot index object is not a blob".to_string());
            }
        }
        for id in extra_ids {
            repo.find_header(object_id(id)?)
                .map_err(|_| "snapshot metadata object is missing".to_string())?;
        }
        if hash_file(&mut pack)?.0 != pack_hash {
            return Err("Git snapshot changed during verification".to_string());
        }
        Ok(())
    })();
    crate::private_fs::remove_dir_retrying(&scratch)
        .map_err(|e| format!("cannot remove private verification directory: {e}"))?;
    result
}

pub(super) fn import(source: &Path, snapshot: &Path) -> Result<(), String> {
    let pack_dir = {
        let (_gate, repo) = open_repo(source)?;
        repo.common_dir().join("objects/pack")
    };
    let mut pack = open_pack(&snapshot.join("objects.pack"))?;
    index_pack(source, &pack_dir, &mut pack)
}

fn available_branch(
    repo: &gix::Repository,
    branch: &str,
    head: gix::ObjectId,
) -> Result<bool, String> {
    let full = format!("refs/heads/{branch}");
    let Some(mut reference) = repo
        .try_find_reference(full.as_str())
        .map_err(|_| "cannot inspect original branch".to_string())?
    else {
        return Ok(false);
    };
    if reference.target().try_name().is_some() {
        return Ok(false);
    }
    let target = reference
        .peel_to_id()
        .map_err(|_| "cannot inspect original branch".to_string())?
        .detach();
    if target != head {
        return Ok(false);
    }
    let main = repo
        .main_repo()
        .map_err(|_| "cannot inspect primary worktree".to_string())?;
    let main_head = main
        .head()
        .map_err(|_| "cannot inspect primary worktree HEAD".to_string())?;
    if main_head
        .referent_name()
        .is_some_and(|name| name.as_bstr().as_bytes() == full.as_bytes())
    {
        return Ok(false);
    }
    // Inspect every registered HEAD, including stale or inaccessible worktrees.
    // Unlike the gix proxy list this does not skip malformed registrations.
    let entries = match fs::read_dir(repo.common_dir().join("worktrees")) {
        Ok(entries) => entries,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(true),
        Err(e) => return Err(format!("cannot inspect registered worktrees: {e}")),
    };
    for entry in entries {
        let entry = entry.map_err(|e| format!("cannot inspect registered worktrees: {e}"))?;
        let kind = entry
            .file_type()
            .map_err(|e| format!("cannot inspect registered worktree: {e}"))?;
        if !kind.is_dir() {
            return Ok(false);
        }
        let mut file = File::open(entry.path().join("HEAD"))
            .map_err(|_| "cannot inspect registered worktree HEAD".to_string())?;
        let mut data = Vec::new();
        Read::by_ref(&mut file)
            .take(4097)
            .read_to_end(&mut data)
            .map_err(|_| "cannot inspect registered worktree HEAD".to_string())?;
        if data.len() > 4096 {
            return Err("registered worktree HEAD is too large".to_string());
        }
        let line = data.strip_suffix(b"\n").unwrap_or(&data);
        let line = line.strip_suffix(b"\r").unwrap_or(line);
        if let Some(name) = line.strip_prefix(b"ref: ") {
            if name == full.as_bytes() {
                return Ok(false);
            }
            if !name.starts_with(b"refs/heads/") {
                return Ok(false);
            }
        } else if std::str::from_utf8(line)
            .ok()
            .and_then(|v| object_id(v).ok())
            .is_none()
        {
            return Ok(false);
        }
    }
    Ok(true)
}

pub(super) fn add(
    source: &Path,
    dest: &Path,
    head: &str,
    original_branch: Option<&str>,
    id: &str,
) -> Result<String, String> {
    let commit = object_id(head)?;
    if commit.is_null()
        || !dest.is_absolute()
        || id.is_empty()
        || id.len() > 128
        || !id.bytes().all(|b| b.is_ascii_alphanumeric() || b == b'-')
    {
        return Err("invalid recovery worktree destination or identifier".to_string());
    }
    let original_available = {
        let (_gate, repo) = open_repo(source)?;
        if repo
            .find_header(commit)
            .map_err(|_| "recovery commit is missing".to_string())?
            .kind()
            != gix::object::Kind::Commit
        {
            return Err("recovery object is not a commit".to_string());
        }
        match original_branch {
            Some(branch) => available_branch(&repo, branch, commit)?,
            None => false,
        }
    };
    let branch = if original_available {
        original_branch
            .ok_or_else(|| "original branch is unavailable".to_string())?
            .to_string()
    } else {
        format!("omp/restore-{id}-{}", random_hex()?)
    };
    // Git accepts an existing empty directory. Create it exclusively so even an
    // empty pre-existing checkout is never adopted or overwritten.
    fs::create_dir(dest)
        .map_err(|e| format!("cannot exclusively create recovery destination: {e}"))?;
    let mut command = git(source)?;
    command.args(["worktree", "add", "--no-checkout"]);
    if !original_available {
        command.arg("-b").arg(&branch);
    }
    command.arg("--").arg(dest).arg(if original_available {
        branch.as_str()
    } else {
        head
    });
    run(&mut command, "Git recovery worktree creation", || Ok(()))?;
    let (_gate, restored) = open_repo(dest)?;
    let actual = restored
        .head_id()
        .map_err(|_| "cannot inspect restored HEAD".to_string())?
        .detach();
    let restored_head = restored
        .head()
        .map_err(|_| "cannot inspect restored branch".to_string())?;
    let full = format!("refs/heads/{branch}");
    if actual != commit
        || restored_head
            .referent_name()
            .is_none_or(|name| name.as_bstr().as_bytes() != full.as_bytes())
    {
        return Err(
            "recovery branch changed during worktree creation; checkout retained".to_string(),
        );
    }
    Ok(branch)
}

pub(super) fn remove(source: &Path, root: &Path) -> Result<(), String> {
    if !root.is_absolute() {
        return Err("worktree path must be absolute".to_string());
    }
    let mut command = git(source)?;
    command
        .args(["worktree", "remove", "--force", "--"])
        .arg(root);
    run(&mut command, "Git worktree removal", || Ok(()))
}

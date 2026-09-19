//! Per-tab omp profile registry.
//!
//! `omp --profile <id>` runs omp against an isolated tree of auth, sessions,
//! settings and caches under `~/.omp/profiles/<id>/` instead of the shared
//! `~/.omp/agent/` (verified against the installed binary: the flag wins even
//! over `PI_CODING_AGENT_DIR`). Every desktop tab owns its own omp process,
//! so every tab can run under its own profile — this module owns the list of
//! profiles the UI offers, persisted at `<app_config_dir>/profiles.json`.
//!
//! # The built-in profile
//! [`DEFAULT_PROFILE_ID`] is reserved and spawns omp with **no** `--profile`
//! flag at all, so it keeps using omp's own `~/.omp/agent` tree: an existing
//! install's auth and history stay exactly where they already are. Its
//! display `name` is renameable like any other profile; its `id` never
//! changes, so no data directory ever moves as a consequence of a rename.
//!
/// # Trust boundary
/// A profile id reaches `omp`'s argv (see `agent::spawn::omp_args`), is
/// joined into a filesystem path (see [`agent_dir`]), and — for the
/// bootstrap seed — is joined into a path that is actually written to
/// ([`seed_bootstrap`]/[`clear_bootstrap`], via [`bootstrap_path`]). So ids
/// are (a) generated here by [`slugify`] rather than taken verbatim from
/// the frontend, and (b) checked by [`validate_id`] plus membership in the
/// persisted list before any tab is allowed to spawn under one, before a
/// seed is written, or before a seed is cleared.
use std::ffi::OsStr;
use std::path::{Path, PathBuf};
use std::sync::Mutex;

/// Reserved id of the built-in profile: omp's own agent directory, spawned
/// without a `--profile` flag.
pub const DEFAULT_PROFILE_ID: &str = "default";

/// Max length of a generated profile id (also the directory name).
const MAX_ID_LEN: usize = 48;
/// Max length of a display name, after trimming.
const MAX_NAME_LEN: usize = 48;
/// Upper bound on stored profiles. A desktop user has a handful; the cap
/// exists so a runaway caller can't grow the file (or the profile list in
/// every snapshot pushed to the UI) without limit.
const MAX_PROFILES: usize = 64;

/// One selectable profile. `id` is the `--profile` value (and the directory
/// name under `~/.omp/profiles/`); `name` is the user-facing label.
#[derive(Debug, Clone, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
pub struct Profile {
    pub id: String,
    pub name: String,
}

/// On-disk shape of `profiles.json`.
#[derive(Debug, Default, serde::Serialize, serde::Deserialize)]
struct ProfilesFile {
    /// Absent (e.g. a hand-edited `{}`, or `{"startup":"work"}`) means "no
    /// profiles yet" — the same outcome as a missing file — not "corrupt".
    /// Without this, serde treats the field as required and a user who
    /// empties the file to reset their list gets it resurrected from the
    /// snapshot ring by `read_or_recover`'s corrupt-file path instead.
    #[serde(default)]
    profiles: Vec<Profile>,
    /// The profile new omp processes start in when no tab dictates otherwise
    /// (app launch, and a tab opened with no active tab to inherit from).
    /// `None` - the absent-field default, and what the built-in profile
    /// persists as - means omp's own `~/.omp/agent`.
    ///
    /// Stored as a *pointer* rather than reordering `profiles`, because the
    /// built-in entry is pinned first by [`normalize`] and ids are the join
    /// key for on-disk data: moving entries around could never express "the
    /// built-in one is the startup default" and would risk re-deriving ids.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    startup: Option<String>,
}

/// The built-in profile as it appears when nothing is persisted yet.
fn builtin() -> Profile {
    Profile {
        id: DEFAULT_PROFILE_ID.to_string(),
        name: DEFAULT_PROFILE_ID.to_string(),
    }
}

/// `true` when `id` denotes the built-in profile (empty is treated as
/// "unspecified", which means the built-in one).
pub fn is_default(id: &str) -> bool {
    id.is_empty() || id == DEFAULT_PROFILE_ID
}

/// omp's agent directory for a *resolved* profile (see
/// [`ProfileStore::resolve`]; `None` = built-in): `<home>/.omp/agent` for the
/// built-in one, `<home>/.omp/profiles/<id>/agent` for a named one. Mirrors
/// the layout the installed omp binary creates for `--profile`.
pub fn agent_dir(home: &Path, profile: Option<&str>) -> PathBuf {
    let omp = home.join(".omp");
    profile.map_or_else(
        || omp.join("agent"),
        |id| omp.join("profiles").join(id).join("agent"),
    )
}

/// Resolve the omp agent directory honouring `PI_CODING_AGENT_DIR` for the
/// **built-in** profile only — a named profile always resolves under
/// `~/.omp/profiles/<id>/agent`, matching the installed omp binary's own
/// precedence (the env var loses to `--profile`, verified against the real
/// binary). `Some("")` is treated as "unspecified" (built-in), not as a
/// named profile with an empty id — `Path::join("")` would otherwise just
/// add a trailing separator instead of falling through to the built-in path.
///
/// Shared by every reader that must agree with the installed omp binary and
/// the spawned child on where a profile's tree lives — `saved_sessions`'s
/// history panel and `keybindings`'s config reader both call this so neither
/// can silently point at a different directory than the other for the same
/// profile.
pub fn agent_dir_for(home: &Path, profile: Option<&str>, env_dir: Option<&OsStr>) -> PathBuf {
    let profile = profile.filter(|id| !id.is_empty());
    if profile.is_none() {
        if let Some(dir) = env_dir.filter(|d| !d.is_empty()) {
            return PathBuf::from(dir);
        }
    }
    agent_dir(home, profile)
}

/// The bootstrap `models.yml` seeded into a freshly created profile.
///
/// `omp --mode rpc`/`rpc-ui` is non-interactive, and omp exits at startup
/// when no model resolves (`main.ts`: `if (!isInteractive && !session.model)`
/// → `process.exit(1)`, before the RPC loop is ever entered). A new profile
/// has no credentials, so the tab's child died ~1.8s after spawn and the
/// desktop could never host the very `/login` flow that would fix it —
/// `get_login_providers` had no process left to answer.
///
/// This is the minimal file that clears that gate, established by probing
/// omp 18.2.2 directly:
/// - no file, or `providers: {}` → still exits 1 ("No models available").
/// - an *empty* file → worse: `Schema error: root: must be an object`.
/// - a known provider with `auth: none` and no `models:` key → boots,
///   emits `ready`, and answers `get_login_providers` with every provider.
///
/// `auth: none` puts the provider in omp's `keylessProviders` set, and
/// availability is `keyless || hasAuth(provider)`
/// (`model-registry.ts::#createProviderAvailabilityCheck`) — an *or*, so this
/// only *adds* the bundled catalog while unauthenticated and can never
/// suppress real credentials once they exist. The field's only other reader
/// (`#parseModels`) iterates declared `models:` entries, of which this file
/// has none, so nothing else interprets it.
///
/// Deliberately not a fake provider with a dead `baseUrl` and an invented
/// model id: that also boots, but puts a junk model in the picker and makes
/// the model chip show a name that means nothing. This way the pre-login
/// catalog is the real one.
const BOOTSTRAP_MODELS_YML: &str = "\
# Written by OMP Desktop when this profile was created.
#
# omp's RPC mode (which the desktop uses) exits at startup unless at least
# one model resolves, and a new profile has no credentials yet — so without
# this the desktop could not even run /login for it. Marking one provider
# keyless makes its bundled models resolve so omp boots; it grants no
# access and never overrides real credentials.
#
# Removed automatically after a successful login. Safe to delete by hand.
providers:
  anthropic:
    auth: none
";

/// Path of the seed file for a named profile.
fn bootstrap_path(home: &Path, id: &str) -> PathBuf {
    agent_dir(home, Some(id)).join("models.yml")
}

/// Seed [`BOOTSTRAP_MODELS_YML`] for a newly created profile so its first
/// desktop tab can reach `/login`.
///
/// Never clobbers: creation is atomic (`OpenOptions::create_new`), so an
/// existing `models.yml` — the user's, or a re-created profile id's — is
/// left exactly as found even if two callers raced to create it.
///
/// `id` must already be validated ([`validate_id`]) or resolved
/// ([`ProfileStore::resolve`]) — this joins it into a path that is then
/// written to.
///
/// # Errors
/// Returns a message when the profile's agent directory or the file cannot
/// be written.
pub fn seed_bootstrap(home: &Path, id: &str) -> Result<(), String> {
    let path = bootstrap_path(home, id);
    let dir = path
        .parent()
        .ok_or_else(|| "profile agent directory has no parent".to_string())?;
    std::fs::create_dir_all(dir).map_err(|e| format!("create {}: {e}", dir.display()))?;
    // `create_new` makes the non-clobber guarantee atomic instead of relying
    // on the `exists`-then-`write` window never being hit by two creators of
    // the same id — `AlreadyExists` is treated as the existing file winning,
    // exactly like the check this replaces.
    match std::fs::OpenOptions::new()
        .write(true)
        .create_new(true)
        .open(&path)
    {
        Ok(mut f) => std::io::Write::write_all(&mut f, BOOTSTRAP_MODELS_YML.as_bytes())
            .map_err(|e| format!("write {}: {e}", path.display())),
        Err(e) if e.kind() == std::io::ErrorKind::AlreadyExists => Ok(()),
        Err(e) => Err(format!("write {}: {e}", path.display())),
    }
}

/// Drop the seed once the profile has real credentials.
///
/// Identity is [`semantic_lines`] equality with [`BOOTSTRAP_MODELS_YML`], not
/// whole-byte equality: comparing raw bytes means any future edit to this
/// module's prose — even a typo fix in the nine purely-cosmetic comment
/// lines — permanently orphans every profile already seeded by an older
/// build, since cleanup would silently no-op forever. That orphan is not
/// inert: an orphaned seed keeps `anthropic` in omp's keyless-credential
/// pool, so a profile authed only against a different provider could still
/// default to an Anthropic model that 401s on every turn. Stripping
/// comments and blank lines before comparing keeps that pool honest across
/// prose edits while still refusing to touch a file the user has actually
/// changed — a real `models:` block, an extra field, a different
/// provider — since those show up as real differences in the projection.
/// Silent no-op when the file is absent, semantically modified, or
/// unreadable — this runs on a best-effort cleanup path, and leaving a
/// stale placeholder behind is strictly better than deleting someone's
/// model config.
///
/// `id` must already be resolved ([`ProfileStore::resolve`]) — this joins
/// it into a path that is then read and possibly removed.
pub fn clear_bootstrap(home: &Path, id: &str) {
    let path = bootstrap_path(home, id);
    let Ok(contents) = std::fs::read_to_string(&path) else {
        return;
    };
    if semantic_lines(&contents).eq(semantic_lines(BOOTSTRAP_MODELS_YML)) {
        let _ = std::fs::remove_file(&path);
    }
}

/// `s`'s lines with pure-comment (`#...`) and blank lines dropped and
/// trailing whitespace trimmed. The projection [`clear_bootstrap`] compares
/// instead of raw bytes, so the seed's comment prose can change across
/// builds without the file it already wrote becoming unrecognisable.
fn semantic_lines(s: &str) -> impl Iterator<Item = &str> {
    s.lines()
        .map(str::trim_end)
        .filter(|line| !line.is_empty() && !line.trim_start().starts_with('#'))
}

/// Reject a profile id that could escape its directory or be re-tokenised as
/// a flag by omp's argument parser: it must start with an ASCII lowercase
/// alphanumeric (which also rules out `.`/`..` and `-flag`) and contain only
/// those plus `-`, `_`, `.`.
///
/// # Errors
/// Returns a message when `id` is empty, too long, or malformed.
pub fn validate_id(id: &str) -> Result<(), String> {
    let lower_alnum = |b: u8| b.is_ascii_lowercase() || b.is_ascii_digit();
    // Windows reserves these names in *every* path component, so
    // `~/.omp/profiles/nul/agent` can't be created - and "Nul" or "Aux" are
    // names `slugify` produces from ordinary input. Rejecting here (rather
    // than letting the tab spawn and die on an uncreatable directory) also
    // makes `normalize` drop such an entry and `unique_id` suffix past it.
    // The device is matched on the portion *before the first dot*: Win32
    // resolves `nul.bak` to the NUL device too, and `slugify` preserves `.`,
    // so a profile named "NUL.bak" would otherwise reach `--profile=nul.bak`.
    let stem = id.split('.').next().unwrap_or(id);
    let reserved = matches!(stem, "con" | "prn" | "aux" | "nul")
        || (stem.len() == 4
            && (stem.starts_with("com") || stem.starts_with("lpt"))
            && stem.as_bytes()[3].is_ascii_digit());
    // Win32 strips trailing dots from path components, so a hand-edited
    // `work.` would resolve onto the existing `work` profile's directory and
    // silently share its credentials. `slugify` already trims them, so this
    // only rejects ids that never came from the UI.
    let ok = !reserved
        && !id.ends_with('.')
        && id.len() <= MAX_ID_LEN
        && id.bytes().next().is_some_and(lower_alnum)
        && id
            .bytes()
            .all(|b| lower_alnum(b) || matches!(b, b'-' | b'_' | b'.'));
    if ok {
        Ok(())
    } else {
        Err(format!("invalid profile id: {id:?}"))
    }
}

/// Trim and bound a display name.
///
/// # Errors
/// Returns a message when `name` is blank or contains control characters.
pub fn sanitize_name(name: &str) -> Result<String, String> {
    let trimmed = name.trim();
    if trimmed.is_empty() {
        return Err("profile name must not be empty".to_string());
    }
    if trimmed.chars().any(char::is_control) {
        return Err("profile name must not contain control characters".to_string());
    }
    Ok(trimmed.chars().take(MAX_NAME_LEN).collect())
}

/// Derive a filesystem/argv-safe id from a display name: ASCII-lowercased,
/// every run of unsupported characters collapsed to a single `-`, trimmed of
/// leading/trailing separators and bounded by [`MAX_ID_LEN`]. Returns
/// `"profile"` when nothing usable survives (e.g. a name that is entirely
/// non-ASCII), leaving uniquification to [`unique_id`].
pub fn slugify(name: &str) -> String {
    let mut out = String::with_capacity(name.len().min(MAX_ID_LEN));
    let mut pending_sep = false;
    for ch in name.chars() {
        if out.len() >= MAX_ID_LEN {
            break;
        }
        if !(ch.is_ascii_alphanumeric() || matches!(ch, '_' | '.')) {
            pending_sep = true;
            continue;
        }
        if pending_sep && !out.is_empty() {
            out.push('-');
        }
        pending_sep = false;
        out.push(ch.to_ascii_lowercase());
    }
    // A pushed separator can land exactly on the cap; the trim below drops
    // it along with any leading/trailing `_`/`.` (see `validate_id`).
    out.truncate(MAX_ID_LEN);
    let trimmed = out.trim_matches(|c| matches!(c, '-' | '_' | '.'));
    if trimmed.is_empty() {
        "profile".to_string()
    } else {
        trimmed.to_string()
    }
}

/// Make `base` (an ASCII slug from [`slugify`]) unique against `taken`,
/// suffixing `-2`, `-3`, … as needed. [`DEFAULT_PROFILE_ID`] is always
/// considered taken so a user-created profile can never claim the built-in
/// id and silently point a tab at `~/.omp/agent`.
///
/// Returns `None` only when every candidate is taken, which a list capped
/// below [`MAX_PROFILES`] can never cause.
pub fn unique_id(base: &str, taken: &[Profile]) -> Option<String> {
    // `validate_id` also rejects Windows reserved device stems, so a name
    // like "Nul" suffixes to `nul-2` instead of failing the create outright.
    let is_free = |candidate: &str| {
        candidate != DEFAULT_PROFILE_ID
            && validate_id(candidate).is_ok()
            && !taken.iter().any(|p| p.id == candidate)
    };
    if is_free(base) {
        return Some(base.to_string());
    }
    // Suffix the portion before the first dot, not the whole base: a base
    // whose stem is a Windows device (`nul.bak`) keeps failing `validate_id`
    // on every `nul.bak-<n>` candidate, dead-ending `create` with
    // "no free profile id" instead of falling back to `nul-2`.
    let root = base.split('.').next().unwrap_or(base);
    (2..=MAX_PROFILES + 1).find_map(|n| {
        let suffix = format!("-{n}");
        // Keep room for the `-<n>` suffix within MAX_ID_LEN.
        let stem = root.get(..MAX_ID_LEN - suffix.len()).unwrap_or(root);
        let candidate = format!("{stem}{suffix}");
        is_free(&candidate).then_some(candidate)
    })
}

/// Normalise a persisted (or freshly mutated) profile list: drop entries
/// with invalid ids or blank names, drop duplicates, force the built-in
/// profile to exist as the first entry (keeping its persisted display name),
/// and cap the list at [`MAX_PROFILES`].
fn normalize(profiles: Vec<Profile>) -> Vec<Profile> {
    let mut out: Vec<Profile> = Vec::with_capacity(profiles.len() + 1);
    out.push(builtin());
    for p in profiles {
        if p.id == DEFAULT_PROFILE_ID {
            // Built-in profile: only its display name is persisted.
            if let Ok(name) = sanitize_name(&p.name) {
                out[0].name = name;
            }
            continue;
        }
        if validate_id(&p.id).is_err() || out.iter().any(|e| e.id == p.id) {
            continue;
        }
        let Ok(name) = sanitize_name(&p.name) else {
            continue;
        };
        out.push(Profile { id: p.id, name });
        if out.len() >= MAX_PROFILES {
            break;
        }
    }
    out
}

/// Normalise the startup pointer against an already-[`normalize`]d list.
///
/// `None` means the built-in profile, and so does any pointer that no longer
/// resolves — a profile deleted by this app instance, by another one, or by a
/// hand edit. Falling back keeps launch working instead of failing every
/// spawn against a profile that isn't there; `resolve` would otherwise reject
/// it and `setup` would start with no session at all.
fn normalize_startup(startup: Option<String>, profiles: &[Profile]) -> Option<String> {
    startup
        .filter(|id| !is_default(id))
        .filter(|id| profiles.iter().any(|p| &p.id == id))
}

/// Normalise both halves of a persisted file. The startup pointer is checked
/// against the *normalised* list, so an entry dropped for an invalid id can't
/// still be the startup default.
fn normalize_file(file: ProfilesFile) -> ProfilesFile {
    let profiles = normalize(file.profiles);
    let startup = normalize_startup(file.startup, &profiles);
    ProfilesFile { profiles, startup }
}

/// The profile list, cached in memory and persisted as JSON.
///
/// Mutations re-read the file under an advisory lock before writing, so a
/// second app instance adding a profile concurrently can't have its entry
/// clobbered by this one's cached copy.
pub struct ProfileStore {
    path: PathBuf,
    snapshots: PathBuf,
    lock: PathBuf,
    /// The list and the startup pointer behind **one** mutex, not two.
    /// `startup_id()` is documented to always name a member of the list
    /// `snapshot()` returns, and
    /// two separate locks cannot honour that: a reader interleaving between
    /// them would see a pointer from after a mutation and a list from before
    /// it. `ProfileList` ships both in one IPC payload for the same reason.
    cache: Mutex<ProfilesFile>,
}

impl ProfileStore {
    /// Load the store at `path` (`<app_config_dir>/profiles.json`). A missing
    /// file yields just the built-in profile - the list is UI convenience
    /// state, never worth failing startup over. A *corrupt* file is recovered
    /// from the snapshot ring; see [`read_or_recover`]. The corrupt primary
    /// is deliberately left on disk here — `load` has no upcoming write to
    /// quarantine it before, and renaming it away with nothing to replace it
    /// would strand a process that never mutates again this run with
    /// neither a primary nor (once the ring prunes past it) a snapshot to
    /// recover from on the next launch. [`ProfileStore::mutate`] performs
    /// the quarantine instead, immediately before it writes a replacement.
    pub fn load(path: PathBuf) -> Self {
        let snapshots = path.with_extension("snapshots");
        let lock = path.with_extension("lock");
        let (file, _corrupt_primary) =
            read_or_recover(&path, &Self::snapshot_ring(&snapshots)).unwrap_or_default();
        let file = normalize_file(file);
        Self {
            path,
            snapshots,
            lock,
            cache: Mutex::new(file),
        }
    }

    /// Consume the store and yield its file path.
    ///
    /// Exists so a test can drop the store - releasing its in-memory cache -
    /// and reopen the same file to assert what was persisted, *without*
    /// cloning the path. `let path = store.path.clone(); drop(store);` is the
    /// same thing with an allocation and two lines.
    #[cfg(test)]
    fn into_path(self) -> PathBuf {
        self.path
    }

    /// A second store over the same file, as a separate app instance would
    /// see it. One clone, here, instead of one per callsite: `load` needs an
    /// owned `PathBuf` and this store keeps using its own.
    #[cfg(test)]
    fn reopen(&self) -> Self {
        Self::load(self.path.clone())
    }

    /// Past versions of `profiles.json`, consulted only when the primary file
    /// exists but fails to parse. Mirrors `approval::RuleBook`'s ring.
    fn snapshot_ring(dir: &Path) -> crate::json_store::SnapshotRing {
        crate::json_store::SnapshotRing::new(dir.to_path_buf(), 8)
    }

    /// The list and the startup default together, read under **one**
    /// `cache` lock — see the field's doc comment for why two separate
    /// locks cannot guarantee the id names a member of the list. This is
    /// the store's only read accessor for the list: `list_profiles` is its
    /// only IPC-facing read, so this is its single source of truth.
    pub fn snapshot(&self) -> (Vec<Profile>, String) {
        self.cache.lock().map_or_else(
            |_| (vec![builtin()], DEFAULT_PROFILE_ID.to_string()),
            |c| {
                // Both fields are borrowed from the guard, which drops at
                // the end of this closure — the caller needs owned data to
                // outlive it, and to serialise into the IPC response.
                let profiles = c.profiles.clone();
                let startup_id = c
                    .startup
                    .as_deref()
                    .map_or_else(|| DEFAULT_PROFILE_ID.to_string(), ToString::to_string);
                (profiles, startup_id)
            },
        )
    }

    /// Resolve a profile id arriving over IPC — the one place a raw string
    /// becomes a profile. Blank/`"default"` resolve to `None` (the built-in
    /// profile, spawned without `--profile`); anything else must be a profile
    /// the user actually created, so a tab can neither invent a profile
    /// directory nor smuggle a path/flag into omp's argv. Membership implies
    /// a valid id: [`normalize`] drops invalid ones on every load/mutation.
    ///
    /// # Errors
    /// Returns a message when `profile` names no listed profile.
    pub fn resolve<'a>(&self, profile: Option<&'a str>) -> Result<Option<&'a str>, String> {
        match profile.filter(|id| !is_default(id)) {
            None => Ok(None),
            Some(id) if self.contains(id) => Ok(Some(id)),
            Some(id) => Err(format!("unknown profile: {id:?}")),
        }
    }

    /// `true` when `id` is selectable: the built-in profile, or a persisted
    /// one.
    pub fn contains(&self, id: &str) -> bool {
        if is_default(id) {
            return true;
        }
        self.cache
            .lock()
            .is_ok_and(|c| c.profiles.iter().any(|e| e.id == id))
    }

    /// Create a profile named `name`, deriving its id with [`slugify`] +
    /// [`unique_id`]. Returns the created profile.
    ///
    /// # Errors
    /// Returns a message when `name` is blank/invalid, the list is already at
    /// [`MAX_PROFILES`], or the list can't be persisted.
    pub fn create(&self, name: &str) -> Result<Profile, String> {
        let name = sanitize_name(name)?;
        self.mutate(|file| {
            let profiles = &mut file.profiles;
            if profiles.len() >= MAX_PROFILES {
                return Err(format!("profile limit reached ({MAX_PROFILES})"));
            }
            let id = unique_id(&slugify(&name), profiles)
                .ok_or_else(|| "no free profile id".to_string())?;
            let created = Profile { id, name };
            // One copy is unavoidable: the list keeps the entry and the
            // caller needs it back for the IPC response.
            profiles.push(created.clone());
            Ok(created)
        })
    }

    /// Rename an existing profile. Only the display name changes — the id
    /// (and therefore omp's data directory) is immutable, which is what makes
    /// renaming the built-in profile safe.
    ///
    /// # Errors
    /// Returns a message when `id` is unknown, `name` is blank/invalid, or
    /// the list can't be persisted.
    pub fn rename(&self, id: &str, name: &str) -> Result<Profile, String> {
        let name = sanitize_name(name)?;
        let id = if is_default(id) {
            DEFAULT_PROFILE_ID
        } else {
            id
        };
        self.mutate(|file| {
            let entry = file
                .profiles
                .iter_mut()
                .find(|p| p.id == id)
                .ok_or_else(|| format!("unknown profile: {id:?}"))?;
            entry.name = name;
            // Borrowed from the list being persisted, so the response needs
            // its own copy.
            Ok(entry.clone())
        })
    }

    /// Remove a profile from the selectable list.
    ///
    /// **Deliberately does not touch `~/.omp/profiles/<id>/` on disk.** That
    /// tree holds real credentials and session history; a desktop menu
    /// click is the wrong gate for an irreversible `rm -rf` of it. Removing
    /// the entry unlists the profile — recreating it under the same name
    /// yields the same slug and therefore re-adopts the existing directory.
    ///
    /// The built-in profile cannot be removed: it is omp's own
    /// `~/.omp/agent` tree and the fallback every tab resolves to.
    ///
    /// # Errors
    /// Returns a message when `id` is the built-in profile, unknown, or the
    /// list can't be persisted.
    pub fn remove(&self, id: &str) -> Result<(), String> {
        if is_default(id) {
            return Err("the default profile cannot be deleted".to_string());
        }
        self.mutate(|file| {
            let before = file.profiles.len();
            file.profiles.retain(|p| p.id != id);
            if file.profiles.len() == before {
                return Err(format!("unknown profile: {id:?}"));
            }
            // The pointer is re-normalised by `mutate` before the write, so
            // deleting the startup profile falls the default back to the
            // built-in one rather than persisting a dangling id.
            Ok(())
        })
    }

    /// The id new processes start in when no tab dictates otherwise. Always a
    /// listed profile: the pointer is re-validated on load and on every
    /// mutation, so a deleted startup profile reads back as the built-in one.
    pub fn startup_id(&self) -> String {
        self.cache
            .lock()
            .ok()
            // Owned: the guard drops at the end of this expression, so the
            // id cannot be returned by reference.
            .and_then(|c| c.startup.as_deref().map(str::to_owned))
            .unwrap_or_else(|| DEFAULT_PROFILE_ID.to_string())
    }

    /// Choose the profile new processes start in. `"default"`/blank selects
    /// the built-in profile, which is stored as an absent pointer.
    ///
    /// Running tabs are untouched: a profile is fixed at spawn, so this only
    /// affects processes started from here on.
    ///
    /// # Errors
    /// Returns a message when `id` names no listed profile, or the list
    /// can't be persisted.
    pub fn set_startup(&self, id: &str) -> Result<(), String> {
        // Same gate as `resolve`: the pointer is persisted and later fed to
        // omp's argv, so it must name a profile the user actually created.
        let next = self.resolve(Some(id))?.map(ToString::to_string);
        self.mutate(|file| {
            // Re-check inside the lock: another instance may have deleted the
            // profile since `resolve`, and persisting a dangling pointer would
            // make every subsequent launch fall back silently.
            if let Some(want) = next.as_deref() {
                if !file.profiles.iter().any(|p| p.id == want) {
                    return Err(format!("unknown profile: {want:?}"));
                }
            }
            file.startup = next;
            Ok(())
        })
    }

    /// Run `f` over the on-disk file under the advisory lock, then persist it
    /// and refresh the in-memory cache. Re-reading inside the lock is what
    /// makes concurrent mutations (two app instances) additive instead of
    /// last-writer-wins.
    fn mutate<T>(
        &self,
        f: impl FnOnce(&mut ProfilesFile) -> Result<T, String>,
    ) -> Result<T, String> {
        // `with_lock_str` creates the lock's (= this file's) parent directory.
        crate::json_store::with_lock_str(&self.lock, || {
            // Normalised on read; `f` only inserts sanitised names and
            // slug-derived ids, so the result needs no second pass. A read
            // error (permissions, I/O) aborts here rather than persisting a
            // list assembled from nothing - that would unlist every profile
            // the user has, and their ids are slug-derived, so re-adoption
            // would need the exact original names back.
            let ring = Self::snapshot_ring(&self.snapshots);
            let (file, corrupt_primary) = read_or_recover(&self.path, &ring)?;
            let mut file = normalize_file(file);
            let value = f(&mut file)?;
            // `f` may have removed the profile the pointer named (or pointed
            // it at the built-in one), so re-normalise before persisting:
            // a dangling pointer must never reach disk.
            file.startup = normalize_startup(file.startup, &file.profiles);
            // The built-in profile's id is implicit, but persisting it keeps
            // its renamed label across restarts.
            let bytes =
                serde_json::to_vec_pretty(&file).map_err(|e| format!("serialize profiles: {e}"))?;
            // Snapshot the *incoming* bytes, like `approval::RuleBook` does:
            // the ring's job is to recover whatever should currently be on
            // disk if the primary file is later found corrupt.
            let _ = ring.snapshot(&bytes);
            if corrupt_primary {
                // `read_or_recover` found the primary corrupt and recovered
                // `file` from the ring instead of it. Quarantine the bad
                // bytes now, immediately before the write below replaces
                // them — the ring snapshot above already holds a good copy,
                // so this is the last moment the *original* corrupt bytes
                // are recoverable for hand repair. Best-effort, mirrors
                // `read_or_recover`'s own note: a failed rename must not
                // fail the mutation, since `file` already stands in for the
                // primary either way.
                let _ = std::fs::rename(&self.path, self.path.with_extension("json.corrupt"));
            }
            crate::json_store::write_atomic(&self.path, &bytes)
                .map_err(|e| format!("write profiles: {e}"))?;
            // Refresh the cache *inside* the advisory lock, like
            // `approval::RuleBook::mutate_project_rules`. Outside it, two
            // overlapping mutations can commit their cache writes in the
            // opposite order to their disk writes: a `set_startup("work")`
            // preempted here, overtaken by a `remove("work")`, would resume
            // and republish its stale snapshot - leaving `startup_id()`
            // naming a profile absent from the list `snapshot()` returns
            // until the next mutation.
            if let Ok(mut cached) = self.cache.lock() {
                *cached = file;
            }
            Ok(value)
        })
    }
}

/// Read and parse `path`, reporting whether the primary was found corrupt
/// (present, but unparseable) so a caller about to replace it can quarantine
/// the bad bytes first.
///
/// Three outcomes, deliberately distinguished:
/// - missing -> `Ok((ProfilesFile::default(), false))` ("nothing persisted
///   yet").
/// - present but unparseable -> `Ok((recovered, true))`, `recovered` being
///   the newest good version from `ring`, or empty if the ring has nothing.
///   Mirrors `approval::RuleBook::load_project_rules`: the ring applies
///   *only* to a corrupt primary file, never a missing one.
/// - unreadable (permissions, I/O error) -> `Err`. This is the case a
///   mutation must not paper over: treating it as "no profiles" and writing
///   would silently unlist every profile the user has.
///
/// Quarantining the corrupt primary is deliberately **not** done here: this
/// function holds no lock and has no upcoming write, so renaming it aside
/// with nothing to replace it would strand a process that never mutates
/// again this run (or crashes before it does) with neither a primary nor —
/// once the ring prunes past this snapshot — a `Some` from the ring on the
/// next launch. That is exactly the "permanent loss of the list instead of
/// a retry on the next launch" this module's history warns against. Callers
/// that are about to write a real replacement (`ProfileStore::mutate`,
/// under the advisory lock) use the returned flag to quarantine themselves,
/// immediately before that write; `ProfileStore::load` (no upcoming write)
/// leaves the corrupt primary in place, so recovery is re-derived from the
/// ring on every subsequent load until a real mutation happens — reading
/// never mutates the ring, so this is idempotent across any number of
/// loads.
///
/// # Errors
/// Returns an error when `path` exists but cannot be read.
fn read_or_recover(
    path: &Path,
    ring: &crate::json_store::SnapshotRing,
) -> Result<(ProfilesFile, bool), String> {
    let bytes = match std::fs::read(path) {
        Ok(bytes) => bytes,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => {
            return Ok((ProfilesFile::default(), false));
        }
        Err(e) => return Err(format!("read profiles: {e}")),
    };
    if let Ok(file) = serde_json::from_slice::<ProfilesFile>(&bytes) {
        return Ok((file, false));
    }
    // A ring *read* failure is not "no snapshot": `%APPDATA%` is commonly held
    // open by a roaming/cloud-sync agent, and a partial sync is exactly what
    // corrupts the primary file in the first place - so both halves fail
    // together rather than independently. Collapsing that to an empty list
    // would unlist every profile and then push the near-empty bytes into the
    // retain-8 ring, pruning the last good snapshot after eight more
    // mutations. `Ok(None)` (ring genuinely empty) still falls back to
    // builtin-only, which is the documented corrupt-with-no-history outcome.
    let recovered = ring
        .restore_latest()
        .map_err(|e| format!("read profile snapshots: {e}"))?;
    Ok((
        recovered
            .and_then(|b| serde_json::from_slice::<ProfilesFile>(&b).ok())
            .unwrap_or_default(),
        true,
    ))
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::atomic::{AtomicU64, Ordering};

    static TEST_COUNTER: AtomicU64 = AtomicU64::new(0);

    /// Removes a test's scratch directory on drop, independent of the
    /// `ProfileStore` built over it: several tests call `into_path`, which
    /// consumes the store, so tying cleanup to the store itself would
    /// delete the directory mid-test instead of at scope exit. Callers keep
    /// the returned guard bound (even as `_scratch`) for the test's
    /// duration; `ProfileStore::into_path`'s callers are unaffected because
    /// this is a separate binding, not a field of the store.
    struct ScratchGuard(PathBuf);

    impl Drop for ScratchGuard {
        fn drop(&mut self) {
            let _ = std::fs::remove_dir_all(&self.0);
        }
    }

    impl ScratchGuard {
        /// The scratch directory, usable as a fake `$HOME` by tests that
        /// exercise the on-disk profile layout (`agent_dir`, the bootstrap
        /// seed) rather than just the list file.
        fn path(&self) -> &Path {
            &self.0
        }
    }

    fn scratch_store() -> (ProfileStore, ScratchGuard) {
        let n = TEST_COUNTER.fetch_add(1, Ordering::Relaxed);
        let dir = std::env::temp_dir().join(format!(
            "omp-desktop-profile-test-{}-{n}",
            std::process::id()
        ));
        std::fs::create_dir_all(&dir).expect("create scratch dir");
        let store = ProfileStore::load(dir.join("profiles.json"));
        (store, ScratchGuard(dir))
    }

    #[test]
    fn concurrent_stores_are_additive_not_last_writer_wins() {
        // Two app instances on one file. `b`'s cache is stale the moment `a`
        // writes, so this only passes because `mutate` re-reads inside the
        // lock rather than persisting its cached list.
        let (a, _scratch) = scratch_store();
        let b = a.reopen();
        a.create("X").expect("a creates X");
        b.create("Y").expect("b creates Y");

        let ids: Vec<String> = ProfileStore::load(a.path)
            .snapshot()
            .0
            .into_iter()
            .map(|p| p.id)
            .collect();
        assert_eq!(ids, vec![DEFAULT_PROFILE_ID, "x", "y"]);
    }

    #[test]
    fn persisted_invalid_ids_are_dropped_and_never_resolve() {
        // A hand-edited (or tampered) profiles.json is the one path by which an
        // id that never passed `validate_id` could reach `--profile=` and
        // `agent_dir`. `normalize` on load is the gate; this pins the join.
        let (store, _scratch) = scratch_store();
        let path = store.into_path();
        std::fs::write(
            &path,
            br#"{"profiles":[{"id":"../../etc","name":"escape"},{"id":"ok","name":"Ok"}]}"#,
        )
        .expect("write hand-edited store");

        let reloaded = ProfileStore::load(path);
        let ids: Vec<String> = reloaded.snapshot().0.into_iter().map(|p| p.id).collect();
        assert_eq!(ids, vec![DEFAULT_PROFILE_ID, "ok"]);
        assert!(reloaded.resolve(Some("../../etc")).is_err());
    }

    #[test]
    fn corrupt_store_is_recovered_from_the_snapshot_ring() {
        let (store, _scratch) = scratch_store();
        store.create("Work").expect("create work");
        // A truncated/garbled file (disk full, partial cloud sync) - the ring
        // holds the last good version, so the profile is not silently unlisted.
        std::fs::write(&store.path, b"{\"profiles\":[").expect("corrupt the store");

        let reloaded = store.reopen();
        let ids: Vec<String> = reloaded.snapshot().0.into_iter().map(|p| p.id).collect();
        assert_eq!(ids, vec![DEFAULT_PROFILE_ID, "work"]);

        // `load` never writes, so the primary is still the same corrupt
        // bytes: a second launch with no mutation in between must re-derive
        // the same recovery from the ring rather than reading back a
        // primary that a first load already emptied or removed.
        let reloaded_again = store.reopen();
        let ids_again: Vec<String> = reloaded_again
            .snapshot()
            .0
            .into_iter()
            .map(|p| p.id)
            .collect();
        assert_eq!(
            ids_again,
            vec![DEFAULT_PROFILE_ID, "work"],
            "recovery must survive a reload with no mutation in between"
        );

        // The first mutation after recovery must persist what the ring
        // restored, not overwrite it with an empty list read from the
        // (still corrupt) primary.
        reloaded_again.create("Extra").expect("create extra");
        let ids_after_mutate: Vec<String> = store
            .reopen()
            .snapshot()
            .0
            .into_iter()
            .map(|p| p.id)
            .collect();
        assert_eq!(
            ids_after_mutate,
            vec![DEFAULT_PROFILE_ID, "work", "extra"],
            "a mutation after recovery must not drop the profiles the ring restored"
        );
    }

    #[test]
    fn mutate_refuses_to_persist_over_an_unreadable_store() {
        // Reading a directory fails with something other than NotFound on every
        // platform, standing in for a permissions/IO failure. The list must not
        // be rewritten from an empty read - that would unlist every profile.
        let (store, _scratch) = scratch_store();
        let path = store.into_path();
        std::fs::create_dir_all(&path).expect("occupy the store path");

        let store = ProfileStore::load(path);
        assert!(store.create("Work").is_err());
    }

    #[test]
    fn agent_dir_isolates_named_profiles_only() {
        let home = Path::new("/home/u");
        assert_eq!(agent_dir(home, None), Path::new("/home/u/.omp/agent"));
        assert_eq!(
            agent_dir(home, Some("work")),
            Path::new("/home/u/.omp/profiles/work/agent")
        );
    }

    #[test]
    fn seed_bootstrap_writes_the_file_a_new_profile_needs_to_boot() {
        let (store, scratch) = scratch_store();
        let home = scratch.path();
        store.create("Work").expect("create work");
        seed_bootstrap(home, "work").expect("seed");
        let written = std::fs::read_to_string(agent_dir(home, Some("work")).join("models.yml"))
            .expect("seed file must exist under the profile's own agent dir");
        assert_eq!(written, BOOTSTRAP_MODELS_YML);
        // The property that makes omp boot at all: exactly one keyless
        // provider, and no custom `models:` block to be misinterpreted.
        assert!(written.contains("auth: none"));
        assert!(!written.contains("models:"));
    }

    #[test]
    fn seed_bootstrap_never_clobbers_an_existing_models_yml() {
        // A re-created id (or a user who wrote their own config first) must
        // keep their file: overwriting it would silently drop real providers.
        let (_store, scratch) = scratch_store();
        let home = scratch.path();
        let dir = agent_dir(home, Some("work"));
        std::fs::create_dir_all(&dir).expect("mkdir");
        std::fs::write(
            dir.join("models.yml"),
            "providers:\n  mine:\n    auth: none\n",
        )
        .expect("write");
        seed_bootstrap(home, "work").expect("seed is a no-op here");
        assert_eq!(
            std::fs::read_to_string(dir.join("models.yml")).expect("read"),
            "providers:\n  mine:\n    auth: none\n"
        );
    }

    #[test]
    fn clear_bootstrap_removes_only_our_own_untouched_seed() {
        let (_store, scratch) = scratch_store();
        let home = scratch.path();
        let path = agent_dir(home, Some("work")).join("models.yml");

        seed_bootstrap(home, "work").expect("seed");
        clear_bootstrap(home, "work");
        assert!(!path.exists(), "an untouched seed must be cleaned up");

        // Edited by the user: now it is their config, and post-login cleanup
        // must not delete it.
        let edited = format!("{BOOTSTRAP_MODELS_YML}    baseUrl: http://localhost:11434/v1\n");
        std::fs::write(&path, &edited).expect("write");
        clear_bootstrap(home, "work");
        assert_eq!(
            std::fs::read_to_string(&path).expect("edited file must survive"),
            edited
        );
    }

    #[test]
    fn clear_bootstrap_survives_a_cosmetic_edit_to_the_templates_prose() {
        // A future typo fix or reworded rationale in the nine purely-cosmetic
        // comment lines must not permanently orphan every profile already
        // seeded by an older build: cleanup compares the YAML this file
        // actually contributes, not its comment prose.
        let (_store, scratch) = scratch_store();
        let home = scratch.path();
        let path = agent_dir(home, Some("work")).join("models.yml");
        let older_build_seed = BOOTSTRAP_MODELS_YML.replace(
            "# Removed automatically after a successful login. Safe to delete by hand.",
            "# Deleted automatically once you have logged in. Safe to remove by hand.",
        );
        assert_ne!(
            older_build_seed, BOOTSTRAP_MODELS_YML,
            "the fixture must actually differ in prose for this test to mean anything"
        );
        std::fs::create_dir_all(agent_dir(home, Some("work"))).expect("mkdir");
        std::fs::write(&path, &older_build_seed).expect("write older-build seed");

        clear_bootstrap(home, "work");
        assert!(
            !path.exists(),
            "a cosmetic prose difference must not orphan the seed"
        );
    }

    #[test]
    fn clear_bootstrap_is_a_no_op_when_there_is_no_file() {
        // Runs after every successful login, including for profiles that were
        // never seeded (created before this existed, or already authed).
        let (_store, scratch) = scratch_store();
        clear_bootstrap(scratch.path(), "work");
        assert!(
            !agent_dir(scratch.path(), Some("work")).exists(),
            "cleanup must not create the profile tree it was asked to clean"
        );
    }

    #[test]
    fn validate_id_rejects_traversal_and_flag_shapes() {
        assert!(validate_id("work").is_ok());
        assert!(validate_id("work-2").is_ok());
        assert!(validate_id("2work").is_ok());
        for bad in [
            "",
            ".",
            "..",
            "../etc",
            "-work",
            "--auto-approve",
            "Work",
            "wo rk",
            "work/sub",
            "work\\sub",
        ] {
            assert!(validate_id(bad).is_err(), "expected reject: {bad:?}");
        }
        assert!(validate_id(&"a".repeat(MAX_ID_LEN + 1)).is_err());
    }

    #[test]
    fn slugify_produces_valid_ids() {
        assert_eq!(slugify("Work"), "work");
        assert_eq!(slugify("  Home  Laptop "), "home-laptop");
        assert_eq!(slugify("client/acme (2024)"), "client-acme-2024");
        assert_eq!(slugify("--danger--"), "danger");
        assert_eq!(slugify("...."), "profile");
        assert_eq!(slugify("日本語"), "profile");
        assert_eq!(slugify(&"x".repeat(80)).len(), MAX_ID_LEN);
        // A separator landing on the cap is trimmed, not kept dangling.
        let at_cap = format!("{} y", "x".repeat(MAX_ID_LEN - 1));
        assert_eq!(slugify(&at_cap), "x".repeat(MAX_ID_LEN - 1));
        for name in ["Work", "  Home  Laptop ", "client/acme (2024)", "日本語"] {
            assert!(validate_id(&slugify(name)).is_ok(), "slug of {name:?}");
        }
    }

    #[test]
    fn unique_id_avoids_collisions_and_the_reserved_id() {
        let taken = vec![
            Profile {
                id: "work".into(),
                name: "work".into(),
            },
            Profile {
                id: "work-2".into(),
                name: "work two".into(),
            },
        ];
        assert_eq!(unique_id("home", &taken).as_deref(), Some("home"));
        assert_eq!(unique_id("work", &taken).as_deref(), Some("work-3"));
        assert_eq!(unique_id("default", &taken).as_deref(), Some("default-2"));
        // Windows device stems are unusable as a path component, so they are
        // never handed out as ids - `slugify("Nul")` is exactly "nul".
        assert_eq!(unique_id("nul", &taken).as_deref(), Some("nul-2"));
        assert_eq!(unique_id("com1", &taken).as_deref(), Some("com1-2"));
        assert_eq!(unique_id("common", &taken).as_deref(), Some("common"));
        // A full-length base is shortened to fit the suffix.
        let long = "x".repeat(MAX_ID_LEN);
        let taken = vec![Profile {
            // `long` is borrowed again by `unique_id` below, so the entry
            // needs its own copy.
            id: long.clone(),
            name: "long".into(),
        }];
        let id = unique_id(&long, &taken).expect("free id");
        assert_eq!(id.len(), MAX_ID_LEN);
        assert!(id.ends_with("-2"));
    }

    #[test]
    fn sanitize_name_trims_and_rejects_blank() {
        assert_eq!(sanitize_name("  work  ").unwrap(), "work");
        assert!(sanitize_name("   ").is_err());
        assert!(sanitize_name("bad\nname").is_err());
        assert_eq!(
            sanitize_name(&"n".repeat(MAX_NAME_LEN + 10)).unwrap().len(),
            MAX_NAME_LEN
        );
    }

    #[test]
    fn normalize_seeds_builtin_and_drops_junk() {
        let list = normalize(vec![
            Profile {
                id: "../escape".into(),
                name: "escape".into(),
            },
            Profile {
                id: "work".into(),
                name: "Work".into(),
            },
            Profile {
                id: "work".into(),
                name: "dup".into(),
            },
            Profile {
                id: "default".into(),
                name: "Personal".into(),
            },
        ]);
        assert_eq!(
            list,
            vec![
                Profile {
                    id: "default".into(),
                    name: "Personal".into()
                },
                Profile {
                    id: "work".into(),
                    name: "Work".into()
                },
            ]
        );
    }

    #[test]
    fn create_persists_and_is_visible_to_a_fresh_store() {
        let (store, _scratch) = scratch_store();
        let created = store.create("Work Laptop").expect("create");
        assert_eq!(created.id, "work-laptop");
        assert!(store.contains("work-laptop"));

        let reloaded = store.reopen();
        assert_eq!(reloaded.snapshot().0, store.snapshot().0);
        assert_eq!(
            reloaded
                .snapshot()
                .0
                .iter()
                .map(|p| p.id.as_str())
                .collect::<Vec<_>>(),
            vec!["default", "work-laptop"]
        );
    }

    #[test]
    fn create_uniquifies_ids_derived_from_the_same_name() {
        let (store, _scratch) = scratch_store();
        let a = store.create("Work").expect("create a");
        let b = store.create("work").expect("create b");
        assert_eq!(a.id, "work");
        assert_eq!(b.id, "work-2");
        assert_eq!(b.name, "work");
    }

    #[test]
    fn rename_keeps_the_id_stable_including_for_the_builtin() {
        let (store, _scratch) = scratch_store();
        let created = store.create("Work").expect("create");
        let renamed = store.rename(&created.id, "Client").expect("rename");
        assert_eq!(renamed.id, "work");
        assert_eq!(renamed.name, "Client");

        let builtin = store
            .rename(DEFAULT_PROFILE_ID, "Personal")
            .expect("rename builtin");
        assert_eq!(builtin.id, DEFAULT_PROFILE_ID);
        assert_eq!(builtin.name, "Personal");
        // Reload proves the built-in rename persisted without moving its id.
        let reloaded = store.reopen();
        drop(store);
        assert_eq!(reloaded.snapshot().0[0].name, "Personal");
        assert_eq!(reloaded.snapshot().0[0].id, DEFAULT_PROFILE_ID);
    }

    #[test]
    fn rename_rejects_unknown_profile() {
        let (store, _scratch) = scratch_store();
        assert!(store.rename("ghost", "X").is_err());
        assert!(!store.contains("ghost"));
    }

    #[test]
    fn resolve_maps_builtin_ids_to_no_flag() {
        let (store, _scratch) = scratch_store();
        assert_eq!(store.resolve(None), Ok(None));
        assert_eq!(store.resolve(Some("")), Ok(None));
        assert_eq!(store.resolve(Some(DEFAULT_PROFILE_ID)), Ok(None));
    }

    #[test]
    fn resolve_accepts_only_created_profiles() {
        let (store, _scratch) = scratch_store();
        // Not created yet: a tab must not be able to materialise a profile
        // directory (or an argv value) the user never asked for.
        assert!(store.resolve(Some("work")).is_err());
        let created = store.create("Work").expect("create");
        assert_eq!(store.resolve(Some(&created.id)), Ok(Some("work")));
        for bad in ["../etc", "--auto-approve", "work/sub", "..", "Work"] {
            assert!(
                store.resolve(Some(bad)).is_err(),
                "expected reject: {bad:?}"
            );
        }
    }

    #[test]
    fn contains_accepts_builtin_but_not_uncreated_ids() {
        let (store, _scratch) = scratch_store();
        assert!(store.contains(DEFAULT_PROFILE_ID));
        assert!(store.contains(""));
        assert!(!store.contains("work"));
    }

    #[test]
    fn remove_unlists_the_profile_and_persists() {
        let (store, _scratch) = scratch_store();
        let work = store.create("Work").expect("create work");
        store.create("Home").expect("create home");
        store.remove(&work.id).expect("remove");
        assert!(!store.contains("work"));
        assert!(store.contains("home"));
        let path = store.into_path();
        assert_eq!(
            ProfileStore::load(path)
                .snapshot()
                .0
                .into_iter()
                .map(|p| p.id)
                .collect::<Vec<_>>(),
            vec!["default".to_string(), "home".to_string()]
        );
    }

    #[test]
    fn remove_leaves_the_data_directory_alone_so_recreating_readopts_it() {
        // Removing only unlists: the same name slugifies to the same id, so
        // the profile comes back pointing at its existing ~/.omp/profiles
        // tree rather than a fresh one.
        let (store, _scratch) = scratch_store();
        let first = store.create("Work").expect("create");
        store.remove(&first.id).expect("remove");
        let again = store.create("Work").expect("recreate");
        assert_eq!(again.id, first.id);
    }

    #[test]
    fn remove_refuses_the_builtin_and_unknown_profiles() {
        let (store, _scratch) = scratch_store();
        assert!(store.remove(DEFAULT_PROFILE_ID).is_err());
        assert!(store.remove("").is_err());
        assert!(store.remove("ghost").is_err());
        assert!(store.remove("../etc").is_err());
        assert!(store.contains(DEFAULT_PROFILE_ID));
    }

    #[test]
    fn corrupt_store_file_falls_back_to_builtin_only() {
        let (store, _scratch) = scratch_store();
        std::fs::write(&store.path, b"not json").expect("write corrupt");
        let reloaded = ProfileStore::load(store.into_path());
        assert_eq!(reloaded.snapshot().0, vec![builtin()]);
        // And a mutation still succeeds, overwriting the corrupt file.
        assert!(reloaded.create("Work").is_ok());
        assert!(reloaded.reopen().contains("work"));
    }

    #[test]
    fn create_enforces_max_profiles_and_the_cap_survives_a_reload() {
        let (store, _scratch) = scratch_store();
        // The builtin occupies one slot, so MAX_PROFILES - 1 creates fill it.
        for n in 0..MAX_PROFILES - 1 {
            store
                .create(&format!("p{n}"))
                .unwrap_or_else(|e| panic!("create p{n}: {e}"));
        }
        assert_eq!(store.snapshot().0.len(), MAX_PROFILES);
        // The next create must be refused, not silently accepted and then
        // dropped by `normalize` on the following load.
        assert!(store.create("overflow").is_err());
        let path = store.into_path();
        let reloaded = ProfileStore::load(path);
        assert_eq!(reloaded.snapshot().0.len(), MAX_PROFILES);
        assert!(!reloaded.contains("overflow"));
    }

    #[test]
    fn normalize_caps_an_overlong_persisted_list_keeping_the_builtin_first() {
        let overlong: Vec<Profile> = (0..MAX_PROFILES + 10)
            .map(|n| Profile {
                id: format!("p{n}"),
                name: format!("P{n}"),
            })
            .collect();
        let out = normalize(overlong);
        assert_eq!(out.len(), MAX_PROFILES);
        assert_eq!(out[0].id, DEFAULT_PROFILE_ID);
    }

    #[test]
    fn resolve_rejects_a_profile_after_it_is_unlisted() {
        let (store, _scratch) = scratch_store();
        let work = store.create("Work").expect("create work");
        assert!(store.resolve(Some(&work.id)).is_ok());
        store.remove(&work.id).expect("remove work");
        // A stale frontend must not be able to respawn a tab under an id that
        // is no longer in the list.
        assert!(store.resolve(Some(&work.id)).is_err());
    }

    #[test]
    fn validate_id_rejects_windows_device_stems_with_and_without_extensions() {
        for bad in [
            "nul",
            "con",
            "prn",
            "aux",
            "com1",
            "lpt9",
            "nul.bak",
            "com1.log",
            "aux.tar.gz",
        ] {
            assert!(
                validate_id(bad).is_err(),
                "{bad} must be rejected as a Windows device name"
            );
        }
        // Names that merely *start* with a device stem are fine.
        for ok in ["nullable", "console", "com", "lpt", "auxiliary"] {
            assert!(validate_id(ok).is_ok(), "{ok} must be accepted");
        }
    }

    #[test]
    fn validate_id_rejects_a_trailing_dot_that_win32_would_fold() {
        // A hand-edited `work.` must not resolve onto `work`'s directory.
        assert!(validate_id("work.").is_err());
        assert!(validate_id("work..").is_err());
        // `slugify` never produces one, so the UI path is unaffected.
        assert_eq!(slugify("Work."), "work");
        assert!(validate_id("work.bak").is_ok());
    }

    #[test]
    fn create_falls_back_past_a_reserved_stem_carrying_an_extension() {
        let (store, _scratch) = scratch_store();
        // `slugify("NUL.bak")` is `nul.bak`, whose stem is the NUL device;
        // `unique_id` must suffix the stem, not the whole base, or every
        // candidate stays reserved and the create dead-ends.
        let created = store.create("NUL.bak").expect("create must not dead-end");
        assert_eq!(created.id, "nul-2");
        assert_eq!(created.name, "NUL.bak");
    }

    #[test]
    fn mutate_refuses_when_the_primary_is_corrupt_and_the_ring_is_unreadable() {
        let (store, _scratch) = scratch_store();
        let work = store.create("Work").expect("create work");
        // Corrupt the primary so recovery is attempted, then block the
        // snapshot directory by replacing it with a regular file:
        // `fs::read_dir` fails with ENOTDIR regardless of the calling
        // user, unlike a `chmod 0o000` directory, which root ignores and
        // which previously made this test false-red under a root test
        // runner.
        std::fs::write(&store.path, b"not json").expect("write corrupt");
        let snapshots = &store.snapshots;
        std::fs::remove_dir_all(snapshots).expect("remove snapshots dir");
        std::fs::write(snapshots, b"not a directory").expect("block with a regular file");
        let res = store.create("Second");
        assert!(res.is_err(), "mutate must refuse, not clobber");
        // A ring-read failure must leave the corrupt primary exactly where
        // it was: `read_or_recover` treats a *missing* primary as "nothing
        // persisted yet" and never consults the ring (see its doc comment),
        // so quarantining here — before recovery has actually succeeded —
        // would strand the next `load` with neither a primary to recover
        // from nor a restored copy, turning a transient failure (a ring
        // directory the OS or a sync agent is momentarily holding onto)
        // into permanent loss of the list.
        assert!(
            !store.path.with_extension("json.corrupt").exists(),
            "must not quarantine before recovery succeeds"
        );
        assert_eq!(
            std::fs::read(&store.path).expect("corrupt primary must survive a failed recovery"),
            b"not json",
            "primary must be left in place for the next launch to retry recovery"
        );
        assert_eq!(work.id, "work");
    }
    #[test]
    fn startup_defaults_to_the_builtin_profile() {
        let (store, _scratch) = scratch_store();
        assert_eq!(store.startup_id(), DEFAULT_PROFILE_ID);
    }

    #[test]
    fn set_startup_persists_and_survives_a_reload() {
        let (store, _scratch) = scratch_store();
        let work = store.create("Work").expect("create work");
        store.set_startup(&work.id).expect("set startup");
        assert_eq!(store.startup_id(), work.id);
        let path = store.into_path();
        assert_eq!(ProfileStore::load(path).startup_id(), work.id);
    }

    #[test]
    fn set_startup_rejects_an_unknown_profile_and_keeps_the_previous_one() {
        let (store, _scratch) = scratch_store();
        let work = store.create("Work").expect("create work");
        store.set_startup(&work.id).expect("set startup");
        assert!(store.set_startup("ghost").is_err());
        assert!(store.set_startup("../../etc").is_err());
        assert_eq!(store.startup_id(), work.id);
    }

    #[test]
    fn set_startup_back_to_the_builtin_clears_the_pointer() {
        let (store, _scratch) = scratch_store();
        let work = store.create("Work").expect("create work");
        store.set_startup(&work.id).expect("set startup");
        store.set_startup(DEFAULT_PROFILE_ID).expect("set builtin");
        assert_eq!(store.startup_id(), DEFAULT_PROFILE_ID);
        // Absent, not `"default"`: the built-in id is implicit on disk.
        // Parsed, not a raw substring check: a profile literally named
        // "startup" would also match `raw.contains("startup")`.
        let raw = std::fs::read_to_string(&store.path).expect("read file");
        let parsed: serde_json::Value = serde_json::from_str(&raw).expect("parse json");
        assert!(
            parsed.get("startup").is_none(),
            "pointer must be omitted: {raw}"
        );
    }

    #[test]
    fn deleting_the_startup_profile_falls_back_to_the_builtin() {
        let (store, _scratch) = scratch_store();
        let work = store.create("Work").expect("create work");
        store.set_startup(&work.id).expect("set startup");
        store.remove(&work.id).expect("remove work");
        assert_eq!(store.startup_id(), DEFAULT_PROFILE_ID);
        // And the dangling pointer must not have reached disk.
        let path = store.into_path();
        assert_eq!(ProfileStore::load(path).startup_id(), DEFAULT_PROFILE_ID);
    }

    #[test]
    fn renaming_the_startup_profile_keeps_it_the_default() {
        let (store, _scratch) = scratch_store();
        let work = store.create("Work").expect("create work");
        store.set_startup(&work.id).expect("set startup");
        store.rename(&work.id, "Client Acme").expect("rename");
        // Ids are immutable, so the pointer is unaffected by a relabel.
        assert_eq!(store.startup_id(), work.id);
    }

    #[test]
    fn a_hand_edited_dangling_startup_pointer_reads_back_as_the_builtin() {
        let (store, _scratch) = scratch_store();
        let path = store.into_path();
        std::fs::create_dir_all(path.parent().expect("parent")).expect("mkdir");
        std::fs::write(
            &path,
            br#"{"profiles":[{"id":"work","name":"Work"}],"startup":"ghost"}"#,
        )
        .expect("write");
        let store = ProfileStore::load(path);
        assert_eq!(store.startup_id(), DEFAULT_PROFILE_ID);
        assert!(store.contains("work"));
    }

    #[test]
    fn a_hand_edited_startup_pointing_at_an_invalid_id_is_dropped() {
        // The entry itself is dropped by `normalize` for a traversal id, so
        // the pointer must not survive it either.
        let file = ProfilesFile {
            profiles: vec![Profile {
                id: "../../etc".into(),
                name: "Bad".into(),
            }],
            startup: Some("../../etc".into()),
        };
        let out = normalize_file(file);
        assert_eq!(out.startup, None);
        assert_eq!(out.profiles, vec![builtin()]);
    }

    #[test]
    fn set_startup_rejects_a_profile_another_instance_deleted() {
        // `resolve` checks this store's *cached* list, which is stale the
        // moment another app instance deletes the profile. Only the re-check
        // inside the lock can catch it - delete that check and this fails.
        let (a, _scratch) = scratch_store();
        let work = a.create("Work").expect("create work");
        let b = a.reopen();
        assert!(b.contains(&work.id), "b's cache still lists it");
        a.remove(&work.id).expect("a removes work");
        assert!(
            b.set_startup(&work.id).is_err(),
            "stale cache must not let a deleted profile become the default"
        );
        assert_eq!(b.startup_id(), DEFAULT_PROFILE_ID);
    }

    #[test]
    fn a_stale_cached_pointer_is_never_written_back() {
        // b ticks work, a deletes it, then b mutates for an unrelated reason:
        // b's next write must not resurrect the pointer it still has cached.
        let (a, _scratch) = scratch_store();
        let work = a.create("Work").expect("create work");
        let b = a.reopen();
        b.set_startup(&work.id).expect("b ticks work");
        a.remove(&work.id).expect("a removes work");
        b.create("Other").expect("b creates another profile");
        // Parsed, not a raw substring check: a profile literally named
        // "startup" would also match `raw.contains("startup")`.
        let raw = std::fs::read_to_string(&a.path).expect("read file");
        let parsed: serde_json::Value = serde_json::from_str(&raw).expect("parse json");
        assert!(
            parsed.get("startup").is_none(),
            "dangling pointer persisted: {raw}"
        );
        assert_eq!(b.startup_id(), DEFAULT_PROFILE_ID);
    }

    #[test]
    fn startup_id_always_names_a_listed_profile() {
        // The headline invariant `ProfileList` and the frontend both rely on.
        let (store, _scratch) = scratch_store();
        let work = store.create("Work").expect("create work");
        store.create("Home").expect("create home");
        for id in [DEFAULT_PROFILE_ID, work.id.as_str()] {
            store.set_startup(id).expect("set startup");
            let listed = store.snapshot().0;
            let startup = store.startup_id();
            assert!(
                listed.iter().any(|p| p.id == startup),
                "startup {startup:?} absent from {:?}",
                listed.iter().map(|p| &p.id).collect::<Vec<_>>()
            );
        }
    }

    #[test]
    fn a_ring_recovered_file_has_its_startup_pointer_revalidated() {
        let (store, _scratch) = scratch_store();
        let work = store.create("Work").expect("create work");
        store.set_startup(&work.id).expect("set startup");
        // Corrupt the primary; the ring's newest snapshot still names work.
        std::fs::write(&store.path, b"not json").expect("write corrupt");
        let reloaded = ProfileStore::load(store.path);
        assert!(reloaded.contains(&work.id), "ring restored the list");
        assert_eq!(
            reloaded.startup_id(),
            work.id,
            "a recovered pointer that still resolves must survive"
        );
    }

    #[test]
    fn snapshot_startup_id_is_always_listed_even_after_removing_the_ticked_profile() {
        // A separate list accessor and `startup_id()` would each take their
        // own `cache.lock()` and cannot make this guarantee under
        // concurrency; `snapshot()` (what `list_profiles` now calls) reads
        // both under one lock instead.
        let (store, _scratch) = scratch_store();
        let work = store.create("Work").expect("create work");
        store.set_startup(&work.id).expect("set startup");
        let (profiles, startup_id) = store.snapshot();
        assert_eq!(startup_id, work.id);
        assert!(profiles.iter().any(|p| p.id == startup_id));

        store.remove(&work.id).expect("remove work");
        let (profiles, startup_id) = store.snapshot();
        assert_eq!(startup_id, DEFAULT_PROFILE_ID);
        assert!(
            profiles.iter().any(|p| p.id == startup_id),
            "startup {startup_id:?} absent from {:?}",
            profiles.iter().map(|p| &p.id).collect::<Vec<_>>()
        );
    }

    #[test]
    fn an_empty_json_object_means_no_profiles_not_corrupt() {
        // Without `#[serde(default)]` on `profiles`, `{}` fails to parse
        // (the field is required), so `read_or_recover` misclassifies a
        // user's intentional reset as corruption and resurrects the
        // pre-reset list from the ring.
        let (store, _scratch) = scratch_store();
        let work = store.create("Work").expect("create work");
        let path = store.into_path();
        std::fs::write(&path, b"{}").expect("write empty object");

        let reloaded = ProfileStore::load(path);
        assert_eq!(reloaded.snapshot().0, vec![builtin()]);
        assert!(
            !reloaded.contains(&work.id),
            "an emptied file must not resurrect the previous list from the ring"
        );
    }

    #[test]
    fn a_corrupt_primary_is_quarantined_only_once_a_mutation_replaces_it() {
        let (store, _scratch) = scratch_store();
        std::fs::write(&store.path, b"not json").expect("write corrupt");

        // `load` alone must not touch the corrupt primary: nothing is about
        // to replace it, so quarantining here would strand a process that
        // never mutates again this run with neither a primary nor a ring
        // hit on the next launch (see `read_or_recover`'s doc comment).
        let reloaded = store.reopen();
        assert_eq!(reloaded.snapshot().0, vec![builtin()]);
        let quarantined = store.path.with_extension("json.corrupt");
        assert!(
            !quarantined.exists(),
            "load must not quarantine without an upcoming write"
        );
        assert_eq!(
            std::fs::read(&store.path).expect("primary must still be present"),
            b"not json",
            "load must leave the corrupt primary in place"
        );

        // The first mutation replaces the primary - quarantine happens
        // then, immediately before the write, so the bad bytes survive for
        // hand repair instead of being silently clobbered by `write_atomic`.
        reloaded.create("Work").expect("create work");
        assert_eq!(
            std::fs::read(&quarantined).expect("quarantined file must exist"),
            b"not json",
            "the corrupt bytes must survive for hand repair"
        );
        assert!(
            store.path.exists(),
            "mutate must leave a fresh primary behind"
        );
    }
}

//! The open-tab layout, persisted so a relaunch reopens it (issue #17).
//!
//! `live.js` rewrites the file whenever the tab set, a tab's conversation or
//! the active tab changes, and reads it once at launch. Rewriting
//! continuously, rather than on quit, is deliberate: the app is often ended
//! without the webview getting a say (the updater's installer launch, a
//! relaunch, an OS shutdown).
//!
//! On-disk shape (`<app config dir>/open-tabs.json`), in tab order:
//!
//! ```json
//! { "tabs": [ { "path": "/abs/project", "profile": "work",
//!               "sessionFile": "/home/u/.omp/…/x.jsonl", "name": "Fix login" } ],
//!   "active": 0 }
//! ```
//!
//! Like `recent-projects.json` this is disposable data: a missing or
//! unreadable file means nothing to restore, and the next write replaces it.
//! The resume path is not trusted here: `start_session` validates it against
//! the tab's profile like every other resume.
//!
//! Without a resolvable config folder the layout lives in memory (a webview
//! reload still restores it) and no file is read or written: the next launch
//! starts without tabs.

use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};

use crate::config_file::ConfigFile;

/// Tabs kept per layout; a restore drops any beyond this. Every restored tab
/// is an omp process spawned at launch, so the cap bounds that too.
pub const MAX_TABS: usize = 64;

/// One open tab, as `live.js` saves it and as a restore hands it back.
#[derive(Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct OpenTab {
    /// Project folder; empty for a pathless tab (a resumed session with no
    /// recorded cwd).
    #[serde(default)]
    pub path: String,
    /// Profile id; `None` is the built-in profile.
    #[serde(default)]
    pub profile: Option<String>,
    /// The conversation's `.jsonl`, when the tab has one.
    #[serde(default)]
    pub session_file: Option<String>,
    /// Tab label at save time, shown until omp reports the session's title.
    #[serde(default)]
    pub name: Option<String>,
    /// Origin/base metadata is display-only; `path` remains the execution folder.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub workspace: Option<crate::conversation_workspace::WorkspaceBinding>,
}

/// The persisted layout: tabs in order plus the active tab's index.
#[derive(Debug, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Layout {
    #[serde(default)]
    pub tabs: Vec<OpenTab>,
    #[serde(default)]
    pub active: Option<usize>,
}

/// What a launch can reopen: the saved tabs minus the unrestorable ones,
/// `active` remapped (`None` when the saved active tab was dropped).
#[derive(Debug, Serialize)]
pub struct Restore {
    #[serde(flatten)]
    pub layout: Layout,
    /// Folders of dropped tabs, so the user is told instead of a tab just
    /// missing.
    pub skipped: Vec<String>,
}

/// Manages `<app config dir>/open-tabs.json`.
pub struct OpenTabsStore {
    /// The file, or memory (no app config folder: the layout lasts for the
    /// app run, and a load still takes it through [`restorable`]).
    backing: ConfigFile,
}

impl OpenTabsStore {
    /// Create a store pointing at `path` (the file need not exist yet), or
    /// a memory-only one for `None`.
    pub fn new(path: Option<PathBuf>) -> Self {
        Self {
            backing: ConfigFile::new(path),
        }
    }

    /// The saved layout, checked against the file system (see
    /// [`restorable`]). Unlocked for the same reason as
    /// `RecentProjectsStore::list` (`write_atomic` never exposes a
    /// half-written file).
    pub fn load(&self, can_restore: impl FnMut(&OpenTab) -> bool) -> Restore {
        restorable(self.backing.read_or_default(), can_restore)
    }

    /// Replace the saved layout with `layout`. Written as is: the file is
    /// untrusted anyway, so [`restorable`] sanitises it on the way back.
    pub fn save(&self, layout: &Layout) -> Result<(), String> {
        self.backing.write(layout)
    }
}

/// Cap to [`MAX_TABS`], drop an `active` index that points past the end,
/// and normalise empty optional strings to `None`.
fn sanitize(mut layout: Layout) -> Layout {
    layout.tabs.truncate(MAX_TABS);
    for tab in &mut layout.tabs {
        for field in [&mut tab.profile, &mut tab.session_file, &mut tab.name] {
            if field.as_deref().is_some_and(str::is_empty) {
                *field = None;
            }
        }
    }
    layout.active = layout.active.filter(|&i| i < layout.tabs.len());
    layout
}

/// The tabs of `layout` that can be reopened, with `active` remapped.
///
/// - A conversation file gone from disk (an empty conversation omp never
///   wrote, or one deleted since) reopens as a fresh conversation in the
///   same folder: the folder is what the user had open.
/// - A missing folder is retained only when its saved conversation has a
///   native recovery point; otherwise it is dropped and listed in `skipped`.
/// - A pathless tab without a conversation has nothing left to reopen and
///   is dropped silently.
fn restorable(layout: Layout, mut can_restore: impl FnMut(&OpenTab) -> bool) -> Restore {
    let Layout { tabs, active } = sanitize(layout);
    let mut out = Vec::with_capacity(tabs.len());
    let mut skipped = Vec::new();
    let mut new_active = None;
    for (i, mut tab) in tabs.into_iter().enumerate() {
        if tab
            .session_file
            .as_deref()
            .is_some_and(|f| !Path::new(f).is_file())
        {
            tab.session_file = None;
        }
        if !(tab.path.is_empty()
            || Path::new(&tab.path).is_dir()
            || tab.session_file.is_some() && can_restore(&tab))
        {
            skipped.push(tab.path);
            continue;
        }
        if tab.path.is_empty() && tab.session_file.is_none() {
            continue;
        }
        if active == Some(i) {
            new_active = Some(out.len());
        }
        out.push(tab);
    }
    Restore {
        layout: Layout {
            tabs: out,
            active: new_active,
        },
        skipped,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;
    use std::sync::atomic::{AtomicU64, Ordering};

    static TEST_COUNTER: AtomicU64 = AtomicU64::new(0);

    /// Scratch directory removed on drop, including after a failed assertion.
    struct ScratchGuard(PathBuf);

    impl Drop for ScratchGuard {
        fn drop(&mut self) {
            let _ = fs::remove_dir_all(&self.0);
        }
    }

    impl ScratchGuard {
        /// A path inside the scratch dir that does not exist.
        fn missing(&self, name: &str) -> String {
            self.0
                .join(name)
                .into_os_string()
                .into_string()
                .expect("utf-8 temp path")
        }

        /// A fresh existing folder `name` inside the scratch dir.
        fn folder(&self, name: &str) -> String {
            let dir = self.missing(name);
            fs::create_dir_all(&dir).expect("create project dir");
            dir
        }

        /// A fresh existing file `name` inside the scratch dir.
        fn file(&self, name: &str) -> String {
            fs::create_dir_all(&self.0).expect("create scratch dir");
            let path = self.missing(name);
            fs::write(&path, b"{}\n").expect("write session file");
            path
        }
    }

    fn scratch() -> ScratchGuard {
        let n = TEST_COUNTER.fetch_add(1, Ordering::Relaxed);
        let dir = std::env::temp_dir().join(format!(
            "omp-desktop-open-tabs-test-{}-{n}",
            std::process::id()
        ));
        let _ = fs::remove_dir_all(&dir);
        ScratchGuard(dir)
    }

    fn scratch_store() -> (OpenTabsStore, ScratchGuard) {
        let dir = scratch();
        (OpenTabsStore::new(Some(dir.0.join("open-tabs.json"))), dir)
    }

    fn tab(path: &str, session_file: Option<&str>) -> OpenTab {
        OpenTab {
            path: path.to_owned(),
            profile: Some("work".to_owned()),
            session_file: session_file.map(str::to_owned),
            name: Some("label".to_owned()),
            workspace: None,
        }
    }

    #[test]
    fn save_then_load_round_trips_order_active_and_fields() {
        let (store, dir) = scratch_store();
        let a = dir.folder("a");
        let b = dir.folder("b");
        let conv = dir.file("conv.jsonl");
        store
            .save(&Layout {
                tabs: vec![tab(&a, None), tab(&b, Some(&conv))],
                active: Some(1),
            })
            .expect("save");

        let got = store.load(|_| false);
        assert_eq!(got.layout.tabs, vec![tab(&a, None), tab(&b, Some(&conv))]);
        assert_eq!(got.layout.active, Some(1));
        assert_eq!(got.skipped, Vec::<String>::new());
    }

    #[test]
    fn worktree_metadata_never_replaces_the_execution_folder_on_restore() {
        let (store, dir) = scratch_store();
        let working = dir.folder("isolated");
        let origin = dir.missing("source-no-longer-present");
        let payload = serde_json::json!({
            "tabs": [{ "path": working, "workspace": {
                "projectPath": origin, "baseRef": "refs/heads/main",
                "baseCommit": "a".repeat(40), "worktree": true
            }}], "active": 0
        });
        store
            .save(&serde_json::from_value(payload).expect("layout"))
            .expect("save");
        let restored = serde_json::to_value(store.load(|_| false)).expect("serialize");
        assert_eq!(restored["tabs"][0]["path"], working);
        assert_eq!(restored["tabs"][0]["workspace"]["projectPath"], origin);
        assert_eq!(restored["active"], 0);
    }

    #[test]
    fn a_missing_worktree_is_skipped_even_when_its_source_exists() {
        let (store, dir) = scratch_store();
        let source = dir.folder("source");
        let missing = dir.missing("missing-worktree");
        let payload = serde_json::json!({
            "tabs": [{ "path": missing, "workspace": {
                "projectPath": source, "baseRef": "refs/heads/main",
                "baseCommit": "a".repeat(40), "worktree": true
            }}], "active": 0
        });
        store
            .save(&serde_json::from_value(payload).expect("layout"))
            .expect("save");
        let restored = store.load(|_| false);
        assert_eq!(restored.layout.tabs, Vec::<OpenTab>::new());
        assert_eq!(restored.skipped, vec![missing]);
        assert_eq!(restored.layout.active, None);
    }

    #[test]
    fn a_recoverable_missing_checkout_stays_bound_to_its_saved_conversation() {
        let (store, dir) = scratch_store();
        let missing = dir.missing("evicted-worktree");
        let conversation = dir.file("conversation.jsonl");
        store
            .save(&Layout {
                tabs: vec![tab(&missing, Some(&conversation))],
                active: Some(0),
            })
            .expect("save");
        let restored = store
            .load(|candidate| candidate.session_file.as_deref() == Some(conversation.as_str()));
        assert_eq!(
            restored.layout.tabs,
            vec![tab(&missing, Some(&conversation))]
        );
        assert_eq!(restored.layout.active, Some(0));
        assert_eq!(restored.skipped, Vec::<String>::new());
        assert!(
            !Path::new(&missing).exists(),
            "filtering does not reconstruct or renew a workspace"
        );
    }

    #[test]
    fn missing_or_corrupt_file_restores_nothing() {
        let (store, dir) = scratch_store();
        let empty = store.load(|_| false);
        assert!(empty.layout.tabs.is_empty() && empty.layout.active.is_none());

        fs::create_dir_all(&dir.0).expect("create scratch dir");
        fs::write(dir.0.join("open-tabs.json"), b"{ not json").expect("write");
        let corrupt = store.load(|_| false);
        assert!(corrupt.layout.tabs.is_empty() && corrupt.layout.active.is_none());
    }

    #[test]
    fn a_memory_only_store_round_trips_for_its_lifetime_only() {
        let dir = scratch();
        let a = dir.folder("a");
        let gone = dir.missing("gone");
        let store = OpenTabsStore::new(None);
        let empty = store.load(|_| false);
        assert!(empty.layout.tabs.is_empty() && empty.layout.active.is_none());

        store
            .save(&Layout {
                tabs: vec![tab(&gone, None), tab(&a, None)],
                active: Some(1),
            })
            .expect("save");
        // The same sanitising restore as a file-backed store.
        let got = store.load(|_| false);
        assert_eq!(got.layout.tabs, vec![tab(&a, None)]);
        assert_eq!(got.layout.active, Some(0));
        assert_eq!(got.skipped, vec![gone]);
        assert_eq!(
            OpenTabsStore::new(None).load(|_| false).layout.tabs,
            Vec::new()
        );
    }

    #[test]
    fn a_gone_folder_is_skipped_and_the_active_index_follows_its_tab() {
        let dir = scratch();
        let gone = dir.missing("gone");
        let kept = dir.folder("kept");
        let got = restorable(
            Layout {
                tabs: vec![tab(&gone, None), tab(&kept, None)],
                active: Some(1),
            },
            |_| false,
        );
        assert_eq!(got.layout.tabs, vec![tab(&kept, None)]);
        assert_eq!(got.layout.active, Some(0));
        assert_eq!(got.skipped, vec![gone]);
    }

    #[test]
    fn dropping_the_active_tab_leaves_no_active_index() {
        let dir = scratch();
        let gone = dir.missing("gone");
        let kept = dir.folder("kept");
        let got = restorable(
            Layout {
                tabs: vec![tab(&kept, None), tab(&gone, None)],
                active: Some(1),
            },
            |_| false,
        );
        assert_eq!(got.layout.active, None);
    }

    #[test]
    fn a_gone_conversation_reopens_as_a_fresh_one_in_its_folder() {
        let dir = scratch();
        let folder = dir.folder("p");
        let gone = dir.missing("never-written.jsonl");
        let got = restorable(
            Layout {
                tabs: vec![tab(&folder, Some(&gone))],
                active: None,
            },
            |_| false,
        );
        assert_eq!(got.layout.tabs, vec![tab(&folder, None)]);
        assert_eq!(got.skipped, Vec::<String>::new());
    }

    #[test]
    fn a_pathless_tab_needs_its_conversation() {
        let dir = scratch();
        let conv = dir.file("conv.jsonl");
        let gone = dir.missing("gone.jsonl");
        let got = restorable(
            Layout {
                tabs: vec![tab("", Some(&gone)), tab("", Some(&conv))],
                active: Some(1),
            },
            |_| false,
        );
        assert_eq!(got.layout.tabs, vec![tab("", Some(&conv))]);
        assert_eq!(got.layout.active, Some(0));
        // Nothing the user could recognise to report.
        assert_eq!(got.skipped, Vec::<String>::new());
    }

    #[test]
    fn load_caps_the_tab_count_and_drops_an_out_of_range_active_index() {
        let (store, dir) = scratch_store();
        let folder = dir.folder("p");
        let tabs = (0..=MAX_TABS).map(|_| tab(&folder, None)).collect();
        store
            .save(&Layout {
                tabs,
                active: Some(MAX_TABS),
            })
            .expect("save");

        let got = store.load(|_| false);
        assert_eq!(got.layout.tabs.len(), MAX_TABS);
        assert_eq!(got.layout.active, None);
    }

    #[test]
    fn empty_optional_strings_read_back_as_absent() {
        let got = sanitize(Layout {
            tabs: vec![OpenTab {
                path: String::new(),
                profile: Some(String::new()),
                session_file: Some(String::new()),
                name: Some(String::new()),
                workspace: None,
            }],
            active: Some(0),
        });
        let t = &got.tabs[0];
        assert_eq!(
            (&t.profile, &t.session_file, &t.name),
            (&None, &None, &None)
        );
        assert_eq!(got.active, Some(0));
    }

    #[test]
    fn layout_deserializes_from_the_frontend_shape() {
        let payload = serde_json::json!({
            "tabs": [{ "path": "/p", "profile": null, "sessionFile": null, "name": "p" }],
            "active": null,
        });
        let layout: Layout = serde_json::from_value(payload).expect("deserialize");
        assert_eq!(layout.tabs[0].path, "/p");
        assert_eq!(layout.tabs[0].profile, None);
        assert_eq!(layout.tabs[0].name.as_deref(), Some("p"));
        assert_eq!(layout.active, None);
    }

    #[test]
    fn restore_serializes_flat_for_the_frontend() {
        let restore = Restore {
            layout: Layout {
                tabs: vec![tab("/p", None)],
                active: Some(0),
            },
            skipped: vec!["/gone".to_owned()],
        };
        assert_eq!(
            serde_json::to_value(&restore).expect("serialize"),
            serde_json::json!({
                "tabs": [{ "path": "/p", "profile": "work", "sessionFile": null, "name": "label" }],
                "active": 0,
                "skipped": ["/gone"],
            })
        );
    }
}

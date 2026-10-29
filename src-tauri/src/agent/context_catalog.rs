//! Process-scoped catalogs from the observer's native RPC entries. Preview is
//! keyed by agent and skill name, never by a renderer-provided filesystem path.
use std::collections::{HashMap, HashSet};
use std::io::Read;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};

use base64::engine::general_purpose::STANDARD;
use base64::Engine;
use serde::Serialize;
use serde_json::Value;

const MAX_PREVIEW_BYTES: usize = 1024 * 1024;
const MAX_FRAME_BYTES: usize = 64 * 1024 * 1024;
const CHUNK_BYTES: usize = 256 * 1024;
const MAX_PENDING: usize = 1024;

#[derive(Clone)]
struct Skill {
    name: String,
    path: PathBuf,
    // Pin the observed directory before a later symlink can redirect it.
    root: Result<PathBuf, String>,
}

struct Node {
    parent: Option<String>,
    skills: Option<Vec<Skill>>,
}

#[derive(Default)]
struct AgentCatalog {
    records: HashMap<String, Node>,
    current: Option<String>,
    leaf: Option<String>,
    session_file: Option<String>,
}

struct Request {
    agent: String,
    full: bool,
}

#[derive(Default)]
pub(super) struct Catalog {
    epoch: String,
    pending: HashMap<String, Request>,
    agents: HashMap<String, AgentCatalog>,
}

impl Catalog {
    pub(super) fn new(epoch: String) -> Self {
        Self {
            epoch,
            ..Self::default()
        }
    }

    /// Register before writing stdin: a fast response may arrive immediately.
    pub(super) fn request(&mut self, command: &Value) {
        let Some(id) = command.get("id").and_then(Value::as_str) else {
            return;
        };
        let (agent, full) = match command.get("type").and_then(Value::as_str) {
            Some("get_entries") => ("main", command.get("since").is_none()),
            Some("get_subagent_messages") => {
                let Some(agent) = command.get("subagentId").and_then(Value::as_str) else {
                    return;
                };
                if agent.is_empty() || agent == "main" {
                    return;
                }
                (
                    agent,
                    command.get("fromByte").and_then(Value::as_u64).unwrap_or(0) == 0,
                )
            }
            _ => return,
        };
        if self.pending.len() < MAX_PENDING {
            self.pending.insert(
                id.to_owned(),
                Request {
                    agent: agent.to_owned(),
                    full,
                },
            );
        }
    }

    pub(super) fn cancel(&mut self, command: &Value) {
        if let Some(id) = command.get("id").and_then(Value::as_str) {
            self.pending.remove(id);
        }
    }

    pub(super) fn observe(&mut self, frame: &Value) {
        if frame.get("type").and_then(Value::as_str) != Some("response") {
            return;
        }
        let Some(id) = frame.get("id").and_then(Value::as_str) else {
            return;
        };
        let Some(request) = self.pending.remove(id) else {
            return;
        };
        let expected = if request.agent == "main" {
            "get_entries"
        } else {
            "get_subagent_messages"
        };
        if frame.get("command").and_then(Value::as_str) != Some(expected)
            || frame.get("success").and_then(Value::as_bool) != Some(true)
        {
            return;
        }
        let Some(data) = frame.get("data") else {
            return;
        };
        let Some(entries) = data.get("entries").and_then(Value::as_array) else {
            return;
        };
        // The map owns this agent id; response validation below still borrows it.
        let catalog = self.agents.entry(request.agent.clone()).or_default();
        let session_file = data.get("sessionFile").and_then(Value::as_str);
        if request.full
            || data.get("reset").and_then(Value::as_bool) == Some(true)
            || (session_file.is_some() && catalog.session_file.as_deref() != session_file)
        {
            *catalog = AgentCatalog::default();
        }
        if let Some(file) = session_file {
            catalog.session_file = Some(file.to_owned());
        }
        let mut last = catalog.leaf.take();
        for entry in entries {
            if entry.get("type").and_then(Value::as_str) == Some("session") {
                continue;
            }
            let Some(entry_id) = entry.get("id").and_then(Value::as_str) else {
                continue;
            };
            let parent = entry
                .get("parentId")
                .and_then(Value::as_str)
                .map(str::to_owned);
            let skills = observation(entry, &request.agent, &self.epoch);
            catalog
                .records
                .insert(entry_id.to_owned(), Node { parent, skills });
            last = if entry.get("activeLeafId").is_some() {
                entry
                    .get("activeLeafId")
                    .and_then(Value::as_str)
                    .map(str::to_owned)
            } else {
                Some(entry_id.to_owned())
            };
        }
        catalog.leaf = if data.get("leafId").is_some() {
            data.get("leafId")
                .and_then(Value::as_str)
                .map(str::to_owned)
        } else {
            last
        };
        catalog.current = None;
        let mut cursor = catalog.leaf.as_deref();
        let mut seen = HashSet::new();
        let mut found = None;
        while let Some(id) = cursor {
            if !seen.insert(id) {
                return;
            }
            let Some(node) = catalog.records.get(id) else {
                return;
            };
            if found.is_none() {
                found = node.skills.as_ref().map(|_| id);
            }
            cursor = node.parent.as_deref();
        }
        // Keep only the selected observation id, not a second copy of its catalog.
        catalog.current = found.map(str::to_owned);
    }

    fn skill(&self, agent: &str, name: &str) -> Result<Skill, String> {
        self.agents
            .get(agent)
            .and_then(|a| a.current.as_ref().and_then(|id| a.records.get(id)))
            .and_then(|node| node.skills.as_ref())
            .and_then(|skills| skills.iter().find(|skill| skill.name == name))
            // The read worker must own one skill after releasing the catalog lock.
            .cloned()
            .ok_or_else(|| "skill is not in this agent's observed catalog".to_owned())
    }
}

fn observation(entry: &Value, agent: &str, epoch: &str) -> Option<Vec<Skill>> {
    if entry.get("type")?.as_str()? != "custom"
        || entry.get("customType")?.as_str()? != "omp-desktop:agent-context"
    {
        return None;
    }
    let data = entry.get("data")?;
    if data.get("version")?.as_u64()? != 1 {
        return None;
    }
    if data.get("epoch")?.as_str()? != epoch {
        return None;
    }
    let identity = data.get("agent")?;
    if agent == "main" {
        if identity.get("kind")?.as_str()? != "main" {
            return None;
        }
    } else if identity.get("kind")?.as_str()? != "sub" || identity.get("id")?.as_str()? != agent {
        return None;
    }
    let mut skills = Vec::new();
    for item in data.get("skills")?.as_array()? {
        let (Some(name), Some(path), Some(scope)) = (
            item.get("name").and_then(Value::as_str),
            item.get("path").and_then(Value::as_str),
            item.get("scope").and_then(Value::as_str),
        ) else {
            continue;
        };
        let path = Path::new(path);
        if name.is_empty()
            || !path.is_absolute()
            || path.file_name().and_then(|v| v.to_str()) != Some("SKILL.md")
            || !matches!(scope, "repo" | "global")
        {
            continue;
        }
        let root = path
            .parent()
            .ok_or_else(|| "skill has no directory".to_owned())
            .and_then(|dir| {
                std::fs::canonicalize(dir)
                    .map_err(|e| format!("could not resolve skill directory: {e}"))
            });
        skills.push(Skill {
            name: name.to_owned(),
            path: path.to_path_buf(),
            root,
        });
    }
    Some(skills)
}

#[derive(Serialize)]
pub struct SkillPreview {
    name: String,
    path: String,
    text: String,
    truncated: bool,
}

pub(super) fn read_skill(
    catalog: &Mutex<Catalog>,
    alive: &Arc<AtomicBool>,
    agent: &str,
    name: &str,
) -> Result<SkillPreview, String> {
    let skill = catalog
        .lock()
        .map_err(|_| "catalog lock poisoned".to_owned())?
        .skill(agent, name)?;
    let root = skill.root?;
    let file =
        std::fs::canonicalize(&skill.path).map_err(|e| format!("could not resolve skill: {e}"))?;
    if !file.starts_with(&root) {
        return Err("skill resolves outside its observed directory".to_owned());
    }
    if !std::fs::metadata(&file)
        .map_err(|e| format!("could not stat skill: {e}"))?
        .is_file()
    {
        return Err("skill is not a regular file".to_owned());
    }
    let mut options = std::fs::OpenOptions::new();
    options.read(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        // A replaced FIFO must not park a blocking worker in open().
        options.custom_flags(libc::O_NOFOLLOW | libc::O_NONBLOCK);
    }
    let handle = options
        .open(&file)
        .map_err(|e| format!("could not open skill: {e}"))?;
    if !handle
        .metadata()
        .map_err(|e| format!("could not stat skill: {e}"))?
        .is_file()
    {
        return Err("skill is not a regular file".to_owned());
    }
    let mut bytes = Vec::new();
    handle
        .take((MAX_PREVIEW_BYTES + 1) as u64)
        .read_to_end(&mut bytes)
        .map_err(|e| format!("could not read skill: {e}"))?;
    let truncated = bytes.len() > MAX_PREVIEW_BYTES;
    if truncated {
        bytes.truncate(MAX_PREVIEW_BYTES);
    }
    // When the cap cuts a UTF-8 character, discard only that incomplete suffix.
    if truncated {
        if let Err(error) = std::str::from_utf8(&bytes) {
            if error.error_len().is_none() {
                bytes.truncate(error.valid_up_to());
            }
        }
    }
    let text = String::from_utf8(bytes).map_err(|e| format!("skill is not UTF-8: {e}"))?;
    if !alive.load(Ordering::Acquire) {
        return Err("agent process has ended".to_owned());
    }
    Ok(SkillPreview {
        name: skill.name,
        path: skill.path.to_string_lossy().into_owned(),
        text,
        truncated,
    })
}

/// Observe decoded responses without changing the physical frames forwarded to JS.
pub(super) fn record(
    catalog: &Mutex<Catalog>,
    chunks: &mut ChunkDecoder,
    frame: Option<&Value>,
) -> Option<Value> {
    let frame = frame?;
    let complete = chunks.push(frame);
    let response = complete.as_ref().or_else(|| {
        (frame.get("type").and_then(Value::as_str) == Some("response")).then_some(frame)
    });
    if let Some(response) = response {
        if let Ok(mut catalog) = catalog.lock() {
            catalog.observe(response);
        }
    }
    complete
}

struct PendingChunks {
    id: String,
    count: usize,
    length: usize,
    next: usize,
    bytes: Vec<u8>,
}

/// Separate native decoder: physical chunks still go unchanged to the frontend.
#[derive(Default)]
pub(super) struct ChunkDecoder {
    pending: Option<PendingChunks>,
}

impl ChunkDecoder {
    pub(super) fn push(&mut self, frame: &Value) -> Option<Value> {
        if frame.get("type").and_then(Value::as_str) != Some("rpc_chunk") {
            self.pending = None;
            return None;
        }
        let result = self.chunk(frame);
        if result.is_err() {
            self.pending = None;
        }
        result.ok().flatten()
    }

    fn chunk(&mut self, frame: &Value) -> Result<Option<Value>, ()> {
        let id = frame.get("chunkId").and_then(Value::as_str).ok_or(())?;
        let index = frame
            .get("index")
            .and_then(Value::as_u64)
            .and_then(|n| usize::try_from(n).ok())
            .ok_or(())?;
        let count = frame
            .get("count")
            .and_then(Value::as_u64)
            .and_then(|n| usize::try_from(n).ok())
            .ok_or(())?;
        let length = frame
            .get("byteLength")
            .and_then(Value::as_u64)
            .and_then(|n| usize::try_from(n).ok())
            .ok_or(())?;
        if id.is_empty()
            || id.len() > 128
            || !(2..=MAX_FRAME_BYTES.div_ceil(CHUNK_BYTES)).contains(&count)
            || index >= count
            || !(1024 * 1024..=MAX_FRAME_BYTES).contains(&length)
        {
            return Err(());
        }
        let data = frame.get("data").and_then(Value::as_str).ok_or(())?;
        if data.len() > CHUNK_BYTES.div_ceil(3) * 4 {
            return Err(());
        }
        let bytes = STANDARD.decode(data).map_err(|_| ())?;
        if bytes.is_empty() || bytes.len() > CHUNK_BYTES {
            return Err(());
        }
        if self.pending.is_none() {
            if index != 0 {
                return Err(());
            }
            self.pending = Some(PendingChunks {
                id: id.to_owned(),
                count,
                length,
                next: 0,
                bytes: Vec::new(),
            });
        }
        let pending = self.pending.as_mut().ok_or(())?;
        if pending.id != id
            || pending.count != count
            || pending.length != length
            || pending.next != index
            || pending.bytes.len() + bytes.len() > length
        {
            return Err(());
        }
        pending.bytes.extend_from_slice(&bytes);
        pending.next += 1;
        if pending.next != count {
            return Ok(None);
        }
        let pending = self.pending.take().ok_or(())?;
        if pending.bytes.len() != length {
            return Err(());
        }
        let value: Value = serde_json::from_slice(&pending.bytes).map_err(|_| ())?;
        if !value.is_object() {
            return Err(());
        }
        Ok(Some(value))
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::test_support::TempDir;
    use serde_json::json;

    fn skill_file(root: &Path, directory: &str, body: &str) -> PathBuf {
        let dir = root.join(directory);
        std::fs::create_dir_all(&dir).unwrap();
        let file = dir.join("SKILL.md");
        std::fs::write(&file, body).unwrap();
        file
    }

    fn entry(id: &str, parent: Option<&str>, agent: &str, name: &str, path: &Path) -> Value {
        let identity = if agent == "main" {
            json!({"kind": "main", "id": "Main"})
        } else {
            json!({"kind": "sub", "id": agent})
        };
        json!({
            "type": "custom", "customType": "omp-desktop:agent-context",
            "id": id, "parentId": parent,
            "data": {"version": 1, "epoch": "", "agent": identity, "blocks": [],
                "skills": [{"name": name, "path": path, "scope": "repo"}]}
        })
    }

    fn main_response(catalog: &mut Catalog, id: &str, entries: Vec<Value>, leaf: &str) {
        catalog.request(&json!({"type": "get_entries", "id": id}));
        catalog.observe(&json!({
            "type": "response", "id": id, "command": "get_entries", "success": true,
            "data": {"entries": entries, "leafId": leaf}
        }));
    }

    fn sub_response(catalog: &mut Catalog, id: &str, agent: &str, entries: Vec<Value>) {
        catalog.request(
            &json!({"type": "get_subagent_messages", "id": id, "subagentId": agent, "fromByte": 0}),
        );
        catalog.observe(&json!({
            "type": "response", "id": id, "command": "get_subagent_messages", "success": true,
            "data": {"entries": entries, "sessionFile": format!("{agent}.jsonl"), "fromByte": 0}
        }));
    }

    #[test]
    fn reads_observed_main_and_child_catalogs_without_cross_agent_access() {
        let root = TempDir::new("context-catalog", "isolated");
        let main = skill_file(root.path(), "main", "---\nname: main\n---\nOriginal\n");
        let child = skill_file(root.path(), "child", "Child text\n");
        let mut catalog = Catalog::default();
        main_response(
            &mut catalog,
            "m",
            vec![entry("a", None, "main", "shared", &main)],
            "a",
        );
        sub_response(
            &mut catalog,
            "s",
            "0-Task",
            vec![entry("b", None, "0-Task", "shared", &child)],
        );
        let catalog = Mutex::new(catalog);
        let alive = Arc::new(AtomicBool::new(true));
        let preview = read_skill(&catalog, &alive, "main", "shared").unwrap();
        assert_eq!(preview.text, "---\nname: main\n---\nOriginal\n");
        assert_eq!(preview.path, main.to_string_lossy());
        assert!(!preview.truncated);
        assert_eq!(
            read_skill(&catalog, &alive, "0-Task", "shared")
                .unwrap()
                .text,
            "Child text\n"
        );
        assert!(read_skill(&catalog, &alive, "other", "shared").is_err());
        assert!(read_skill(&catalog, &alive, "main", main.to_str().unwrap()).is_err());
        alive.store(false, Ordering::Release);
        assert!(read_skill(&catalog, &alive, "main", "shared").is_err());
    }

    #[test]
    fn respects_branch_ancestry_and_rejects_unsolicited_or_mismatched_response() {
        let root = TempDir::new("context-catalog", "branches");
        let a = skill_file(root.path(), "a", "a");
        let b = skill_file(root.path(), "b", "b");
        let mut catalog = Catalog::default();
        main_response(
            &mut catalog,
            "m",
            vec![
                entry("one", None, "main", "chosen", &a),
                entry("two", None, "main", "other", &b),
            ],
            "one",
        );
        assert!(catalog.skill("main", "chosen").is_ok());
        assert!(catalog.skill("main", "other").is_err());
        catalog.observe(&json!({"type": "response", "id": "unsolicited", "command": "get_entries", "success": true,
            "data": {"entries": [entry("x", None, "main", "other", &b)], "leafId": "x"}}));
        assert!(catalog.skill("main", "other").is_err());
        sub_response(
            &mut catalog,
            "s",
            "0-Task",
            vec![entry("x", None, "0-Other", "other", &b)],
        );
        assert!(catalog.skill("0-Task", "other").is_err());
        catalog.request(&json!({"type": "get_entries", "id": "delta", "since": "two"}));
        catalog.observe(
            &json!({"type": "response", "id": "delta", "command": "get_entries", "success": true,
            "data": {"entries": [], "leafId": "two"}}),
        );
        assert!(catalog.skill("main", "chosen").is_err());
        assert!(catalog.skill("main", "other").is_ok());
        catalog.request(&json!({"type": "get_entries", "id": "broken", "since": "two"}));
        catalog.observe(
            &json!({"type": "response", "id": "broken", "command": "get_entries", "success": true,
            "data": {"entries": [], "leafId": "unknown"}}),
        );
        assert!(catalog.skill("main", "other").is_err());
        // A newly installed process starts with no catalogs.
        assert!(Catalog::default().skill("main", "chosen").is_err());
    }

    #[test]
    fn old_process_observations_and_unknown_sessions_are_not_accepted() {
        let root = TempDir::new("context-catalog", "epoch");
        let file = skill_file(root.path(), "skill", "current");
        let mut catalog = Catalog::new("new-process".to_owned());
        main_response(
            &mut catalog,
            "m",
            vec![entry("old", None, "main", "skill", &file)],
            "old",
        );
        assert!(catalog.skill("main", "skill").is_err());
        let mut current = entry("new", Some("old"), "main", "skill", &file);
        current["data"]["epoch"] = json!("new-process");
        catalog.request(&json!({"type": "get_entries", "id": "next", "since": "old"}));
        catalog.observe(
            &json!({"type": "response", "id": "next", "command": "get_entries", "success": true,
            "data": {"entries": [current], "leafId": "new"}}),
        );
        let bridge = super::super::AgentBridge::new();
        let mut inner = super::super::tests::idle_inner(Arc::new(AtomicBool::new(true)));
        inner.context_catalog = Arc::new(Mutex::new(catalog));
        bridge
            .sessions
            .lock()
            .unwrap()
            .insert("tab".to_owned(), inner);
        assert!(bridge
            .context_read_skill("other-tab", "main", "skill")
            .is_err());
        assert_eq!(
            bridge
                .context_read_skill("tab", "main", "skill")
                .unwrap()
                .text,
            "current"
        );
        bridge.sessions.lock().unwrap().insert(
            "tab".to_owned(),
            super::super::tests::idle_inner(Arc::new(AtomicBool::new(true))),
        );
        assert!(bridge.context_read_skill("tab", "main", "skill").is_err());
    }

    #[test]
    fn missing_invalid_utf8_and_truncated_reads_are_reported() {
        let root = TempDir::new("context-catalog", "errors");
        let file = skill_file(root.path(), "one", "original");
        let mut catalog = Catalog::default();
        main_response(
            &mut catalog,
            "m",
            vec![entry("a", None, "main", "skill", &file)],
            "a",
        );
        let catalog = Mutex::new(catalog);
        let alive = Arc::new(AtomicBool::new(true));
        std::fs::remove_file(&file).unwrap();
        assert!(read_skill(&catalog, &alive, "main", "skill").is_err());
        std::fs::create_dir(&file).unwrap();
        assert!(read_skill(&catalog, &alive, "main", "skill").is_err());
        std::fs::remove_dir(&file).unwrap();
        std::fs::write(&file, [0xff]).unwrap();
        assert!(read_skill(&catalog, &alive, "main", "skill").is_err());
        let mut bytes = vec![b'a'; MAX_PREVIEW_BYTES - 1];
        bytes.extend_from_slice("🦀".as_bytes());
        std::fs::write(&file, bytes).unwrap();
        let result = read_skill(&catalog, &alive, "main", "skill").unwrap();
        assert!(result.truncated);
        assert_eq!(result.text.len(), MAX_PREVIEW_BYTES - 1);
    }

    #[cfg(unix)]
    #[test]
    fn refuses_a_retargeted_skill_file_or_directory() {
        use std::os::unix::fs::symlink;
        let root = TempDir::new("context-catalog", "symlink");
        let file = skill_file(root.path(), "skill", "safe");
        let outside = root.path().join("outside");
        std::fs::write(&outside, "secret").unwrap();
        let mut catalog = Catalog::default();
        main_response(
            &mut catalog,
            "m",
            vec![entry("a", None, "main", "skill", &file)],
            "a",
        );
        let catalog = Mutex::new(catalog);
        let alive = Arc::new(AtomicBool::new(true));
        std::fs::remove_file(&file).unwrap();
        symlink(&outside, &file).unwrap();
        assert!(read_skill(&catalog, &alive, "main", "skill").is_err());
        std::fs::remove_file(&file).unwrap();
        std::fs::remove_dir(file.parent().unwrap()).unwrap();
        let replacement = root.path().join("replacement");
        std::fs::create_dir(&replacement).unwrap();
        std::fs::write(replacement.join("SKILL.md"), "secret").unwrap();
        symlink(&replacement, file.parent().unwrap()).unwrap();
        assert!(read_skill(&catalog, &alive, "main", "skill").is_err());
    }

    #[test]
    fn decodes_native_chunked_entries_and_rejects_broken_sequences() {
        let root = TempDir::new("context-catalog", "chunks");
        let file = skill_file(root.path(), "skill", "large frame skill");
        let response = json!({"type": "response", "id": "m", "command": "get_entries", "success": true,
            "data": {"entries": [entry("a", None, "main", "skill", &file)], "leafId": "a",
                "padding": "x".repeat(1024 * 1024)}});
        let bytes = serde_json::to_vec(&response).unwrap();
        let length = bytes.len();
        let count = bytes.len().div_ceil(CHUNK_BYTES);
        let chunks: Vec<_> = bytes
            .chunks(CHUNK_BYTES)
            .enumerate()
            .map(|(index, bytes)| {
                json!({
                    "type": "rpc_chunk", "chunkId": "chunk", "index": index, "count": count,
                    "byteLength": length, "data": STANDARD.encode(bytes)
                })
            })
            .collect();
        let mut decoder = ChunkDecoder::default();
        assert!(decoder.push(&chunks[1]).is_none());
        assert!(decoder.push(&chunks[0]).is_none());
        assert!(decoder.push(&json!({"type": "ready"})).is_none());
        assert!(decoder.push(&chunks[1]).is_none());
        let mut response_frame = None;
        for chunk in &chunks {
            response_frame = decoder.push(chunk).or(response_frame);
        }
        let mut catalog = Catalog::default();
        catalog.request(&json!({"type": "get_entries", "id": "m"}));
        catalog.observe(&response_frame.unwrap());
        assert!(catalog.skill("main", "skill").is_ok());
    }
}

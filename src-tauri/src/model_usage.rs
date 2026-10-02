//! Recently used models for the model picker (issue #11), read from omp's
//! own `agent.db`.
//!
//! omp records every model switch (`set_model`, `cycle_model`, retry and
//! advisor fallbacks) in `model_usage (model_key TEXT PRIMARY KEY,
//! last_used_at INTEGER)` — `model_key` is `provider/modelId`, `last_used_at`
//! Unix seconds — and its own model selector orders by it
//! (`AgentStorage::getModelUsageOrder`). Reading the same table keeps the
//! desktop picker in step with the terminal UI, including switches made there.
//!
//! The table is omp's private schema, not part of the RPC protocol, so every
//! failure (no database yet, schema drift, a locked or corrupt file) reads as
//! an empty list: the picker then shows the plain model list, as before.
//!
//! omp opens the database in WAL mode, where readers and the writer never
//! block each other. The connection here is read-only — never `immutable`,
//! which would skip the WAL and read stale pages — and lives for one query:
//! a long-lived read transaction would pin the WAL and stall omp's
//! checkpoints.

use std::path::{Path, PathBuf};
use std::time::Duration;

use rusqlite::{Connection, OpenFlags};
use tauri::{AppHandle, Manager};

/// Keys returned per call. More than the picker shows: some recent models
/// may no longer be available (provider logged out, model retired).
pub const MAX_KEYS: u32 = 20;

/// How long a read waits out a write lock — a WAL checkpoint or recovery —
/// before giving up. Short: the picker is open and waiting.
const BUSY_TIMEOUT: Duration = Duration::from_millis(250);

/// `agent.db` of a resolved `profile` (`None` = built-in), under the same
/// agent directory the tab's omp process uses (see
/// [`crate::profiles::agent_dir_for`]).
fn db_path(app: &AppHandle, profile: Option<&str>) -> Option<PathBuf> {
    let env_dir = std::env::var_os("PI_CODING_AGENT_DIR");
    let home = app.path().home_dir().ok()?;
    Some(crate::profiles::agent_dir_for(&home, profile, env_dir.as_deref()).join("agent.db"))
}

/// `profile`'s most recently used model keys, newest first.
pub fn recent_for(app: &AppHandle, profile: Option<&str>) -> Vec<String> {
    db_path(app, profile).map_or_else(Vec::new, |db| recent(&db, MAX_KEYS))
}

/// Up to `limit` model keys from `db`, most recently used first. A missing
/// database is a fresh profile and reads as empty silently; any other
/// failure is logged and reads as empty too.
fn recent(db: &Path, limit: u32) -> Vec<String> {
    // Checked up front only to keep a fresh profile out of the log:
    // without `SQLITE_OPEN_CREATE` the open below never creates the file.
    if !db.is_file() {
        return Vec::new();
    }
    query(db, limit).unwrap_or_else(|e| {
        eprintln!(
            "[omp-desktop] model usage unreadable in {}: {e}",
            db.display()
        );
        Vec::new()
    })
}

fn query(db: &Path, limit: u32) -> rusqlite::Result<Vec<String>> {
    let conn = Connection::open_with_flags(
        db,
        OpenFlags::SQLITE_OPEN_READ_ONLY | OpenFlags::SQLITE_OPEN_NO_MUTEX,
    )?;
    conn.busy_timeout(BUSY_TIMEOUT)?;
    // `model_key` breaks ties: `last_used_at` has one-second resolution.
    let mut stmt = conn.prepare(
        "SELECT model_key FROM model_usage ORDER BY last_used_at DESC, model_key LIMIT ?1",
    )?;
    let keys = stmt
        .query_map([i64::from(limit)], |row| row.get(0))?
        .collect();
    keys
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

    /// A scratch dir and the `agent.db` path inside it (not created).
    fn scratch_db() -> (PathBuf, ScratchGuard) {
        let n = TEST_COUNTER.fetch_add(1, Ordering::Relaxed);
        let dir = std::env::temp_dir().join(format!(
            "omp-desktop-model-usage-test-{}-{n}",
            std::process::id()
        ));
        let _ = fs::remove_dir_all(&dir);
        fs::create_dir_all(&dir).expect("create scratch dir");
        (dir.join("agent.db"), ScratchGuard(dir))
    }

    /// A writable connection set up the way omp's `AgentStorage` does it:
    /// WAL journal and the `model_usage` table.
    fn omp_db(path: &Path) -> Connection {
        let conn = Connection::open(path).expect("open test db");
        conn.execute_batch(
            "PRAGMA journal_mode=WAL;
             CREATE TABLE model_usage (
                 model_key TEXT PRIMARY KEY,
                 last_used_at INTEGER NOT NULL
             );",
        )
        .expect("create omp schema");
        conn
    }

    fn used(conn: &Connection, key: &str, at: i64) {
        conn.execute(
            "INSERT INTO model_usage (model_key, last_used_at) VALUES (?1, ?2)
             ON CONFLICT(model_key) DO UPDATE SET last_used_at = ?2",
            (key, at),
        )
        .expect("record usage");
    }

    #[test]
    fn newest_first_ties_by_key_and_capped() {
        let (db, _guard) = scratch_db();
        let conn = omp_db(&db);
        used(&conn, "anthropic/claude-sonnet-4-6", 100);
        used(&conn, "openai/gpt-5.2", 300);
        used(&conn, "anthropic/claude-opus-4-6", 200);
        used(&conn, "anthropic/claude-haiku-4-5", 200);
        // An upsert moves an existing key, it does not add a second row.
        used(&conn, "anthropic/claude-sonnet-4-6", 400);

        assert_eq!(
            recent(&db, MAX_KEYS),
            [
                "anthropic/claude-sonnet-4-6",
                "openai/gpt-5.2",
                "anthropic/claude-haiku-4-5",
                "anthropic/claude-opus-4-6",
            ]
        );
        assert_eq!(
            recent(&db, 2),
            ["anthropic/claude-sonnet-4-6", "openai/gpt-5.2"]
        );
    }

    #[test]
    fn missing_database_is_empty_and_not_created() {
        let (db, _guard) = scratch_db();
        assert_eq!(recent(&db, MAX_KEYS), [] as [String; 0]);
        assert!(!db.exists(), "a read must never create omp's database");
    }

    #[test]
    fn schema_drift_reads_as_empty() {
        let (db, _guard) = scratch_db();
        Connection::open(&db)
            .and_then(|c| c.execute_batch("CREATE TABLE other (x INTEGER);"))
            .expect("create unrelated db");
        assert_eq!(recent(&db, MAX_KEYS), [] as [String; 0]);
    }

    #[test]
    fn reads_while_omp_holds_an_open_write_transaction() {
        let (db, _guard) = scratch_db();
        let mut writer = omp_db(&db);
        used(&writer, "anthropic/claude-sonnet-4-6", 100);

        let tx = writer.transaction().expect("begin write");
        used(&tx, "openai/gpt-5.2", 200);
        // WAL: the reader is neither blocked nor shown the uncommitted row.
        assert_eq!(recent(&db, MAX_KEYS), ["anthropic/claude-sonnet-4-6"]);
        tx.commit().expect("commit");
        assert_eq!(
            recent(&db, MAX_KEYS),
            ["openai/gpt-5.2", "anthropic/claude-sonnet-4-6"]
        );
    }
}

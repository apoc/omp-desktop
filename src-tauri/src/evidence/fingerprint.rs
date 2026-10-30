//! Source freshness and factual PR-check snapshots, obtained off the reader thread.
#[path = "fingerprint_safe.rs"]
mod safe;
#[path = "fingerprint_scan.rs"]
mod scan;
#[cfg(test)]
#[path = "fingerprint_tests.rs"]
mod tests;

use crate::text::prefix_within as bounded;
use serde_json::{json, Value};
use std::path::Path;

pub(super) fn fingerprint(cwd: Option<&str>) -> Value {
    scan::fingerprint(cwd)
}

/// The existing PR service constrains discovery to the configured GitHub upstream
/// and revalidates the local branch and head. It is not a worktree check.
pub(super) fn ci(cwd: Option<&str>) -> Value {
    let Some(cwd) = cwd.filter(|path| !path.is_empty()) else {
        return ci_result(Err("No project folder is available".into()));
    };
    let result = crate::pr_automation::snapshot(Path::new(cwd)).and_then(|snapshot| {
        snapshot
            .map(serde_json::to_value)
            .transpose()
            .map_err(|error| format!("Could not serialize CI feedback: {error}"))
    });
    ci_result(result)
}

fn ci_result(result: Result<Option<Value>, String>) -> Value {
    let limitations = "GitHub PR checks apply to sourceSha only, not uncommitted local changes. Only the configured GitHub upstream and the reported PR check rollup are observed; absence of checks is not a pass.";
    match result {
        Err(error) => {
            let reason = if error.len() <= 1024 {
                error
            } else {
                format!("{} [truncated]", bounded(&error, 1000))
            };
            json!({"state": "unknown", "sourceSha": null, "reason": reason,
                "limitations": limitations, "snapshot": null})
        }
        Ok(None) => json!({
            "state": "absent", "sourceSha": null, "reason": "No matching pull request was found",
            "limitations": limitations, "snapshot": null
        }),
        Ok(Some(snapshot)) => {
            let head = snapshot
                .get("head")
                .and_then(Value::as_str)
                .filter(|s| !s.is_empty() && s.len() <= 128);
            let checks = snapshot.get("checksState").and_then(Value::as_str);
            let state = match (head, checks) {
                (Some(_), Some("none")) => "absent",
                (Some(_), Some("pending")) => "pending",
                (Some(_), Some("success")) => "success",
                (Some(_), Some("failure")) => "failure",
                _ => "unknown",
            };
            let reason = match state {
                "absent" => Some("No CI check rollup was reported for this commit"),
                "pending" => Some("CI checks are still pending"),
                "unknown" => Some("CI state or source commit is unavailable or unrecognized"),
                "failure" => Some("The reported CI check rollup contains a failure"),
                _ => None,
            };
            let text = |name| {
                snapshot
                    .get(name)
                    .and_then(Value::as_str)
                    .map(|s| bounded(s, 512))
            };
            let checks_list = snapshot.get("failedChecks").and_then(Value::as_array);
            let mut truncated = checks_list.is_some_and(|items| {
                items.len() > 100
                    || items.iter().take(100).any(|check| {
                        [("id", 256), ("name", 256), ("url", 512)]
                            .iter()
                            .any(|(key, limit)| {
                                check
                                    .get(*key)
                                    .and_then(Value::as_str)
                                    .is_some_and(|s| s.len() > *limit)
                            })
                    })
            }) || ["url", "repository", "branch", "state"].iter().any(|key| {
                snapshot
                    .get(*key)
                    .and_then(Value::as_str)
                    .is_some_and(|s| s.len() > 512)
            });
            // JSON escaping can expand a byte severalfold. Account for the
            // serialized size, not just the input text, before retaining it.
            let mut remaining = 96 * 1024;
            let mut failed = Vec::new();
            for check in checks_list.into_iter().flatten().take(100) {
                let item = json!({
                    "id": check.get("id").and_then(Value::as_str).map(|s| bounded(s, 256)),
                    "name": check.get("name").and_then(Value::as_str).map(|s| bounded(s, 256)),
                    "url": check.get("url").and_then(Value::as_str).map(|s| bounded(s, 512))
                });
                let Ok(encoded) = serde_json::to_vec(&item) else {
                    truncated = true;
                    break;
                };
                let size = encoded.len() + 1;
                if size > remaining {
                    truncated = true;
                    break;
                }
                remaining -= size;
                failed.push(item);
            }
            let limitations = if truncated {
                format!("{limitations} Some CI metadata was truncated to fit size limits.")
            } else {
                limitations.to_owned()
            };
            json!({
                "state": state, "sourceSha": head, "reason": reason,
                "limitations": limitations,
                "snapshot": {"number": snapshot.get("number").and_then(Value::as_u64), "url": text("url"),
                    "repository": text("repository"), "branch": text("branch"),
                    "prState": text("state"), "checksState": checks.map(|s| bounded(s, 32)),
                    "failedChecks": failed, "truncated": truncated}
            })
        }
    }
}

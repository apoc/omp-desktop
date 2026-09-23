//! Cross-session usage-statistics data for the "Usage" panel.
//!
//! Unlike `workspace.rs` (scoped to one repository) or the per-tab
//! `omp --mode rpc` bridge (scoped to one running session), this module's
//! data spans every session log on disk, across every project and profile.
//! It is sourced from the standalone `omp stats` subcommand — not the RPC
//! protocol at all — which syncs `~/.omp/agent/sessions/*.jsonl` into a
//! SQLite warehouse and can print the aggregated result as JSON via
//! `omp stats --json` (sync then `JSON.stringify(dashboardStats)` to
//! stdout, no server started). That one-shot invocation is what [`fetch`]
//! shells out to; the field shapes below mirror `@oh-my-pi/omp-stats`'s
//! `DashboardStats`/`AggregatedStats`/`ModelStats`/`FolderStats`/
//! `AgentTypeStats` TypeScript types, keeping only the breakdowns this
//! panel renders (the upstream payload's time-series arrays are ignored —
//! `serde` drops unknown fields by default, so no `deny_unknown_fields`
//! here).

use std::process::Stdio;

/// Aggregate request/token/cost totals shared by the overall summary and
/// each per-model/per-folder breakdown row.
#[derive(Debug, Clone, Default, PartialEq, serde::Deserialize, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AggregatedStats {
    pub total_requests: u64,
    pub successful_requests: u64,
    pub failed_requests: u64,
    /// Fraction of requests that failed, `0.0..=1.0`.
    pub error_rate: f64,
    pub total_input_tokens: u64,
    pub total_output_tokens: u64,
    pub total_cache_read_tokens: u64,
    pub total_cache_write_tokens: u64,
    /// Fraction of prompt input served from cache, `0.0..=1.0`.
    pub cache_rate: f64,
    /// Fraction of cost saved versus uncached billing, `0.0..=1.0`.
    pub cache_savings: f64,
    /// API-equivalent dollar cost estimate.
    pub total_cost: f64,
    pub unpriced_requests: u64,
    pub total_premium_requests: u64,
    pub avg_duration: Option<f64>,
    pub avg_ttft: Option<f64>,
    pub avg_tokens_per_second: Option<f64>,
    /// Unix epoch milliseconds of the earliest/latest request in scope.
    pub first_timestamp: i64,
    pub last_timestamp: i64,
}

/// [`AggregatedStats`] for a single model/provider pair.
#[derive(Debug, Clone, PartialEq, serde::Deserialize, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ModelStats {
    pub model: String,
    pub provider: String,
    #[serde(flatten)]
    pub stats: AggregatedStats,
}

/// [`AggregatedStats`] for a single project folder.
#[derive(Debug, Clone, PartialEq, serde::Deserialize, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FolderStats {
    pub folder: String,
    #[serde(flatten)]
    pub stats: AggregatedStats,
}

/// Token/cost totals for one agent role (`main`, `subagent`, `advisor`).
/// Deliberately not an [`AggregatedStats`] — the upstream payload omits
/// success/failure/cache/latency fields for this breakdown.
#[derive(Debug, Clone, PartialEq, serde::Deserialize, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AgentTypeStats {
    pub agent_type: String,
    pub total_requests: u64,
    pub total_input_tokens: u64,
    pub total_output_tokens: u64,
    pub total_cache_read_tokens: u64,
    pub total_cache_write_tokens: u64,
    pub total_cost: f64,
}

/// The subset of `omp stats --json`'s `DashboardStats` this panel renders.
#[derive(Debug, Clone, Default, PartialEq, serde::Deserialize, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DashboardStats {
    pub overall: AggregatedStats,
    #[serde(default)]
    pub by_model: Vec<ModelStats>,
    #[serde(default)]
    pub by_folder: Vec<FolderStats>,
    #[serde(default)]
    pub by_agent_type: Vec<AgentTypeStats>,
}

/// Run `omp stats --json` and parse its stdout.
///
/// Unlike `workspace.rs`'s `git` calls, no explicit output cap is applied:
/// the payload's size is bounded by the number of distinct models/folders
/// seen, not by session transcript size, so it stays small even for a
/// large history. The sync step this performs (walking every on-disk
/// session log) can still take several seconds on a first run or after a
/// long gap — callers MUST run this off the main thread (see
/// `usage_stats` in `lib.rs`).
pub fn fetch() -> Result<DashboardStats, String> {
    let mut last_spawn_err = None;
    for name in crate::agent::spawn::CANDIDATES {
        let mut cmd = crate::agent::spawn::omp_command(name);
        cmd.args(["stats", "--json"])
            .stdout(Stdio::piped())
            .stderr(Stdio::piped());
        let output = match cmd.output() {
            Ok(output) => output,
            Err(e) => {
                last_spawn_err = Some(format!("failed to run omp stats: {e}"));
                continue;
            }
        };
        if !output.status.success() {
            return Err(exit_failure_message(
                output.status,
                &output.stderr,
                &output.stdout,
            ));
        }
        return parse_stats_json(&output.stdout);
    }
    Err(last_spawn_err.unwrap_or_else(|| "omp not found on PATH".to_string()))
}

/// How much of a failing `omp stats --json`'s stdout is retained in the
/// error message when stderr was empty. A handful of lines of usage/error
/// text is ample; this exists only to bound a pathological case (an old
/// omp printing something unexpectedly large to stdout before failing).
const STDOUT_TAIL_MAX_BYTES: usize = 4 * 1024;

/// Build the error string for a non-zero `omp stats --json` exit.
///
/// Confirmed failure modes that reach here (`omp` not being on PATH at
/// all is a separate, earlier branch in [`fetch`]): running the CLI's own
/// argument parser against an unrecognized subcommand — the shape an omp
/// build old enough to predate `stats` would produce — exits non-zero
/// with *empty* stderr (observed directly: exit 129, no stderr, no
/// stdout, on a real build). A bare `"omp stats failed: "` would leave
/// the panel showing nothing useful for that case, so this falls back to
/// a capped stdout tail, and only if that's also empty names the concrete
/// symptom (exit status, no output) rather than guessing at a cause.
///
/// Takes `status` by `impl Display` (rather than the whole
/// `std::process::Output`) so it can be unit-tested without constructing
/// a platform-specific `ExitStatus` (`std::os::unix::process::ExitStatusExt`
/// and its Windows equivalent have incompatible signatures).
fn exit_failure_message(status: impl std::fmt::Display, stderr: &[u8], stdout: &[u8]) -> String {
    let stderr = String::from_utf8_lossy(stderr);
    let stderr = stderr.trim();
    if !stderr.is_empty() {
        return format!("omp stats failed: {stderr}");
    }
    let stdout = String::from_utf8_lossy(&stdout[..stdout.len().min(STDOUT_TAIL_MAX_BYTES)]);
    let stdout = stdout.trim();
    if !stdout.is_empty() {
        return format!("omp stats failed (exit {status}): {stdout}");
    }
    format!("omp stats exited with {status} and produced no output")
}

/// Parse `omp stats --json`'s stdout into [`DashboardStats`].
///
/// `omp stats` prints a `Synced N new entries from M files (T total)`
/// progress line to stdout *before* the JSON object, not to stderr as the
/// CLI's own doc comment claims (verified against a real `omp stats
/// --json` run) — so the payload is "preamble line(s), then the JSON
/// object to EOF", not clean JSON from byte 0. Skip to the first `{` and
/// parse from there; a payload with no `{` at all is treated as
/// malformed rather than silently returning an empty struct.
///
/// Split out of [`fetch`] so it can be unit-tested without spawning a
/// subprocess.
fn parse_stats_json(bytes: &[u8]) -> Result<DashboardStats, String> {
    let start = bytes
        .iter()
        .position(|&b| b == b'{')
        .ok_or_else(|| "omp stats output contained no JSON object".to_string())?;
    serde_json::from_slice(&bytes[start..])
        .map_err(|e| format!("failed to parse omp stats output: {e}"))
}

#[cfg(test)]
mod tests {
    use super::*;

    const AGGREGATED_FIELDS: &str = r#""totalRequests":10,"successfulRequests":9,
        "failedRequests":1,"errorRate":0.1,"totalInputTokens":1000,"totalOutputTokens":500,
        "totalCacheReadTokens":200,"totalCacheWriteTokens":50,"cacheRate":0.2,"cacheSavings":0.15,
        "totalCost":1.23,"unpricedRequests":0,"totalPremiumRequests":2,"avgDuration":1200.5,
        "avgTtft":300.0,"avgTokensPerSecond":42.0,"firstTimestamp":1000,"lastTimestamp":2000"#;

    #[test]
    fn parses_full_dashboard_payload() {
        let json = format!(
            r#"{{
              "overall": {{{AGGREGATED_FIELDS}}},
              "byModel": [{{"model":"claude-5-sonnet","provider":"anthropic",{AGGREGATED_FIELDS}}}],
              "byFolder": [{{"folder":"/home/user/project",{AGGREGATED_FIELDS}}}],
              "byAgentType": [{{"agentType":"main","totalRequests":8,"totalInputTokens":900,
                "totalOutputTokens":450,"totalCacheReadTokens":180,"totalCacheWriteTokens":45,
                "totalCost":1.1}}],
              "timeSeries": [], "modelSeries": [], "modelPerformanceSeries": [], "costSeries": []
            }}"#
        );
        let parsed = parse_stats_json(json.as_bytes()).expect("valid payload parses");
        assert_eq!(parsed.overall.total_requests, 10);
        assert!((parsed.overall.total_cost - 1.23).abs() < f64::EPSILON);
        assert_eq!(parsed.by_model.len(), 1);
        assert_eq!(parsed.by_model[0].model, "claude-5-sonnet");
        assert_eq!(parsed.by_model[0].stats.total_requests, 10);
        assert_eq!(parsed.by_folder[0].folder, "/home/user/project");
        assert_eq!(parsed.by_agent_type[0].agent_type, "main");
        assert_eq!(parsed.by_agent_type[0].total_requests, 8);
    }

    #[test]
    fn missing_optional_breakdown_arrays_default_empty() {
        let json = format!(r#"{{"overall": {{{AGGREGATED_FIELDS}}}}}"#);
        let parsed = parse_stats_json(json.as_bytes()).expect("overall-only payload parses");
        assert_eq!(parsed.by_model.len(), 0);
        assert_eq!(parsed.by_folder.len(), 0);
        assert_eq!(parsed.by_agent_type.len(), 0);
    }

    #[test]
    fn skips_sync_progress_preamble_on_real_stdout() {
        // Real `omp stats --json` output: a `Synced ...` progress line
        // precedes the JSON object on stdout (see parse_stats_json's doc
        // comment — this contradicts the CLI's own claim that the line
        // goes to stderr, verified against a live `omp stats --json` run).
        let json = format!("Synced 56651 new entries from 836 files (55484 total)\n\n{{\"overall\": {{{AGGREGATED_FIELDS}}}}}");
        let parsed =
            parse_stats_json(json.as_bytes()).expect("payload with stdout preamble parses");
        assert_eq!(parsed.overall.total_requests, 10);
    }

    #[test]
    fn rejects_malformed_json() {
        assert!(parse_stats_json(b"not json").is_err());
    }

    #[test]
    fn rejects_payload_missing_required_overall() {
        assert!(parse_stats_json(b"{}").is_err());
    }

    #[test]
    fn exit_failure_with_empty_stderr_and_stdout_names_the_status() {
        // The case actually observed running a real omp build: an
        // unrecognized subcommand exits non-zero with nothing on either
        // stream.
        let msg = exit_failure_message("exit status: 129", &[], &[]);
        assert_eq!(
            msg,
            "omp stats exited with exit status: 129 and produced no output"
        );
    }

    #[test]
    fn exit_failure_with_stderr_surfaces_it_verbatim() {
        let msg = exit_failure_message("exit status: 1", b"  permission denied  \n", b"");
        assert_eq!(msg, "omp stats failed: permission denied");
    }

    #[test]
    fn exit_failure_falls_back_to_stdout_when_stderr_is_empty() {
        let msg = exit_failure_message("exit status: 2", b"", b"  usage: omp [command]  \n");
        assert_eq!(
            msg,
            "omp stats failed (exit exit status: 2): usage: omp [command]"
        );
    }

    #[test]
    #[ignore = "spawns the real `omp` binary; requires omp on PATH (run with `cargo test -- --ignored`)"]
    fn fetch_returns_real_dashboard_stats() {
        // Not run by default (no CI machine is guaranteed to have `omp`
        // installed), but exercises the actual `omp_command`-built
        // subprocess path end to end against whatever `omp` is on this
        // machine's PATH — the unit tests above only cover the pure
        // parsing/formatting helpers.
        let stats = fetch().expect("omp stats --json should succeed with omp on PATH");
        // This machine's real session history is non-empty; a fresh
        // machine with genuinely zero sessions would need this relaxed.
        assert!(stats.overall.total_requests > 0);
    }
}

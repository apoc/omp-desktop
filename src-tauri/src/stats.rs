//! Usage-statistics data for the "Usage" panel.
//!
//! Unlike `workspace.rs` (scoped to one repository) or the per-tab
//! `omp --mode rpc` bridge (scoped to one running session), this module's
//! data spans every session log on disk *for one profile* — not the
//! active tab's live conversation, but still not "every profile at
//! once": `omp stats` resolves its session directory and SQLite warehouse
//! against whichever profile it's told (`--profile=<id>` before the
//! subcommand, or the built-in profile with no flag), the same way every
//! other per-tab omp invocation in this app is profile-scoped. It is
//! sourced from the standalone `omp stats` subcommand — not the RPC
//! protocol at all — which syncs `~/.omp/agent/sessions/*.jsonl` (or the
//! named profile's equivalent tree) into a SQLite warehouse and can print
//! the aggregated result as JSON via `omp stats --json` (sync then
//! `JSON.stringify(dashboardStats)` to stdout, no server started).
//!
//! **Also not all-time**: the installed CLI's `--json` path calls
//! `getDashboardStats()` with no range argument, and the upstream
//! aggregator's `DEFAULT_TIME_RANGE` is `"24h"` — confirmed by reading
//! `@oh-my-pi/omp-stats`' `stats-cli.ts`/`aggregator.ts` source and cross
//! -checked against this machine's own `~/.omp/stats.db` (all-time vs.
//! last-24h totals differ by roughly 6x). The underlying package accepts
//! a `range: "all"` value, but no currently-installed CLI flag reaches
//! it — `omp stats --json` offers no `--range`/`--days` flag at all. Every
//! number [`fetch`] returns is therefore a rolling last-24-hours window,
//! not a lifetime total; the panel and every doc comment downstream of
//! this module must say so rather than imply "everything".
//!
//! [`fetch`] is what shells out to `omp stats --json`; the field shapes
//! below mirror `@oh-my-pi/omp-stats`'s `DashboardStats`/
//! `AggregatedStats`/`ModelStats`/`FolderStats`/`AgentTypeStats`
//! TypeScript types, keeping only the breakdowns this panel renders (the
//! upstream payload's time-series arrays are ignored — `serde` drops
//! unknown fields by default, so no `deny_unknown_fields` here).

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
    /// Fraction of cost saved versus uncached billing. Usually
    /// `0.0..=1.0` but not clamped upstream — a cache-write-heavy period
    /// (cache writes cost more than a plain input token) can make this
    /// negative.
    pub cache_savings: f64,
    /// API-equivalent dollar cost estimate.
    pub total_cost: f64,
    pub unpriced_requests: u64,
    /// Not a plain count: upstream is `SUM(premium_requests)` over a SQL
    /// `REAL` column, and provider premium multipliers include fractional
    /// values (e.g. `0.33`, `0.25`), so this is frequently non-integer.
    /// `u64` here would reject the very first request against such a
    /// model with a hard parse failure for the whole payload.
    pub total_premium_requests: f64,
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

/// Run `omp stats --json` for `profile` and parse its stdout.
///
/// `profile` is `None` for the built-in profile (no flag — matches every
/// other per-tab omp invocation in this app) or `Some(id)` for a named
/// profile. omp requires a global `--profile=<id>` to *precede* the
/// subcommand — verified against a real build: `omp stats --json
/// --profile=<id>` is rejected with `"Unknown option '--profile'"`, while
/// `omp --profile=<id> stats --json` succeeds and syncs that profile's
/// own `~/.omp/profiles/<id>/agent/sessions` tree (confirmed distinct,
/// smaller totals than the built-in profile's on this machine).
///
/// Unlike `workspace.rs`'s `git` calls, no explicit output cap is applied:
/// the payload's size is bounded by the number of distinct models/folders
/// seen, not by session transcript size, so it stays small even for a
/// large history. The sync step this performs (walking every on-disk
/// session log for this one profile) can still take several seconds on a
/// first run or after a long gap — callers MUST run this off the main
/// thread (see `usage_stats` in `lib.rs`).
pub fn fetch(profile: Option<&str>) -> Result<DashboardStats, String> {
    let profile_flag = profile.map(|id| format!("--profile={id}"));
    let mut args: Vec<&str> = Vec::with_capacity(3);
    if let Some(flag) = &profile_flag {
        args.push(flag);
    }
    args.push("stats");
    args.push("--json");

    let output = crate::agent::spawn::spawn_candidate_output(&args)?;
    if !output.status.success() {
        return Err(exit_failure_message(
            output.status,
            &output.stderr,
            &output.stdout,
        ));
    }
    parse_stats_json(&output.stdout)
}

/// How much of a failing `omp stats --json`'s stdout is retained in the
/// error message when stderr was empty. A handful of lines of usage/error
/// text is ample; this exists only to bound a pathological case (an old
/// omp printing something unexpectedly large to stdout before failing).
const STDOUT_TAIL_MAX_BYTES: usize = 4 * 1024;

/// Build the error string for a non-zero `omp stats --json` exit.
///
/// Confirmed failure modes that reach here (`omp` not being on PATH at
/// all is a separate, earlier branch in [`fetch`]): probing this CLI's
/// own argument parser with an unrecognized subcommand and no flags
/// exits non-zero with *both* streams empty (observed directly: exit
/// 129, no stderr, no stdout); the same probe with an added `--json`
/// flag instead exits 2 with `"unknown flag: --json"` on stderr — that
/// shape is already handled by the stderr branch below. Neither probe
/// confirms *why* a real omp build would take this path (old build
/// predating `stats`, a build without the module, ...) — only that a
/// non-zero exit with nothing on either stream is a real, reachable
/// shape this CLI's parser produces, which is why a bare
/// `"omp stats failed: "` would leave the panel showing nothing useful.
/// Falls back to a capped stdout *tail* (the trailing bytes, most likely
/// to hold a final error line if something more verbose ever precedes
/// it — not the head) when stderr is empty, and only if that's also
/// empty names the concrete symptom (exit status, no output) rather than
/// guessing at a cause.
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
    let tail_start = stdout.len().saturating_sub(STDOUT_TAIL_MAX_BYTES);
    let stdout = String::from_utf8_lossy(&stdout[tail_start..]);
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
    fn parses_fractional_premium_requests() {
        // Provider premium multipliers include fractional values (e.g.
        // Copilot's 0.33x/0.25x tiers), so `SUM(premium_requests)`
        // upstream is frequently non-integer. A `u64` field would reject
        // the whole payload with `invalid type: floating point` the first
        // time a user made even one request against such a model.
        let json = r#"{"overall":{"totalRequests":3,"successfulRequests":3,
            "failedRequests":0,"errorRate":0,"totalInputTokens":10,"totalOutputTokens":10,
            "totalCacheReadTokens":0,"totalCacheWriteTokens":0,"cacheRate":0,"cacheSavings":0,
            "totalCost":0.01,"unpricedRequests":0,"totalPremiumRequests":0.33,
            "avgDuration":null,"avgTtft":null,"avgTokensPerSecond":null,
            "firstTimestamp":0,"lastTimestamp":0}}"#;
        let parsed = parse_stats_json(json.as_bytes()).expect("fractional premium requests parses");
        assert!((parsed.overall.total_premium_requests - 0.33).abs() < f64::EPSILON);
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
    fn exit_failure_stdout_fallback_keeps_the_tail_not_the_head() {
        // A stdout longer than STDOUT_TAIL_MAX_BYTES must keep the
        // *trailing* bytes, where a final error line is most likely to
        // land after some earlier, less useful output. A distinct marker
        // at the very front (rather than reasoning about how much filler
        // survives a partial trim) makes "not the head" a direct,
        // unambiguous check: if the slicing direction ever regresses to
        // a head-slice, HEAD_MARKER would appear and TRAILING_MARKER
        // would not.
        let filler = "x".repeat(STDOUT_TAIL_MAX_BYTES * 2);
        let stdout = format!("HEAD_MARKER{filler}TRAILING_MARKER");
        let msg = exit_failure_message("exit status: 2", b"", stdout.as_bytes());
        assert!(msg.contains("TRAILING_MARKER"), "message was: {msg}");
        assert!(!msg.contains("HEAD_MARKER"), "message was: {msg}");
        // Pins the cap itself, not just the slice direction: removing
        // `STDOUT_TAIL_MAX_BYTES` entirely (returning the whole stdout)
        // would still pass both assertions above.
        let prefix_len = "omp stats failed (exit exit status: 2): ".len();
        assert!(
            msg.len() <= prefix_len + STDOUT_TAIL_MAX_BYTES,
            "message length {} exceeds the cap; message was: {msg}",
            msg.len()
        );
    }
}

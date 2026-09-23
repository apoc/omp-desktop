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

use std::process::Command;

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
    let output = Command::new("omp")
        .args(["stats", "--json"])
        .output()
        .map_err(|e| format!("failed to run omp stats: {e}"))?;
    if !output.status.success() {
        return Err(format!(
            "omp stats failed: {}",
            String::from_utf8_lossy(&output.stderr)
        ));
    }
    parse_stats_json(&output.stdout)
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
}

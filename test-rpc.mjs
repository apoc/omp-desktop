/**
 * test-rpc.mjs — Direct omp RPC protocol probe.
 *
 * Default mode: spawns omp --mode rpc, sends "say hello in one sentence",
 * logs every event with type + key fields for 15 seconds, then exits.
 *
 * `--evidence` mode: spawns omp --mode rpc, sends get_state, redacts the
 * response (mirroring src-tauri/src/agent/reader.rs's REDACTED_KEYS list —
 * kept in sync manually; this script's redaction is documentation
 * evidence, not itself a security boundary, the Rust sanitizer is the
 * actual enforcement), and writes it to
 * docs/agents/evidence/get-state-shape.json as a checked-in ground-truth
 * artifact for what the real RPC shape looks like, so future changes to
 * `sanitize_frame`/`approval_tool_name` can be checked against real output
 * instead of assumption.
 *
 * Run: node test-rpc.mjs [--evidence]  OR  bun test-rpc.mjs [--evidence]
 */

import { spawn } from "child_process";
import { createInterface } from "readline";
import { writeFileSync, mkdirSync } from "fs";
import { dirname } from "path";

const EVIDENCE_MODE = process.argv.includes("--evidence");
const EVIDENCE_PATH = "docs/agents/evidence/get-state-shape.json";

// Mirrors src-tauri/src/agent/reader.rs::REDACTED_KEYS.
const REDACTED_KEYS = [
  "headers", "authorization", "apikey", "accesstoken", "refreshtoken",
  "idtoken", "password", "secret", "credential", "credentials",
  "secretkey", "accesskey", "privatekey", "apisecret",
];
const REDACTED_PLACEHOLDER = "[REDACTED]";

function normalizeKey(key) {
  return key.replace(/[_-]/g, "").toLowerCase();
}

// Recursively replace the value of any object key matching REDACTED_KEYS —
// same shape as Rust's sanitize_frame, redacted subtrees are not descended
// into. A key matches when its normalized form *ends with* one of
// REDACTED_KEYS (not just equals one), so compound spellings like
// `x-api-key`/`OPENAI_API_KEY` (normalizing to `xapikey`/`openaiapikey`,
// both ending in `apikey`) are caught too, mirroring Rust's `ends_with` match.
function redact(value) {
  if (Array.isArray(value)) return value.map(redact);
  if (value && typeof value === "object") {
    const out = {};
    for (const [k, v] of Object.entries(value)) {
      const normalized = normalizeKey(k);
      out[k] = REDACTED_KEYS.some((rk) => normalized.endsWith(rk))
        ? REDACTED_PLACEHOLDER
        : redact(v);
    }
    return out;
  }
  return value;
}

const MAX_STRING_LEN = 80;
const MAX_ARRAY_ITEMS = 2;

// Collapse a redacted value into a small structural "shape" — long strings
// (system prompts, tool descriptions) become `<string:N>` and arrays are
// truncated to a couple of sample items plus a total count. This is what
// actually gets committed: real get_state has multi-hundred-KB system
// prompt/tool-definition text mixed in, which would make the evidence file
// bulky *and* leak prompt-engineering content for no benefit — the whole
// point of this file is documenting the JSON *shape*, not its content.
function summarizeShape(value) {
  if (typeof value === "string") {
    return value.length > MAX_STRING_LEN ? `<string:${value.length}>` : value;
  }
  if (Array.isArray(value)) {
    const sample = value.slice(0, MAX_ARRAY_ITEMS).map(summarizeShape);
    return value.length > MAX_ARRAY_ITEMS
      ? [...sample, `<+${value.length - MAX_ARRAY_ITEMS} more>`]
      : sample;
  }
  if (value && typeof value === "object") {
    const out = {};
    for (const [k, v] of Object.entries(value)) out[k] = summarizeShape(v);
    return out;
  }
  return value;
}

const proc = spawn("omp", ["--mode", "rpc"], {
  stdio: ["pipe", "pipe", "pipe"],
  shell: false,
});

proc.stderr.on("data", d => process.stderr.write(`[stderr] ${d}`));
proc.on("error", e => { console.error("spawn error:", e.message); process.exit(1); });
proc.on("exit", code => console.log(`\n[exit] code=${code}`));

const rl = createInterface({ input: proc.stdout });
let ready = false;
let lineCount = 0;

rl.on("line", raw => {
  lineCount++;
  let obj;
  try { obj = JSON.parse(raw); } catch { console.log(`[raw] ${raw}`); return; }

  const t = obj.type;

  // Summarise instead of dumping full JSON — easier to read
  if (t === "ready") {
    ready = true;
    if (EVIDENCE_MODE) {
      console.log("[ready] agent is up — sending get_state for evidence capture");
      send({ type: "get_state", id: "evidence-1" });
    } else {
      console.log("[ready] agent is up — sending test prompt");
      send({ type: "prompt", message: "Say hello in one sentence. Be brief." });
    }
    return;
  }

  if (t === "response") {
    if (EVIDENCE_MODE && obj.id === "evidence-1") {
      const shaped = summarizeShape(redact(obj));
      mkdirSync(dirname(EVIDENCE_PATH), { recursive: true });
      writeFileSync(EVIDENCE_PATH, JSON.stringify(shaped, null, 2) + "\n");
      console.log(`[evidence] wrote redacted get_state response to ${EVIDENCE_PATH}`);
      proc.kill();
      process.exit(0);
    }
    console.log(`[response] cmd=${obj.command} ok=${obj.success}`);
    return;
  }

  // AgentSessionEvent — print type + key fields without full JSON dump
  const fields = { type: t };

  if (t === "message_start" || t === "message_update" || t === "message_end") {
    const msg = obj.message;
    fields.role = msg?.role;
    if (msg?.content) {
      fields.content_blocks = (Array.isArray(msg.content) ? msg.content : []).map(b => ({
        type: b.type,
        text_len: b.text?.length,
        thinking_len: b.thinking?.length,
      }));
    }
    if (obj.assistantMessageEvent) {
      const ame = obj.assistantMessageEvent;
      fields.ame_type = ame.type;
      // Show delta value (string for text_delta/thinking_delta)
      if (ame.delta !== undefined) fields.ame_delta = typeof ame.delta === "string"
        ? ame.delta.slice(0, 60)
        : JSON.stringify(ame.delta).slice(0, 60);
      if (ame.content !== undefined) fields.ame_content_len = String(ame.content).length;
    }
  }

  if (t === "tool_execution_start") {
    fields.toolName = obj.toolName;
    fields.toolCallId = obj.toolCallId;
    fields.intent = obj.intent;
    fields.args_keys = obj.args ? Object.keys(obj.args) : [];
  }

  if (t === "tool_execution_end") {
    fields.toolName = obj.toolName;
    fields.toolCallId = obj.toolCallId;
    fields.isError = obj.isError;
    // Show top-level result shape
    if (obj.result !== null && obj.result !== undefined) {
      fields.result_keys = typeof obj.result === "object" ? Object.keys(obj.result) : [typeof obj.result];
      if (obj.result?.details !== undefined) {
        fields.result_details_keys = typeof obj.result.details === "object"
          ? Object.keys(obj.result.details) : [typeof obj.result.details];
      }
    }
  }

  if (t === "turn_start") fields.turnIndex = obj.turnIndex;
  if (t === "turn_end") {
    fields.turnIndex = obj.turnIndex;
    fields.msg_role = obj.message?.role;
    fields.msg_usage = obj.message?.usage
      ? { input: obj.message.usage.input, output: obj.message.usage.output }
      : null;
  }
  if (t === "agent_start") {}
  if (t === "agent_end") fields.msg_count = obj.messages?.length;

  console.log(JSON.stringify(fields));
});

function send(cmd) {
  proc.stdin.write(JSON.stringify(cmd) + "\n");
}

// Kill after 20 seconds
setTimeout(() => {
  console.log(`\n[done] ${lineCount} lines received. Killing agent.`);
  proc.kill();
  process.exit(0);
}, 20_000);

/**
 * test-rpc.mjs — Direct omp RPC protocol probe.
 * Spawns omp --mode rpc, sends "say hello in one sentence", logs every
 * event with type + key fields for 15 seconds, then exits.
 *
 * Run: node test-rpc.mjs  OR  bun test-rpc.mjs
 */

import { spawn } from "child_process";
import { createInterface } from "readline";

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
    console.log("[ready] agent is up — sending test prompt");
    send({ type: "prompt", message: "Say hello in one sentence. Be brief." });
    return;
  }

  if (t === "response") {
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

#!/usr/bin/env bun
// omp simulator: speaks enough of `omp --mode rpc-ui` for OMP Desktop to open a
// tab, and answers each prompt by replaying a recorded omp session file
// (`~/.omp/agent/sessions/**.jsonl`) as a live stream: message_update frames
// per chunk, tool cards, tool results. No model, no network, deterministic.
//
// Build it as the `omp` the app finds first on PATH:
//   bun build --compile scripts/omp-sim.mjs --outfile <dir>/omp.exe
//   PATH=<dir>;%PATH% OMP_SIM_SESSION=<file.jsonl> <omp-desktop.exe>
//
// Environment:
//   OMP_SIM_SESSION  session .jsonl to replay (required for replies)
//   OMP_SIM_REPLAY   "turn" (default): each prompt replays the next recorded
//                    user turn; "all": the first prompt replays the whole file
//   OMP_SIM_UPDATES  "full" (default) or "delta": initial message_update shape;
//                    `set_event_filter { messageUpdates }` changes it, as in omp
//   OMP_SIM_CHUNK    characters per streamed delta (default 20)
//   OMP_SIM_CPS      streamed characters per second; 0 (default) = unpaced
//   OMP_SIM_LOG      file to append one JSON line per replayed run (timings)
import fs from "node:fs";
import readline from "node:readline";

const VERSION = "18.14.0";
const MAX_FRAME_BYTES = 1024 * 1024; // omp MAX_RPC_FRAME_BYTES
const CHUNK_PAYLOAD_BYTES = 256 * 1024; // omp RPC_CHUNK_PAYLOAD_BYTES

if (process.argv.includes("--version")) {
  process.stdout.write(`omp/${VERSION}\n`);
  process.exit(0);
}

const env = process.env;
const CHUNK = Math.max(1, Number(env.OMP_SIM_CHUNK) || 20);
const CPS = Math.max(0, Number(env.OMP_SIM_CPS) || 0);
const REPLAY_ALL = env.OMP_SIM_REPLAY === "all";
let messageUpdates = env.OMP_SIM_UPDATES === "delta" ? "delta" : "full";
let protocolV2 = false;

// ── Recorded session ─────────────────────────────────────────────────────────
const recorded = [];
let model = { provider: "omp-sim", id: "replay", name: "omp-sim replay", contextWindow: 200000 };
if (env.OMP_SIM_SESSION) {
  for (const line of fs.readFileSync(env.OMP_SIM_SESSION, "utf8").split("\n")) {
    if (!line) continue;
    let entry;
    try { entry = JSON.parse(line); } catch { continue; }
    if (entry.type !== "message" || !entry.message?.role) continue;
    recorded.push(entry.message);
    if (entry.message.role === "assistant" && model.provider === "omp-sim" && entry.message.model) {
      model = { ...model, provider: entry.message.provider ?? "omp-sim", id: entry.message.model, name: entry.message.model };
    }
  }
}
let cursor = 0;
// A prompt's first recorded user message is the prompt itself: skip it.
while (cursor < recorded.length && recorded[cursor].role !== "user") cursor++;

const history = [];
let running = null; // { aborted }
let messageSeq = 0;
let chunkSeq = 0;
const sessionId = `omp-sim-${process.pid}`;

// ── Output ───────────────────────────────────────────────────────────────────
// fd write stream: reports backpressure on Windows (process.stdout blocks).
const out = process.platform === "win32" ? fs.createWriteStream("", { fd: 1, autoClose: false }) : process.stdout;
const stats = { frames: 0, bytes: 0 };

async function writeLine(line) {
  stats.frames++;
  stats.bytes += Buffer.byteLength(line);
  if (!out.write(line)) await new Promise(r => out.once("drain", r));
}

async function emitNow(frame) {
  const json = JSON.stringify(frame);
  if (!protocolV2 || Buffer.byteLength(json) + 1 <= MAX_FRAME_BYTES) return writeLine(json + "\n");
  const bytes = Buffer.from(json, "utf8");
  const count = Math.ceil(bytes.length / CHUNK_PAYLOAD_BYTES);
  const chunkId = `sim-${++chunkSeq}`;
  for (let index = 0; index < count; index++) {
    const data = bytes.subarray(index * CHUNK_PAYLOAD_BYTES, (index + 1) * CHUNK_PAYLOAD_BYTES).toString("base64");
    await writeLine(JSON.stringify({ type: "rpc_chunk", chunkId, index, count, byteLength: bytes.length, data }) + "\n");
  }
}

// One writer at a time: a response written while a replay streams must not
// land inside an rpc_chunk sequence.
let outputTail = Promise.resolve();
function emit(frame) {
  const done = outputTail.then(() => emitNow(frame));
  outputTail = done.catch(() => {});
  return done;
}

const respond = (id, command, data) =>
  emit(data === undefined ? { id, type: "response", command, success: true } : { id, type: "response", command, success: true, data });
const fail = (id, command, error) => emit({ id, type: "response", command, success: false, error });

// ── Pacing ───────────────────────────────────────────────────────────────────
let paceStart = 0, paceChars = 0;
async function pace(chars) {
  if (!CPS) return;
  paceChars += chars;
  const due = paceStart + (paceChars / CPS) * 1000;
  const wait = due - performance.now();
  if (wait > 1) await new Promise(r => setTimeout(r, wait));
}

// ── Streaming one assistant message ──────────────────────────────────────────
/** A toolCall's arguments with every string cut to `fraction` of its length:
 *  roughly the partially parsed arguments omp's snapshot carries mid-stream. */
function partialArgs(args, fraction) {
  if (typeof args === "string") return args.slice(0, Math.ceil(args.length * fraction));
  if (Array.isArray(args)) return args.map(v => partialArgs(v, fraction));
  if (args && typeof args === "object") {
    const res = {};
    for (const [k, v] of Object.entries(args)) res[k] = partialArgs(v, fraction);
    return res;
  }
  return args;
}

/** The streamed text of a block, and how to rebuild the block from a prefix. */
function blockStream(block) {
  switch (block.type) {
    case "text":
      return { kind: "text", text: block.text ?? "", at: n => ({ ...block, text: (block.text ?? "").slice(0, n) }) };
    case "thinking":
      return { kind: "thinking", text: block.thinking ?? "", at: n => ({ ...block, thinking: (block.thinking ?? "").slice(0, n) }) };
    case "toolCall": {
      const json = JSON.stringify(block.arguments ?? {});
      return { kind: "toolcall", text: json, at: n => ({ ...block, arguments: partialArgs(block.arguments ?? {}, json.length ? n / json.length : 1) }) };
    }
    default:
      return null;
  }
}

/** One message_update frame, in the shape `messageUpdates` selects. */
function updateFrame(messageId, partial, event) {
  if (messageUpdates === "full") {
    return { type: "message_update", message: partial, assistantMessageEvent: { ...event, partial }, messageId };
  }
  return { type: "message_update", message: { role: "assistant" }, assistantMessageEvent: event, messageId };
}

async function streamAssistant(final) {
  const messageId = `msg-${++messageSeq}`;
  const shell = { ...final, content: [] };
  await emit({ type: "message_start", message: shell, messageId });
  const content = [];
  const snapshot = () => ({ ...final, content: content.slice() });
  for (let index = 0; index < final.content.length; index++) {
    if (running.aborted) break;
    const block = final.content[index];
    const s = blockStream(block);
    if (!s) {
      content.push(block);
      continue;
    }
    content.push(s.at(0));
    await emit(updateFrame(messageId, snapshot(), {
      type: `${s.kind}_start`, contentIndex: index,
      ...(messageUpdates === "delta" ? { block: s.at(0) } : {}),
    }));
    for (let n = 0; n < s.text.length && !running.aborted; n += CHUNK) {
      const delta = s.text.slice(n, n + CHUNK);
      content[index] = s.at(n + delta.length);
      await emit(updateFrame(messageId, snapshot(), { type: `${s.kind}_delta`, contentIndex: index, delta }));
      await pace(delta.length);
    }
    content[index] = block;
    const end = s.kind === "toolcall"
      ? { type: "toolcall_end", contentIndex: index, toolCall: block }
      : { type: `${s.kind}_end`, contentIndex: index, content: s.text,
          ...(messageUpdates === "delta" ? { block: s.kind === "text" ? { ...block, text: undefined } : { ...block, thinking: undefined } } : {}) };
    await emit(updateFrame(messageId, snapshot(), end));
  }
  const message = running.aborted ? { ...final, content, stopReason: "aborted" } : final;
  await emit({ type: "message_end", message, messageId });
  history.push(message);
  return message;
}

async function plainMessage(message) {
  const messageId = `msg-${++messageSeq}`;
  await emit({ type: "message_start", message, messageId });
  await emit({ type: "message_end", message, messageId });
  history.push(message);
}

// ── One prompt = one replayed run ────────────────────────────────────────────
async function run(prompt) {
  running = { aborted: false };
  const t0 = Date.now();
  const before = { ...stats };
  paceStart = performance.now();
  paceChars = 0;
  await emit({ type: "agent_start" });
  await plainMessage({ role: "user", content: [{ type: "text", text: prompt }], timestamp: Date.now() });
  let turnOpen = false;
  let replayed = 0;
  for (; cursor < recorded.length && !running.aborted; cursor++) {
    const message = recorded[cursor];
    if (message.role === "user" && !REPLAY_ALL && replayed > 0) break;
    if (message.role === "user" && replayed === 0) continue; // this prompt's own recorded copy
    replayed++;
    if (message.role === "assistant") {
      if (turnOpen) await emit({ type: "turn_end", message: history.at(-1), toolResults: [] });
      await emit({ type: "turn_start" });
      turnOpen = true;
      const final = await streamAssistant({ ...message, timestamp: Date.now() });
      for (const call of final.content.filter(b => b.type === "toolCall")) {
        await emit({ type: "tool_execution_start", toolCallId: call.id, toolName: call.name, args: call.arguments, intent: call.intent });
      }
    } else if (message.role === "toolResult") {
      await emit({
        type: "tool_execution_end", toolCallId: message.toolCallId, toolName: message.toolName,
        result: { content: message.content, details: message.details }, isError: message.isError === true,
      });
      await plainMessage({ ...message, timestamp: Date.now() });
    } else {
      await plainMessage({ ...message, timestamp: Date.now() });
    }
  }
  if (cursor < recorded.length && recorded[cursor].role === "user") cursor++;
  if (turnOpen) await emit({ type: "turn_end", message: history.at(-1), toolResults: [] });
  if (replayed === 0) {
    await streamAssistant({ role: "assistant", content: [{ type: "text", text: "omp-sim: the recorded session has no more turns." }],
      provider: model.provider, model: model.id, stopReason: "stop", timestamp: Date.now() });
  }
  await emit({ type: "agent_end", messages: [] });
  if (env.OMP_SIM_LOG) {
    fs.appendFileSync(env.OMP_SIM_LOG, JSON.stringify({
      mode: messageUpdates, chunk: CHUNK, cps: CPS, start: t0, end: Date.now(),
      frames: stats.frames - before.frames, bytes: stats.bytes - before.bytes, aborted: running.aborted,
    }) + "\n");
  }
  running = null;
}

// ── Commands ─────────────────────────────────────────────────────────────────
function state() {
  return {
    model, thinkingLevel: "off", isStreaming: running !== null, isCompacting: false,
    steeringMode: "one-at-a-time", followUpMode: "one-at-a-time", interruptMode: "immediate",
    sessionFile: null, sessionId, sessionName: "omp-sim", autoCompactionEnabled: false,
    queuedMessageCount: 0, hasPendingAsyncWork: false, isSettled: running === null,
    queuedMessages: { steering: [], followUp: [], liveSteered: [] }, todoPhases: [],
    fastModeEnabled: false, fastModeActive: false, slowModeSupported: false, slowModeEnabled: false,
    messageCount: history.length, contextUsage: null, goal: null,
  };
}

async function handle(cmd) {
  const { id, type } = cmd;
  switch (type) {
    case "negotiate_protocol":
      if (cmd.protocolVersion !== 2) return fail(id, type, `Unsupported RPC protocol version: ${cmd.protocolVersion}`);
      await respond(id, type, { protocolVersion: 2 });
      protocolV2 = true;
      return;
    case "set_event_filter":
      if (cmd.messageUpdates !== undefined && cmd.messageUpdates !== "full" && cmd.messageUpdates !== "delta") {
        return fail(id, type, 'messageUpdates must be "full" or "delta"');
      }
      messageUpdates = cmd.messageUpdates ?? "full";
      return respond(id, type, { events: null, messageUpdates });
    case "get_state": return respond(id, type, state());
    case "get_messages": return respond(id, type, { messages: history });
    case "get_available_models": return respond(id, type, { models: [model] });
    case "get_available_commands": return respond(id, type, { commands: [] });
    case "get_subagents": return respond(id, type, { subagents: [] });
    case "get_available_thinking_levels": return respond(id, type, { levels: ["off"] });
    case "get_session_stats": return respond(id, type, { sessionId, totalMessages: history.length });
    case "prompt": {
      if (running) return fail(id, type, "omp-sim: a replay is already running");
      await respond(id, type);
      const text = String(cmd.message ?? "");
      if (text.startsWith("/")) return; // builtins (auto-rename's /rename) are no-ops here
      void run(text);
      return;
    }
    case "abort":
      if (running) running.aborted = true;
      return respond(id, type);
    default:
      // Settings toggles and subscriptions: accepted, nothing to simulate.
      return respond(id, type);
  }
}

await emit({ type: "ready", protocolVersion: 1, supportedProtocolVersions: [1, 2], maxFrameBytes: MAX_FRAME_BYTES, maxReassembledFrameBytes: 64 * 1024 * 1024 });
const rl = readline.createInterface({ input: process.stdin });
rl.on("line", line => {
  if (!line.trim()) return;
  let cmd;
  try { cmd = JSON.parse(line); } catch { return; }
  void handle(cmd);
});
rl.on("close", () => process.exit(0));

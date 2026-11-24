// Loads the persona extension against a fake service socket and checks
// that each tool sends hello + one request and returns the reply.
import assert from "node:assert/strict";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import fs from "node:fs";

let checks = 0;
const check = async (label, fn) => { await fn(); checks++; };

const sock = process.platform === "win32" ? `\\\\.\\pipe\\ompy-ext-test-${process.pid}` : path.join(os.tmpdir(), `ompy-ext-${process.pid}.sock`);
if (process.platform !== "win32") fs.rmSync(sock, { force: true });
const seen = [];
const server = net.createServer(c => {
  c.setEncoding("utf8");
  let buf = "";
  c.on("data", d => {
    buf += d;
    let i;
    while ((i = buf.indexOf("\n")) >= 0) {
      const msg = JSON.parse(buf.slice(0, i)); buf = buf.slice(i + 1);
      seen.push(msg);
      if (msg.type === "hello") c.write(JSON.stringify({ type: "hello", protocol: 1 }) + "\n");
      else if (msg.type === "schedule_wake" && !msg.note) c.write(JSON.stringify({ type: "reply", req: msg.req, ok: false, error: "note required" }) + "\n");
      else if (msg.note === "split utf8") {
        const reply = Buffer.from(JSON.stringify({ type: "reply", req: msg.req, ok: true, data: { text: "prüfen" } }) + "\n");
        const split = reply.indexOf(Buffer.from("ü")) + 1;
        c.write(reply.subarray(0, split));
        setImmediate(() => c.write(reply.subarray(split)));
      } else if (msg.note === "close") c.end();
      else if (msg.note === "malformed") c.write("not json\n");
      else c.write(JSON.stringify({ type: "reply", req: msg.req, ok: true, data: { echo: msg.type } }) + "\n");
    }
  });
});
await new Promise(r => server.listen(sock, r));
process.env.OMPY_SOCKET = sock;

const tools = new Map();
const { default: register } = await import(new URL("../src-tauri/crates/omp-desktopd/persona/extension.mjs", import.meta.url));
register({ registerTool: t => tools.set(t.name, t) });

await check("registers four read-tier tools", () => {
  assert.deepEqual([...tools.keys()].sort(), ["cancel_wake", "list_schedule", "notify", "schedule_wake"]);
  for (const t of tools.values()) assert.equal(t.approval, "read");
});

await check("schedule_wake sends hello then inMs", async () => {
  seen.length = 0;
  const res = await tools.get("schedule_wake").execute("call1", { in_minutes: 90, note: "check invoices" });
  assert.equal(seen[0].type, "hello");
  assert.equal(seen[0].client, "extension");
  assert.equal(seen[1].inMs, 90 * 60000);
  assert.match(JSON.stringify(res), /schedule_wake/);
});

await check("service errors become thrown errors", async () => {
  await assert.rejects(tools.get("schedule_wake").execute("call2", { in_minutes: 5, note: "" }), /note required/);
});

await check("notify passes kind and options", async () => {
  seen.length = 0;
  await tools.get("notify").execute("call3", { kind: "decision", title: "Termin?", options: ["Do", "Fr"] });
  assert.deepEqual([seen[1].kind, seen[1].options], ["decision", ["Do", "Fr"]]);
});

await check("decodes a multi-byte character split across chunks", async () => {
  const res = await tools.get("schedule_wake").execute("call4", { in_minutes: 1, note: "split utf8" });
  assert.match(JSON.stringify(res), /prüfen/);
});

await check("rejects malformed service replies", async () => {
  await assert.rejects(tools.get("schedule_wake").execute("call5", { in_minutes: 1, note: "malformed" }));
});

await check("rejects promptly when the service closes without a reply", async () => {
  const started = Date.now();
  await assert.rejects(
    tools.get("schedule_wake").execute("call6", { in_minutes: 1, note: "close" }),
    /persona service closed the connection/,
  );
  assert.ok(Date.now() - started < 2000, "close rejection must not wait for the 10 s timeout");
});

await check("rejects an invalid ISO time before contacting the service", async () => {
  seen.length = 0;
  await assert.rejects(
    tools.get("schedule_wake").execute("call7", { at: "tomorrow-ish", note: "check" }),
    { message: "at is not an ISO 8601 time: tomorrow-ish" },
  );
  assert.equal(seen.length, 0);
});

server.close();
console.log(`test-persona-extension: ${checks} checks passed`);

// Ompy's tools: they talk to the persona service (omp-desktopd) over its
// local socket. One connection per call: hello, one request, one reply.
import net from "node:net";

function call(type, fields) {
  const sock = process.env.OMPY_SOCKET;
  if (!sock) return Promise.reject(new Error("OMPY_SOCKET is not set; Ompy tools only work inside the persona service"));
  return new Promise((resolve, reject) => {
    const c = net.createConnection(sock);
    let buf = "", done = false;
    const finish = (err, data) => { if (done) return; done = true; clearTimeout(timer); c.destroy(); err ? reject(err) : resolve(data); };
    const timer = setTimeout(() => finish(new Error("persona service did not answer")), 10000);
    c.on("error", e => finish(e));
    c.on("connect", () => {
      c.write(JSON.stringify({ req: 0, type: "hello", protocol: 1, client: "extension" }) + "\n");
      c.write(JSON.stringify({ req: 1, type, ...fields }) + "\n");
    });
    c.on("data", d => {
      buf += d;
      let i;
      while ((i = buf.indexOf("\n")) >= 0) {
        const msg = JSON.parse(buf.slice(0, i)); buf = buf.slice(i + 1);
        if (msg.type === "reply" && msg.req === 1) finish(msg.ok ? null : new Error(msg.error || "failed"), msg.data);
        if (msg.type === "reply" && msg.req === 0 && !msg.ok) finish(new Error(msg.error || "handshake failed"));
      }
    });
  });
}

const text = data => ({ content: [{ type: "text", text: JSON.stringify(data ?? null) }] });

export default function (pi) {
  pi.registerTool({
    name: "schedule_wake", label: "Schedule wake-up", approval: "read",
    description: "Wake yourself up later to continue work. Give exactly one of `at` (ISO 8601 time) or `in_minutes`, and a `note` saying what to do then. At most 50 pending, at most 30 days ahead.",
    parameters: { type: "object", properties: { at: { type: "string" }, in_minutes: { type: "number" }, note: { type: "string" } }, required: ["note"], additionalProperties: false },
    async execute(_id, p) {
      const fields = { note: p.note };
      if (p.at !== undefined) fields.atMs = Date.parse(p.at);
      if (p.in_minutes !== undefined) fields.inMs = Math.round(p.in_minutes * 60000);
      return text(await call("schedule_wake", fields));
    },
  });
  pi.registerTool({
    name: "list_schedule", label: "List wake-ups", approval: "read",
    description: "List your pending self-scheduled wake-ups and the next interval wake-up.",
    parameters: { type: "object", properties: {}, additionalProperties: false },
    async execute() { return text(await call("list_schedule", {})); },
  });
  pi.registerTool({
    name: "cancel_wake", label: "Cancel wake-up", approval: "read",
    description: "Cancel one of your self-scheduled wake-ups by id.",
    parameters: { type: "object", properties: { id: { type: "string" } }, required: ["id"], additionalProperties: false },
    async execute(_id, p) { return text(await call("cancel_wake", { id: p.id })); },
  });
  pi.registerTool({
    name: "notify", label: "Tell the user", approval: "read",
    description: "Put an item in the user's inbox. kind `result` reports what you did; kind `decision` asks the user to choose among `options` and resumes you with the choice. Set `urgent` only when it cannot wait until morning.",
    parameters: { type: "object", properties: { kind: { type: "string", enum: ["result", "decision"] }, title: { type: "string" }, body: { type: "string" }, options: { type: "array", items: { type: "string" } }, urgent: { type: "boolean" } }, required: ["kind", "title"], additionalProperties: false },
    async execute(_id, p) { return text(await call("notify", { kind: p.kind, title: p.title, body: p.body ?? null, options: p.options ?? null, urgent: !!p.urgent })); },
  });
}

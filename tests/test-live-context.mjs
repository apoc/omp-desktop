#!/usr/bin/env node
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";
import { test } from "node:test";

const window = {};
runInNewContext(readFileSync(new URL("../src/app/live-context.js", import.meta.url), "utf8"), { window, TextEncoder });
const C = window.OMP_LIVE_CONTEXT;
const history = instructions => JSON.parse(instructions.split("\nConversation history (JSON data):\n")[1]);

test("live startup includes earlier chat intent, completed work and spoken discussion", () => {
  const prompt = C.instructions({
    project: "/work/desktop",
    messages: [
      { role: "user", content: [{ type: "text", text: "Add offline mode without losing drafts." }] },
      { role: "assistant", content: [{ type: "thinking", thinking: "private scratchpad" }, { type: "text", text: "Draft persistence is implemented; network tests are still pending." }] },
    ],
    voice: [
      { role: "user", turn: 1, text: "Keep the pause button next to mute.", final: true },
      { role: "assistant", turn: 1, text: "Yes, and resume will preserve the discussion.", final: true },
    ],
  });
  const data = history(prompt);
  assert.equal(data.project, "/work/desktop");
  assert.deepEqual(data.chat.messages.map(m => m.text), ["Add offline mode without losing drafts.", "Draft persistence is implemented; network tests are still pending."]);
  assert.deepEqual(data.voice.messages.map(m => m.text), ["Keep the pause button next to mute.", "Yes, and resume will preserve the discussion."]);
  assert.equal(prompt.includes("private scratchpad"), false);
});

test("history containing Handlebars expressions stays literal and round-trips exactly", () => {
  const text = 'Keep {{firstName}}, {{{username}}}, {{#if secret}}private{{/if}} and "quotes" literal.';
  const prompt = C.instructions({ messages: [{ role: "user", content: text }], voice: [] });
  const raw = prompt.split("\nConversation history (JSON data):\n")[1];
  assert.equal(raw.includes("{{"), false);
  assert.equal(history(prompt).chat.messages[0].text, text);
});

test("tools supply execution evidence, not thinking or image payloads", () => {
  const data = history(C.instructions({ messages: [
    { role: "user", content: [{ type: "image", data: "private-image-base64" }, { type: "text", text: "Run the verification." }] },
    { role: "assistant", content: [{ type: "thinking", thinking: "secret" }, { type: "toolCall", name: "bash", arguments: { command: "npm test" } }] },
    { role: "toolResult", toolName: "bash", content: [{ type: "text", text: "42 passed; 0 failed" }] },
  ] }));
  assert.deepEqual(data.chat.messages, [
    { role: "user", text: "Run the verification." },
    { role: "assistant", text: "Tool calls: bash" },
    { role: "toolResult", text: "42 passed; 0 failed", tool: "bash" },
  ]);
});

test("large histories retain the original goal and latest exchanges with explicit omissions", () => {
  const messages = [{ role: "user", content: "Original goal: offline editing" }];
  for (let i = 0; i < 50; i++) messages.push({ role: "assistant", content: `${i}: ${"x".repeat(8000)}` });
  messages.push({ role: "user", content: "Latest change: never discard unsaved drafts" });
  const data = history(C.instructions({ messages }));
  assert.equal(data.chat.messages[0].text, "Original goal: offline editing");
  assert.equal(data.chat.messages.at(-1).text, "Latest change: never discard unsaved drafts");
  assert.ok(data.chat.omitted > 0);
  assert.ok(data.chat.messages.reduce((n, m) => n + m.text.length, 0) <= C.LIMITS.chat);
});

test("complete voice instructions fit the service envelope after Unicode and JSON escaping", () => {
  const messages = [{ role: "user", content: "Original objective: preserve drafts." }];
  for (let i = 0; i < 80; i++) messages.push({ role: "toolResult", toolName: "bash", content: '{{"漢字😀\\\\\\n"}}'.repeat(1000) });
  messages.push({ role: "user", content: "Latest request: verify resume." });
  const voice = Array.from({ length: 30 }, (_, i) => ({ role: i % 2 ? "assistant" : "user", text: "Earlier spoken decision: " + "語😀{{}}".repeat(1000), final: true }));
  const prompt = C.instructions({ messages, voice, project: "{{😀}}".repeat(1000) });
  assert.ok(Buffer.byteLength(prompt, "utf8") <= 12288, "the complete template must leave room below the 16384-token ceiling");
  const data = history(prompt);
  assert.equal(data.chat.messages[0].text, "Original objective: preserve drafts.");
  assert.equal(data.chat.messages.at(-1).text, "Latest request: verify resume.");
  assert.ok(data.chat.omitted > 0);
  assert.ok(data.voice.messages.length > 0);
});

test("row metadata and numerous short messages are charged to the instruction budget", () => {
  const messages = [{ role: "user", content: "Keep the original objective." },
    ...Array.from({ length: 3000 }, () => ({ role: "toolResult", toolName: "bash", content: "x" })),
    { role: "assistant", content: "Latest result." }];
  const prompt = C.instructions({ messages });
  const data = history(prompt);
  assert.ok(Buffer.byteLength(prompt, "utf8") <= 12288);
  assert.equal(data.chat.messages[0].text, "Keep the original objective.");
  assert.equal(data.chat.messages.at(-1).text, "Latest result.");
  assert.ok(data.chat.omitted > 0);
});

test("oversized anchors cannot crowd out the latest turn or split Unicode text", () => {
  const text = "😀{{語}}".repeat(8000);
  const prompt = C.instructions({ messages: [
    { role: "compactionSummary", summary: text },
    { role: "user", content: text },
    { role: "assistant", content: text },
  ], voice: [{ role: "user", text, final: true }, { role: "assistant", text: "Latest spoken choice: keep drafts.", final: true }] });
  assert.ok(Buffer.byteLength(prompt, "utf8") <= 12288);
  const data = history(prompt);
  assert.deepEqual(data.chat.messages.map(row => row.role), ["compactionSummary", "user", "assistant"]);
  for (const row of data.chat.messages) {
    assert.equal(row.truncated, true);
    assert.ok(text.startsWith(row.text));
    assert.equal(row.text.isWellFormed(), true);
  }
  assert.equal(data.voice.messages.at(-1).text, "Latest spoken choice: keep drafts.");
});

test("truncation is reported without splitting a Unicode surrogate pair", () => {
  const data = history(C.instructions({ messages: [{ role: "user", content: "x".repeat(C.LIMITS.entry - 1) + "😀tail" }] }));
  assert.equal(data.chat.messages[0].truncated, true);
  assert.equal(data.chat.messages[0].text, "x".repeat(C.LIMITS.entry - 1));
});

test("separate tab histories never reuse another conversation's voice discussion", () => {
  C.instructions({ project: "/alpha", messages: [], voice: [{ role: "user", text: "alpha-only private decision", final: true }] });
  const next = history(C.instructions({ project: "/beta", messages: [{ role: "user", content: "beta task" }], voice: [] }));
  assert.deepEqual(next.voice.messages, []);
  assert.equal(JSON.stringify(next).includes("alpha"), false);
  assert.throws(() => C.instructions({ messages: null }), /history/);
});

test("compacted and branched chat retains the summary that holds earlier decisions", () => {
  const data = history(C.instructions({ messages: [
    { role: "compactionSummary", summary: "We chose SQLite, not JSON. Preserve drafts across offline edits." },
    { role: "branchSummary", summary: "The previous branch verified migration rollback." },
    { role: "user", content: "Continue with the pause control." },
  ] }));
  assert.deepEqual(data.chat.messages.map(m => m.text), [
    "We chose SQLite, not JSON. Preserve drafts across offline edits.",
    "The previous branch verified migration rollback.",
    "Continue with the pause control.",
  ]);
});

test("a long compacted conversation keeps its saved intent as well as the latest turn", () => {
  const messages = [{ role: "compactionSummary", summary: "Saved intent: prioritize offline editing over sync." },
    { role: "user", content: "Continue implementation." }];
  for (let i = 0; i < 30; i++) messages.push({ role: "assistant", content: "x".repeat(8000) });
  messages.push({ role: "user", content: "Now add resume." });
  const data = history(C.instructions({ messages }));
  assert.equal(data.chat.messages[0].text, "Saved intent: prioritize offline editing over sync.");
  assert.equal(data.chat.messages.at(-1).text, "Now add resume.");
});

test("hidden custom thinking never enters the voice context", () => {
  const prompt = C.instructions({ messages: [
    { role: "custom", customType: "interrupted-thinking", content: "private scratchpad continuity" },
    { role: "custom", customType: "internal-note", display: false, content: "hidden internal note" },
    { role: "custom", customType: "live-delegation", display: true, content: "User asked to add pause and resume." },
  ] });
  assert.equal(prompt.includes("private scratchpad continuity"), false);
  assert.equal(prompt.includes("hidden internal note"), false);
  assert.deepEqual(history(prompt).chat.messages, [{ role: "custom", text: "User asked to add pause and resume." }]);
});

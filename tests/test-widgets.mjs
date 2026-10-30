#!/usr/bin/env node
// Regression script for src/app/widgets.js — the rail widget plugin output
// contract (schema v1 validation and capping, safe urls, insert and append
// text) and the run bookkeeping app/use-widgets.jsx builds card props with
// (event/snapshot merge, parse cache, card state). Triggers, matching,
// approval and scheduling are Rust's (src-tauri/src/widgets/, cargo test).
// Run: node tests/test-widgets.mjs

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const win = {};
// eslint-disable-next-line no-new-func
new Function("window", readFileSync(join(root, "src/app/widgets.js"), "utf8"))(win);
const W = win.OMP_WIDGETS;

let passed = 0;
function check(label, fn) {
  try { fn(); } catch (err) { console.error(`FAILED: ${label}`); throw err; }
  passed++;
}
const out = (o) => W.parseOutput(JSON.stringify(o));

// ── parseOutput ───────────────────────────────────────────────────────────
check("valid v1 output renders its blocks and default status", () => {
  const r = out({ version: 1, blocks: [{ type: "text", text: "hi" }] });
  assert.equal(r.ok, true);
  assert.equal(r.widget.status, "neutral");
  assert.deepEqual(r.widget.blocks, [{ type: "text", text: "hi" }]);
  assert.equal(r.widget.skipped, 0);
});
check("non-JSON stdout is an error that echoes none of it", () => {
  const r = W.parseOutput("not json token=secret");
  assert.equal(r.ok, false);
  assert.equal(r.error, "stdout is not JSON");
});
check("top-level null, array, string and number are not a widget", () => {
  for (const src of ["null", "[]", "[1]", '"str"', "5", "true"]) {
    const r = W.parseOutput(src);
    assert.equal(r.ok, false, src);
    assert.match(r.error, /not a JSON object/, src);
  }
});
check("version 2 is rejected with the supported version named", () => {
  const r = out({ version: 2, blocks: [] });
  assert.equal(r.ok, false);
  assert.match(r.error, /version 2.*supports 1/);
});
check("non-primitive version is an error, not an exception", () => {
  const r = W.parseOutput('{"version":{"toString":null}}');
  assert.equal(r.ok, false);
  assert.match(r.error, /invalid version/);
});
check("string version is rejected", () => {
  const r = out({ version: "1", blocks: [] });
  assert.equal(r.ok, false);
  assert.match(r.error, /invalid version/);
});
check("missing blocks array is an error", () => {
  assert.equal(out({ version: 1 }).ok, false);
  assert.equal(out({ version: 1, blocks: {} }).ok, false);
});
check("unknown block types are skipped and counted", () => {
  const r = out({ version: 1, blocks: [{ type: "hologram" }, { type: "text", text: "x" }, null, "str", { text: "no type" }] });
  assert.deepEqual(r.widget.blocks, [{ type: "text", text: "x" }]);
  assert.equal(r.widget.skipped, 4);
});
check("unknown fields are dropped from blocks and items", () => {
  const r = out({ version: 1, blocks: [
    { type: "text", text: "x", html: "<b>x</b>", onClick: "alert(1)", style: "color:red" },
    { type: "list", items: [{ label: "a", html: "<i>", className: "evil" }], extra: 1 },
  ] });
  assert.deepEqual(r.widget.blocks, [
    { type: "text", text: "x" },
    { type: "list", items: [{ label: "a", tone: "neutral" }] },
  ]);
});
check("unknown status/tone fall back to neutral", () => {
  const r = out({ version: 1, status: "purple", blocks: [{ type: "status", label: "a", value: "b", tone: "loud" }] });
  assert.equal(r.widget.status, "neutral");
  assert.equal(r.widget.blocks[0].tone, "neutral");
});
check("strings are capped and lists are truncated", () => {
  const items = Array.from({ length: 80 }, (_, i) => ({ label: "x".repeat(500) + i }));
  const r = out({ version: 1, blocks: [{ type: "list", items }, { type: "text", text: "y".repeat(5000) }] });
  assert.equal(r.widget.blocks[0].items.length, 50);
  assert.equal(r.widget.blocks[0].items[0].label.length, 200);
  assert.equal(r.widget.blocks[1].text.length, 2000);
});
check("more than 32 blocks are truncated", () => {
  const blocks = Array.from({ length: 40 }, () => ({ type: "text", text: "t" }));
  assert.equal(out({ version: 1, blocks }).widget.blocks.length, 32);
});
check("number and progress take finite numbers or decimal strings, else are skipped", () => {
  const r = out({ version: 1, blocks: [
    { type: "number", label: "n", value: "12" },
    { type: "number", label: "neg", value: " -1.5e2 " },
    { type: "number", label: "bad", value: "NaN" },
    { type: "progress", label: "p", value: 2, max: 0 },
  ] });
  assert.equal(r.widget.blocks[0].value, 12);
  assert.equal(r.widget.blocks[1].value, -150);
  assert.equal(r.widget.blocks[2].max, 1, "max<1 becomes 1");
  assert.equal(r.widget.blocks.length, 3, "NaN number skipped");
  assert.equal(r.widget.skipped, 1);
});
check("blank and non-decimal numeric strings are skipped, never shown as 0 or hex", () => {
  for (const value of ["", "   ", "0x10", "0b11", "0o7", "1,5", "12px", "Infinity"]) {
    const r = out({ version: 1, blocks: [{ type: "number", label: "n", value }, { type: "progress", label: "p", value }] });
    assert.deepEqual(r.widget.blocks, [], JSON.stringify(value));
  }
  const p = out({ version: 1, blocks: [{ type: "progress", label: "p", value: 1, max: "" }] });
  assert.equal(p.widget.blocks[0].max, 1, "blank max falls back to 1");
});
check("kv rows need a scalar k and v; a number or boolean k is coerced", () => {
  const r = out({ version: 1, blocks: [{ type: "kv", rows: [{ k: "a", v: "b" }, { k: 2024, v: "x" }, { k: true, v: 1 }, { k: null, v: "y" }, { k: {}, v: "z" }, { k: "c" }, "junk"] }] });
  assert.deepEqual(r.widget.blocks[0].rows, [{ k: "a", v: "b" }, { k: "2024", v: "x" }, { k: "true", v: "1" }]);
});
check("inherited Object.prototype keys are not block types", () => {
  const r = out({ version: 1, blocks: [{ type: "__proto__" }, { type: "constructor" }, { type: "toString" }, { type: "text", text: "ok" }] });
  assert.deepEqual(r.widget.blocks, [{ type: "text", text: "ok" }]);
  assert.equal(r.widget.skipped, 3);
});
check("non-number non-string numeric fields never throw", () => {
  const r = out({ version: 1, blocks: [
    { type: "number", label: "n", value: { toString: null } },
    { type: "progress", label: "p", value: { toString: null } },
    { type: "progress", label: "q", value: 1, max: { toString: null } },
    { type: "text", text: "ok" },
  ] });
  assert.deepEqual(r.widget.blocks, [{ type: "progress", label: "q", value: 1, max: 1 }, { type: "text", text: "ok" }]);
  assert.equal(r.widget.skipped, 2);
});
check("status with neither label nor value is skipped", () => {
  const r = out({ version: 1, blocks: [
    { type: "status" },
    { type: "status", label: "", value: "" },
    { type: "status", label: {}, value: null },
    { type: "status", value: 0 },
  ] });
  assert.deepEqual(r.widget.blocks, [{ type: "status", label: "", value: "0", tone: "neutral" }]);
  assert.equal(r.widget.skipped, 3);
});
check("labels on status, number, progress and link accept scalars", () => {
  const r = out({ version: 1, blocks: [
    { type: "status", label: 5, value: "" },
    { type: "number", label: 3, value: 1 },
    { type: "progress", label: true, value: 1 },
    { type: "link", label: 42, url: "https://x.y" },
    { type: "number", label: {}, value: 2 },
  ] });
  assert.deepEqual(r.widget.blocks.map(b => b.label), ["5", "3", "true", "42", ""]);
});

// ── link ──────────────────────────────────────────────────────────────────
check("link without label caps the label but keeps the full url", () => {
  const url = "https://example.com/" + "a".repeat(480);
  const r = out({ version: 1, blocks: [{ type: "link", url }] });
  assert.equal(r.widget.blocks[0].label.length, 200);
  assert.equal(r.widget.blocks[0].url.length, 500);
});
check("a link with a non-http(s) url stays as plain text without a url", () => {
  const r = out({ version: 1, blocks: [
    { type: "link", label: "docs", url: "file:///etc/passwd" },
    { type: "link", url: "javascript:alert(1)" },
    { type: "link", label: "x", url: "https://ok.example" },
    { type: "link" },
    { type: "link", url: 5 },
  ] });
  assert.deepEqual(r.widget.blocks, [
    { type: "link", label: "docs" },
    { type: "link", label: "javascript:alert(1)" },
    { type: "link", label: "x", url: "https://ok.example" },
  ]);
  assert.equal(r.widget.skipped, 2);
});
check("a list item's non-http(s) url is dropped, the item kept", () => {
  const r = out({ version: 1, blocks: [{ type: "list", items: [{ label: "a", url: "ftp://x" }] }] });
  assert.deepEqual(r.widget.blocks[0].items, [{ label: "a", tone: "neutral" }]);
});

// ── safeUrl / insertText / appendToDraft ──────────────────────────────────
check("only http(s) urls are opened", () => {
  assert.equal(W.safeUrl("https://x.y/z"), "https://x.y/z");
  assert.equal(W.safeUrl("http://x.y"), "http://x.y");
  assert.equal(W.safeUrl("HTTPS://X.Y"), "HTTPS://X.Y", "scheme is case-insensitive");
  for (const bad of ["javascript:alert(1)", " javascript:alert(1)", "\tjavascript:x", " https://x.y",
    "\u0001https://x.y", "data:text/html,<script>", "file:///etc/passwd", "//evil.com", "https:/x", "https:\\\\evil",
    "https://x.y/\u0000a", "https://x.y/\na", undefined, null, 5, {}]) {
    assert.equal(W.safeUrl(bad), null, JSON.stringify(bad));
  }
});
check("an over-long url is refused, never truncated to another address", () => {
  const ok = "https://x.y/" + "a".repeat(2000 - 12);
  assert.equal(W.safeUrl(ok), ok);
  assert.equal(W.safeUrl(ok + "b"), null);
});
check("insert text is capped and NUL-free", () => {
  const t = W.insertText({ insert: "a\u0000b" + "c".repeat(5000) });
  assert.equal(t.length, 2000);
  assert.equal(t.includes("\u0000"), false);
  assert.equal(t.startsWith("abc"), true);
});
check("insert falls back to label and safe url", () => {
  assert.equal(W.insertText({ label: "MR !1", url: "https://g/1" }), "MR !1 https://g/1");
  assert.equal(W.insertText({ label: "MR !1", url: "javascript:x" }), "MR !1");
  assert.equal(W.insertText({ label: "x" }), "x");
  assert.equal(W.insertText({}), "");
});
check("appendToDraft appends after the draft with single spaces", () => {
  assert.equal(W.appendToDraft("fix login", "MR !42"), "fix login MR !42 ");
  assert.equal(W.appendToDraft("fix login ", "MR !42"), "fix login MR !42 ", "no double space");
  assert.equal(W.appendToDraft("fix login", "  MR !42  "), "fix login MR !42 ", "insert is trimmed");
  assert.equal(W.appendToDraft("line one\n", "x"), "line one\nx ", "a trailing newline is kept");
  assert.equal(W.appendToDraft(W.appendToDraft("a", "b"), "c"), "a b c ", "repeated inserts");
});
check("appendToDraft keeps a /command draft", () => {
  assert.equal(W.appendToDraft("/skill:code-review check this", "MR !42"), "/skill:code-review check this MR !42 ");
  assert.equal(W.appendToDraft("/plan", "x"), "/plan x ");
});
check("appendToDraft on an empty draft, or with an empty insert", () => {
  assert.equal(W.appendToDraft("", "MR !42"), "MR !42 ");
  assert.equal(W.appendToDraft("   ", "MR !42"), "MR !42 ");
  assert.equal(W.appendToDraft(undefined, "x"), "x ");
  assert.equal(W.appendToDraft("draft", "   "), "draft", "blank insert changes nothing");
  assert.equal(W.appendToDraft("draft", ""), "draft");
});
check("tweakKey is namespaced per widget source", () => {
  assert.equal(W.tweakKey("git"), "widget:plugin:git");
});
check("hiddenPluginIds reads every switched-off plugin from the tweaks, loaded ones first", () => {
  const tweaks = {
    [W.tweakKey("zeta")]: false, // not in the config right now: still hidden
    [W.tweakKey("git")]: false,
    [W.tweakKey("mcp")]: true,
    [W.tweakKey("")]: false,
    "widget:ext:x": false,
    showRadar: false,
    [W.tweakKey("alpha")]: false,
    [W.tweakKey("hello")]: false,
  };
  assert.deepEqual(W.hiddenPluginIds(tweaks, ["hello", "mcp", "git"]), ["hello", "git", "alpha", "zeta"]);
  assert.deepEqual(W.hiddenPluginIds(tweaks, []), ["alpha", "git", "hello", "zeta"]);
  assert.deepEqual(W.hiddenPluginIds({}, ["git"]), []);
  assert.deepEqual(W.hiddenPluginIds(undefined, undefined), []);
});
check("argvDisplay quotes each element and escapes what could hide or fake an argument", () => {
  assert.equal(W.argvDisplay("bash"), '"bash"');
  assert.equal(W.argvDisplay(""), '""', "an empty argument stays visible");
  assert.equal(W.argvDisplay("a\nb"), '"a\\nb"', "a newline cannot pose as a second argument");
  assert.equal(W.argvDisplay('say "hi" \\ ok'), '"say \\"hi\\" \\\\ ok"');
  assert.equal(W.argvDisplay("x\u202Ehs.lmth"), '"x\\u202ehs.lmth"', "bidi override");
  assert.equal(W.argvDisplay("a\u200Bb\u0085c\u2028d\uFEFF"), '"a\\u200bb\\u0085c\\u2028d\\ufeff"');
  assert.equal(W.argvDisplay("~/ä €"), '"~/ä €"', "ordinary text is untouched");
});
// ── scalar coercion ───────────────────────────────────────────────────────
check("kv.v coerces string, number, boolean; drops null/object", () => {
  const r = out({ version: 1, blocks: [{ type: "kv", rows: [
    { k: "ahead", v: 3 },
    { k: "x", v: true },
    { k: "y", v: false },
    { k: "bad", v: {} },
    { k: "nul", v: null },
    { k: "ok", v: "str" },
  ] }] });
  assert.deepEqual(r.widget.blocks[0].rows, [
    { k: "ahead", v: "3" },
    { k: "x", v: "true" },
    { k: "y", v: "false" },
    { k: "ok", v: "str" },
  ]);
});
check("status.value coerces scalars", () => {
  const r = out({ version: 1, blocks: [{ type: "status", label: "x", value: 42 }] });
  assert.equal(r.widget.blocks[0].value, "42");
});
check("item label and detail coerce scalars; null/object labels drop the item", () => {
  const r = out({ version: 1, blocks: [{ type: "list", items: [
    { label: 3, detail: true },
    { label: {}, detail: "dropped" },
    { label: null },
    { label: "ok", detail: {} },
  ] }] });
  assert.deepEqual(r.widget.blocks[0].items, [
    { label: "3", tone: "neutral", detail: "true" },
    { label: "ok", tone: "neutral" },
  ]);
});
check("non-finite numbers are dropped from scalar fields", () => {
  // out() would JSON.stringify Infinity to null, so parse a literal 1e400.
  const r = W.parseOutput(`{"version":1,"blocks":[
    {"type":"status","label":"x","value":1e400},
    {"type":"kv","rows":[{"k":"inf","v":1e400},{"k":"ok","v":1}]},
    {"type":"list","items":[{"label":-1e400},{"label":"a","detail":1e400}]}
  ]}`);
  assert.equal(r.widget.blocks[0].value, "");
  assert.deepEqual(r.widget.blocks[1].rows, [{ k: "ok", v: "1" }]);
  assert.deepEqual(r.widget.blocks[2].items, [{ label: "a", tone: "neutral" }]);
});

// ── tone info ─────────────────────────────────────────────────────────────
check("info tone is preserved", () => {
  const r = out({ version: 1, status: "info", blocks: [{ type: "status", label: "x", value: "y", tone: "info" }] });
  assert.equal(r.widget.status, "info");
  assert.equal(r.widget.blocks[0].tone, "info");
});

// ── title on list and kv ──────────────────────────────────────────────────
check("title on list and kv is preserved and clipped", () => {
  const long = "t".repeat(300);
  const r = out({ version: 1, blocks: [
    { type: "list", items: [{ label: "a" }], title: "Section A" },
    { type: "kv", rows: [{ k: "x", v: "y" }], title: long },
  ] });
  assert.equal(r.widget.blocks[0].title, "Section A");
  assert.equal(r.widget.blocks[1].title.length, 200);
});
check("absent title means no field", () => {
  const r = out({ version: 1, blocks: [{ type: "list", items: [{ label: "a" }] }] });
  assert.equal("title" in r.widget.blocks[0], false);
});

// ── list limit ────────────────────────────────────────────────────────────
check("list limit: kept when valid, clamped to 50, dropped when unusable", () => {
  const list = (limit) => out({ version: 1, blocks: [{ type: "list", items: [{ label: "a" }], limit }] }).widget.blocks[0];
  assert.equal(list(5).limit, 5);
  assert.equal(list(1).limit, 1);
  assert.equal(list(99).limit, 50);
  assert.equal(list(2.7).limit, 2);
  assert.equal("limit" in list(0), false);
  assert.equal("limit" in list(-3), false);
  assert.equal("limit" in list("x"), false);
  assert.equal("limit" in list(null), false);
  assert.equal("limit" in list(undefined), false);
});


// ── item time ─────────────────────────────────────────────────────────────
const times = (vals) => out({ version: 1, blocks: [{ type: "list", items: vals.map((time, i) => ({ label: String(i), time })) }] })
  .widget.blocks[0].items.map(i => i.time);
check("item time: zoned ISO 8601 and epoch seconds become epoch ms; a bad time keeps the item", () => {
  const r = out({ version: 1, blocks: [{ type: "list", items: [
    { label: "a", time: "2026-01-15T12:00:00Z" },
    { label: "b", time: 1736942400 },
    { label: "c", time: "not a date" },
    { label: "d", time: null },
    { label: "e", time: 1e20 },
    { label: "f", time: {} },
  ] }] });
  assert.deepEqual(r.widget.blocks[0].items.map(i => i.time),
    [Date.UTC(2026, 0, 15, 12), 1736942400000, undefined, undefined, undefined, undefined]);
  assert.equal(r.widget.blocks[0].items.length, 6);
});
check("item time: offsets, minutes-only and fractional seconds", () => {
  assert.deepEqual(times([
    "2026-01-15T12:00Z",
    "2026-01-15T12:00:30.5+02:00",
    "2026-01-15T12:00:00-05:00",
    "2026-01-15T12:00:00.123456Z",
    "2026-01-15T00:00:00+00:00",
  ]), [
    Date.UTC(2026, 0, 15, 12),
    Date.UTC(2026, 0, 15, 10, 0, 30, 500),
    Date.UTC(2026, 0, 15, 17),
    Date.UTC(2026, 0, 15, 12, 0, 0, 123),
    Date.UTC(2026, 0, 15),
  ]);
});
check("item time: zoneless, date-only, compact-offset and free-form strings are dropped", () => {
  assert.deepEqual(times([
    "2026-01-15", "2026-01-15T12:00", "2026-01-15T12:00:00", "2026-01-15T12:00:00-0500",
    "2026-01-15 12:00Z", "March 7", "Jan 15 2026 12:00", "1/15/2026", "", "2026-01-15T12:00:00ZZ",
  ]), Array(10).fill(undefined));
});
check("item time: impossible dates and clock values are dropped", () => {
  assert.deepEqual(times([
    "2026-02-30T00:00Z", "2026-13-01T00:00Z", "2026-00-10T00:00Z", "2026-01-00T00:00Z",
    "2026-01-15T24:00Z", "2026-01-15T12:60Z", "2026-01-15T12:00:60Z", "2026-01-15T12:00+24:00",
  ]), Array(8).fill(undefined));
  assert.deepEqual(times(["2024-02-29T00:00Z"]), [Date.UTC(2024, 1, 29)], "leap day");
  assert.deepEqual(times(["0050-01-01T00:00Z"]), [-60589296000000], "a two-digit year is not 19xx");
});

// ── relativeTime ──────────────────────────────────────────────────────────
const NOW = Date.parse("2026-06-15T12:00:00Z");
const MIN = 60_000, HOUR = 3_600_000, DAY = 86_400_000;
check("relativeTime: past minutes, hours, days (floored)", () => {
  assert.equal(W.relativeTime(NOW - 5 * MIN, NOW), "5m");
  assert.equal(W.relativeTime(NOW - 3 * HOUR, NOW), "3h");
  assert.equal(W.relativeTime(NOW - 2 * DAY, NOW), "2d");
  assert.equal(W.relativeTime(NOW - (HOUR - 1), NOW), "59m", "floors, never rounds up to 60m");
  assert.equal(W.relativeTime(NOW - (DAY - 1), NOW), "23h");
});
check("relativeTime: future gets an in prefix", () => {
  assert.equal(W.relativeTime(NOW + 12 * MIN, NOW), "in 12m");
  assert.equal(W.relativeTime(NOW + 3 * HOUR, NOW), "in 3h");
  assert.equal(W.relativeTime(NOW + 2 * DAY, NOW), "in 2d");
});
check("relativeTime: under a minute is now, unit boundaries are exact", () => {
  assert.equal(W.relativeTime(NOW - (MIN - 1), NOW), "now");
  assert.equal(W.relativeTime(NOW + 30_000, NOW), "now");
  assert.equal(W.relativeTime(NOW - MIN, NOW), "1m");
  assert.equal(W.relativeTime(NOW - HOUR, NOW), "1h");
  assert.equal(W.relativeTime(NOW - DAY, NOW), "1d");
});
check("relativeTime: 30 days is still days, beyond is the UTC date (past and future)", () => {
  assert.equal(W.relativeTime(NOW - 30 * DAY, NOW), "30d");
  assert.equal(W.relativeTime(NOW - 30 * DAY - 1, NOW), "2026-05-16");
  assert.equal(W.relativeTime(NOW + 31 * DAY, NOW), "2026-07-16");
});

// ── insert on text block ──────────────────────────────────────────────────
check("text block insert is preserved and clipped", () => {
  const r = out({ version: 1, blocks: [
    { type: "text", text: "hi", insert: "insert me" },
    { type: "text", text: "no insert" },
    { type: "text", text: "long", insert: "x".repeat(3000) },
  ] });
  assert.equal(r.widget.blocks[0].insert, "insert me");
  assert.equal("insert" in r.widget.blocks[1], false);
  assert.equal(r.widget.blocks[2].insert.length, 2000);
});

// ── run bookkeeping: mergeRun / parsedLast / cardRun ──────────────────────
const view = (over = {}) => ({ key: "s1", pluginId: "git", seq: 1, phase: "running", last: null, lastOkAt: null, ...over });
const okStdout = JSON.stringify({ version: 1, status: "ok", blocks: [{ type: "text", text: "hi" }] });
const finished = (at, over = {}) => ({ at, stdout: okStdout, error: null, durationMs: 7, ...over });

check("runKey separates session key and plugin id", () => {
  assert.notEqual(W.runKey("a", "bc"), W.runKey("ab", "c"));
  assert.equal(W.runKey("__global__", "g"), "__global__\u0000g");
});
check("mergeRun stores a new run and replaces it with newer seq or later phase", () => {
  const runs = new Map();
  assert.equal(W.mergeRun(runs, view({ phase: "waiting" })), true);
  assert.equal(W.mergeRun(runs, view({ phase: "running" })), true, "waiting → running");
  assert.equal(W.mergeRun(runs, view({ phase: "idle", last: finished(1) })), true, "running → idle");
  assert.equal(W.mergeRun(runs, view({ seq: 2, phase: "waiting" })), true, "next run");
  assert.equal(runs.get(W.runKey("s1", "git")).seq, 2);
  assert.equal(runs.size, 1);
});
check("mergeRun never lets an older state overwrite a newer one (snapshot after events)", () => {
  const runs = new Map();
  W.mergeRun(runs, view({ seq: 3, phase: "idle", last: finished(30) }));
  assert.equal(W.mergeRun(runs, view({ seq: 3, phase: "running" })), false, "same seq, earlier phase");
  assert.equal(W.mergeRun(runs, view({ seq: 2, phase: "idle", last: finished(20) })), false, "older seq");
  assert.equal(runs.get(W.runKey("s1", "git")).last.at, 30);
});
check("mergeRun: same seq and phase takes the later payload", () => {
  const runs = new Map();
  W.mergeRun(runs, view());
  assert.equal(W.mergeRun(runs, view({ lastOkAt: 5 })), true);
  assert.equal(runs.get(W.runKey("s1", "git")).lastOkAt, 5);
});
check("mergeRun keeps tab and global keys apart and ignores malformed payloads", () => {
  const runs = new Map();
  W.mergeRun(runs, view({ key: "s1" }));
  W.mergeRun(runs, view({ key: "s2" }));
  W.mergeRun(runs, view({ key: "__global__" }));
  for (const bad of [null, undefined, {}, { key: "s1", pluginId: "git" }, { key: 1, pluginId: "git", seq: 1 }]) {
    assert.equal(W.mergeRun(runs, bad), false);
  }
  assert.equal(runs.size, 3);
});
check("parsedLast parses once per finish and re-parses a new one", () => {
  const cache = new Map();
  const k = W.runKey("s1", "git");
  const a = W.parsedLast(cache, k, finished(1));
  assert.equal(a.ok, true);
  assert.equal(W.parsedLast(cache, k, { ...finished(1) }), a, "same finish: cached object");
  const b = W.parsedLast(cache, k, finished(2, { stdout: JSON.stringify({ version: 2, blocks: [] }) }));
  assert.equal(b.ok, false, "new finish is parsed");
  assert.equal(W.parsedLast(cache, k, finished(3, { stdout: null, error: "boom" })), null);
  assert.equal(cache.has(k), false, "an error result clears the cache entry");
  assert.equal(W.parsedLast(cache, k, null), null);
});
const card = (run) => W.cardRun(run, W.parsedLast(new Map(), "k", run?.last));
check("cardRun: never ran is an idle card", () => {
  assert.deepEqual(W.cardRun(undefined, null), { state: "idle", widget: null, error: null, durationMs: null, at: null, lastOkAt: null });
});
check("cardRun: a finished run is ok with its widget, timing and lastOkAt", () => {
  const c = card(view({ phase: "idle", last: finished(1000), lastOkAt: 1000 }));
  assert.equal(c.state, "ok");
  assert.deepEqual(c.widget.blocks, [{ type: "text", text: "hi" }]);
  assert.equal(c.widget.status, "ok");
  assert.deepEqual([c.durationMs, c.at, c.lastOkAt, c.error], [7, 1000, 1000, null]);
});
check("cardRun: a failed run is an error card; a schema error is one too", () => {
  const e = card(view({ phase: "idle", last: finished(2000, { stdout: null, error: "exit 1: boom" }), lastOkAt: 1000 }));
  assert.deepEqual([e.state, e.error, e.widget, e.lastOkAt], ["error", "exit 1: boom", null, 1000]);
  const s = card(view({ phase: "idle", last: finished(2000, { stdout: "{\"version\":9,\"blocks\":[]}" }) }));
  assert.equal(s.state, "error");
  assert.match(s.error, /version 9/);
});
check("cardRun: a run in flight keeps the previous good widget for the dimmed display", () => {
  for (const phase of ["waiting", "running"]) {
    const c = card(view({ seq: 2, phase, last: finished(1000) }));
    assert.equal(c.state, "running", phase);
    assert.ok(c.widget, phase);
    assert.equal(c.error, null);
  }
  const first = card(view({ phase: "running" }));
  assert.deepEqual([first.state, first.widget], ["running", null], "first run: nothing to show yet");
  const afterError = card(view({ seq: 2, phase: "running", last: finished(1, { stdout: null, error: "x" }) }));
  assert.deepEqual([afterError.state, afterError.widget, afterError.error], ["running", null, null]);
});
check("cardRun: idle without a result (stdout missing) is an error, not a crash", () => {
  const c = W.cardRun(view({ phase: "idle", last: finished(1, { stdout: null }) }), null);
  assert.equal(c.state, "error");
});

// ── attention ─────────────────────────────────────────────────────────────
check("attention is parsed onto the widget", () => {
  assert.equal(out({ version: 1, blocks: [], attention: "k1" }).widget.attention, "k1");
});
check("attention is cut to 200 chars", () => {
  assert.equal(out({ version: 1, blocks: [], attention: "x".repeat(300) }).widget.attention.length, 200);
});
check("missing, empty and non-string attention is no attention", () => {
  for (const attention of [undefined, "", 5, true, null, ["a"], { a: 1 }]) {
    assert.equal("attention" in out({ version: 1, blocks: [], attention }).widget, false, JSON.stringify(attention));
  }
});
const step = (o) => W.attentionStep({ hasWidget: true, ...o });
check("attentionStep: a new unacknowledged key is active and bounces", () => {
  assert.deepEqual(step({ key: "a", ack: null, seen: undefined }), { active: true, seen: "a", writeAck: false, bounce: true });
  assert.deepEqual(step({ key: "b", ack: "a", seen: "a" }), { active: true, seen: "b", writeAck: false, bounce: true });
});
check("attentionStep: a rerun with the same key is active but bounces only on entry", () => {
  assert.deepEqual(step({ key: "a", ack: null, seen: "a" }), { active: true, seen: "a", writeAck: false, bounce: false });
});
check("attentionStep: the acknowledged key is not active and does not bounce", () => {
  assert.deepEqual(step({ key: "a", ack: "a", seen: "a" }), { active: false, seen: "a", writeAck: false, bounce: false });
  assert.deepEqual(step({ key: "a", ack: "a", seen: undefined }), { active: false, seen: "a", writeAck: false, bounce: false });
});
check("attentionStep: no key ends attention and clears the ack, so the same key alerts again", () => {
  for (const key of [undefined, ""]) {
    assert.deepEqual(step({ key, ack: "a", seen: "a" }), { active: false, seen: "", writeAck: true, bounce: false });
  }
  assert.deepEqual(step({ key: undefined, ack: null, seen: "a" }), { active: false, seen: "", writeAck: false, bounce: false });
  assert.deepEqual(step({ key: "a", ack: null, seen: "" }), { active: true, seen: "a", writeAck: false, bounce: true });
});
check("attentionStep: no widget (error, idle) keeps ack and seen and signals nothing", () => {
  for (const key of [undefined, "", "b"]) {
    assert.deepEqual(W.attentionStep({ key, ack: "a", seen: "a", hasWidget: false }), { active: false, seen: "a", writeAck: false, bounce: false });
  }
  assert.deepEqual(W.attentionStep({ key: undefined, ack: "a", seen: undefined, hasWidget: false }), { active: false, seen: "", writeAck: false, bounce: false });
});
check("ackKey stays out of the Settings `widget:` toggle namespace", () => {
  assert.equal(W.ackKey("ci").startsWith("widget:"), false);
  assert.equal(W.ackKey("ci", "/p/a").startsWith("widget:"), false);
});
check("ackKey: global plugin per id; tab plugin per id and project, bounded and stable", () => {
  assert.equal(W.ackKey("ci"), "widgetAck:ci");
  assert.equal(W.ackKey("ci", "/p/a"), W.ackKey("ci", "/p/a"));
  assert.notEqual(W.ackKey("ci", "/p/a"), W.ackKey("ci", "/p/b"));
  assert.notEqual(W.ackKey("ci", "/p/a"), W.ackKey("lint", "/p/a"));
  assert.notEqual(W.ackKey("ci", "/p/a"), W.ackKey("ci"));
  assert.equal(W.ackKey("ci", "x".repeat(100000)).length, "widgetAck:ci:".length + 16);
});
check("a tab without a key does not clear another tab's ack", () => {
  const store = {};
  const run = (project, key) => {
    const k = W.ackKey("ci", project);
    const s = step({ key, ack: store[k] ?? null, seen: undefined });
    if (s.writeAck) store[k] = null;
    return s;
  };
  store[W.ackKey("ci", "/p/a")] = "a";
  run("/p/b", undefined);
  assert.equal(store[W.ackKey("ci", "/p/a")], "a");
  assert.equal(run("/p/a", "a").active, false);
});

// ── insert target (widgets.json `insert`, ⌥-click) ────────────────────────
const NEW_TAB = { target: "new-tab", project: "/Users/me/GIT/work/inbox" };
check("insertAction: no config or draft target inserts into the draft", () => {
  for (const cfg of [undefined, null, {}, { target: "draft" }]) {
    assert.deepEqual(W.insertAction(cfg, false), { target: "draft" });
  }
});
check("insertAction: new-tab opens the configured project", () => {
  assert.deepEqual(W.insertAction(NEW_TAB, false), { target: "new-tab", project: NEW_TAB.project });
});
check("insertAction: ⌥/Alt-click falls back to the draft for new-tab", () => {
  assert.deepEqual(W.insertAction(NEW_TAB, true), { target: "draft" });
  assert.deepEqual(W.insertAction({ target: "draft" }, true), { target: "draft" });
});
check("insertAction: an incomplete or unknown target never opens a tab", () => {
  for (const cfg of [{ target: "new-tab" }, { target: "new-tab", project: "" }, { target: "new-tab", project: 5 }, { target: "tab", project: "/x" }]) {
    assert.deepEqual(W.insertAction(cfg, false), { target: "draft" });
  }
});
check("insertAction: plugin output cannot carry a target (parseOutput drops it)", () => {
  const r = out({ version: 1, insert: NEW_TAB, blocks: [
    { type: "text", text: "t", insert: "x", target: "new-tab", project: "/evil" },
    { type: "list", items: [{ label: "a", insertTarget: NEW_TAB, project: "/evil" }] },
  ] });
  assert.equal(JSON.stringify(r).includes("/evil"), false);
  assert.equal("insert" in r.widget, false);
});
check("insertAction: derives the target only from its cfg argument", () => {
  // Callers pass the config's `insert`; an item or output object carrying target/project
  // fields next to it must change nothing.
  const item = { label: "a", insert: "x", target: "new-tab", project: "/evil", insertTarget: NEW_TAB };
  assert.equal(W.insertAction.length, 2, "only (cfg, altKey)");
  assert.deepEqual(W.insertAction(undefined, false, item), { target: "draft" });
  assert.deepEqual(W.insertAction({ target: "draft" }, false, item), { target: "draft" });
  assert.deepEqual(W.insertAction(NEW_TAB, false, item), { target: "new-tab", project: NEW_TAB.project });
});
check("insertTitle: plain tooltip for draft, folder name and ⌥ hint for new-tab", () => {
  assert.equal(W.insertTitle(undefined), "insert into prompt");
  assert.equal(W.insertTitle({ target: "draft" }), "insert into prompt");
  assert.equal(W.insertTitle(NEW_TAB), "Click: new tab in inbox · ⌥-click: insert here");
  assert.equal(W.insertTitle({ target: "new-tab", project: "/a/b/" }), "Click: new tab in b · ⌥-click: insert here");
  assert.equal(W.insertTitle({ target: "new-tab", project: "C:\\a\\proj" }), "Click: new tab in proj · ⌥-click: insert here");
  assert.equal(W.insertTitle({ target: "new-tab", project: "/" }), "Click: new tab in / · ⌥-click: insert here");
});
check("consumePromptInsert: waits for target sessionId to join sessionIds before consuming nonce", () => {
  const targeted = { text: "fix #1", append: true, sessionId: "session-2", nonce: 100 };
  // Before sessionIds includes session-2, the insert stays pending (kind: "none").
  assert.deepEqual(W.consumePromptInsert(targeted, null, ["session-1"]), { kind: "none" });
  assert.deepEqual(W.consumePromptInsert(targeted, null, []), { kind: "none" });
  // Once session-2 is in sessionIds, it consumes the nonce.
  assert.deepEqual(W.consumePromptInsert(targeted, null, ["session-1", "session-2"]), {
    kind: "targeted",
    nonce: 100,
    sessionId: "session-2",
  });
  // Re-running with seenNonce === 100 does not apply it a second time.
  assert.deepEqual(W.consumePromptInsert(targeted, 100, ["session-1", "session-2"]), { kind: "none" });
  // Active-tab insert (no sessionId) applies immediately and is skipped once seen.
  const active = { text: "here", append: true, nonce: 101 };
  assert.deepEqual(W.consumePromptInsert(active, 100, []), { kind: "active", nonce: 101 });
  assert.deepEqual(W.consumePromptInsert(active, 101, []), { kind: "none" });
  assert.deepEqual(W.consumePromptInsert(null, 101, ["session-1"]), { kind: "none" });
});

console.log(`test-widgets: ${passed} checks passed`);

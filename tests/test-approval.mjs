#!/usr/bin/env node
// Regression script for src/app/approval.js — the "Allow tool:" prompt
// split shared with src-tauri/src/approval.rs, and the transcript row for a
// prompt an approval rule answered (#42). Titles follow omp's
// `formatApprovalPrompt` (tools/approval.ts): `Allow tool: <name>`, an
// optional Origin:/Reason: line, then the tool's own detail lines.
// Run: node tests/test-approval.mjs

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const win = {};
// eslint-disable-next-line no-new-func
new Function("window", readFileSync(join(root, "src/app/approval.js"), "utf8"))(win);
const A = win.OMP_APPROVAL;

let passed = 0;
function check(label, fn) {
  try {
    fn();
  } catch (err) {
    console.error(`FAILED: ${label}`);
    throw err;
  }
  passed++;
}

const prompt = (title, options = ["Approve", "Deny"]) => ({ kind: "ask", method: "select", title, options });

// ── approvalInfo ──────────────────────────────────────────────────────────

check("a multi-line approval title splits into its head and detail lines", () => {
  assert.deepEqual(A.approvalInfo(prompt("Allow tool: write\nPath: a.txt\nContent:\nhello")),
    { tool: "write", head: "Allow tool: write", details: "Path: a.txt\nContent:\nhello" });
});

check("CRLF titles split like Rust's lines(): no \\r in the name or the details", () => {
  const info = A.approvalInfo(prompt("Allow tool: mcp__ida_decompile\r\nOrigin: MCP server tool\r\nAction: run"));
  assert.equal(info.tool, "mcp__ida_decompile");
  assert.equal(info.details, "Origin: MCP server tool\nAction: run");
});

check("a name Rust would reject stays an approval card, without a grantable tool", () => {
  const info = A.approvalInfo(prompt("Allow tool: ../../etc/passwd\nCommand: x"));
  assert.equal(info.tool, null);
  assert.equal(info.details, "Command: x");
  // A lone trailing \r stays in the name, as in Rust, and fails the grammar.
  assert.equal(A.approvalInfo(prompt("Allow tool: bash\r")).tool, null);
  assert.equal(A.approvalInfo(prompt(`Allow tool: ${"a".repeat(65)}`)).tool, null);
  assert.equal(A.approvalInfo(prompt(`Allow tool: ${"a".repeat(64)}`)).tool, "a".repeat(64));
});

check("only the exact Approve/Deny select with an Allow tool: head is an approval", () => {
  assert.equal(A.approvalInfo(prompt("Allow tool: bash", ["Yes", "No"])), null);
  assert.equal(A.approvalInfo(prompt("Allow tool: bash", ["Deny", "Approve"])), null);
  assert.equal(A.approvalInfo(prompt("Pick a color")), null);
  assert.equal(A.approvalInfo(prompt("Note\nAllow tool: bash")), null);
  assert.equal(A.approvalInfo({ title: 3, options: ["Approve", "Deny"] }), null);
  assert.equal(A.approvalInfo({ title: "Allow tool: bash" }), null);
});

// ── autoApprovalRow ───────────────────────────────────────────────────────

check("the auto-approval row keeps tool and details, and never carries a ts", () => {
  const row = A.autoApprovalRow({ type: "desktop_auto_approval", tool: "bash", details: "Command: ls\r\nCwd: /tmp" }, "12:00");
  assert.deepEqual(row, { kind: "approval", tool: "bash", details: "Command: ls\nCwd: /tmp", time: "12:00" });
  assert.equal("ts" in row, false);
});

check("a frame without details (or from an older backend) yields an empty detail string", () => {
  assert.equal(A.autoApprovalRow({ tool: "bash", details: null }, "t").details, "");
  assert.equal(A.autoApprovalRow({ tool: "bash" }, "t").details, "");
});

// ── rowView ───────────────────────────────────────────────────────────────

check("the summary is what the call does, skipping Origin:/Reason: context lines", () => {
  const view = A.rowView({ details: "Origin: MCP server tool\nReason: exec tier\nAction: decompile\nDB: a.i64" });
  assert.deepEqual(view, { summary: "Action: decompile", expandable: true });
});

check("a context line is the summary when the tool gave nothing else", () => {
  assert.deepEqual(A.rowView({ details: "Origin: MCP server tool" }), { summary: "Origin: MCP server tool", expandable: false });
});

check("one short detail line has nothing more to unfold", () => {
  assert.deepEqual(A.rowView({ details: "Command: ls -la" }), { summary: "Command: ls -la", expandable: false });
  assert.deepEqual(A.rowView({ details: "Command: ls -la\n\n  \n" }), { summary: "Command: ls -la", expandable: false });
});

check("a multi-line command, or one line too long for the row, unfolds", () => {
  assert.equal(A.rowView({ details: "Command: make \\\n  && make test" }).expandable, true);
  assert.equal(A.rowView({ details: `Command: ${"x".repeat(100)}` }).expandable, true);
});

check("no details: an empty summary and no toggle", () => {
  assert.deepEqual(A.rowView({ details: "" }), { summary: "", expandable: false });
});

console.log(`approval: ${passed} checks passed`);

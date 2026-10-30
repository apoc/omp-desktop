#!/usr/bin/env node
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const window = {};
new Function(
  "window",
  readFileSync(
    new URL("../src/app/evidence-model.js", import.meta.url),
    "utf8",
  ),
)(window);
const M = window.OMP_EVIDENCE_MODEL;
const fp = (head = "abc", dirtyDigest = null, complete = true) => ({
  head,
  dirtyDigest,
  complete,
  reason: null,
  environment: {},
});
function fixture() {
  const view = M.initial();
  const requirement = {
    id: "criterion",
    text: "It works",
    kind: "test",
    required: true,
    author: "user",
    revision: 1,
    retired: false,
  };
  const outcome = {
    id: "outcome",
    title: "Works",
    description: "",
    author: "user",
    todoRefs: [],
    retired: false,
    requirements: [requirement],
  };
  view.outcomes.push(outcome);
  view.currentFingerprint = fp();
  return { view, outcome, requirement };
}
function record(extra = {}) {
  return {
    id: "r",
    outcomeId: "outcome",
    requirementId: "criterion",
    requirementRevision: 1,
    title: "Tests",
    kind: "test",
    result: "passed",
    summary: "Agent says tests passed",
    limitations: "",
    reason: "",
    source: { type: "agent" },
    fingerprint: fp(),
    review: { decision: "unreviewed" },
    ...extra,
  };
}

test("missing, interpreted, reviewed and waived states remain separate", () => {
  const { view, outcome, requirement } = fixture();
  assert.equal(
    M.requirementStatus(view, outcome, requirement).state,
    "missing",
  );
  view.records.push(record());
  assert.equal(
    M.requirementStatus(view, outcome, requirement).state,
    "collected",
  );
  assert.match(
    M.recordStatus(view, view.records[0]).reason,
    /agent.*interpretation/i,
  );
  assert.equal(M.summarize(view).unreviewed, 1);
  view.records[0].review = { decision: "accepted", at: "now" };
  assert.equal(M.summarize(view).unreviewed, 0);
  assert.match(M.report(view), /Review: accepted/);
  requirement.waiver = { actor: "user", reason: "not applicable", at: "now" };
  assert.equal(M.requirementStatus(view, outcome, requirement).state, "waived");
  assert.match(M.report(view), /not applicable/);
});

test("old failures do not disappear behind later passes, but explicit rejection is visible", () => {
  const { view, outcome, requirement } = fixture();
  view.records.push(
    record({ id: "failure", result: "failed", reason: "failed assertion" }),
    record({ id: "pass" }),
  );
  assert.equal(M.requirementStatus(view, outcome, requirement).state, "failed");
  assert.equal(M.summarize(view).failed, 1);
  view.records[0].review = { decision: "rejected", reason: "wrong target" };
  assert.equal(M.recordStatus(view, view.records[0]).state, "rejected");
  assert.equal(
    M.requirementStatus(view, outcome, requirement).state,
    "collected",
  );
  assert.match(M.report(view), /failed assertion/);
});

test("fingerprints, criterion revisions and before/after execution states cannot imply freshness", () => {
  const { view, outcome, requirement } = fixture();
  const proof = record();
  view.records.push(proof);
  view.currentFingerprint = null;
  assert.match(M.recordStatus(view, proof).reason, /unknown/i);
  view.currentFingerprint = fp("abc", "dirty");
  assert.equal(M.recordStatus(view, proof).state, "stale");
  view.currentFingerprint = fp();
  proof.source.receiptId = "receipt";
  proof.beforeFingerprint = null;
  assert.match(M.recordStatus(view, proof).reason, /unknown during/i);
  proof.beforeFingerprint = fp("other");
  assert.equal(M.recordStatus(view, proof).state, "stale");
  proof.beforeFingerprint = fp();
  assert.equal(M.recordStatus(view, proof).state, "collected");
  requirement.revision++;
  assert.match(
    M.requirementStatus(view, outcome, requirement).reason,
    /requirement has changed/i,
  );
});

test("media without an inspectable artifact is blocked and ignored/retired criteria do not affect counts", () => {
  const { view, outcome, requirement } = fixture();
  requirement.kind = "image";
  const image = record({ kind: "image" });
  view.records.push(image);
  assert.equal(M.recordStatus(view, image).state, "blocked");
  image.artifact = { mime: "image/png" };
  assert.equal(M.recordStatus(view, image).state, "collected");
  requirement.required = false;
  assert.equal(M.summarize(view).collected, 0);
  requirement.required = true;
  outcome.retired = true;
  assert.equal(M.summarize(view).collected, 0);
});

test("Markdown export escapes untrusted headings and markup", () => {
  const { view, outcome } = fixture();
  outcome.title = "<img onerror=alert(1)> # heading";
  view.records.push(record({ summary: "[link](javascript:alert(1))" }));
  const report = M.report(view);
  assert.match(report, /\\<img/);
  assert.match(report, /\\\[link\\\]/);
});

test("report retains inspectable artifact identity, execution scope and CI limitations", () => {
  const { view } = fixture();
  view.records.push(
    record({
      kind: "ci",
      limitations: "Commit only",
      artifact: {
        id: "asset",
        name: "output.txt",
        mime: "text/plain",
        bytes: 42,
        sha256: "abc123",
      },
      ci: {
        state: "failure",
        sourceSha: "abc",
        snapshot: {
          failedChecks: [{ name: "lint", url: "https://example.test/check" }],
        },
      },
    }),
  );
  view.receipts.push({
    id: "receipt",
    toolCallId: "call",
    toolName: "bash",
    at: "now",
    isError: true,
    exitCode: 2,
    command: "npm test",
    preview: "failed assertion",
    truncated: true,
    beforeFingerprint: fp(),
    fingerprint: fp("abc", "dirty"),
  });
  const report = M.report(view);
  assert.match(report, /output\.txt/);
  assert.match(report, /SHA-256 abc123/);
  assert.match(report, /Failed check: lint/);
  assert.match(report, /Commit only/);
  assert.match(report, /Output preview \(truncated\): failed assertion/);
  assert.match(report, /dirty digest dirty/);
});

test("reports expose stable ownership links and scoped request text", () => {
  const { view } = fixture();
  view.outcomes[0].author = "agent";
  view.outcomes[0].owner = "user";
  view.outcomes[0].requirements[0].author = "agent";
  view.outcomes[0].requirements[0].owner = "user";
  view.records.push(
    record({
      id: "record-id",
      source: { type: "agent", receiptId: "receipt-id", toolName: "bash" },
      beforeFingerprint: fp(),
    }),
  );
  view.receipts.push({
    id: "receipt-id",
    toolCallId: "call-id",
    toolName: "bash",
    isError: false,
    exitCode: 0,
    command: "npm test",
    fingerprint: fp(),
    beforeFingerprint: fp(),
  });
  view.requests.push({
    id: "request-id",
    outcomeId: "outcome",
    requirementId: "criterion",
    text: "Inspect this exact behavior",
  });
  const report = M.report(view);
  for (const id of [
    "outcome",
    "criterion",
    "record-id",
    "receipt-id",
    "request-id",
  ])
    assert.ok(report.includes(id));
  assert.match(report, /author agent; owner user/);
  const request = M.report(view, {
    outcomeId: "outcome",
    requirementId: "criterion",
    requestId: "request-id",
  });
  assert.match(request, /Inspect this exact behavior/);
  assert.match(request, /Outcome: outcome; criterion: criterion/);
  const receipt = M.report(view, { receiptId: "receipt-id" });
  assert.match(receipt, /npm test/);
  assert.doesNotMatch(receipt, /Inspect this exact behavior/);
});

test("initial policies are independent snapshots", () => {
  const first = M.initial();
  first.policy.preset.name = "Changed";
  first.policy.preset.triggers.beforeWork = false;
  const next = M.initial();
  assert.equal(next.policy.preset.name, "Standard");
  assert.equal(next.policy.preset.triggers.beforeWork, true);
  assert.equal(next.policyPinned, false);
});

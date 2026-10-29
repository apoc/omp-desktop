#!/usr/bin/env node
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const window = {};
new Function(
  "window",
  readFileSync(
    new URL("../src/app/context-target.js", import.meta.url),
    "utf8",
  ),
)(window);
const T = window.OMP_CONTEXT_TARGET;
const policy = (extra = {}) => ({
  supported: true,
  profileId: "work",
  sessionId: "one",
  sessionFile: "/one",
  model: { provider: "local", id: "large", contextWindow: 1000000 },
  revision: "a",
  target: { percent: 30, tokens: 300000, mode: "tokens" },
  budgetBounds: { percent: { min: 12.5, max: 83.3 } },
  controls: [
    { id: "enabled", value: true },
    { id: "method", value: "native" },
    { id: "asyncEnabled", value: false },
    { id: "midTurnEnabled", value: false },
  ],
  ...extra,
});
const at = (angle) => ({
  x: Math.sin((angle * Math.PI) / 180),
  y: -Math.cos((angle * Math.PI) / 180),
});

test("dragging across the bottom seam clamps instead of wrapping", () => {
  const limit = { min: 0, max: 100 };
  let p = at(130),
    drag = T.startDrag(p.x, p.y, 0, 0, limit);
  assert.ok(drag.percent > 98);
  for (const angle of [145, 180, 220, 230, 250]) {
    p = at(angle);
    drag = T.moveDrag(drag, p.x, p.y, 0, 0, limit);
    assert.equal(drag.percent, 100);
  }
  for (const angle of [220, 180, 145]) {
    p = at(angle);
    drag = T.moveDrag(drag, p.x, p.y, 0, 0, limit);
    assert.equal(drag.percent, 100);
  }
  p = at(120);
  drag = T.moveDrag(drag, p.x, p.y, 0, 0, limit);
  assert.ok(drag.percent < 100 && drag.percent > 90);
});

test("dragging backward across the bottom seam cannot jump to the maximum", () => {
  const limit = { min: 0, max: 100 };
  let p = at(230),
    drag = T.startDrag(p.x, p.y, 0, 0, limit);
  assert.ok(drag.percent < 2);
  for (const angle of [215, 180, 140, 130, 110]) {
    p = at(angle);
    drag = T.moveDrag(drag, p.x, p.y, 0, 0, limit);
    assert.equal(drag.percent, 0);
  }
  for (const angle of [140, 180, 215]) {
    p = at(angle);
    drag = T.moveDrag(drag, p.x, p.y, 0, 0, limit);
    assert.equal(drag.percent, 0);
  }
  p = at(235);
  drag = T.moveDrag(drag, p.x, p.y, 0, 0, limit);
  assert.ok(drag.percent > 0 && drag.percent < 10);
});

test("the readout, usage arc and bottom gap cannot start a target drag", () => {
  const c = 72,
    radius = 72;
  assert.equal(T.pointerHit(c, c, c, c, radius), false);
  const usage = T.point(50, 52, c);
  assert.equal(T.pointerHit(usage.x, usage.y, c, c, radius), false);
  const gap = at(180);
  assert.equal(
    T.pointerHit(c + gap.x * 64, c + gap.y * 64, c, c, radius),
    false,
  );
  for (const percent of [0, 30, 100]) {
    const marker = T.point(percent, 64, c);
    assert.equal(T.pointerHit(marker.x, marker.y, c, c, radius), true);
  }
  const outside = T.point(30, 73, c);
  assert.equal(T.pointerHit(outside.x, outside.y, c, c, radius), false);
});

test("pointer and keyboard respect the actual dynamic native bounds", () => {
  const limit = T.bounds(policy());
  const start = T.point(0, 1, 0),
    end = T.point(100, 1, 0);
  assert.equal(T.startDrag(start.x, start.y, 0, 0, limit).percent, 12.5);
  assert.equal(T.startDrag(end.x, end.y, 0, 0, limit).percent, 83.3);
  let p = at(130),
    drag = T.startDrag(p.x, p.y, 0, 0, limit);
  assert.equal(drag.percent, 83.3);
  p = at(110);
  drag = T.moveDrag(drag, p.x, p.y, 0, 0, limit);
  assert.equal(drag.percent, 83.3, "motion outside the bound stays clamped");
  p = at(80);
  drag = T.moveDrag(drag, p.x, p.y, 0, 0, limit);
  assert.ok(drag.percent < 83.3 && drag.percent > 79);
  assert.equal(T.keyPercent("Home", 30, limit), 12.5);
  assert.equal(T.keyPercent("End", 30, limit), 83.3);
  assert.equal(T.keyPercent("PageUp", 80, limit), 83.3);
  assert.equal(T.keyPercent("ArrowDown", 12.5, limit), 12.5);
  assert.equal(T.keyPercent("Tab", 30, limit), null);
});

test("a native token threshold is preserved unless the target is intentionally edited", () => {
  const snapshot = policy(),
    draft = T.createDraft(snapshot);
  draft.values.enabled = false;
  assert.deepEqual(T.requestValues(draft, snapshot), { enabled: false });
  draft.values.method = "summary";
  assert.deepEqual(T.requestValues(draft, snapshot), {
    enabled: false,
    method: "summary",
  });
  draft.targetChange = "percent";
  assert.deepEqual(T.requestValues(draft, snapshot), {
    enabled: false,
    method: "summary",
    targetPercent: 30,
  });
  draft.targetChange = "reset";
  assert.deepEqual(T.requestValues(draft, snapshot), {
    enabled: false,
    method: "summary",
    targetPercent: null,
  });
});

test("reverting unrelated options leaves the target and request untouched", () => {
  const snapshot = policy({
    target: { percent: 30, tokens: 300000, mode: "native" },
  });
  const draft = T.createDraft(snapshot);
  draft.values.midTurnEnabled = true;
  assert.equal(T.dirty(draft), true);
  assert.deepEqual(T.requestValues(draft, snapshot), { midTurnEnabled: true });
  draft.values.midTurnEnabled = false;
  assert.equal(T.dirty(draft), false);
  assert.deepEqual(T.requestValues(draft, snapshot), {});
});

test("target validation is deferred until a target is changed", () => {
  const snapshot = policy(),
    draft = T.createDraft(snapshot);
  draft.targetChange = "percent";
  for (const value of ["", "NaN", "12.4", "83.31"]) {
    draft.percent = value;
    assert.throws(() => T.requestValues(draft, snapshot), /percentage/);
  }
  draft.percent = "12.5";
  assert.deepEqual(T.requestValues(draft, snapshot), { targetPercent: 12.5 });
});

test("draft belongs to its profile, branch, model and revision, not usage updates", () => {
  const snapshot = policy(),
    draft = T.createDraft(snapshot);
  assert.equal(T.stale(draft, snapshot, "local/large"), false);
  assert.equal(
    T.stale(draft, { ...snapshot, revision: "b" }, "local/large"),
    true,
  );
  assert.equal(
    T.stale(draft, { ...snapshot, sessionId: "two" }, "local/large"),
    true,
  );
  assert.equal(
    T.stale(draft, { ...snapshot, profileId: "other" }, "local/large"),
    true,
  );
  assert.equal(
    T.stale(
      draft,
      { ...snapshot, model: { ...snapshot.model, id: "small" } },
      "local/small",
    ),
    true,
  );
  assert.equal(T.stale(draft, snapshot, "local/small"), true);
  assert.equal(T.stale(draft, null, null), true);
});

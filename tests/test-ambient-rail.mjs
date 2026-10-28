import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";

const win = {};
new Function(
  "window",
  readFileSync(new URL("../src/app/ambient-rail.js", import.meta.url), "utf8"),
)(win);
const { ordered, move } = win.OMP_AMBIENT_RAIL;
const cards = ["context", "radar", "skills", "minimap"].map((id) => ({ id }));
const ids = (result) => result.map((card) => card.id);

test("partial and stale saved layouts show every current card exactly once", () => {
  assert.deepEqual(
    ids(
      ordered(cards, ["minimap", "removed-widget", "minimap", null, "context"]),
    ),
    ["minimap", "context", "radar", "skills"],
  );
  assert.deepEqual(ids(ordered(cards, { minimap: 0 })), ids(cards));
});

test("moving before and after updates order without changing card data or the stored value", () => {
  const saved = ["context", "radar", "skills", "minimap"];
  const next = move(cards, saved, "minimap", "radar", false);
  assert.deepEqual(next, ["context", "minimap", "radar", "skills"]);
  assert.deepEqual(move(cards, next, "context", "skills", true), [
    "minimap",
    "radar",
    "skills",
    "context",
  ]);
  assert.deepEqual(saved, ["context", "radar", "skills", "minimap"]);
  assert.deepEqual(ids(cards), saved);
});

test("tab-specific widgets recover their saved position after another tab's cards move", () => {
  const saved = [
    "minimap",
    "widget:ext:other-project",
    "context",
    "radar",
    "skills",
  ];
  const next = move(cards, saved, "radar", "context", false);
  assert.deepEqual(next, [
    "minimap",
    "widget:ext:other-project",
    "radar",
    "context",
    "skills",
  ]);
  assert.deepEqual(
    ids(ordered([...cards, { id: "widget:ext:other-project" }], next)),
    next,
  );
});

test("hidden cards and newly discovered widgets remain movable and recoverable", () => {
  const withNew = [...cards, { id: "plugin" }];
  const saved = move(
    withNew,
    ["minimap", "skills"],
    "plugin",
    "minimap",
    false,
  );
  assert.deepEqual(ids(ordered(withNew, saved)), [
    "plugin",
    "minimap",
    "skills",
    "context",
    "radar",
  ]);
  assert.deepEqual(
    ids(
      ordered(
        withNew.filter((c) => c.id !== "skills"),
        saved,
      ),
    ),
    ["plugin", "minimap", "context", "radar"],
  );
  assert.deepEqual(ids(ordered(withNew, saved)), [
    "plugin",
    "minimap",
    "skills",
    "context",
    "radar",
  ]);
});

test("invalid and same-card drops leave the saved layout unchanged", () => {
  const saved = ["minimap", "context"];
  assert.equal(move(cards, saved, "minimap", "minimap", true), saved);
  assert.equal(move(cards, saved, "missing", "context", false), saved);
  assert.equal(move(cards, saved, "context", "missing", false), saved);
});

test("merging context cards preserves visibility and the first saved slot without reviving the old card", () => {
  const saved = { showContext: false, showAgentContext: true,
    railOrder: ["showRadar", "showAgentContext", "widget:other", "showContext", "showMinimap"] };
  const next = win.OMP_AMBIENT_RAIL.migrate(saved);
  assert.equal(next.showContext, true);
  assert.equal("showAgentContext" in next, false);
  assert.deepEqual(next.railOrder, ["showRadar", "showContext", "widget:other", "showMinimap"]);
  assert.equal(saved.showContext, false);
  assert.equal(win.OMP_AMBIENT_RAIL.migrate(next), next, "migration is idempotent");
  assert.equal(win.OMP_AMBIENT_RAIL.migrate({ showContext: false, showAgentContext: false }).showContext, false);
  assert.equal(win.OMP_AMBIENT_RAIL.migrate({ showContext: false }).showContext, false);
});

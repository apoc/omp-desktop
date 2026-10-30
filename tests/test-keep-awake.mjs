#!/usr/bin/env node
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { runInNewContext } from "node:vm";

const window = {};
runInNewContext(
  readFileSync(new URL("../src/app/keep-awake.js", import.meta.url), "utf8"),
  { window },
);
const K = window.OMP_KEEP_AWAKE;
const deferred = () => {
  let resolve;
  const promise = new Promise((r) => {
    resolve = r;
  });
  return { promise, resolve };
};
const session = (id, overrideEnabled, enabled, working = false) => ({
  id,
  overrideEnabled,
  enabled,
  working,
});
const snap = (revision, defaultEnabled = false, sessions = [], extra = {}) => ({
  revision,
  defaultEnabled,
  active: false,
  error: null,
  sessions,
  ...extra,
});
function harness(initial) {
  let emit,
    removed = 0,
    changes = 0;
  const calls = [];
  const bridge = {
    onKeepAwakeChanged(fn) {
      emit = fn;
      return Promise.resolve(() => {
        removed++;
      });
    },
    keepAwakeSnapshot() {
      calls.push(["read"]);
      return Promise.resolve({ ok: true, value: initial });
    },
    setKeepAwakeDefault(enabled) {
      const result = deferred();
      calls.push(["default", enabled, result]);
      return result.promise;
    },
    setKeepAwakeSession(id, enabled) {
      const result = deferred();
      calls.push(["session", id, enabled, result]);
      return result.promise;
    },
  };
  const client = K.create(bridge, () => {
    changes++;
  });
  return {
    bridge,
    client,
    calls,
    emit: (value) => emit(value),
    removed: () => removed,
    changes: () => changes,
  };
}

test("subscription precedes the read and an older read cannot overwrite an event", async () => {
  const read = deferred(),
    listen = deferred(),
    reading = deferred();
  let emit,
    reads = 0;
  const bridge = {
    onKeepAwakeChanged(fn) {
      emit = fn;
      return listen.promise;
    },
    keepAwakeSnapshot() {
      reads++;
      reading.resolve();
      return read.promise;
    },
  };
  const client = K.create(bridge, () => {});
  const starting = client.start();
  assert.equal(reads, 0);
  listen.resolve(() => {});
  await reading.promise;
  emit(snap(3, true, [session("a", null, true)]));
  read.resolve({
    ok: true,
    value: snap(2, false, [session("a", null, false)]),
  });
  await starting;
  assert.equal(client.view("a").snapshot.revision, 3);
  assert.equal(client.view("a").session.enabled, true);
  client.dispose();
});

test("missing and closed chat identities cannot create an override", async () => {
  const h = harness(snap(1, false, [session("a", null, false)]));
  await h.client.start();
  await h.client.setSession(null, true);
  await h.client.setSession("missing", true);
  h.emit(snap(2, false, [session("b", null, false)]));
  await h.client.setSession("a", true);
  assert.equal(
    h.calls.length,
    1,
    "only the initial read may reach the backend",
  );
  assert.equal(h.client.view("a").session, null);
  h.client.dispose();
});

test("stale action results never overwrite newer events and repeated actions serialize", async () => {
  const h = harness(
    snap(1, false, [session("a", null, false), session("b", null, false)]),
  );
  await h.client.start();
  const action = h.client.setSession("a", true);
  h.client.setSession("a", false);
  assert.equal(h.calls.length, 2);
  const other = h.client.setSession("b", true);
  assert.equal(h.calls.length, 3);
  h.emit(snap(5, false, [session("a", true, true), session("b", true, true)]));
  h.calls[1][3].resolve({
    ok: true,
    value: snap(2, false, [
      session("a", true, true),
      session("b", null, false),
    ]),
  });
  h.calls[2][3].resolve({
    ok: true,
    value: snap(4, false, [session("a", true, true), session("b", true, true)]),
  });
  await Promise.all([action, other]);
  assert.equal(h.client.view("b").session.enabled, true);
  assert.equal(h.client.view("a").snapshot.revision, 5);
  assert.equal(h.client.view("a").pending, false);
  h.client.dispose();
});

test("tab action errors belong only to the origin and abandoned owners cannot revive them", async () => {
  const h = harness(
    snap(1, false, [session("a", null, false), session("b", null, false)]),
  );
  await h.client.start();
  const rejected = h.client.setSession("a", true);
  h.calls[1][3].resolve({ ok: false, error: "closed tab" });
  await rejected;
  assert.equal(h.client.view("a").error, "closed tab");
  assert.equal(h.client.view("b").error, null);
  let owner = true;
  const abandoned = h.client.setSession("a", true, () => owner);
  owner = false;
  h.calls[2][3].resolve({ ok: false, error: "old failure" });
  await abandoned;
  assert.equal(h.client.view("a").error, null);
  const defaultAction = h.client.setDefault(true);
  h.calls[3][2].resolve({ ok: false, error: "settings corrupt" });
  await defaultAction;
  assert.equal(h.client.view("b").defaultError, "settings corrupt");
  assert.equal(h.client.view("b").snapshot.defaultEnabled, false);
  h.client.dispose();
});

test("listener and storage failures are explicit even without a snapshot", async () => {
  const client = K.create(
    {
      onKeepAwakeChanged: async () => {
        throw new Error("listener unavailable");
      },
      keepAwakeSnapshot: async () => ({
        ok: false,
        error: "settings unreadable",
      }),
    },
    () => {},
  );
  await client.start();
  assert.equal(client.view(null).snapshot, null);
  assert.equal(client.view(null).defaultError, "settings unreadable");
  client.dispose();
});

test("the hook rejects callbacks and failures from a superseded tab visit", async () => {
  const h = harness(
    snap(1, false, [session("a", null, false), session("b", true, true)]),
  );
  const slots = [];
  const refreshed = deferred();
  let index = 0,
    effect,
    cleanup;
  const React = {
    useRef(value) {
      const i = index++;
      return slots[i] ?? (slots[i] = { current: value });
    },
    useReducer() {
      index++;
      return [0, () => refreshed.resolve()];
    },
    useEffect(fn) {
      const i = index++;
      if (!slots[i]) {
        slots[i] = true;
        effect = fn;
      }
    },
  };
  const hookWindow = { OMP_KEEP_AWAKE: K };
  runInNewContext(
    readFileSync(
      new URL("../src/app/use-keep-awake.jsx", import.meta.url),
      "utf8",
    ),
    { window: hookWindow, React },
  );
  const render = (id) => {
    h.bridge.activeSessionId = id;
    index = 0;
    return hookWindow.useKeepAwake(h.bridge, id);
  };
  render("a");
  cleanup = effect();
  await refreshed.promise;
  const a = render("a");
  const pending = a.setSession(true);
  h.bridge.activeSessionId = "b";
  a.setSession(false);
  assert.equal(
    h.calls.length,
    2,
    "bridge switch invalidates callbacks before React renders",
  );
  const b = render("b");
  assert.equal(b.session.enabled, true);
  a.setSession(false);
  assert.equal(h.calls.length, 2, "stale callback cannot issue a command");
  render("a");
  h.calls[1][3].resolve({ ok: false, error: "old visit failed" });
  await pending;
  assert.equal(render("a").error, null);
  assert.equal(render(null).session, null);
  cleanup();
  assert.equal(h.removed(), 1);
});

test("disposing before subscription or action completion cleans up and prevents updates", async () => {
  const lateListener = deferred();
  let removed = 0,
    reads = 0,
    updates = 0;
  const client = K.create(
    {
      onKeepAwakeChanged: () => lateListener.promise,
      keepAwakeSnapshot: () => {
        reads++;
      },
    },
    () => {
      updates++;
    },
  );
  const starting = client.start();
  client.dispose();
  lateListener.resolve(() => {
    removed++;
  });
  await starting;
  assert.equal(removed, 1);
  assert.equal(reads, 0);
  assert.equal(updates, 0);

  const h = harness(snap(1, false, [session("a", null, false)]));
  await h.client.start();
  const action = h.client.setSession("a", true);
  const before = h.changes();
  h.client.dispose();
  h.calls[1][3].resolve({
    ok: true,
    value: snap(2, false, [session("a", true, true)]),
  });
  h.emit(snap(3));
  await action;
  assert.equal(h.changes(), before);
  assert.equal(h.removed(), 1);
  assert.equal(h.client.view("a").snapshot.revision, 1);
});

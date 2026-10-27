#!/usr/bin/env node
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { test } from "node:test";
import { runInNewContext } from "node:vm";

const Babel = createRequire(import.meta.url)("../src/babel.min.js");
const code = Babel.transform(
  readFileSync(
    new URL("../src/design/settings/rows-notifications.jsx", import.meta.url),
    "utf8",
  ),
  {
    presets: ["react"],
  },
).code;
const flush = async () => {
  for (let i = 0; i < 10; i++) await Promise.resolve();
};
const deferred = () => {
  let resolve, reject;
  const promise = new Promise((a, b) => {
    resolve = a;
    reject = b;
  });
  return { promise, resolve, reject };
};

function harness() {
  const slots = [];
  const effects = [];
  const listeners = new Map();
  let cursor = 0;
  let request = async () => "granted";
  let requests = 0;
  const t = { notifyFinished: false, notifyQuestions: false };
  const React = {
    createElement: (type, props, ...children) => ({
      type,
      props: { ...props, children },
    }),
    useState(initial) {
      const index = cursor++;
      if (!(index in slots))
        slots[index] = typeof initial === "function" ? initial() : initial;
      return [
        slots[index],
        (value) => {
          slots[index] = value;
        },
      ];
    },
    useRef(initial) {
      const index = cursor++;
      if (!(index in slots)) slots[index] = { current: initial };
      return slots[index];
    },
    useEffect(effect) {
      const index = cursor++;
      if (!(index in slots)) {
        slots[index] = true;
        effects.push(effect());
      }
    },
  };
  const window = {
    SettingsRow: "row",
    SettingsToggle: "toggle",
    SettingsMark: "mark",
    addEventListener: (type, fn) => listeners.set(type, fn),
    removeEventListener: (type) => listeners.delete(type),
    __TAURI__: {
      core: {
        invoke: async (_command, { request: prompt }) => {
          if (!prompt) return "prompt";
          requests++;
          return request();
        },
      },
    },
  };
  runInNewContext(code, { window, React });
  const component = window.OMP_SETTINGS_ROWS.desktopNotifications;
  const render = () => {
    cursor = 0;
    return component({
      row: { label: "Desktop notifications", desc: "Local alerts" },
      ctx: {
        t,
        setTweak: (key, value) => {
          t[key] = value;
        },
      },
      onReset: () => {
        t.notifyFinished = false;
        t.notifyQuestions = false;
      },
    });
  };
  const nodes = (node) =>
    !node || typeof node !== "object"
      ? []
      : Array.isArray(node)
        ? node.flatMap(nodes)
        : [node, ...nodes(node.props?.children)];
  const toggle = (label) =>
    nodes(render()).find(
      (node) => node.type === "toggle" && node.props.label === label,
    );
  render();
  return {
    t,
    render,
    toggle,
    setRequest: (next) => {
      request = next;
    },
    requests: () => requests,
    unmount: () => effects.forEach((cleanup) => cleanup?.()),
    focus: () => listeners.get("focus")?.(),
  };
}

test("authorization is requested by enabling, never just by viewing Settings", async () => {
  const h = harness();
  await flush();
  assert.equal(h.requests(), 0);
  const permission = deferred();
  h.setRequest(() => permission.promise);
  const enabling = h.toggle("Conversation finished").props.onChange(true);
  assert.deepEqual(
    h.t,
    { notifyFinished: false, notifyQuestions: false },
    "permission has not been granted",
  );
  assert.equal(h.toggle("User input needed").props.disabled, true);
  await h.toggle("User input needed").props.onChange(true);
  h.focus();
  assert.equal(h.requests(), 1, "one OS decision in flight");
  permission.resolve("granted");
  await enabling;
  assert.deepEqual(h.t, { notifyFinished: true, notifyQuestions: false });
  await h.toggle("Conversation finished").props.onChange(false);
  assert.equal(h.requests(), 1, "disabling must not prompt");
  h.setRequest(async () => "granted");
  await h.toggle("User input needed").props.onChange(true);
  assert.deepEqual(h.t, { notifyFinished: false, notifyQuestions: true });
  h.unmount();
});

test("denied authorization leaves both alerts disabled", async () => {
  const h = harness();
  await flush();
  h.setRequest(async () => "denied");
  await h.toggle("Conversation finished").props.onChange(true);
  await h.toggle("User input needed").props.onChange(true);
  assert.deepEqual(h.t, { notifyFinished: false, notifyQuestions: false });
  h.unmount();
});

test("an authorization error does not save opt-in or prevent a later successful choice", async () => {
  const h = harness();
  await flush();
  h.setRequest(async () => {
    throw new Error("OS authorization unavailable");
  });
  await h.toggle("User input needed").props.onChange(true);
  assert.equal(h.t.notifyQuestions, false);
  assert.equal(h.toggle("User input needed").props.disabled, false);
  h.setRequest(async () => "granted");
  await h.toggle("User input needed").props.onChange(true);
  assert.equal(h.t.notifyQuestions, true);
  h.unmount();
});

test("leaving or resetting Settings invalidates a pending enable choice", async () => {
  for (const action of ["leave", "reset"]) {
    const h = harness();
    await flush();
    const permission = deferred();
    h.setRequest(() => permission.promise);
    const enabling = h.toggle("Conversation finished").props.onChange(true);
    if (action === "leave") h.unmount();
    else h.render().props.onReset();
    permission.resolve("granted");
    await enabling;
    assert.deepEqual(
      h.t,
      { notifyFinished: false, notifyQuestions: false },
      action,
    );
    if (action !== "leave") h.unmount();
  }
});

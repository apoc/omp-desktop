#!/usr/bin/env node
// Regression script for src/design/settings/rows-sounds.jsx — Settings →
// Session → Sounds (#91): one line per cue with a segment of `none` plus the
// catalogue, a ▶ preview button and its own reset. The row is rendered under
// a React stand-in (it uses no hooks) with a recording `OMP_NOTIFY_SOUND.play`,
// and the test talks to the elements the row returns (Row, Seg, Button) and to
// what reaches `ctx.setTweak` and `play`.
// Run: node tests/test-rows-sounds.mjs

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { createContext, runInContext } from "node:vm";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const Babel = createRequire(import.meta.url)(join(root, "src/babel.min.js"));
const source = path => readFileSync(join(root, path), "utf8");
const rowsFile = Babel.transform(source("src/design/settings/rows-sounds.jsx"), { presets: ["react"] }).code;

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

// The shipped dictionary, to prove every string the row shows is translated.
const ZH = {};
new Function("window", source("src/app/i18n-zh.js"))({ OMP_I18N: { add: (code, strings) => { if (code === "zh") Object.assign(ZH, strings); } } });

const D = { notifySound: "off", soundAttention: "bell", soundFinished: "chime", soundVolume: 60 };

/** The row in a window with the real sound module, `play` replaced by a
 *  recorder, and an OMP_TR that records every source string it is asked for. */
function rows() {
  const plays = [], seen = new Set();
  const t = (s, vars) => { seen.add(s); return vars ? s.replace(/\{(\w+)\}/g, (_, k) => vars[k]) : s; };
  const window = { SettingsRow: "Row", SettingsSeg: "Seg", SettingsButton: "Button", Icon: "Icon", TWEAK_DEFAULTS: D, OMP_TR: t };
  new Function("window", source("src/app/notify-sound.js"))(window);
  window.OMP_NOTIFY_SOUND = { ...window.OMP_NOTIFY_SOUND, play: (id, volume) => plays.push([id, volume]) };
  const React = {
    Fragment: "fragment",
    createElement: (type, props, ...children) => ({ type, props: props ?? {}, children }),
  };
  runInContext(rowsFile, createContext({ window, React, OMP_TR: t }));
  const expand = node => {
    if (Array.isArray(node)) return node.map(expand);
    if (!node || typeof node !== "object") return node;
    if (typeof node.type === "function") return expand(node.type({ ...node.props, children: node.children }));
    return { ...node, children: node.children.map(expand) };
  };
  return {
    plays, seen,
    /** The two lines for the stored tweaks `stored`: `{ rowProps, seg, button }` per cue. */
    render(stored) {
      const sets = [];
      const ctx = { t: stored, setTweak: (key, value) => sets.push([key, value]) };
      const tree = expand(window.OMP_SETTINGS_ROWS.sounds({ row: { label: "Sounds" }, ctx, query: "" }));
      const find = (node, type, out = []) => {
        if (Array.isArray(node)) node.forEach(n => find(n, type, out));
        else if (node && typeof node === "object") { if (node.type === type) out.push(node); find(node.children, type, out); find(node.props?.aside, type, out); }
        return out;
      };
      const lines = find(tree, "Row").map(row => ({
        row: row.props,
        seg: find(row, "Seg")[0].props,
        button: find(row.props.aside, "Button")[0].props,
      }));
      return { lines, sets };
    },
  };
}

check("two lines, one per cue, each a seg of none plus the catalogue", () => {
  const { lines } = rows().render({});
  assert.deepEqual(lines.map(l => l.row.label), ["Question waiting", "Turn finished"]);
  for (const l of lines) assert.deepEqual([...l.seg.options.map(o => o.value)], ["none", "chime", "bell", "pop", "knock", "rise", "blip"]);
  assert.deepEqual(lines.map(l => l.seg.value), ["bell", "chime"], "the defaults when nothing is stored");
});

check("picking saves the cue's own key and previews the pick at the saved volume", () => {
  const r = rows();
  const stored = { notifySound: "always", soundVolume: 35 };
  const { lines, sets } = r.render(stored);
  lines[0].seg.onChange("pop");
  lines[1].seg.onChange("knock");
  assert.deepEqual(sets, [["soundAttention", "pop"], ["soundFinished", "knock"]]);
  assert.deepEqual(r.plays.map(p => [...p]), [["pop", 35], ["knock", 35]]);
});

check("re-picking the selected sound previews it again", () => {
  const r = rows();
  const { lines, sets } = r.render({ soundAttention: "rise" });
  lines[0].seg.onChange("rise");
  assert.deepEqual(r.plays.map(p => [...p]), [["rise", 60]]);
  assert.deepEqual(sets, [["soundAttention", "rise"]]);
});

check("picking none saves it and plays nothing through the module's own guard", () => {
  const r = rows();
  const { lines, sets } = r.render({});
  lines[1].seg.onChange("none");
  assert.deepEqual(sets, [["soundFinished", "none"]]);
  assert.deepEqual(r.plays.map(p => [...p]), [["none", 60]], "play is asked; the module itself ignores none");
});

check("▶ plays the line's current sound at the saved volume", () => {
  const r = rows();
  const { lines } = r.render({ soundAttention: "blip", soundFinished: "pop", soundVolume: 80 });
  lines[0].button.onClick();
  lines[1].button.onClick();
  assert.deepEqual(r.plays.map(p => [...p]), [["blip", 80], ["pop", 80]]);
});

check("▶ is disabled for none and at volume 0, enabled otherwise", () => {
  const r = rows();
  const { lines } = r.render({ soundFinished: "none" });
  assert.deepEqual(lines.map(l => l.button.disabled), [false, true]);
  assert.equal(lines[1].button.title, undefined, "no preview title for none");
  assert.equal(lines[0].button.title, "Preview Bell");
  const quiet = r.render({ soundVolume: 0 }).lines;
  assert.deepEqual(quiet.map(l => l.button.disabled), [true, true]);
});

check("an invalid stored sound or volume shows the default", () => {
  const { lines } = rows().render({ soundAttention: "gong", soundVolume: "loud" });
  assert.equal(lines[0].seg.value, "bell");
  assert.equal(lines[0].button.disabled, false);
});

check("each line's changed dot and reset target its own key and default", () => {
  const r = rows();
  const { lines, sets } = r.render({ soundAttention: "pop", soundFinished: "chime" });
  assert.deepEqual(lines.map(l => l.row.modified), [true, false], "the stored value against its default");
  lines[0].row.onReset();
  lines[1].row.onReset();
  assert.deepEqual(sets, [["soundAttention", "bell"], ["soundFinished", "chime"]]);
  assert.deepEqual(r.render({}).lines.map(l => l.row.modified), [false, false], "nothing stored is not changed");
  assert.equal(r.render({ soundAttention: "gong" }).lines[0].row.modified, true, "counted on the stored value, as the page's badges do");
});

check("every string the row shows has a zh entry", () => {
  const r = rows();
  const shown = [];
  for (const stored of [{}, { soundAttention: "none", soundFinished: "none" }]) {
    for (const l of r.render(stored).lines) shown.push(l.row.label, l.row.desc, ...l.seg.options.map(o => o.label));
  }
  const missing = [...new Set([...shown, ...r.seen])].filter(s => !Object.hasOwn(ZH, s));
  assert.deepEqual(missing, []);
  assert.ok(r.seen.has("Preview {sound}"), "the preview title is among the strings checked");
});

console.log(`test-rows-sounds: ${passed} checks passed`);

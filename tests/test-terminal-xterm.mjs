#!/usr/bin/env node
// Regression script for src/app/terminal-xterm.js — building a tab's xterm
// (options, OSC 8 swallowed, fit and web-links addons, data / resize wiring), its key
// routing (restart on Enter without leaking "\r", copy / paste chords,
// chords handed back to the keymap), the ConPTY option and the lines it
// writes. xterm itself is replaced by a recording fake; the routing
// decisions are app/terminal.js's and app/keymap.js's (test-terminal.mjs,
// test-keymap.mjs), stubbed here.
// Run: node tests/test-terminal-xterm.mjs

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const { WebLinksAddon: RealWebLinksAddon } = require("../src/xterm-addon-web-links.js");

const root = join(dirname(fileURLToPath(import.meta.url)), "..");

class FakeTerminal {
  constructor(options) {
    this.options = options;
    this.osc = new Map();
    this.addons = [];
    this.selection = "";
    this.parser = { registerOscHandler: (id, fn) => this.osc.set(id, fn) };
  }
  loadAddon(a) { this.addons.push(a); }
  attachCustomKeyEventHandler(fn) { this.key = fn; }
  onData(fn) { this.data = fn; }
  onResize(fn) { this.resize = fn; }
  hasSelection() { return this.selection !== ""; }
  getSelection() { return this.selection; }
  paste(text) { (this.pasted ||= []).push(text); }
}
class FakeFit {}
class FakeWebLinks {
  constructor(handler, options) { this.handler = handler; this.options = options; }
}

const copied = [];
let clipboardText = "";
const win = {
  Terminal: FakeTerminal,
  FitAddon: { FitAddon: FakeFit },
  WebLinksAddon: { WebLinksAddon: FakeWebLinks },
  copyText: (t) => copied.push(t),
  navigator: { clipboard: { readText: async () => clipboardText } },
  OMP_TERMINAL: {
    clipboardAction: (e) => (e.key === "C" ? "copy" : e.key === "V" ? "paste" : null),
  },
  OMP_KEYMAP: { guestShouldBypass: (e) => e.key === "bypass" },
};
// eslint-disable-next-line no-new-func
new Function("window", readFileSync(join(root, "src/app/terminal-xterm.js"), "utf8"))(win);
const X = win.OMP_TERMINAL_XTERM;

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

/** A key event; `prevented` records preventDefault. */
const key = (type, k) => {
  const e = { type, key: k, prevented: false };
  e.preventDefault = () => { e.prevented = true; };
  return e;
};

function make({ restart = () => false, scrollback, onLink = () => {} } = {}) {
  const seen = { data: [], resize: [], restarts: 0 };
  const made = X.createXterm({
    fontSize: 14,
    scrollback,
    theme: { background: "#000" },
    tryRestart: () => { const ok = restart(); if (ok) seen.restarts++; return ok; },
    onData: (d) => seen.data.push(d),
    onResize: (s) => seen.resize.push(s),
    onLink,
  });
  return { ...made, seen };
}

check("createXterm: options, OSC 8 swallowed, fit addon, wiring", () => {
  const { term, fit, seen } = make();
  assert.equal(term.options.fontSize, 14);
  assert.deepEqual(term.options.theme, { background: "#000" });
  assert.equal(term.options.allowProposedApi, false);
  assert.equal(term.options.scrollback, 5000, "no pref: the default");
  assert.equal(term.osc.get(8)("id=1;https://x"), true, "OSC 8 handled (dropped)");
  assert.ok(fit instanceof FakeFit && term.addons.includes(fit));
  term.data("ls\r");
  term.resize({ cols: 90, rows: 20 });
  assert.deepEqual(seen.data, ["ls\r"]);
  assert.deepEqual(seen.resize, [{ cols: 90, rows: 20 }]);
});

check("createXterm loads web links with the terminal's activation handler", () => {
  const opened = [];
  const { term } = make({ onLink: (e, url) => opened.push([e, url]) });
  const links = term.addons.find((addon) => addon instanceof FakeWebLinks);
  assert.ok(links, "web-links addon loaded");
  const event = { button: 0, metaKey: true };
  links.handler(event, "https://example.com/");
  assert.deepEqual(opened, [[event, "https://example.com/"]]);
});

/** Run the real vendored provider against fixed-width wrapped buffer lines. */
function realProvider(lines, options, activate) {
  const bufferLines = lines.map((text, index) => ({
    length: text.length,
    isWrapped: index > 0,
    translateToString: () => text,
    getCell(x, cell) { cell.chars = text[x] ?? ""; cell.width = 1; },
  }));
  let provider;
  const terminal = {
    buffer: { active: {
      getLine: (index) => bufferLines[index],
      getNullCell: () => ({ chars: "", width: 0, getChars() { return this.chars; }, getWidth() { return this.width; } }),
    } },
    registerLinkProvider(p) { provider = p; return { dispose() {} }; },
  };
  new RealWebLinksAddon(activate, options).activate(terminal);
  return (y = 1) => {
    let links;
    provider.provideLinks(y, (value) => { links = value; });
    return links;
  };
}

check("a URL truncated by the real addon's wrapped-line scan never activates", () => {
  const opened = [];
  const { term } = make({ onLink: (event, url) => opened.push(url) });
  const addon = term.addons.find((candidate) => candidate instanceof FakeWebLinks);
  const url = `http://localhost:3000/${"a".repeat(3500)}`;
  const lines = url.match(/.{1,100}/g);
  const provide = realProvider(lines, addon.options, addon.handler);
  const links = provide();
  assert.equal(links.length, 1);
  assert.ok(links[0].text.length < url.length, "fixture exceeds the addon's 2048-character forward scan");
  links[0].activate({ button: 0, metaKey: true }, links[0].text);
  assert.deepEqual(opened, []);
});

check("the real addon matches bracketed IPv6 URLs", () => {
  const { term } = make();
  const { options } = term.addons.find((addon) => addon instanceof FakeWebLinks);
  for (const url of ["http://[::1]", "http://[::1]/", "https://[2001:db8::1]:8443/path?q=1"]) {
    const provide = realProvider([url], options, () => {});
    const links = provide();
    assert.equal(links.length, 1, url);
    assert.equal(links[0].text, url);
  }
});

check("createXterm: scrollback from the terminalScrollback tweak", () => {
  assert.equal(make({ scrollback: 50000 }).term.options.scrollback, 50000);
  assert.equal(make({ scrollback: 1000 }).term.options.scrollback, 1000);
});

check("scrollbackLines: whole lines in 0..100000, the default for junk", () => {
  assert.equal(X.scrollbackLines(10000), 10000);
  assert.equal(X.scrollbackLines(1234.6), 1235);
  assert.equal(X.scrollbackLines(-5), 0);
  assert.equal(X.scrollbackLines(1e9), 100000);
  assert.equal(X.scrollbackLines(undefined), 5000);
  assert.equal(X.scrollbackLines("5000"), 5000);
  assert.equal(X.scrollbackLines(NaN), 5000);
});

check("a restarting Enter never reaches the shell, not even as keypress", () => {
  const { term, seen } = make({ restart: () => true });
  const down = key("keydown", "Enter");
  assert.equal(term.key(down), false);
  assert.equal(down.prevented, true, "no keypress gets fired");
  assert.equal(seen.restarts, 1);
  assert.equal(term.key(key("keypress", "Enter")), false, "a keypress anyway is swallowed");
  assert.equal(term.key(key("keyup", "Enter")), false);
  assert.equal(term.key(key("keypress", "Enter")), true, "after keyup Enter is the shell's again");
});

check("Enter in a live shell (no restart) goes to the shell", () => {
  const { term, seen } = make({ restart: () => false });
  const down = key("keydown", "Enter");
  assert.equal(term.key(down), true);
  assert.equal(down.prevented, false);
  assert.equal(term.key(key("keypress", "Enter")), true);
  assert.equal(seen.restarts, 0);
});

check("tryRestart is asked only for an Enter keydown", () => {
  let asked = 0;
  const { term } = make({ restart: () => { asked++; return false; } });
  term.key(key("keypress", "Enter"));
  term.key(key("keyup", "Enter"));
  term.key(key("keydown", "a"));
  assert.equal(asked, 0);
  term.key(key("keydown", "Enter"));
  assert.equal(asked, 1);
});

check("copy chord: copies a selection, consumed either way", () => {
  const { term } = make();
  copied.length = 0;
  const none = key("keydown", "C");
  assert.equal(term.key(none), false);
  assert.equal(none.prevented, true);
  assert.deepEqual(copied, [], "nothing selected: nothing copied");
  term.selection = "abc";
  term.key(key("keydown", "C"));
  assert.deepEqual(copied, ["abc"]);
});

check("paste chord: consumed, keeps the WebView's paste out", () => {
  const { term } = make();
  const e = key("keydown", "V");
  assert.equal(term.key(e), false);
  assert.equal(e.prevented, true);
});

// The paste lands after the clipboard read resolves.
{
  const { term } = make();
  clipboardText = "echo pasted";
  term.key(key("keydown", "V"));
  await new Promise((r) => setTimeout(r, 0));
  clipboardText = "";
  term.key(key("keydown", "V"));
  await new Promise((r) => setTimeout(r, 0));
  check("paste chord: the clipboard's text goes to the shell, an empty one does not", () => {
    assert.deepEqual(term.pasted, ["echo pasted"]);
  });
}

check("a bypassed chord goes back to the page; others and non-keydowns stay xterm's", () => {
  const { term } = make();
  const by = key("keydown", "bypass");
  assert.equal(term.key(by), false);
  assert.equal(by.prevented, false, "the keymap must still see it");
  assert.equal(term.key(key("keydown", "x")), true);
  assert.equal(term.key(key("keyup", "bypass")), true);
});

check("applyWindowsPty sets the option only when Rust reports a different one", () => {
  const term = { options: {} };
  X.applyWindowsPty(term, null);
  X.applyWindowsPty(term, { windowsPty: null });
  assert.equal("windowsPty" in term.options, false, "off Windows: left unset");
  X.applyWindowsPty(term, { windowsPty: { backend: "conpty", buildNumber: 19045 } });
  const first = term.options.windowsPty;
  assert.deepEqual(first, { backend: "conpty", buildNumber: 19045 });
  X.applyWindowsPty(term, { windowsPty: { backend: "conpty", buildNumber: 19045 } });
  assert.equal(term.options.windowsPty, first, "same value: not rewritten");
  X.applyWindowsPty(term, { windowsPty: { backend: "conpty", buildNumber: 22631 } });
  assert.equal(term.options.windowsPty.buildNumber, 22631);
});

check("exit / failure / skipped lines", () => {
  assert.match(X.exitLine(3), /shell exited \(code 3\) — press Enter to restart/);
  assert.match(X.exitLine(null), /shell exited — press Enter/);
  assert.match(X.failLine("no such file"), /could not start the shell: no such file\x1b\[0m — press Enter to retry/);
  assert.match(X.SKIPPED_LINE, /\[output skipped\]/);
  for (const line of [X.exitLine(0), X.failLine("x"), X.SKIPPED_LINE]) {
    assert.ok(line.startsWith("\r\n") && line.endsWith("\r\n"), "on a line of its own");
  }
});

console.log(`terminal-xterm: ${passed} checks passed`);

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
let isMac = true;
const win = {
  Terminal: FakeTerminal,
  FitAddon: { FitAddon: FakeFit },
  WebLinksAddon: { WebLinksAddon: FakeWebLinks },
  copyText: (t) => copied.push(t),
  navigator: { clipboard: { readText: async () => clipboardText } },
  OMP_TERMINAL: {
    clipboardAction: (e) => (e.key === "C" ? "copy" : e.key === "V" ? "paste" : null),
  },
  OMP_KEYMAP: { guestShouldBypass: (e) => e.key === "bypass", detectMac: () => isMac },
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
  const url = "https://example.com/";
  const provide = realProvider([url], links.options, links.handler, term);
  const link = provide()[0];
  link.hover(event, link.text, link.range);
  link.activate(event, url);
  assert.deepEqual(opened, [[event, url]]);
});

/** Cells for a text string, one per code point. */
function textCells(text, extra = {}) {
  return Array.from(text, (chars) => ({ chars, width: 1, ...extra }));
}

/** xterm's cell for a column with no character: one blank column. */
function nullCell() { return { chars: "", width: 1 }; }

/** `text`'s cells, padded with null cells to a terminal row of `cols`. */
function rowCells(text, cols) {
  const cells = textCells(text);
  while (cells.length < cols) cells.push(nullCell());
  return cells;
}

/** Full-width terminal text wrapped into `cols`-wide rows, like xterm. */
function wrappedRows(text, cols) {
  const rows = [];
  for (let at = 0; at < text.length; at += cols) {
    rows.push({ cells: rowCells(text.slice(at, at + cols), cols), isWrapped: at > 0 });
  }
  return rows;
}

/**
 * Buffer lines shaped like xterm's: every row `cols` cells wide, a row that
 * continues the previous one flagged `isWrapped`, and `translateToString`
 * built from the cells the way xterm does it (null cells read as spaces,
 * continuation cells are skipped, `trimRight` drops the pad).
 */
function bufferLines(rows) {
  return rows.map((entry, index) => {
    const cells = entry.cells ?? textCells(entry.text ?? entry);
    const isWrapped = entry.cells ? Boolean(entry.isWrapped) : entry.isWrapped ?? index > 0;
    return {
      length: cells.length,
      isWrapped,
      translateToString(trimRight) {
        let text = "";
        for (const cell of cells) if (cell.width) text += cell.chars || " ";
        return trimRight ? text.replace(/ +$/, "") : text;
      },
      getCell(x, cell) {
        const source = cells[x] ?? { chars: "", width: 0 };
        cell.chars = source.chars ?? "";
        cell.width = source.width ?? 0;
        cell.invisible = Boolean(source.invisible);
        cell.isInvisible = () => cell.invisible;
        cell.getChars = () => cell.chars;
        cell.getWidth = () => cell.width;
      },
    };
  });
}

/** A buffer view over `rows`; `onRead` sees every `getLine` (a walk probe). */
function bufferOf(rows, onRead) {
  const lines = bufferLines(rows);
  return { active: {
    length: lines.length,
    getLine(index) { onRead?.(index); return lines[index]; },
    getNullCell: () => ({ ...nullCell(), invisible: false, getChars() { return this.chars; }, getWidth() { return this.width; }, isInvisible() { return this.invisible; } }),
  } };
}

/** Run the real vendored provider against xterm-shaped wrapped buffer lines. */
function realProvider(rows, options, activate, term) {
  let provider;
  const terminal = {
    buffer: bufferOf(rows),
    registerLinkProvider(p) { provider = p; return { dispose() {} }; },
  };
  if (term) term.buffer = terminal.buffer;
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
  const prefix = "https://example.test/path";
  const url = `${prefix}${".".repeat(2300)}tail`;
  assert.equal(url.length, 2329);
  const lines = url.match(/.{1,100}/g);
  const provide = realProvider(lines, addon.options, addon.handler, term);
  const links = provide();
  assert.equal(links.length, 1);
  assert.equal(links[0].text, prefix, "the addon strips dots at its 2048-character scan boundary");
  links[0].hover({}, links[0].text, links[0].range);
  links[0].activate({ button: 0, metaKey: true }, links[0].text);
  assert.deepEqual(opened, []);
});

check("duplicate complete URLs activate at the hovered occurrence", () => {
  const opened = [];
  const { term } = make({ onLink: (event, url) => opened.push(url) });
  const { options, handler } = term.addons.find((addon) => addon instanceof FakeWebLinks);
  const url = "https://example.test/same";
  const provide = realProvider([
    { text: url, isWrapped: false },
    { text: url, isWrapped: false },
  ], options, handler, term);
  const links = provide();
  assert.equal(links.length, 1);
  links[0].hover({}, links[0].text, links[0].range);
  links[0].activate({ button: 0, metaKey: true }, links[0].text);
  assert.deepEqual(opened, [url]);
});

check("the real addon matches and activates complete bracketed IPv6 URLs", () => {
  const opened = [];
  const { term } = make({ onLink: (event, url) => opened.push(url) });
  const { options, handler } = term.addons.find((addon) => addon instanceof FakeWebLinks);
  for (const url of ["http://[::1]", "http://[::1]/", "https://[2001:db8::1]:8443/path?q=1"]) {
    const provide = realProvider([url], options, handler, term);
    const links = provide();
    assert.equal(links.length, 1, url);
    assert.equal(links[0].text, url);
    links[0].hover({}, links[0].text, links[0].range);
    links[0].activate({ button: 0, metaKey: true }, links[0].text);
  }
  assert.deepEqual(opened, ["http://[::1]", "http://[::1]/", "https://[2001:db8::1]:8443/path?q=1"]);
});

check("a bracketed IPv6 match never drops a following URL authority", () => {
  const opened = [];
  const { term } = make({ onLink: (event, url) => opened.push(url) });
  const { options, handler } = term.addons.find((addon) => addon instanceof FakeWebLinks);
  const candidate = "http://[2001:db8::1]@example.test/page";
  const provide = realProvider([candidate], options, handler, term);
  const links = provide();
  assert.equal(links.length, 1);
  assert.equal(links[0].text, "http://[2001:db8::1]");
  assert.equal(new URL(candidate).host, "example.test");
  links[0].hover({}, links[0].text, links[0].range);
  links[0].activate({ button: 0, metaKey: true }, links[0].text);
  assert.deepEqual(opened, []);
});

check("a match spanning concealed cells never activates", () => {
  const opened = [];
  const { term } = make({ onLink: (event, url) => opened.push(url) });
  const { options, handler } = term.addons.find((addon) => addon instanceof FakeWebLinks);
  const url = "https://evil.test/path";
  const cells = [
    ...textCells("https://"),
    ...textCells("evil.test", { invisible: true }),
    ...textCells("/path"),
  ];
  const provide = realProvider([{ text: url, cells, isWrapped: false }], options, handler, term);
  const links = provide();
  assert.equal(links.length, 1);
  assert.equal(links[0].text, url);
  links[0].hover({}, links[0].text, links[0].range);
  links[0].activate({ button: 0, metaKey: true }, links[0].text);
  assert.deepEqual(opened, []);
});

check("concealed cells outside the match do not block it", () => {
  const opened = [];
  const { term } = make({ onLink: (event, url) => opened.push(url) });
  const { options, handler } = term.addons.find((addon) => addon instanceof FakeWebLinks);
  const url = "https://example.test/visible";
  const cells = [
    ...textCells(url),
    { chars: " ", width: 1 },
    ...textCells("secret", { invisible: true }),
  ];
  const provide = realProvider([{ text: `${url} secret`, cells, isWrapped: false }], options, handler, term);
  const links = provide();
  assert.equal(links.length, 1);
  links[0].hover({}, links[0].text, links[0].range);
  links[0].activate({ button: 0, metaKey: true }, links[0].text);
  assert.deepEqual(opened, [url]);
});

check("a URL the addon stops at after a legal character opens its full token", () => {
  const opened = [];
  const { term } = make({ onLink: (event, url) => opened.push(url) });
  const { options, handler } = term.addons.find((addon) => addon instanceof FakeWebLinks);
  const url = "https://example.test/files/Notes(1).pdf";
  const provide = realProvider([url], options, handler, term);
  const links = provide();
  assert.equal(links.length, 1);
  assert.equal(links[0].text, "https://example.test/files/Notes");
  links[0].hover({}, links[0].text, links[0].range);
  links[0].activate({ button: 0, metaKey: true }, links[0].text);
  assert.deepEqual(opened, [url]);
});

check("a URL found inside a larger token never activates its prefix", () => {
  const opened = [];
  const { term } = make({ onLink: (event, url) => opened.push(url) });
  const { options, handler } = term.addons.find((addon) => addon instanceof FakeWebLinks);
  const url = "https://example.test/path";
  const line = `see${url}`;
  const provide = realProvider([line], options, handler, term);
  const links = provide();
  assert.equal(links.length, 1);
  assert.equal(links[0].text, url);
  links[0].hover({}, links[0].text, links[0].range);
  links[0].activate({ button: 0, metaKey: true }, links[0].text);
  assert.deepEqual(opened, []);
});

check("links after wide and combining characters activate at their cell offsets", () => {
  const opened = [];
  const { term } = make({ onLink: (event, url) => opened.push(url) });
  const { options, handler } = term.addons.find((addon) => addon instanceof FakeWebLinks);
  const wide = "https://example.test/wide";
  const wideLine = {
    text: `界 ${wide}`,
    isWrapped: false,
    cells: [
      { chars: "界", width: 2 },
      { chars: "", width: 0 },
      { chars: " ", width: 1 },
      ...textCells(wide),
    ],
  };
  const combining = "https://example.test/accent";
  const combiningLine = {
    text: `e\u0301 ${combining}`,
    isWrapped: false,
    cells: [
      { chars: "e\u0301", width: 1 },
      { chars: " ", width: 1 },
      ...textCells(combining),
    ],
  };
  for (const [line, url] of [[wideLine, wide], [combiningLine, combining]]) {
    const links = realProvider([line], options, handler, term)();
    assert.equal(links.length, 1, url);
    links[0].hover({}, links[0].text, links[0].range);
    links[0].activate({ button: 0, metaKey: true }, links[0].text);
  }
  assert.deepEqual(opened, [wide, combining]);
});

check("prose brackets stay out of the target, IPv6 host brackets stay in", () => {
  const opened = [];
  const { term } = make({ onLink: (event, url) => opened.push(url) });
  const { options, handler } = term.addons.find((addon) => addon instanceof FakeWebLinks);
  const cases = [
    ["[https://example.test/build]", "https://example.test/build"],
    ["(https://example.test/build)", "https://example.test/build"],
    ["[http://[::1]]", "http://[::1]"],
  ];
  for (const [line, target] of cases) {
    const links = realProvider([line], options, handler, term)();
    assert.equal(links.length, 1, line);
    links[0].hover({}, links[0].text, links[0].range);
    links[0].activate({ button: 0, metaKey: true }, links[0].text);
    assert.equal(opened.at(-1), target, line);
  }
  assert.deepEqual(opened, cases.map(([, target]) => target));
});

check("link activation checks the gesture before reading the buffer", () => {
  const opened = [];
  const { term } = make({ onLink: (event, url) => opened.push(url) });
  const { options, handler } = term.addons.find((addon) => addon instanceof FakeWebLinks);
  const url = "https://example.test/";
  let reads = 0;
  Object.defineProperty(term, "buffer", {
    configurable: true,
    get() {
      reads++;
      return { active: {
        length: 0,
        getLine: () => undefined,
        getNullCell: () => ({
          chars: "", width: 0, invisible: false,
          getChars() { return this.chars; },
          getWidth() { return this.width; },
          isInvisible() { return this.invisible; },
        }),
      } };
    },
  });
  options.hover({}, url, { start: { x: 1, y: 1 }, end: { x: url.length, y: 1 } });
  handler({ button: 0 }, url);
  handler({ button: 0, metaKey: false }, url);
  handler({ button: 1, metaKey: true }, url);
  assert.equal(reads, 0, "no buffer scan without the link gesture");
  handler({ button: 0, metaKey: true }, url);
  assert.ok(reads > 0, "the link gesture reads the buffer");
  const macReads = reads;
  isMac = false;
  try {
    handler({ button: 0, metaKey: true }, url);
    assert.equal(reads, macReads, "meta is not the link modifier off macOS");
    handler({ button: 0, ctrlKey: true }, url);
    assert.ok(reads > macReads, "ctrl is the link modifier off macOS");
  } finally {
    isMac = true;
  }
  assert.deepEqual(opened, []);
});

check("a logical line beyond the scan cap never activates", () => {
  const opened = [];
  const { term } = make({ onLink: (event, url) => opened.push(url) });
  const { options, handler } = term.addons.find((addon) => addon instanceof FakeWebLinks);
  const url = `https://example.test/${"a".repeat(2100)}`;
  const provide = realProvider([url], options, handler, term);
  const links = provide();
  assert.equal(links.length, 1);
  assert.equal(links[0].text, url, "the addon matches the long line; the scan cap refuses it");
  links[0].hover({}, links[0].text, links[0].range);
  links[0].activate({ button: 0, metaKey: true }, links[0].text);
  assert.deepEqual(opened, []);
});

check("erased cell gaps split the token; a skipped cell keeps a following URL apart", () => {
  const opened = [];
  const { term } = make({ onLink: (event, url) => opened.push(url) });
  const { options, handler } = term.addons.find((addon) => addon instanceof FakeWebLinks);
  const cols = 80;
  const splitCells = [...textCells("https://example.test/a"), nullCell(), ...textCells("/../../admin")];
  while (splitCells.length < cols) splitCells.push(nullCell());
  const gapCells = [...textCells("abc"), nullCell(), nullCell(), nullCell(), ...textCells("https://example.test/gap")];
  while (gapCells.length < cols) gapCells.push(nullCell());
  const cases = [
    [splitCells, "https://example.test/a", "the token ends at the erased column"],
    [gapCells, "https://example.test/gap", "the skipped columns end the prose token"],
  ];
  for (const [cells, target, why] of cases) {
    const links = realProvider([{ cells, isWrapped: false }], options, handler, term)();
    assert.equal(links.length, 1, why);
    links[0].hover({}, links[0].text, links[0].range);
    links[0].activate({ button: 0, metaKey: true }, links[0].text);
    assert.equal(opened.at(-1), target, why);
  }
  assert.deepEqual(opened, ["https://example.test/a", "https://example.test/gap"]);
});

check("a wrapped line over 64 rows never activates; exactly 64 rows still do", () => {
  const opened = [];
  const { term } = make({ onLink: (event, url) => opened.push(url) });
  const { options, handler } = term.addons.find((addon) => addon instanceof FakeWebLinks);
  const cols = 20;
  const over = `https://example.test/a(${"x".repeat(1400)})`;
  assert.ok(wrappedRows(over, cols).length > 64, "the repro line is longer than the cap");
  const truncated = realProvider(wrappedRows(over, cols), options, handler, term)();
  assert.equal(truncated.length, 1, "the addon still finds the URL prefix");
  truncated[0].hover({}, truncated[0].text, truncated[0].range);
  truncated[0].activate({ button: 0, metaKey: true }, truncated[0].text);
  assert.deepEqual(opened, [], "a line the cell walk cannot read whole is refused");

  const exact = `https://example.test/${"x".repeat(1259)}`;
  assert.equal(exact.length, 1280);
  assert.equal(wrappedRows(exact, cols).length, 64, "exactly at the row cap");
  const complete = realProvider(wrappedRows(exact, cols), options, handler, term)();
  assert.equal(complete.length, 1);
  complete[0].hover({}, complete[0].text, complete[0].range);
  complete[0].activate({ button: 0, metaKey: true }, complete[0].text);
  assert.deepEqual(opened, [exact], "the cap is inclusive");
});

check("the backward wrapped-line walk stops at the row cap", () => {
  const opened = [];
  const { term } = make({ onLink: (event, url) => opened.push(url) });
  const { options, handler } = term.addons.find((addon) => addon instanceof FakeWebLinks);
  const url = "https://example.test/late";
  const rows = 200;
  const lines = [];
  for (let i = 0; i < rows; i++) {
    lines.push({ cells: rowCells(i === rows - 1 ? url : "x".repeat(80), 80), isWrapped: i > 0 });
  }
  let reads = 0;
  term.buffer = bufferOf(lines, () => { reads++; });
  options.hover({}, url, { start: { x: 1, y: rows }, end: { x: url.length, y: rows } });
  handler({ button: 0, metaKey: true }, url);
  assert.deepEqual(opened, [], "the line is longer than the cap");
  assert.ok(reads <= 65, `the walk stays within the 64-row window (read ${reads} rows)`);
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

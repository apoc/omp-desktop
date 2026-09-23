#!/usr/bin/env node
// Regression script for src/app/slash-commands.js — the `/` palette's merge
// of the desktop-native command list with omp's RPC get_available_commands /
// available_commands_update (issue #8: `/` never listed real commands or
// skills, only a static 12-entry desktop list).
// Run: node test-slash-commands.mjs

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const __dir = dirname(fileURLToPath(import.meta.url));
const src   = readFileSync(join(__dir, "src/app/slash-commands.js"), "utf8");
const win   = {};
// eslint-disable-next-line no-new-func
new Function("window", src)(win);
const S = win.OMP_SLASH;

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

const rpc = (over) => ({ name: "x", source: "builtin", ...over });

// ── adaptAvailableCommands ──────────────────────────────────────────────

check("non-array input returns []", () => {
  assert.deepEqual(S.adaptAvailableCommands(null), []);
  assert.deepEqual(S.adaptAvailableCommands(undefined), []);
  assert.deepEqual(S.adaptAvailableCommands("nope"), []);
});

check("entries without a usable name are dropped", () => {
  const out = S.adaptAvailableCommands([{ source: "builtin" }, { name: "", source: "builtin" }, { name: 42 }]);
  assert.deepEqual(out, []);
});

check("leading slash on name/aliases is stripped; case is preserved", () => {
  // omp resolves names case-sensitively (exact === against a filename- or
  // registry-derived name) — lowercasing here would make insertText() emit
  // a name omp can no longer match against what advertised it.
  const [c] = S.adaptAvailableCommands([{ name: "/Skill:Foo", aliases: ["/FOO"] }]);
  assert.equal(c.name, "Skill:Foo");
  assert.deepEqual(c.aliases, ["FOO"]);
});

check("skill source groups under Skills", () => {
  const [c] = S.adaptAvailableCommands([rpc({ name: "skill:diagnose-crash", source: "skill" })]);
  assert.equal(c.group, "Skills");
  assert.equal(c.source, "skill");
});

check("builtin source groups under Commands", () => {
  const [c] = S.adaptAvailableCommands([rpc({ name: "model" })]);
  assert.equal(c.group, "Commands");
});

check("unknown source (extension/custom/file) falls back to Custom group", () => {
  for (const source of ["extension", "custom", "file", "something-new"]) {
    const [c] = S.adaptAvailableCommands([rpc({ name: "x", source })]);
    assert.equal(c.group, "Custom", `source=${source}`);
  }
});

check("input.hint is folded in front of the description; subcommands aren't carried", () => {
  const [withBoth, hintOnly, descOnly, neither] = S.adaptAvailableCommands([
    rpc({ name: "security", input: { hint: "<plan|scan>" }, description: "scan things", subcommands: [{ name: "plan", description: "d" }] }),
    rpc({ name: "switch", input: { hint: "[model]" } }),
    rpc({ name: "model", description: "show current model" }),
    rpc({ name: "bare" }),
  ]);
  assert.equal(withBoth.hint, "<plan|scan>  scan things");
  assert.equal(withBoth.subcommands, undefined);
  assert.equal(hintOnly.hint, "[model]");
  assert.equal(descOnly.hint, "show current model");
  assert.equal(neither.hint, "");
});

check("embedded newlines/indentation in input.hint or description are collapsed to single spaces", () => {
  // Real-world shapes this guards against: an MCP prompt's description is
  // the server's raw docstring verbatim (often multi-line with leading
  // indentation), and a skill/file command's YAML frontmatter can use a
  // `|` block scalar that keeps internal newlines. The popup renders
  // `hint` with `white-space: pre` so the intentional `  ` separator
  // between input.hint and description survives — normalizing each part's
  // own whitespace first keeps that `pre` from also turning a raw
  // docstring into a multi-line row.
  const [c] = S.adaptAvailableCommands([rpc({
    name: "summarize",
    input: { hint: "\narguments\n  " },
    description: "\n    Summarize a file.\n\n    Args:\n      path: str\n    ",
  })]);
  assert.equal(c.hint, "arguments  Summarize a file. Args: path: str");
  assert.ok(!c.hint.includes("\n"));
});

check("description missing defaults to empty hint, not undefined", () => {
  const [c] = S.adaptAvailableCommands([rpc({ name: "x", description: undefined })]);
  assert.equal(c.hint, "");
});

check("order is preserved", () => {
  const out = S.adaptAvailableCommands([rpc({ name: "b" }), rpc({ name: "a" }), rpc({ name: "c" })]);
  assert.deepEqual(out.map(c => c.name), ["b", "a", "c"]);
});

// ── mergeSlashCommands ───────────────────────────────────────────────────

check("empty RPC list gives exactly the local list", () => {
  const out = S.mergeSlashCommands(S.LOCAL_COMMANDS, []);
  assert.deepEqual(out, S.LOCAL_COMMANDS);
});

check("RPC entry with a name colliding with a local command is dropped, local kept", () => {
  const out = S.mergeSlashCommands(S.LOCAL_COMMANDS, S.adaptAvailableCommands([rpc({ name: "model", description: "omp's own /model" })]));
  const models = out.filter(c => c.name === "model");
  assert.equal(models.length, 1);
  assert.equal(models[0].source, "desktop");
});

check("RPC entry with an alias colliding with a local name is dropped", () => {
  // "model" is local; an RPC command that merely *aliases* to "model" must
  // not sneak a second "model"-reachable row in under a different name.
  const out = S.mergeSlashCommands(S.LOCAL_COMMANDS, S.adaptAvailableCommands([rpc({ name: "models", aliases: ["model"] })]));
  assert.ok(!out.some(c => c.name === "models"));
});

check("RPC entry whose own alias collides with an earlier RPC entry's name is dropped (first wins)", () => {
  const out = S.mergeSlashCommands([], S.adaptAvailableCommands([
    rpc({ name: "switch", description: "first" }),
    rpc({ name: "sw", aliases: ["switch"], description: "second, aliases the first" }),
  ]));
  assert.deepEqual(out.map(c => c.name), ["switch"]);
});

check("duplicate RPC entries (same name reported twice) keep only the first", () => {
  const out = S.mergeSlashCommands([], S.adaptAvailableCommands([
    rpc({ name: "todo", description: "first" }),
    rpc({ name: "todo", description: "second" }),
  ]));
  assert.equal(out.length, 1);
  assert.equal(out[0].hint, "first");
});

check("non-colliding RPC entries are appended after the full local list, in order", () => {
  const out = S.mergeSlashCommands(S.LOCAL_COMMANDS, S.adaptAvailableCommands([
    rpc({ name: "skill:foo", source: "skill" }),
    rpc({ name: "security" }),
  ]));
  assert.deepEqual(out.slice(0, S.LOCAL_COMMANDS.length), S.LOCAL_COMMANDS);
  assert.deepEqual(out.slice(S.LOCAL_COMMANDS.length).map(c => c.name), ["skill:foo", "security"]);
});

// ── slashMenu (composer inline popup) ────────────────────────────────────

const cmds = S.mergeSlashCommands(S.LOCAL_COMMANDS, S.adaptAvailableCommands([
  rpc({ name: "skill:diagnose-crash", source: "skill", description: "crash triage" }),
  rpc({ name: "security" }),
  rpc({ name: "fixPR", source: "file", description: "apply review feedback" }),
]));

check("non-slash text closes the menu", () => {
  assert.deepEqual(S.slashMenu(cmds, "hello"), []);
  assert.deepEqual(S.slashMenu(cmds, ""), []);
});

check("bare '/' lists every merged command", () => {
  assert.equal(S.slashMenu(cmds, "/").length, cmds.length);
});

check("prefix matches (name or alias) rank before substring matches", () => {
  const out = S.slashMenu(cmds, "/sk");
  // "skill:diagnose-crash" is a name-prefix match; nothing else starts with "sk".
  assert.equal(out[0].name, "skill:diagnose-crash");
});

check("slashMenu matches case-insensitively; insertText preserves the source's original case", () => {
  // A mixed-case custom/file command (e.g. from `fixPR.md`) must still be
  // findable by a lowercase-typed query, but the text inserted into the
  // composer has to keep the exact case omp registered it under — omp
  // matches command names with `===`, not case-insensitively.
  const lower = S.slashMenu(cmds, "/fixpr");
  const upper = S.slashMenu(cmds, "/FIXPR");
  assert.equal(lower.length, 1);
  assert.equal(lower[0].name, "fixPR");
  assert.deepEqual(upper.map(c => c.name), lower.map(c => c.name));
  assert.equal(S.insertText(lower[0]), "/fixPR ");
});

check("still typing the command token with args pending keeps filtering", () => {
  // No trailing space yet — "/plan" with a partial next word is not "args typed".
  const out = S.slashMenu(cmds, "/pla");
  assert.ok(out.some(c => c.name === "plan"));
});

check("args typed after a desktop command keeps only that command (Enter still runs it)", () => {
  const out = S.slashMenu(cmds, "/plan add the login flow");
  assert.deepEqual(out.map(c => c.name), ["plan"]);
});

check("args typed after a non-desktop (RPC) command closes the menu — omp runs it, not the composer", () => {
  const out = S.slashMenu(cmds, "/security scan --full");
  assert.deepEqual(out, []);
});

check("args typed after an unknown token closes the menu", () => {
  assert.deepEqual(S.slashMenu(cmds, "/not-a-command with args"), []);
});

check("a case-exact typed command reaches an RPC entry that differs from a desktop one only by case", () => {
  // Desktop `plan` always wins case-insensitive dedup collisions, but a
  // command that's case-exact-distinct (an RPC "Plan" is a genuinely
  // different command to omp than desktop "plan") must stay reachable by
  // typing its exact case, not silently unreachable behind the desktop one.
  const withCollision = S.mergeSlashCommands(S.LOCAL_COMMANDS, S.adaptAvailableCommands([
    rpc({ name: "Plan", source: "file", description: "run the Plan.md template" }),
  ]));
  const out = S.slashMenu(withCollision, "/Plan do the thing");
  assert.deepEqual(out, []); // non-desktop -> omp runs it, popup gets out of the way
  assert.equal(S.isSlashCommand(withCollision, "/Plan do the thing"), true);
  // Typing the desktop-cased version still reaches the desktop command.
  assert.deepEqual(S.slashMenu(withCollision, "/plan do the thing").map(c => c.name), ["plan"]);
});

check("still-typing (no args yet) also ranks a case-exact match first — not just the args branch", () => {
  const withCollision = S.mergeSlashCommands(S.LOCAL_COMMANDS, S.adaptAvailableCommands([
    rpc({ name: "Plan", source: "file", description: "run the Plan.md template" }),
  ]));
  assert.equal(S.slashMenu(withCollision, "/Plan")[0].name, "Plan");
  assert.equal(S.slashMenu(withCollision, "/plan")[0].name, "plan");
  assert.equal(S.slashMenu(withCollision, "/PLAN")[0].name, "plan"); // no case-exact match -> case-insensitive fallback, first in list order
});

check("a full name match ranks before a longer command that merely shares the prefix", () => {
  const withOverlap = S.mergeSlashCommands([], S.adaptAvailableCommands([
    rpc({ name: "skill:review-pr", source: "skill" }),
    rpc({ name: "skill:review", source: "skill" }),
  ]));
  const out = S.slashMenu(withOverlap, "/skill:review");
  assert.equal(out[0].name, "skill:review");
});

check("a full alias match ranks before an unrelated command that merely shares the prefix", () => {
  const withOverlap = S.mergeSlashCommands([], S.adaptAvailableCommands([
    rpc({ name: "queue" }),
    rpc({ name: "quit", aliases: ["q"] }),
  ]));
  const out = S.slashMenu(withOverlap, "/q");
  assert.equal(out[0].name, "quit");
});

// ── matchesQuery (⌘K bridge filter) ──────────────────────────────────────

check("empty query matches everything", () => {
  assert.ok(cmds.every(c => S.matchesQuery(c, "")));
});

check("matches on name, alias, or description case-insensitively", () => {
  const skillCmd = cmds.find(c => c.name === "skill:diagnose-crash");
  assert.ok(S.matchesQuery(skillCmd, "CRASH")); // description
  assert.ok(S.matchesQuery(skillCmd, "diagnose")); // name
  const withAlias = S.adaptAvailableCommands([rpc({ name: "switch", aliases: ["sw"] })])[0];
  assert.ok(S.matchesQuery(withAlias, "sw"));
  assert.equal(S.matchesQuery(skillCmd, "nope-not-here"), false);
});

// ── insertText ────────────────────────────────────────────────────────────

check("insertText produces '/name ' with a trailing space for the caret", () => {
  assert.equal(S.insertText({ name: "security" }), "/security ");
});

// ── isSlashCommand ────────────────────────────────────────────────────────

check("isSlashCommand is true only for a known name/alias, not just a leading slash", () => {
  assert.equal(S.isSlashCommand(cmds, "/plan"), true);
  assert.equal(S.isSlashCommand(cmds, "/plan draft the auth rework"), true);
  assert.equal(S.isSlashCommand(cmds, "/SECURITY scan"), true); // case-insensitive
  assert.equal(S.isSlashCommand(cmds, "/etc/nginx.conf is wrong"), false); // path, not a command
  assert.equal(S.isSlashCommand(cmds, "/not-a-real-command"), false);
  assert.equal(S.isSlashCommand(cmds, "no leading slash"), false);
  assert.equal(S.isSlashCommand(cmds, ""), false);
  assert.equal(S.isSlashCommand(cmds, null), false);
});

console.log(`\n${passed} checks passed.`);

#!/usr/bin/env node
// Regression script for src/app/project-nav.js — project grouping and
// focus-existing lookups behind the grouped tab bar and project sidebar
// (issue #27).
// Run: node tests/test-project-nav.mjs

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const root  = join(dirname(fileURLToPath(import.meta.url)), "..");
const src   = readFileSync(join(root, "src/app/project-nav.js"), "utf8");
const win   = { DEFAULT_PROFILE_ID: "default" }; // app/constants.js
// eslint-disable-next-line no-new-func
new Function("window", src)(win);
const N = win.OMP_PROJECT_NAV;

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

const tab = (id, path, extra = {}) => ({ id, name: id, path, profile: "default", runState: "idle", ...extra });

// ── normPath ──────────────────────────────────────────────────────────────

check("Windows drive paths compare case- and separator-insensitively", () => {
  assert.equal(N.normPath("C:\\Repo\\"), N.normPath("c:/repo"));
});

check("a drive root keeps comparing equal with and without its slash", () => {
  assert.equal(N.normPath("C:\\"), N.normPath("c:"));
});

check("UNC paths are case-insensitive", () => {
  assert.equal(N.normPath("\\\\Server\\Share"), N.normPath("//server/share/"));
});

check("POSIX paths stay case-sensitive", () => {
  assert.notEqual(N.normPath("/Home/x"), N.normPath("/home/x"));
});

check("the POSIX root survives trailing-slash stripping", () => {
  assert.equal(N.normPath("/"), "/");
});

// ── basename ──────────────────────────────────────────────────────────────

check("basename keeps the original case of either separator style", () => {
  assert.equal(N.basename("C:\\Users\\Me\\MyRepo\\"), "MyRepo");
  assert.equal(N.basename("/home/apoc/devel/omp-desktop"), "omp-desktop");
});

check("parentName is the containing folder, empty without one", () => {
  assert.equal(N.parentName("/home/apoc/devel/dotfiles/"), "devel");
  assert.equal(N.parentName("C:\\Users\\Me\\MyRepo"), "Me");
  assert.equal(N.parentName("/srv"), "");
  assert.equal(N.parentName(""), "");
});

// ── groupTabs ─────────────────────────────────────────────────────────────

check("the same folder under two profiles is two groups", () => {
  const groups = N.groupTabs([tab("a", "/p"), tab("b", "/p", { profile: "work" })]);
  assert.equal(groups.length, 2);
  assert.deepEqual(groups.map(g => g.profile), ["default", "work"]);
});

check("trailing-slash and backslash spellings of one folder share a group", () => {
  const groups = N.groupTabs([tab("a", "C:\\repo"), tab("b", "c:/Repo/"), tab("c", "C:\\REPO\\")]);
  assert.equal(groups.length, 1);
  assert.deepEqual(groups[0].tabs.map(t => t.id), ["a", "b", "c"]);
  assert.equal(groups[0].name, "repo");
});

check("pathless tabs never merge, and keep their own name", () => {
  const groups = N.groupTabs([tab("a", null, { name: "new session" }), tab("b", "")]);
  assert.equal(groups.length, 2);
  assert.equal(groups[0].name, "new session");
  assert.equal(groups[0].path, null);
});

check("group order follows each project's first appearance", () => {
  const groups = N.groupTabs([tab("a", "/x"), tab("b", "/y"), tab("c", "/x"), tab("d", "/z")]);
  assert.deepEqual(groups.map(g => g.name), ["x", "y", "z"]);
  assert.deepEqual(groups[0].tabs.map(t => t.id), ["a", "c"]);
});

// ── groupRunState / groupTarget ───────────────────────────────────────────

check("run state priority is failed > waiting-user > running > background > idle", () => {
  const states = ["idle", "background", "running", "waiting-user", "failed"];
  for (let i = 0; i < states.length; i++) {
    const tabs = states.slice(0, i + 1).map((s, j) => tab(`t${j}`, "/p", { runState: s }));
    // Winner last, then first: a "first non-idle wins" scan fails one of the two.
    assert.equal(N.groupRunState(tabs), states[i]);
    assert.equal(N.groupRunState([...tabs].reverse()), states[i]);
  }
  const mixed = ["running", "failed", "waiting-user", "background"].map((s, j) => tab(`m${j}`, "/p", { runState: s }));
  assert.equal(N.groupRunState(mixed), "failed");
  assert.equal(N.groupRunState([tab("b", "/p", { runState: "background" }), tab("r", "/p", { runState: "running" })]), "running");
  assert.equal(N.groupRunState([tab("a", "/p", { runState: undefined })]), "idle");
});

check("groupTarget prefers the active member, else the last one", () => {
  const [group] = N.groupTabs([tab("a", "/p"), tab("b", "/p"), tab("c", "/p")]);
  assert.equal(N.groupTarget(group, "b"), "b");
  assert.equal(N.groupTarget(group, "elsewhere"), "c");
});

// ── findProjectTab ────────────────────────────────────────────────────────

check("findProjectTab prefers the active tab, else the last match", () => {
  const tabs = [tab("a", "/p"), tab("b", "/p"), tab("c", "/q")];
  assert.equal(N.findProjectTab(tabs, "/p/", "default", "a"), "a");
  assert.equal(N.findProjectTab(tabs, "/p", "default", "c"), "b");
});

check("findProjectTab ignores tabs of another profile, and an empty path", () => {
  const tabs = [tab("a", "/p", { profile: "work" }), tab("b", null)];
  assert.equal(N.findProjectTab(tabs, "/p", "default", "a"), null);
  assert.equal(N.findProjectTab(tabs, "", "default", "b"), null);
});

// ── findConversationTab ───────────────────────────────────────────────────

check("findConversationTab matches the session file within the profile", () => {
  const tabs = [
    tab("a", "/p", { sessionFile: "/s/1.jsonl", profile: "work" }),
    tab("b", "/p", { sessionFile: "/s/1.jsonl" }),
    tab("c", "/p", { sessionFile: null }),
  ];
  assert.equal(N.findConversationTab(tabs, "/s/1.jsonl", "default"), "b");
  assert.equal(N.findConversationTab(tabs, "/s/2.jsonl", "default"), null);
});

check("findConversationTab never matches a falsy session file", () => {
  const tabs = [tab("a", "/p", { sessionFile: null }), tab("b", "/p", { sessionFile: "" })];
  assert.equal(N.findConversationTab(tabs, null, "default"), null);
  assert.equal(N.findConversationTab(tabs, "", "default"), null);
});

// ── recentRows ────────────────────────────────────────────────────────────

check("recentRows drops projects open in the same profile only", () => {
  const recents = [{ path: "/open" }, { path: "/closed" }, { path: "/other-profile" }];
  const tabs = [tab("a", "/open/"), tab("b", "/other-profile", { profile: "work" })];
  assert.deepEqual(N.recentRows(recents, tabs, "default").map(r => r.path), ["/closed", "/other-profile"]);
});

// ── sessionProjects (history filter, #35) ─────────────────────────────────

const saved = cwd => ({ cwd, project_name: cwd ? N.basename(cwd) : "Default" });

check("every distinct folder gets a chip with its sessions, in order of its newest session", () => {
  // Input order differs from both name and count order, so neither sort passes.
  const rows = [saved("C:\\c"), saved("c:/a/"), saved("C:\\b"), saved("C:\\a"), saved("C:\\A")];
  const chips = N.sessionProjects(rows, null);
  assert.deepEqual(chips.map(c => [c.name, c.sessions.length]), [["c", 1], ["a", 3], ["b", 1]]);
  assert.equal(chips[1].key, N.normPath("C:\\a"));
  // The chip's rows are its filter: the same objects, in input order.
  assert.ok(chips[1].sessions.every((s, i) => s === [rows[1], rows[3], rows[4]][i]));
});

check("the active project leads, and keeps a chip without saved sessions", () => {
  assert.deepEqual(
    N.sessionProjects([saved("/x"), saved("/y")], "/y/").map(c => [c.name, c.sessions.length]),
    [["y", 1], ["x", 1]],
  );
  assert.deepEqual(N.sessionProjects([saved("/x")], "/new").map(c => [c.name, c.sessions.length]), [["new", 0], ["x", 1]]);
});

check("POSIX folders differing only in case stay separate chips", () => {
  assert.equal(N.sessionProjects([saved("/Home/x"), saved("/home/x")], null).length, 2);
});

check("sessions without a cwd share one chip named by the backend", () => {
  const chips = N.sessionProjects([saved(""), saved(undefined)], null);
  assert.deepEqual(chips.map(c => [c.key, c.name, c.sessions.length]), [["", "Default", 2]]);
});

check("only same-named chips carry their parent folder", () => {
  const chips = N.sessionProjects([saved("/w/app"), saved("/v/app"), saved("/w/lib")], null);
  assert.deepEqual(chips.map(c => c.parent), ["w", "v", ""]);
});

// ── tabLayout / restoreSpec (reopen tabs on relaunch, #17) ───────────────

check("tabLayout keeps tab order and points at the active tab", () => {
  const tabs = [
    tab("a", "/a", { sessionFile: "/s/a.jsonl", name: "Fix login" }),
    tab("b", "", { profile: "work", sessionFile: null }),
  ];
  assert.deepEqual(N.tabLayout(tabs, "b"), {
    tabs: [
      { path: "/a", profile: "default", sessionFile: "/s/a.jsonl", name: "Fix login" },
      { path: "", profile: "work", sessionFile: null, name: "b" },
    ],
    active: 1,
  });
});

check("tabLayout has no active index without an active tab", () => {
  assert.equal(N.tabLayout([tab("a", "/a")], null).active, null);
  assert.equal(N.tabLayout([tab("a", "/a")], "closed").active, null);
});

check("tabLayout is insensitive to per-tab state that a relaunch cannot restore", () => {
  const idle = tab("a", "/a", { branch: "main", runState: "idle" });
  const busy = tab("a", "/a", { branch: "dev", runState: "running" });
  assert.equal(JSON.stringify(N.tabLayout([idle], "a")), JSON.stringify(N.tabLayout([busy], "a")));
});

check("restoreSpec resumes a conversation under its saved label", () => {
  const spec = N.restoreSpec({ path: "/a", profile: "work", sessionFile: "/s/a.jsonl", name: "Fix login" });
  assert.deepEqual(spec, { cwd: "/a", resume: "/s/a.jsonl", name: "Fix login", profile: "work" });
});

check("restoreSpec leaves an unlabeled conversation's name to the spawn's fallback", () => {
  assert.equal(N.restoreSpec({ path: "/a", sessionFile: "/s/a.jsonl", name: null }).name, null);
});

check("restoreSpec opens a fresh, unnamed tab on the folder when there is no conversation", () => {
  const spec = N.restoreSpec({ path: "/a", profile: null, sessionFile: null, name: "Old title" });
  assert.deepEqual(spec, { cwd: "/a", resume: null, name: null, profile: "default" });
});

console.log(`project-nav: ${passed} checks passed`);

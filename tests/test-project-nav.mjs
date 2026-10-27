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
const isolated = (id, path, source, extra = {}) => tab(id, path, {
  workspace: { projectPath: source, baseRef: "refs/heads/main", worktree: true },
  ...extra,
});

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

// ── projectPath / normalizeWorkspaces ─────────────────────────────────────

check("projectPath selects the source without changing cwd or pathless tabs", () => {
  const worktree = isolated("a", "/worktrees/a", "/projects/repo");
  assert.equal(N.projectPath(worktree), "/projects/repo");
  assert.equal(worktree.path, "/worktrees/a");
  assert.equal(N.projectPath(tab("b", "/projects/repo")), "/projects/repo");
  assert.equal(N.projectPath(isolated("c", "", "/projects/repo")), "");
});

check("normalization follows legacy chains and clones only changed objects", () => {
  const tabs = [
    isolated("leaf", "/worktrees/leaf", "/worktrees/middle", { name: "leaf", sessionFile: "/s/leaf.jsonl" }),
    isolated("middle", "/worktrees/middle", "/projects/repo", { name: "middle" }),
    tab("source", "/projects/repo", { name: "repo" }),
    isolated("manual", "/worktrees/manual", "/worktrees/middle", { name: "Fix login" }),
  ];
  const normalized = N.normalizeWorkspaces(tabs);
  assert.notStrictEqual(normalized, tabs);
  assert.notStrictEqual(normalized[0], tabs[0]);
  assert.notStrictEqual(normalized[0].workspace, tabs[0].workspace);
  assert.equal(normalized[0].workspace.projectPath, "/projects/repo");
  assert.equal(normalized[0].workspace.baseRef, "refs/heads/main");
  assert.equal(normalized[0].path, "/worktrees/leaf");
  assert.equal(normalized[0].sessionFile, "/s/leaf.jsonl");
  assert.equal(normalized[0].name, "repo");
  assert.equal(normalized[1].name, "repo");
  assert.strictEqual(normalized[1].workspace, tabs[1].workspace);
  assert.strictEqual(normalized[2], tabs[2]);
  assert.equal(normalized[3].name, "Fix login");
  assert.equal(normalized[3].workspace.projectPath, "/projects/repo");
  assert.equal(tabs[0].workspace.projectPath, "/worktrees/middle");
  assert.strictEqual(N.normalizeWorkspaces(normalized), normalized);
});

check("legacy origin basenames are normalized but custom titles survive", () => {
  const middle = isolated("middle", "/wt/middle", "/src/repo", { name: "custom" });
  const tabs = [
    middle,
    isolated("a", "/wt/a", "/wt/middle", { name: "middle" }),
    isolated("b", "/wt/b", "/wt/middle", { name: "My middle investigation" }),
  ];
  const normalized = N.normalizeWorkspaces(tabs);
  assert.equal(normalized[1].name, "repo");
  assert.equal(normalized[2].name, "My middle investigation");
  assert.strictEqual(normalized[0], middle);
  assert.strictEqual(N.normalizeWorkspaces([middle])[0], middle);
});

check("cycles and self-bindings are stable without inventing a source", () => {
  const tabs = [
    isolated("a", "/wt/a", "/wt/b", { name: "a" }),
    isolated("b", "/wt/b", "/wt/a", { name: "b" }),
    isolated("c", "/wt/c", "/wt/a", { name: "c" }),
    isolated("self", "/src/repo", "/src/repo", { name: "repo" }),
  ];
  assert.strictEqual(N.normalizeWorkspaces(tabs), tabs);
  assert.deepEqual(tabs.map(t => t.workspace.projectPath), ["/wt/b", "/wt/a", "/wt/a", "/src/repo"]);
});

check("legacy links compare Windows paths and prefer the matching profile", () => {
  const tabs = [
    isolated("default-middle", "C:\\WT\\Middle", "C:\\Projects\\Default", { name: "Default" }),
    isolated("work-middle", "c:/wt/middle/", "C:\\Projects\\Work", { profile: "work", name: "Work" }),
    isolated("work-leaf", "C:\\WT\\Leaf", "c:/WT/MIDDLE", { profile: "work", name: "Leaf" }),
  ];
  const normalized = N.normalizeWorkspaces(tabs);
  assert.equal(normalized[2].workspace.projectPath, "C:\\Projects\\Work");
  assert.equal(normalized[2].name, "Work");
  assert.equal(N.groupKey(normalized[1]), N.groupKey(normalized[2]));
  assert.notEqual(N.groupKey(normalized[0]), N.groupKey(normalized[2]));
});

check("already-normalized and pathless workspaces preserve array identity", () => {
  const tabs = [
    isolated("a", "/worktrees/a", "/src/repo", { name: "repo" }),
    isolated("b", "", "/src/repo", { name: "resumed" }),
    tab("c", "/src/repo", { name: "repo" }),
  ];
  assert.strictEqual(N.normalizeWorkspaces(tabs), tabs);
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

check("worktree conversations group by source project and profile", () => {
  const tabs = [
    isolated("a", "/worktrees/a", "/projects/repo", { name: "a" }),
    tab("other", "/other"),
    isolated("b", "/worktrees/b", "/projects/repo", { name: "Fix login" }),
    isolated("work", "/worktrees/c", "/projects/repo", { profile: "work" }),
    tab("source", "/projects/repo"),
    isolated("pathless", "", "/projects/repo"),
  ];
  const groups = N.groupTabs(tabs);
  assert.deepEqual(groups.map(g => g.path), ["/projects/repo", "/other", "/projects/repo", null]);
  assert.equal(groups[0].name, "repo");
  assert.deepEqual(groups[0].tabs.map(t => t.id), ["a", "b", "source"]);
  assert.equal(N.groupKey(tabs[0]), N.groupKey(tabs[2]));
  assert.notEqual(N.groupKey(tabs[0]), N.groupKey(tabs[3]));
  assert.equal(groups[0].tabs[0].path, "/worktrees/a");
});

check("legacy chains group with their source even if the source tab comes last", () => {
  const tabs = [
    isolated("leaf", "/wt/leaf", "/wt/middle"),
    isolated("middle", "/wt/middle", "/src/repo"),
    tab("source", "/src/repo"),
  ];
  const groups = N.groupTabs(tabs);
  assert.equal(groups.length, 1);
  assert.equal(groups[0].path, "/src/repo");
  assert.deepEqual(groups[0].tabs.map(t => t.id), ["leaf", "middle", "source"]);
});

// ── groupRunState / groupTarget ───────────────────────────────────────────

check("run state priority is failed > waiting-user > retrying > running > background > idle", () => {
  const states = ["idle", "background", "running", "retrying", "waiting-user", "failed"];
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

check("membersNewestFirst lists the newest-opened member first, without reordering the group", () => {
  const [group] = N.groupTabs([tab("a", "/p"), tab("b", "/p"), tab("c", "/p")]);
  assert.deepEqual(N.membersNewestFirst(group).map(t => t.id), ["c", "b", "a"]);
  assert.deepEqual(group.tabs.map(t => t.id), ["a", "b", "c"]);
  // The top row is what a click on the chip selects when no member is active.
  assert.equal(N.membersNewestFirst(group)[0].id, N.groupTarget(group, "elsewhere"));
});

// ── moveGroup / moveMember / shiftGroup (reorder, #40) ────────────────────

const ids = list => list.map(t => t.id);
// Registry with project /p split by /q's tab: a1 q a2 r.
const split = () => [tab("a1", "/p"), tab("q", "/q"), tab("a2", "/p"), tab("r", "/r")];
const keyOf = id => N.groupKey(split().find(t => t.id === id));

check("moveGroup moves a whole project, members contiguous and in order", () => {
  // Tab bar shows [p q r]; p goes behind r.
  assert.deepEqual(N.moveGroup(split(), keyOf("a1"), keyOf("r"), true), ["q", "r", "a1", "a2"]);
  // r goes in front of q.
  assert.deepEqual(N.moveGroup(split(), keyOf("r"), keyOf("q"), false), ["a1", "a2", "r", "q"]);
});

check("moveGroup reports a drop next to itself, or an unknown project, as no change", () => {
  const tabs = [tab("a", "/p"), tab("b", "/q")];
  const [p, q] = tabs.map(N.groupKey);
  assert.equal(N.moveGroup(tabs, p, p, false), null);
  assert.equal(N.moveGroup(tabs, p, q, false), null);
  assert.equal(N.moveGroup(tabs, p, "missing", false), null);
  assert.equal(N.moveGroup(tabs, "missing", q, true), null);
});

check("moveGroup's result renders the moved project where it was dropped", () => {
  const order = N.moveGroup(split(), keyOf("r"), keyOf("a1"), false);
  const byId = new Map(split().map(t => [t.id, t]));
  assert.deepEqual(N.groupTabs(order.map(id => byId.get(id))).map(g => g.key), [keyOf("r"), keyOf("a1"), keyOf("q")]);
});

check("moveMember reorders within a project and keeps the others in place", () => {
  assert.deepEqual(N.moveMember(split(), "a2", "a1", false), ["a2", "a1", "q", "r"]);
  assert.deepEqual(N.moveMember(split(), "a1", "a2", true), ["a2", "a1", "q", "r"]);
});

check("moveMember never moves a tab into another project", () => {
  assert.equal(N.moveMember(split(), "a1", "q", false), null);
  assert.equal(N.moveMember(split(), "a1", "missing", false), null);
  assert.equal(N.moveMember(split(), "a1", "a1", true), null);
});

check("a newest-first drop above a row is a registry move behind it", () => {
  // Dropdown shows [c b a]; dropping a above c must list [a c b].
  const tabs = [tab("a", "/p"), tab("b", "/p"), tab("c", "/p")];
  const order = N.moveMember(tabs, "a", "c", true);
  const byId = new Map(tabs.map(t => [t.id, t]));
  const [group] = N.groupTabs(order.map(id => byId.get(id)));
  assert.deepEqual(ids(N.membersNewestFirst(group)), ["a", "c", "b"]);
});

check("shiftGroup swaps with the neighbouring project and stops at either end", () => {
  assert.deepEqual(N.shiftGroup(split(), keyOf("q"), -1), ["q", "a1", "a2", "r"]);
  assert.deepEqual(N.shiftGroup(split(), keyOf("q"), 1), ["a1", "a2", "r", "q"]);
  assert.equal(N.shiftGroup(split(), keyOf("a1"), -1), null);
  assert.equal(N.shiftGroup(split(), keyOf("r"), 1), null);
  assert.equal(N.shiftGroup(split(), "missing", 1), null);
});

check("reordering moves source projects and worktree members together", () => {
  const tabs = [
    isolated("a", "/wt/a", "/wt/middle"),
    tab("other", "/other"),
    isolated("middle", "/wt/middle", "/src/repo"),
    isolated("work", "/wt/work", "/src/repo", { profile: "work" }),
  ];
  const legacyKey = N.groupKey(tabs[0]);
  const otherKey = N.groupKey(tabs[1]);
  assert.deepEqual(N.moveGroup(tabs, legacyKey, otherKey, true), ["other", "a", "middle", "work"]);
  assert.deepEqual(N.shiftGroup(tabs, legacyKey, 1), ["other", "a", "middle", "work"]);
  assert.deepEqual(N.moveMember(tabs, "a", "middle", true), ["middle", "a", "other", "work"]);
  assert.equal(N.moveMember(tabs, "a", "work", true), null);
});

check("isReorderOf accepts only the open tabs, each once", () => {
  const open = ["a", "b", "c"];
  assert.equal(N.isReorderOf(["c", "a", "b"], open), true);
  // A snapshot from before a tab closed, or before one opened.
  assert.equal(N.isReorderOf(["c", "a", "b", "d"], open), false);
  assert.equal(N.isReorderOf(["c", "a"], open), false);
  // Same length, but a duplicate would drop "b" from the registry.
  assert.equal(N.isReorderOf(["a", "a", "c"], open), false);
  assert.equal(N.isReorderOf(["a", "x", "c"], open), false);
});

// ── tabLabel ──────────────────────────────────────────────────────────────

check("tabLabel prefixes a renamed tab with its project folder", () => {
  assert.deepEqual(N.tabLabel(tab("a", "/home/me/omp-desktop", { name: "fix tab close" })),
    { prefix: "omp-desktop", title: "fix tab close" });
  assert.equal(N.tabLabel(tab("a", "C:\\Repo\\", { name: "x" })).prefix, "Repo");
});

check("tabLabel has no prefix while the title is the folder name, or without a folder", () => {
  assert.equal(N.tabLabel(tab("a", "/home/me/omp-desktop", { name: "omp-desktop" })).prefix, null);
  assert.equal(N.tabLabel(tab("a", "", { name: "resumed" })).prefix, null);
  assert.equal(N.tabLabel(tab("a", null, { name: "new session" })).prefix, null);
  // A fresh tab is named `basename(path)` (live.js `_tabNameFor`), also for
  // a drive root or a trailing separator, which a split-and-pop would not.
  for (const p of ["C:\\", "C:\\Repo\\", "/x/"]) {
    assert.equal(N.tabLabel(tab("a", p, { name: N.basename(p) })).prefix, null, p);
  }
});

check("source project labels hide generated worktree names, not conversation titles", () => {
  const fresh = isolated("a", "/worktrees/generated", "/projects/repo", { name: "generated" });
  const titled = isolated("b", "/worktrees/another", "/projects/repo", { name: "Investigate login" });
  assert.deepEqual(N.tabLabel(fresh), { prefix: null, title: "repo" });
  assert.deepEqual(N.tabLabel(titled), { prefix: "repo", title: "Investigate login" });
  assert.deepEqual(N.tabLabel({ ...fresh, name: null }), { prefix: null, title: "repo" });
  assert.equal(N.memberLabel(fresh), "New conversation");
  assert.equal(N.memberLabel({ ...fresh, name: "repo" }), "New conversation");
  assert.equal(N.memberLabel({ ...fresh, name: "" }), "New conversation");
  assert.equal(N.memberLabel(titled), "Investigate login");
  assert.equal(N.memberLabel(tab("pathless", "", { name: "resumed" })), "resumed");
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

check("project focus resolves legacy worktrees by source and profile", () => {
  const tabs = [
    isolated("leaf", "/wt/leaf", "/wt/middle"),
    isolated("middle", "/wt/middle", "/src/repo"),
    isolated("work", "/wt/work", "/src/repo", { profile: "work" }),
  ];
  assert.equal(N.findProjectTab(tabs, "/src/repo", "default", "leaf"), "leaf");
  assert.equal(N.findProjectTab(tabs, "/src/repo", "default", "work"), "middle");
  assert.equal(N.findProjectTab(tabs, "/src/repo", "work", "leaf"), "work");
  assert.equal(N.findConversationTab([isolated("resume", "/wt/a", "/src/repo", { sessionFile: "/s/a" })], "/s/a", "default"), "resume");
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

check("recents exclude source projects with worktrees only in the same profile", () => {
  const tabs = [
    isolated("leaf", "/wt/leaf", "/wt/middle"),
    isolated("middle", "/wt/middle", "/src/repo"),
    isolated("work", "/wt/work", "/src/work", { profile: "work" }),
  ];
  const recents = [{ path: "/src/repo" }, { path: "/src/work" }, { path: "/wt/leaf" }];
  assert.deepEqual(N.recentRows(recents, tabs, "default").map(r => r.path), ["/src/work"]);
  assert.deepEqual(N.recentRows(recents, tabs, "work").map(r => r.path), ["/src/repo", "/wt/leaf"]);
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

check("worktree restore keeps the execution folder and never requests creation again", () => {
  const workspace = { projectPath: "/source", baseRef: "refs/heads/main", baseCommit: "a".repeat(40), worktree: true };
  const layout = N.tabLayout([tab("isolated", "/worktrees/feature", { workspace, sessionFile: "/s/feature.jsonl" })], "isolated");
  const reopened = N.restoreSpec(JSON.parse(JSON.stringify(layout)).tabs[0]);
  assert.equal(reopened.cwd, "/worktrees/feature");
  assert.equal(reopened.workspaceBinding.projectPath, "/source");
  assert.equal(reopened.workspaceBinding.worktree, true);
  assert.equal(reopened.resume, "/s/feature.jsonl");
  assert.equal(Object.hasOwn(reopened, "workspace"), false, "restoration must not prepare a second worktree");
});

check("normalized legacy worktrees restore their own cwd, profile, title and session", () => {
  const tabs = N.normalizeWorkspaces([
    isolated("leaf", "/wt/leaf", "/wt/middle", {
      profile: "work", name: "Saved title", sessionFile: "/s/leaf.jsonl",
    }),
    isolated("middle", "/wt/middle", "/src/repo", { profile: "work" }),
  ]);
  const layout = JSON.parse(JSON.stringify(N.tabLayout(tabs, "leaf")));
  const spec = N.restoreSpec(layout.tabs[0]);
  assert.equal(layout.active, 0);
  assert.equal(spec.cwd, "/wt/leaf");
  assert.equal(spec.resume, "/s/leaf.jsonl");
  assert.equal(spec.profile, "work");
  assert.equal(spec.name, "Saved title");
  assert.equal(spec.workspaceBinding.projectPath, "/src/repo");
  assert.equal(spec.workspaceBinding.worktree, true);
});

console.log(`project-nav: ${passed} checks passed`);

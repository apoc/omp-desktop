// Project navigation (issue #27): pure grouping/lookup helpers over the
// tab list, shared by the grouped tab bar, the project sidebar and live.js,
// plus the open-tab layout live.js persists and restores (issue #17).
//
// Exposes `window.OMP_PROJECT_NAV`; wrapped as an IIFE per the project rule
// for plain <script> tags (see AGENTS.md "IIFE rule").
//
// A "tab" is a snapshot `sessions` entry: `{id, name, path, profile, color,
// runState, sessionFile, workspace}`. A project is identified by its profile
// and source folder, while `path` remains the conversation's actual cwd.
// Pathless tabs (a resumed session with no recorded cwd) never group.
(function () {
  const { DEFAULT_PROFILE_ID } = window; // app/constants.js
  const RUN_STATE_RANK = { idle: 0, background: 1, running: 2, retrying: 3, "waiting-user": 4, failed: 5 };

  /** Comparable form of a folder path: forward slashes, no trailing slash
   *  (a bare `/` stays), and lowercased only for Windows drive/UNC paths —
   *  NTFS is case-insensitive, POSIX file systems are not. */
  function normPath(p) {
    let s = (p || "").replace(/\\/g, "/");
    const stripped = s.replace(/\/+$/, "");
    s = stripped || (s.startsWith("/") ? "/" : "");
    if (/^[a-z]:(\/|$)/i.test(s) || s.startsWith("//")) s = s.toLowerCase();
    return s;
  }

  /** Last path segment in its original case; `p` itself when there is none. */
  function basename(p) {
    const parts = (p || "").split(/[\\/]/).filter(Boolean);
    return parts.length ? parts[parts.length - 1] : p;
  }

  /** Name of the folder containing `p` ("devel" for ~/devel/x), or "" when
   *  `p` has no parent segment (a root-level folder, a bare drive). */
  function parentName(p) {
    const parts = (p || "").split(/[\\/]/).filter(Boolean);
    return parts.length > 1 ? parts[parts.length - 2] : "";
  }

  /** Source project for a tab, without changing its execution folder. */
  function projectPath(tab) {
    return tab.path ? (tab.workspace?.projectPath || tab.path) : tab.path;
  }

  /** Collapse legacy worktree-to-worktree bindings to their source project.
   *  Cyclic bindings are left alone because none identifies a source. The
   *  input array, tabs and workspace objects are reused wherever unchanged. */
  function normalizeWorkspaces(tabs) {
    const links = new Map();
    for (const tab of tabs) {
      const origin = tab.workspace?.projectPath;
      if (!tab.path || !origin || normPath(tab.path) === normPath(origin)) continue;
      const key = normPath(tab.path);
      if (!links.has(key)) links.set(key, []);
      links.get(key).push(tab);
    }

    let result = tabs;
    tabs.forEach((tab, i) => {
      const origin = tab.workspace?.projectPath;
      if (!tab.path || !origin) return;
      let source = origin;
      const actual = normPath(tab.path);
      const seen = new Set([actual]);
      let cyclic = false;
      while (normPath(source) !== actual || seen.size > 1) {
        const key = normPath(source);
        if (seen.has(key)) {
          cyclic = true;
          break;
        }
        seen.add(key);
        const candidates = links.get(key);
        if (!candidates) break;
        const next = candidates.find(t => t.profile === tab.profile) || candidates[0];
        source = next.workspace.projectPath;
      }
      if (cyclic) return;
      const changedPath = normPath(source) !== normPath(origin);
      const sourceName = basename(source);
      const defaultName = tab.name && (tab.name === basename(tab.path) || tab.name === basename(origin));
      const changedName = defaultName && sourceName && tab.name !== sourceName;
      if (!changedPath && !changedName) return;
      if (result === tabs) result = tabs.slice();
      result[i] = {
        ...tab,
        ...(changedName ? { name: sourceName } : {}),
        ...(changedPath ? { workspace: { ...tab.workspace, projectPath: source } } : {}),
      };
    });
    return result;
  }

  /** Conversation name in a project member list, distinct from its folder. */
  function memberLabel(tab) {
    const name = tab.name;
    if (!name || (tab.path && (name === basename(tab.path) || name === basename(projectPath(tab))))) {
      return "New conversation";
    }
    return name;
  }

  function groupKey(tab) {
    const path = projectPath(tab);
    return path ? `${tab.profile}|${normPath(path)}` : `tab:${tab.id}`;
  }

  /** Tabs grouped by project, groups in order of their first member, members
   *  in input order: `[{ key, path, profile, name, tabs }]`. */
  function groupTabs(tabs) {
    const groups = new Map();
    for (const tab of normalizeWorkspaces(tabs)) {
      const path = projectPath(tab);
      const key = groupKey(tab);
      let group = groups.get(key);
      if (!group) {
        group = {
          key,
          path: path || null,
          profile: tab.profile,
          name: path ? basename(path) : tab.name,
          tabs: [],
        };
        groups.set(key, group);
      }
      group.tabs.push(tab);
    }
    return [...groups.values()];
  }

  /** The most urgent member state: failed > waiting-user > retrying >
   *  running > background > idle. */
  function groupRunState(tabs) {
    let best = "idle";
    for (const tab of tabs) {
      const state = tab.runState || "idle";
      if ((RUN_STATE_RANK[state] ?? 0) > RUN_STATE_RANK[best]) best = state;
    }
    return best;
  }

  /** Tab a click on the whole group activates: the active tab when it is a
   *  member, else the last member — the newest opened, unless a drag (#40)
   *  put another there; either way the first row of `membersNewestFirst`. */
  function groupTarget(group, activeId) {
    return group.tabs.some(t => t.id === activeId)
      ? activeId
      : group.tabs[group.tabs.length - 1].id;
  }

  /** A group's members as listed in the chip dropdown and the sidebar:
   *  registry order reversed, so a newly opened conversation comes first
   *  (#38) until a drag reorders them (#40). A copy: `group.tabs` keeps
   *  registry order, which `groupTarget` reads. */
  function membersNewestFirst(group) {
    return [...group.tabs].reverse();
  }

  /** Ids of `groups` flattened in order, each group's members contiguous.
   *  `null` when that equals `tabs`' own order: nothing to write back. */
  function changedOrder(tabs, groups) {
    const ids = groups.flatMap(g => g.tabs.map(t => t.id));
    return ids.every((id, i) => id === tabs[i].id) ? null : ids;
  }

  // A caller may still hold a key from before legacy bindings were collapsed.
  function resolvedGroupKey(tabs, groups, key) {
    if (groups.some(g => g.key === key)) return key;
    const tab = tabs.find(t => groupKey(t) === key);
    return groups.find(g => g.tabs.some(t => t.id === tab?.id))?.key || key;
  }

  /** Tab ids in the order that puts project `key` before (or, with `after`,
   *  behind) project `targetKey` in the tab bar (#40). Every group comes
   *  out contiguous, which `groupTabs` renders the same as before. `null`
   *  for an unknown key or when the order would not change. */
  function moveGroup(tabs, key, targetKey, after) {
    const groups = groupTabs(tabs);
    key = resolvedGroupKey(tabs, groups, key);
    targetKey = resolvedGroupKey(tabs, groups, targetKey);
    if (key === targetKey) return null;
    const from = groups.findIndex(g => g.key === key);
    if (from < 0 || !groups.some(g => g.key === targetKey)) return null;
    const [moved] = groups.splice(from, 1);
    const to = groups.findIndex(g => g.key === targetKey) + (after ? 1 : 0);
    groups.splice(to, 0, moved);
    return changedOrder(tabs, groups);
  }

  /** Tab ids in the order that puts tab `id` before (or, with `after`,
   *  behind) tab `targetId` of the same project, in registry order — the
   *  newest-first lists (`membersNewestFirst`) show it reversed (#40).
   *  `null` for unknown ids, tabs of different projects, or no change. */
  function moveMember(tabs, id, targetId, after) {
    if (id === targetId) return null;
    const groups = groupTabs(tabs);
    const group = groups.find(g => g.tabs.some(t => t.id === id));
    if (!group || !group.tabs.some(t => t.id === targetId)) return null;
    const members = group.tabs.filter(t => t.id !== id);
    const to = members.findIndex(t => t.id === targetId) + (after ? 1 : 0);
    members.splice(to, 0, group.tabs.find(t => t.id === id));
    group.tabs = members;
    return changedOrder(tabs, groups);
  }

  /** Tab ids with project `key` swapped one place left (`delta` -1) or right
   *  (+1) in the tab bar, for the keyboard move (#40); `null` at either end. */
  function shiftGroup(tabs, key, delta) {
    const groups = groupTabs(tabs);
    key = resolvedGroupKey(tabs, groups, key);
    const neighbour = groups[groups.findIndex(g => g.key === key) + delta];
    if (!neighbour || !groups.some(g => g.key === key)) return null;
    return moveGroup(tabs, key, neighbour.key, delta > 0);
  }

  /** Whether `ids` is exactly the open tabs `openIds` in some order — each
   *  once, none missing or extra — i.e. a reorder `reorderTabs` may apply.
   *  A snapshot taken before a tab opened or closed is not. */
  function isReorderOf(ids, openIds) {
    const open = new Set(openIds);
    return ids.length === open.size && new Set(ids).size === ids.length && ids.every(id => open.has(id));
  }

  /** Label of a tab shown on its own, not inside a group (#46). */
  function tabLabel(tab) {
    const folder = projectPath(tab) ? basename(projectPath(tab)) : "";
    const generated = tab.path && (tab.name === basename(tab.path) || tab.name === folder);
    const title = generated || (!tab.name && folder) ? folder : tab.name;
    return { prefix: folder && folder !== title ? folder : null, title };
  }

  /** Id of an open tab on `path` under `profile` — the active one if it
   *  qualifies, else the last — or `null`. */
  function findProjectTab(tabs, path, profile, activeId) {
    if (!path) return null;
    const want = normPath(path);
    const normalized = normalizeWorkspaces(tabs);
    const sourceMatches = normalized.filter(t =>
      projectPath(t) && t.profile === profile && normPath(projectPath(t)) === want);
    const matches = sourceMatches.length ? sourceMatches : normalized.filter(t =>
      t.path && t.profile === profile && normPath(t.path) === want);
    if (!matches.length) return null;
    return matches.some(t => t.id === activeId) ? activeId : matches[matches.length - 1].id;
  }

  /** Id of the first open tab already running conversation `sessionFile`
   *  under `profile`, or `null`. */
  function findConversationTab(tabs, sessionFile, profile) {
    if (!sessionFile) return null;
    const want = normPath(sessionFile);
    const hit = tabs.find(t => t.sessionFile && t.profile === profile && normPath(t.sessionFile) === want);
    return hit ? hit.id : null;
  }

  /** `recents` minus projects already open under `profile`. */
  function recentRows(recents, tabs, profile) {
    const open = new Set();
    for (const tab of normalizeWorkspaces(tabs)) {
      if (tab.profile !== profile) continue;
      if (projectPath(tab)) open.add(normPath(projectPath(tab)));
      if (tab.path) open.add(normPath(tab.path));
    }
    return recents.filter(r => !r.path || !open.has(normPath(r.path)));
  }

  /** History-panel filter chips (issue #35): one per distinct folder among
   *  `sessions` (saved-session rows, one profile's, newest first),
   *  `[{ key, path, name, parent, sessions }]`, `key` being the folder's
   *  `normPath` — "" for sessions with no recorded cwd, named after their
   *  `project_name` — and `sessions` its rows in input order, so the chip's
   *  count and its filter are one grouping. `activeCwd`'s project leads even
   *  without a saved session; the rest follow their newest session. `parent`
   *  is set only when another chip has the same name; it is one level up, so
   *  two folders whose parents share a name too still look alike — the chip's
   *  tooltip has the full path. */
  function sessionProjects(sessions, activeCwd) {
    const projects = new Map();
    const projectOf = (path, fallbackName = "") => {
      const key = normPath(path);
      let project = projects.get(key);
      if (!project) {
        project = { key, path, name: path ? basename(path) : fallbackName, parent: "", sessions: [] };
        projects.set(key, project);
      }
      return project;
    };
    if (activeCwd) projectOf(activeCwd);
    for (const s of sessions) projectOf(s.cwd || "", s.project_name || "").sessions.push(s);
    const list = [...projects.values()];
    const nameCounts = new Map();
    for (const p of list) nameCounts.set(p.name, (nameCounts.get(p.name) || 0) + 1);
    for (const p of list) if (nameCounts.get(p.name) > 1) p.parent = parentName(p.path);
    return list;
  }

  /** What a relaunch needs to reopen `tabs` (issue #17), in tab order: each
   *  tab's folder, profile, conversation file and label, plus the index of
   *  the active tab (`null` when none is). The shape `open_tabs_save`
   *  takes; equal tab sets yield equal JSON, so it doubles as the change key. */
  function tabLayout(tabs, activeId) {
    const active = tabs.findIndex(t => t.id === activeId);
    return {
      tabs: tabs.map(t => ({
        path: t.path || "",
        profile: t.profile ?? null,
        sessionFile: t.sessionFile || null,
        name: t.name || null,
        ...(t.workspace ? { workspace: t.workspace } : {}),
      })),
      active: active < 0 ? null : active,
    };
  }

  /** `_startProjectSession` arguments reopening saved tab `tab`: a
   *  conversation resumes under its saved label; a tab without one is a
   *  fresh tab on its folder, unnamed (a saved label would be the title of
   *  a conversation no longer there). Fallback names and styling are
   *  `_startProjectSession`'s, as for any other open. */
  function restoreSpec(tab) {
    const resume = tab.sessionFile || null;
    return {
      cwd: tab.path || "",
      resume,
      name: (resume && tab.name) || null,
      // No saved profile is the built-in one: the tab must record the
      // profile its process actually runs under.
      profile: tab.profile || DEFAULT_PROFILE_ID,
      ...(tab.workspace ? { workspaceBinding: tab.workspace } : {}),
    };
  }

  window.OMP_PROJECT_NAV = {
    normPath,
    basename,
    parentName,
    projectPath,
    normalizeWorkspaces,
    memberLabel,
    groupKey,
    groupTabs,
    groupRunState,
    groupTarget,
    membersNewestFirst,
    moveGroup,
    moveMember,
    shiftGroup,
    isReorderOf,
    tabLabel,
    findProjectTab,
    findConversationTab,
    recentRows,
    sessionProjects,
    tabLayout,
    restoreSpec,
  };
})();

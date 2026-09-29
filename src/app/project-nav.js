// Project navigation (issue #27): pure grouping/lookup helpers over the
// tab list, shared by the grouped tab bar, the project sidebar and live.js.
//
// Exposes `window.OMP_PROJECT_NAV`; wrapped as an IIFE per the project rule
// for plain <script> tags (see CLAUDE.md "IIFE rule").
//
// A "tab" is a snapshot `sessions` entry: `{id, name, path, profile, color,
// runState, sessionFile}`. A project is identified by (profile, folder): the
// same folder opened under two profiles is two projects, because each runs
// against its own omp tree. Pathless tabs (a resumed session with no
// recorded cwd) never group.
(function () {
  const RUN_STATE_RANK = { idle: 0, running: 1, "waiting-user": 2, failed: 3 };

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

  function groupKey(tab) {
    return tab.path ? `${tab.profile}|${normPath(tab.path)}` : `tab:${tab.id}`;
  }

  /** Tabs grouped by project, groups in order of their first member, members
   *  in input order: `[{ key, path, profile, name, tabs }]`. */
  function groupTabs(tabs) {
    const groups = new Map();
    for (const tab of tabs) {
      const key = groupKey(tab);
      let group = groups.get(key);
      if (!group) {
        group = {
          key,
          path: tab.path || null,
          profile: tab.profile,
          name: tab.path ? basename(tab.path) : tab.name,
          tabs: [],
        };
        groups.set(key, group);
      }
      group.tabs.push(tab);
    }
    return [...groups.values()];
  }

  /** The most urgent member state: failed > waiting-user > running > idle. */
  function groupRunState(tabs) {
    let best = "idle";
    for (const tab of tabs) {
      const state = tab.runState || "idle";
      if ((RUN_STATE_RANK[state] ?? 0) > RUN_STATE_RANK[best]) best = state;
    }
    return best;
  }

  /** Tab a click on the whole group activates: the active tab when it is a
   *  member, else the most recently opened (last) member. */
  function groupTarget(group, activeId) {
    return group.tabs.some(t => t.id === activeId)
      ? activeId
      : group.tabs[group.tabs.length - 1].id;
  }

  /** Id of an open tab on `path` under `profile` — the active one if it
   *  qualifies, else the last — or `null`. */
  function findProjectTab(tabs, path, profile, activeId) {
    if (!path) return null;
    const want = normPath(path);
    const matches = tabs.filter(t => t.path && t.profile === profile && normPath(t.path) === want);
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
    return recents.filter(r => findProjectTab(tabs, r.path, profile, null) === null);
  }

  window.OMP_PROJECT_NAV = {
    normPath,
    basename,
    parentName,
    groupKey,
    groupTabs,
    groupRunState,
    groupTarget,
    findProjectTab,
    findConversationTab,
    recentRows,
  };
})();

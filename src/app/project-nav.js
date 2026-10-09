// Project navigation (issue #27): pure grouping/lookup helpers over the
// tab list, shared by the grouped tab bar, the project sidebar and live.js,
// plus the open-tab layout live.js persists and restores (issue #17).
//
// Exposes `window.OMP_PROJECT_NAV`; wrapped as an IIFE per the project rule
// for plain <script> tags (see AGENTS.md "IIFE rule").
//
// A "tab" is a snapshot `sessions` entry: `{id, name, path, profile, color,
// runState, sessionFile}`. A project is identified by (profile, folder): the
// same folder opened under two profiles is two projects, because each runs
// against its own omp tree. Pathless tabs (a resumed session with no
// recorded cwd) never group.
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
   *  member, else the most recently opened (last) member. */
  function groupTarget(group, activeId) {
    return group.tabs.some(t => t.id === activeId)
      ? activeId
      : group.tabs[group.tabs.length - 1].id;
  }

  /** A group's members as listed in the chip dropdown and the sidebar,
   *  newest-opened first (#38). A copy: `group.tabs` keeps registry order,
   *  which `groupTarget` reads. */
  function membersNewestFirst(group) {
    return [...group.tabs].reverse();
  }

  /** Label of a tab shown on its own, not inside a group (#46): `title` is
   *  the tab's renameable name; `prefix` is its project folder, or `null`
   *  while the name is still that folder (a fresh tab) or there is none. */
  function tabLabel(tab) {
    const folder = tab.path ? basename(tab.path) : "";
    return { prefix: folder && folder !== tab.name ? folder : null, title: tab.name };
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
    };
  }

  window.OMP_PROJECT_NAV = {
    normPath,
    basename,
    parentName,
    groupKey,
    groupTabs,
    groupRunState,
    groupTarget,
    membersNewestFirst,
    tabLabel,
    findProjectTab,
    findConversationTab,
    recentRows,
    sessionProjects,
    tabLayout,
    restoreSpec,
  };
})();

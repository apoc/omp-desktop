/* ═════════════════════════════════════════════════════════════════════
   app/slash-commands.js — the `/` palette's command list.
   Pure functions only. Two sources feed it:
     - LOCAL_COMMANDS: desktop-native entries, each with its own handler in
       app-live.jsx `handleCommand` (modals, pickers, plan mode…).
    - omp's RPC `get_available_commands` / `available_commands_update`
      (`{ name, source, aliases?, description?, input?.hint? }`, source ∈
      builtin | skill | extension | custom | file). `input.hint` (argument
      syntax) is folded into the rendered `hint` alongside `description`.
      `subcommands` isn't surfaced (would need its own nested picker) and
      is dropped rather than carried as unused data. These commands run
      inside omp: picking one inserts `/name ` into the composer and the
      sent prompt is executed by omp itself.
   ═════════════════════════════════════════════════════════════════════ */
(function () {
  const DESKTOP = "desktop";

  // Only entries app-live.jsx `handleCommand` actually implements, plus
  // `steer`/`branch` — carried over unchanged from the previous hardcoded
  // list; `handleCommand` has no case for either today so picking them is a
  // pre-existing no-op, not something this change touches. A local name
  // shadows the RPC command of the same name/alias (desktop UI wins).
  const LOCAL_COMMANDS = Object.freeze([
    { name: "plan",      hint: "draft a plan before writing code",             icon: "◇", group: "Mode"    },
    { name: "steer",     hint: "interrupt and redirect mid-tool",              icon: "↺", group: "Mode"    },
    { name: "compact",   hint: "compact context window",                       icon: "▤", group: "Session" },
    { name: "new",       hint: "start a fresh session (history kept on disk)", icon: "↺", group: "Session" },
    { name: "history",   hint: "browse and resume saved sessions",             icon: "◷", group: "Session" },
    { name: "branch",    hint: "fork the session from current head",           icon: "⑂", group: "Session" },
    { name: "model",     hint: "switch model",                                 icon: "◉", group: "Agent"   },
    { name: "thinking",  hint: "cycle thinking level",                         icon: "✶", group: "Agent"   },
    { name: "login",     hint: "authenticate with a model provider",           icon: "⊙", group: "Agent"   },
    { name: "todo",      hint: "open the kanban surface",                      icon: "▦", group: "View"    },
    { name: "export",    hint: "export this session to HTML",                  icon: "⇪", group: "View"    },
    { name: "shortcuts", hint: "view and rebind keyboard shortcuts",           icon: "⌘", group: "View"    },
    { name: "check-updates", hint: "check for OMP Desktop updates",            icon: "↑", group: "View"    },
  ].map((c) => Object.freeze({ ...c, source: DESKTOP, aliases: [] })));

  const SOURCE_STYLE = {
    builtin: { group: "Commands", icon: "›" },
    skill:   { group: "Skills",   icon: "✦" },
  };
  const CUSTOM_STYLE = { group: "Custom", icon: "◈" };

  const isDesktop = (cmd) => cmd?.source === DESKTOP;
  const strOr = (v, fallback) => (typeof v === "string" ? v : fallback);
  // Trims and strips a leading slash only — case is preserved. omp resolves
  // command/skill/file-command names case-sensitively (exact `===` against
  // the filename-derived or registered name), so lowercasing here would
  // make insertText() emit a name that no longer matches what invoked it
  // (e.g. a `fixPR.md` custom command surfacing as `/fixpr`, which omp then
  // fails to find and just sends as a literal prompt instead of running).
  const cleanName = (v) => (typeof v === "string" ? v.trim().replace(/^\/+/, "") : "");
  const lc = (v) => (typeof v === "string" ? v.toLowerCase() : "");

  // RPC `commands` array → palette entries. Tolerates anything a newer or
  // older omp might send: non-arrays, entries without a usable name, and
  // non-string aliases are dropped instead of throwing mid-render.
  function adaptAvailableCommands(raw) {
    if (!Array.isArray(raw)) return [];
    const out = [];
    for (const c of raw) {
      const name = cleanName(c?.name);
      if (!name) continue;
      const source = strOr(c.source, "custom");
      const style = SOURCE_STYLE[source] ?? CUSTOM_STYLE;
      // omp's `input.hint` is the argument syntax (e.g. "<plan|scan|status>",
      // "[model]") — folded in front of the description rather than kept as
      // a separate field, so it shows up for free everywhere `hint` already
      // renders instead of needing its own row/column. `subcommands` isn't
      // rendered anywhere (a full nested picker is real feature work, not a
      // one-line fix), so it's dropped rather than carried as dead data
      // through merge/snapshot/OMP_DATA sync. Each part's own internal
      // whitespace is collapsed to single spaces first — an MCP prompt's
      // description is the server's raw docstring verbatim, and a skill/
      // file command's YAML frontmatter can use a `|` block scalar, so
      // either can carry embedded newlines/indentation. The popup CSS
      // renders `hint` with `white-space: pre` specifically so the `  `
      // joining these two parts below survives instead of collapsing to
      // one space — collapsing each part's own whitespace first keeps
      // that the only whitespace `pre` has left to preserve.
      const norm = (s) => s.replace(/\s+/g, " ").trim();
      const inputHint = norm(strOr(c.input?.hint, ""));
      const description = norm(strOr(c.description, ""));
      out.push({
        name,
        hint:    [inputHint, description].filter(Boolean).join("  "),
        icon:    style.icon,
        group:   style.group,
        source,
        aliases: Array.isArray(c.aliases) ? c.aliases.map(cleanName).filter(Boolean) : [],
      });
    }
    return out;
  }

  // Local first, then RPC in received order. An entry is dropped when its
  // name or any alias is already claimed — typing `/models` must reach the
  // same command either way, so a partial collision is still a duplicate.
  const tokensOf = (c) => [c.name, ...(c.aliases ?? [])];

  function mergeSlashCommands(local, rpc) {
    const claimed = new Set();
    const out = [];
    for (const c of [...local, ...rpc]) {
      const tokens = tokensOf(c);
      if (tokens.some((t) => claimed.has(t))) continue;
      tokens.forEach((t) => claimed.add(t));
      out.push(c);
    }
    return out;
  }

  // Exact match on the full token (name or any alias). Tries case-exact
  // first — matching omp's own case-sensitive `===` resolution — so a
  // command that differs from another only by case (e.g. a local desktop
  // `plan` and an RPC file command `Plan`) both stay individually
  // reachable by typing their exact name. Falls back to case-insensitive
  // for everyday convenience (typing lowercase still finds `fixPR`).
  function findExact(cmds, token) {
    const exact = cmds.find((c) => tokensOf(c).includes(token));
    if (exact) return exact;
    const q = lc(token);
    return cmds.find((c) => tokensOf(c).some((t) => lc(t) === q));
  }

  // Entries for the composer's inline popup, given the full draft text.
  //  - Still typing the command token (no whitespace yet): a full
  //    name/alias match ranks first (typing the whole name and pressing
  //    Enter must reach that command, not a shorter prefix-sharing one —
  //    e.g. "skill:review" vs "skill:review-pr"), then other prefix
  //    matches, then substring matches on the name.
  //  - Arguments typed after it: only a desktop command keeps the popup
  //    (Enter runs its handler, as before). An omp command hides it so
  //    Enter sends the text and omp executes it with its arguments.
  function slashMenu(cmds, text) {
    if (typeof text !== "string" || !text.startsWith("/")) return [];
    const m = /^\/(\S*)(\s[\s\S]*)?$/.exec(text);
    const q = lc(m[1]);
    if (m[2] !== undefined) {
      const exact = findExact(cmds, m[1]);
      return exact && isDesktop(exact) ? [exact] : [];
    }
    if (!q) return [...cmds];
    const prefix = cmds.filter((c) => tokensOf(c).some((t) => lc(t).startsWith(q)));
    const exact = findExact(prefix, m[1]);
    const exactIdx = exact ? prefix.indexOf(exact) : -1;
    if (exactIdx > 0) prefix.unshift(prefix.splice(exactIdx, 1)[0]);
    const inner  = cmds.filter((c) => !prefix.includes(c) && lc(c.name).includes(q));
    return [...prefix, ...inner];
  }

  // Command-bridge (⌘K) filter: name, aliases, and description.
  function matchesQuery(cmd, q) {
    if (!q) return true;
    const needle = lc(q);
    return tokensOf(cmd).some((t) => lc(t).includes(needle)) || lc(cmd.hint).includes(needle);
  }

  const insertText = (cmd) => `/${cmd.name} `;

  // Whether `text`'s leading token is a *known* command name/alias — not
  // just "starts with /". Plan-mode prose routinely starts with an
  // absolute path or URL path ("/etc/nginx.conf is wrong"); only a real
  // command should skip plan framing or route through a different send
  // path while streaming.
  function isSlashCommand(cmds, text) {
    if (typeof text !== "string" || !text.startsWith("/")) return false;
    // Same token definition as slashMenu's own regex — one leading `/`,
    // then everything up to the first whitespace run.
    const token = /^\/(\S*)/.exec(text)[1];
    return !!findExact(cmds, token);
  }

  window.OMP_SLASH = {
    LOCAL_COMMANDS,
    isDesktop,
    adaptAvailableCommands,
    mergeSlashCommands,
    slashMenu,
    matchesQuery,
    insertText,
    isSlashCommand,
  };
})();

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
   A `/` typed after other prompt text offers skills only (#30, same rules
   as omp's editor) — see "Mid-prompt skills" below.
   ═════════════════════════════════════════════════════════════════════ */
(function () {
  const DESKTOP = "desktop";

  // Only entries app-live.jsx `handleCommand` actually implements, plus
  // `steer` — carried over unchanged from the previous hardcoded list;
  // `handleCommand` has no case for it today, so picking it is a pre-existing
  // no-op, not something this change touches. `branch` and `tree` both open
  // the conversation-tree pane. A local name shadows the RPC command of the
  // same name/alias (desktop UI wins), so omp's terminal `/branch` and
  // `/tree` pickers never run from the desktop.
  const LOCAL_COMMANDS = Object.freeze([
    { name: "plan",      hint: "draft a plan before writing code",             icon: "◇", group: "Mode"    },
    { name: "goal",      hint: "start a goal the agent works on until done",   icon: "◎", group: "Mode"    },
    { name: "steer",     hint: "interrupt and redirect mid-tool",              icon: "↺", group: "Mode"    },
    { name: "compact",   hint: "compact context window",                       icon: "▤", group: "Session" },
    { name: "new",       hint: "start a fresh session (history kept on disk)", icon: "↺", group: "Session" },
    { name: "history",   hint: "browse and resume saved sessions",             icon: "◷", group: "Session" },
    { name: "branch",    hint: "re-ask a prompt or fork, from the conversation tree", icon: "⑂", group: "Session" },
    { name: "tree",      hint: "conversation tree with prompt-cache status",   icon: "⑂", group: "Session" },
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
        // Kept on its own as well: the mid-prompt skill matcher searches
        // the description, not the argument syntax folded into `hint`.
        description,
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
  function isLeadingCommand(cmds, text) {
    if (typeof text !== "string" || !text.startsWith("/")) return false;
    // Same token definition as slashMenu's own regex — one leading `/`,
    // then everything up to the first whitespace run.
    const token = /^\/(\S*)/.exec(text)[1];
    return !!findExact(cmds, token);
  }

  // ── Mid-prompt skills (#30) ───────────────────────────────────────────
  // A `/token` after other prompt text is a skill lookup, the way omp's own
  // editor treats it (packages/tui/src/autocomplete.ts, prompt/skill-tokens.ts,
  // coding-agent/src/extensibility/skills.ts `parseSkillInvocation`). Only
  // skills are offered there — omp runs no other command mid-prompt — and
  // omp invokes the first `/skill:<name>` token, passing the prose around it
  // as the skill's arguments.

  const SKILL_NS = "skill:";

  // The `/token` the caret ends, when prompt text precedes it: a `/` at the
  // start of a line or after whitespace, then non-space, non-`/` chars up to
  // the caret (omp's `findTrailingSlashCommandStart` + `hasPromptTextBeforeSlash`).
  // A slash with nothing but whitespace before it is the leading command,
  // `slashMenu`'s job. Shaped like `parseMentionQuery`'s range so the same
  // `applyMention` splice replaces it.
  function midPromptSlashToken(text, caret) {
    if (typeof text !== "string" || typeof caret !== "number") return null;
    if (caret < 0 || caret > text.length) return null;
    const before = text.slice(0, caret);
    const m = /(?:^|\s)\/([^\s/]*)$/.exec(before);
    if (!m) return null;
    const start = m.index + m[0].indexOf("/");
    if (before.slice(0, start).trim() === "") return null;
    return { start, end: caret, query: m[1] };
  }

  // omp's ranked subsequence score (100/80/60/40−gaps·5, 0 = no match).
  function subsequenceScore(q, target) {
    if (q.length === 0) return 1;
    if (target === q) return 100;
    if (target.startsWith(q)) return 80;
    if (target.includes(q)) return 60;
    let qi = 0;
    let gaps = 0;
    let last = -1;
    for (let ti = 0; ti < target.length && qi < q.length; ti++) {
      if (q[qi] === target[ti]) {
        if (last >= 0 && ti - last > 1) gaps++;
        last = ti;
        qi++;
      }
    }
    return qi === q.length ? Math.max(1, 40 - gaps * 5) : 0;
  }

  function textMatchScore(q, target) {
    if (q.length === 0) return 1;
    if (q === target) return 1000;
    if (target.startsWith(q)) return 900;
    return subsequenceScore(q, target);
  }

  // A prefix of the bare skill name or of one of its hyphen-separated
  // segments (`hum` → humanizer, `last` → research-last30days); 1000 when
  // the query is the whole name or segment.
  function bareNameTier(q, bare) {
    if (q.length === 0) return 0;
    if (q === bare) return 1000;
    if (bare.startsWith(q)) return 900;
    let from = 0;
    for (;;) {
      const dash = bare.indexOf("-", from);
      if (dash === -1 || dash + 1 >= bare.length) return 0;
      from = dash + 1;
      if (bare.startsWith(q, from)) {
        const end = bare.indexOf("-", from);
        return q.length === (end === -1 ? bare.length : end) - from ? 1000 : 900;
      }
    }
  }

  // omp's `midPromptSkillTokenMatches`: strict enough that a stray `/word`
  // in running prose closes the popup instead of fuzzy-matching something.
  function skillTokenMatches(q, lowerName, lowerDesc) {
    if (SKILL_NS.startsWith(q)) return true;
    if (q.startsWith(SKILL_NS)) {
      return textMatchScore(q, lowerName) > 0 || (!!lowerDesc && textMatchScore(q, lowerDesc) > 0);
    }
    return bareNameTier(q, lowerName.slice(SKILL_NS.length)) > 0;
  }

  // Skills for a mid-prompt `/query`, best first. Ranked like omp: the
  // stronger of the full-name and bare-name scores, or half the description
  // subsequence score; ties keep the received order.
  function skillMenu(cmds, query) {
    const q = lc(query);
    const ranked = [];
    for (const c of cmds) {
      if (typeof c.name !== "string" || !c.name.startsWith(SKILL_NS)) continue;
      const lowerName = lc(c.name);
      const lowerDesc = lc(c.description);
      if (!skillTokenMatches(q, lowerName, lowerDesc)) continue;
      const nameScore = q.length === 0
        ? 950
        : Math.max(textMatchScore(q, lowerName), bareNameTier(q, lowerName.slice(SKILL_NS.length)));
      const descScore = lowerDesc ? subsequenceScore(q, lowerDesc) * 0.5 : 0;
      const score = Math.max(nameScore, descScore);
      if (score > 0) ranked.push({ c, score });
    }
    return ranked.sort((a, b) => b.score - a.score).map((r) => r.c);
  }

  // omp's `allowsSkillTokens` local-execution check: a draft starting with
  // `!`, or `$`/`$$` followed by whitespace or nothing, is consumed verbatim.
  function startsWithLocalExecution(t) {
    if (t.startsWith("!")) return true;
    if (!t.startsWith("$") || t[1] === "{") return false;
    const next = t[t[1] === "$" ? 2 : 1];
    return next === undefined || /[ \t\r\n]/.test(next);
  }

  const SKILL_TOKEN_RE = /(^|\s)\/skill:([^\s/]+(?:\/[^\s/]+)?)(?=\s|$)/;

  // Whether omp will invoke a skill for `text` (`parseSkillInvocation` +
  // `allowsSkillTokens`): a leading `/skill:<name>`, or else the first
  // mid-prompt `/skill:<name>` token unless the draft starts with another
  // `/command` or a local-execution sigil — and only for a skill the session
  // actually lists, matched exactly as omp does.
  function invokesSkill(cmds, text) {
    if (typeof text !== "string") return false;
    const t = text.trimStart();
    let name;
    if (t.startsWith("/skill:")) {
      name = /^\/skill:(\S*)/.exec(t)[1];
    } else {
      if (t.startsWith("/") || startsWithLocalExecution(t)) return false;
      name = SKILL_TOKEN_RE.exec(text)?.[2];
    }
    return !!name && cmds.some((c) => c.name === SKILL_NS + name);
  }

  // Whether `text` must reach omp's command dispatch — sent as an RPC
  // `prompt` even mid-stream (omp's `steer`/`follow_up` skip it) and left
  // out of plan-mode framing: a known leading command, or a skill
  // invocation anywhere in the draft.
  function isCommandInvocation(cmds, text) {
    return isLeadingCommand(cmds, text) || invokesSkill(cmds, text);
  }

  window.OMP_SLASH = {
    LOCAL_COMMANDS,
    isDesktop,
    adaptAvailableCommands,
    mergeSlashCommands,
    slashMenu,
    midPromptSlashToken,
    skillMenu,
    matchesQuery,
    insertText,
    isCommandInvocation,
  };
})();

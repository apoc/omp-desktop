// Settings page (#37): sections, groups and rows, plus the pure helpers the
// page, its tab chip and the tests share.
//
// Exposes `window.OMP_SETTINGS`; wrapped as an IIFE per the project rule for
// plain <script> tags (see AGENTS.md "IIFE rule").
//
// Two row kinds:
//   - `tweak`: one key of TWEAK_DEFAULTS (app/constants.js), rendered by the
//     page itself; `type` is toggle | seg | slider | themes | swatches.
//   - `custom`: rendered by `window.OMP_SETTINGS_ROWS[type]`
//     (design/settings/rows-*.jsx). `keys` / `keyPrefix` name the tweak keys
//     the row owns, so its changes count in the badges and the section
//     reset; Rust-backed rows (shell, chromium, profiles, approvals,
//     keybindings) own none and never count.
// `desc` is schema-authored text; `backtick` segments render as code.
// Bounds of collapseAfter / promptHistoryLimit / pasteCollapseLines and the
// fold modes come from OMP_COLLAPSE / OMP_PROMPT_HISTORY / OMP_SESSION_UI,
// read late (getters), as are OMP_ACCENT (accent comparison), OMP_KEYMAP
// (shortcut keywords) and TWEAK_DEFAULTS, so load order among the plain
// app/*.js modules does not matter.
(function () {
  const THEMES = Object.freeze([
    { id: "aurora", tone: "dark", accent: "#8AF0C8" },
    { id: "phosphor", tone: "dark", accent: "#C4FF3F" },
    { id: "daylight", tone: "light", accent: "#1F8A5B" },
  ]);
  const ACCENTS = Object.freeze(["#8AF0C8", "#6EE7FF", "#FF7AC6", "#FFC56E", "#B59BFF", "#C4FF3F"]);
  /** The accent a theme ships with; picking the theme resets to it. */
  const themeAccent = (theme) => (THEMES.find(t => t.id === theme) ?? THEMES[0]).accent;

  const defaults = () => window.TWEAK_DEFAULTS ?? {};
  const collapse = () => window.OMP_COLLAPSE;
  const history = () => window.OMP_PROMPT_HISTORY;
  const sessionUi = () => window.OMP_SESSION_UI;
  const opts = (values, labels = {}) => values.map(v => ({ value: v, label: labels[v] ?? String(v) }));
  const foldOptions = () => opts(collapse()?.MODES ?? ["auto", "open", "folded"]);

  // Descriptors, not spread: spread would read the bound getters once, now.
  const withExtra = (base, extra) => Object.defineProperties(base, Object.getOwnPropertyDescriptors(extra ?? {}));
  const tweak = (key, type, label, desc, kw, extra) => withExtra({ kind: "tweak", id: key, key, type, label, desc, kw }, extra);
  const custom = (type, label, desc, kw, extra) => withExtra({ kind: "custom", id: `custom:${type}`, type, label, desc, kw }, extra);

  const SECTIONS = [
    { id: "appearance", icon: "sparkle", title: "Appearance", blurb: "Colour theme, accent, density and text size of the whole window.", groups: [
      { name: "Theme", rows: [
        tweak("theme", "themes", "Theme", "Picking a theme also resets the accent to the theme's own.", "dark light colour color aurora phosphor daylight"),
        tweak("accent", "swatches", "Accent", "Focus rings, the active tab, links and the assistant's marks.", "color colour highlight"),
      ] },
      { name: "Text", rows: [
        tweak("density", "seg", "Density", "Row height, padding and the base text size.", "spacing compact",
          { options: opts(["cozy", "compact", "dense"]) }),
        tweak("fontSize", "slider", "Font size", "Scales all text and icons, the terminal's font included.", "zoom scale text",
          { min: 75, max: 150, step: 5, unit: "%" }),
        tweak("monoChat", "toggle", "Monospace chat", "Show messages in the monospace font instead of the UI font.", "font"),
      ] },
    ] },
    { id: "layout", icon: "grid", title: "Layout", blurb: "What sits beside the chat and how wide each column is.", groups: [
      { name: "Columns", rows: [
        tweak("layout", "seg", "Side column", "`rail` shows the widget rail, `split` opens a subagent beside the chat, `focus` shows the chat alone.", "layout rail split focus",
          { options: opts(["rail", "split", "focus"]) }),
        tweak("defaultSide", "seg", "New tabs show", "What the side column of a newly opened tab starts with. The toolbar still switches it per tab.", "conversation tree default browser",
          { options: opts(["rail", "tree", "browser"]) }),
        tweak("sidebar", "toggle", "Project sidebar", "The list of projects and their tabs on the left. `Ctrl+B` toggles it.", "projects"),
        custom("widths", "Column widths", "Drag a column edge to resize it, double-click the edge to reset one.", "width resize pane sidebar rail tree split browser",
          { keys: ["sidebarWidth", "railWidth", "treeWidth", "splitWidth", "browserWidth"] }),
      ] },
    ] },
    { id: "chat", icon: "thinking", title: "Chat", blurb: "How tool calls and thinking show up in the transcript.", groups: [
      { name: "Folding", rows: [
        tweak("foldThinking", "seg", "Thinking", "`auto` folds it once newer turns arrive, `open` and `folded` fix it.", "collapse reasoning",
          { fold: "thinking", get options() { return foldOptions(); } }),
        tweak("foldTools", "seg", "Tool output", "Same choice for tool cards. A card you toggle yourself stays that way.", "collapse cards",
          { fold: "tool", get options() { return foldOptions(); } }),
        tweak("collapseAfter", "slider", "Collapse after", "With `auto`: how many newer turns before an entry folds.", "auto fold", {
          step: 1, unit: " newer",
          // Only matters while a fold mode is auto.
          visibleIf: (values) => {
            const m = collapse()?.foldModes(values) ?? { thinking: values?.foldThinking ?? "auto", tool: values?.foldTools ?? "auto" };
            return m.thinking === "auto" || m.tool === "auto";
          },
          get min() { return collapse()?.MIN_AFTER ?? 1; },
          get max() { return collapse()?.MAX_AFTER ?? 30; },
        }),
      ] },
      { name: "Scrolling", rows: [
        tweak("followOutput", "toggle", "Follow new output", "Keep the transcript scrolled to the newest message while the agent works. Scrolling up always pauses it.", "auto scroll bottom pin"),
      ] },
    ] },
    { id: "composer", icon: "edit", title: "Composer", blurb: "Sending, pasting and recalling prompts.", groups: [
      { name: "Sending", rows: [
        tweak("submitKey", "seg", "Send with", "In the composer, an ask's answer box and a subagent's steer box; the other chord inserts a newline. One-line fields always send with Enter.", "submit newline shift enter",
          { options: opts(["enter", "ctrl+enter"]) }),
      ] },
      { name: "Pasting", rows: [
        tweak("pasteCollapseLines", "slider", "Collapse pastes longer than", "A longer paste shows as a `[paste #1 +40 lines]` chip; the agent still gets the full text.", "paste chip",
          { step: 1, unit: " lines",
            get min() { return sessionUi()?.PASTE_LINES_MIN ?? 2; },
            get max() { return sessionUi()?.PASTE_LINES_MAX ?? 50; } }),
      ] },
      { name: "History", rows: [
        tweak("promptHistoryLimit", "slider", "Prompt history", "How many of your prompts `↑` in the composer can recall, per tab.", "recall up arrow", {
          step: 10, unit: " prompts",
          get min() { return history()?.MIN_LIMIT ?? 10; },
          get max() { return history()?.MAX_LIMIT ?? 1000; },
        }),
      ] },
    ] },
    { id: "rail", icon: "radar", title: "Rail", blurb: "The cards in the rail beside the chat, including widget plugins and extension widgets.", groups: [
      { name: "Built-in cards", rows: [
        tweak("showContext", "toggle", "Context gauge", "How full the model's context window is.", "tokens"),
        tweak("showRadar", "toggle", "Agent radar", "What the agent is doing right now.", "activity"),
        tweak("showSubagents", "toggle", "Subagents", "Running and finished subagents of this tab.", "tasks"),
        tweak("showAgentContext", "toggle", "Agent context", "Native harness, loaded instructions, and skills actually used by the main agent and each subagent.", "skills harness instructions agent context provenance"),
        tweak("showChanges", "toggle", "Changes", "Show the PR for this project's current branch. Off also stops PR monitoring and turns off Auto-fix; enabling this card does not enable Auto-fix.", "github pull request pr auto fix ci checks review"),
        tweak("showMinimap", "toggle", "Minimap", "An overview of the transcript to jump around in.", "overview"),
      ] },
      { name: "Widgets", src: "widgets.json", rows: [
        custom("widgets", "Plugin config", "Plugins and their triggers. A changed script asks for approval again before it runs.", "widget plugins plugin widgets.json extension status reload",
          { keyPrefix: "widget:", prefixDefault: true }),
      ] },
    ] },
    { id: "terminal", icon: "terminal", title: "Terminal", blurb: "The shell panel under the chat. Each tab has its own shell, started in the tab's project folder.", groups: [
      { name: "Shell", src: "terminal.json", rows: [
        custom("shell", "Shell", "What new terminals run. Running ones keep their shell. `default` runs your default shell.", "powershell pwsh bash cmd"),
      ] },
      { name: "Panel", rows: [
        tweak("terminalAutoOpen", "toggle", "Open with new tab", "Show the terminal panel when a tab opens.", "auto"),
        tweak("terminalScrollback", "seg", "Scrollback", "Lines you can scroll back in each terminal. More costs memory per open shell.", "history lines buffer",
          { options: opts([1000, 5000, 10000, 50000]) }),
        custom("terminalHeight", "Height", "Shared by all tabs. Drag the panel's top edge to change it.", "size", { keys: ["terminalHeight"] }),
      ] },
    ] },
    { id: "browser", icon: "web", title: "Browser", blurb: "The Chromium panel the agent and you share in each tab.", groups: [
      { name: "Chromium", src: "browser.json", rows: [
        custom("chromium", "Browser", "Which Chromium the panel runs; panels started afterwards use it. `automatic` finds one installed on this PC.", "chrome edge chromium"),
      ] },
      { name: "Links", rows: [
        tweak("browserLocalhostInPanel", "toggle", "Open localhost links in the panel", "A click on a `localhost` link in the chat opens it here instead of your system browser.", "dev server url"),
      ] },
    ] },
    { id: "agent", icon: "agent", title: "Agent", blurb: "Which omp profile new tabs use and how omp behaves in them.", groups: [
      { name: "Profiles", src: "profiles.json", rows: [
        custom("startupProfile", "Startup profile", "The profile of the tab opened at launch and of new tabs. Profiles are created and renamed from the profile menu.", "profile account"),
      ] },
      { name: "Goals", src: "omp config", rows: [
        custom("goalContinue", "Keep working on a goal", "omp continues an active goal on its own after each turn instead of waiting for you. Costs tokens while unattended.", "goal auto continue"),
      ] },
      { name: "omp behaviour", rows: [
        tweak("autoCompaction", "toggle", "Auto-compact context", "omp summarises older turns when the context fills up. Off: you run `/compact` yourself.", "compaction context window"),
        tweak("autoRetry", "toggle", "Retry failed requests", "omp retries a request the provider refused or dropped, with a retry row you can stop.", "retry error rate limit"),
      ] },
    ] },
    { id: "session", icon: "clock", title: "Session", blurb: "Tabs across restarts, closing, naming and app updates.", groups: [
      { name: "Tabs", rows: [
        tweak("restoreTabs", "toggle", "Reopen tabs on launch", "Start with the tabs and conversations that were open when you quit.", "restore session startup"),
        tweak("confirmBusyClose", "toggle", "Ask before closing a working tab", "Closing a tab whose agent is mid-turn stops it. Ask first, also when quitting.", "confirm quit close"),
        tweak("autoName", "toggle", "Name tabs automatically", "omp titles a new conversation from its first turns (one small model call). `/rename` always wins.", "rename title"),
      ] },
      { name: "Desktop notifications", rows: [
        custom("desktopNotifications", "Desktop notifications", "Local alerts for conversations in another tab or while the app is unfocused. Both off by default. Separate from phone Web Push.", "desktop notification alert completion done finished turn user input ask question permission approval waiting attention", { keys: ["notifyFinished", "notifyQuestions"] }),
      ] },
      { name: "Updates", rows: [
        tweak("updateCheck", "toggle", "Check for updates", "Look for a new release shortly after launch and every 6 hours. You choose when to install; “Check now” works either way.", "version release"),
        custom("version", "Version", "The installed OMP Desktop and the newest release.", "version update check skipped"),
      ] },
    ] },
    { id: "remote", icon: "live", title: "Remote access", blurb: "Read your sessions, answer questions and steer the agent from a phone on your network. Off by default; nothing listens until you enable it.", groups: [
      { name: "Server", src: "remote.json", rows: [
        custom("remoteServer", "Server", "The interface, port and name the phone connects to. The server only listens on the chosen interface.", "remote phone mobile server interface port host name https lan vpn"),
        custom("remoteCert", "Certificate", "A generated certificate is self-signed; your own files (for example for `omp.home.lan`) let the phone trust the page.", "tls https certificate fingerprint pem key"),
      ] },
      { name: "Phones", rows: [
        custom("remotePair", "Pair a phone", "Shows a one-time QR code; scanning it links that phone.", "qr code pairing link"),
        custom("remoteDevices", "Paired phones", "Rename a phone or revoke its access.", "devices revoke rename"),
      ] },
      { name: "Notifications", rows: [
        custom("remotePush", "Push notifications", "Tell the phone when a question waits or a turn finished, even with the page closed.", "web push vapid notification contact locked lock away screen"),
      ] },
    ] },
    { id: "approvals", icon: "check", title: "Approvals", sep: true, blurb: "When the agent asks before it runs a tool.", groups: [
      { name: "Approval mode", src: "approval-mode.json", rows: [
        custom("approvalMode", "Tool approval mode", "When the agent asks before it runs a tool: a default for every project, and projects that override it. A change restarts omp in the affected open tabs; conversations continue.", "yolo write always ask permission project override default"),
      ] },
      { name: "Standing rules", rows: [
        custom("approvalRules", "Always-allow rules", "Rules are only granted from a prompt; here you review and revoke them.", "rules always allow revoke saved answers"),
      ] },
    ] },
    { id: "shortcuts", icon: "command", title: "Shortcuts", blurb: "Every app action and its chords. A change to one of omp's own bindings is saved as a desktop override.", groups: [
      { name: "Keyboard shortcuts", src: "keybindings.json", rows: [
        custom("shortcuts", "Key bindings", "Rebind an action, add a second chord or reset it to its default.", "keys hotkeys keybindings chord rebind shortcut",
          { moreKw: () => (window.OMP_KEYMAP?.KEYMAP_ACTIONS ?? []).map(a => `${a.label} ${a.id}`).join(" ") }),
      ] },
    ] },
  ];

  const sectionById = (id) => SECTIONS.find(s => s.id === id);
  const sectionRows = (s) => s.groups.flatMap(g => g.rows);
  const ROWS = SECTIONS.flatMap(sectionRows);

  /** Every row, in page order. */
  const rows = () => ROWS;

  /** The value a tweak row's control shows: fold modes resolved, numbers clamped. */
  function value(row, values) {
    const v = values?.[row.key];
    if (row.fold) return collapse()?.foldModes(values)[row.fold] ?? v ?? "auto";
    return clamp(row, v === undefined ? defaults()[row.key] : v);
  }

  /** `v` made valid for the row: sliders rounded to their step within bounds,
   *  segments one of their options, toggles a boolean; else the default. */
  function clamp(row, v) {
    const fallback = defaults()[row.key];
    if (row.type === "slider") {
      const n = Number(v);
      if (v === null || v === "" || !Number.isFinite(n)) return fallback;
      const stepped = row.min + Math.round((n - row.min) / row.step) * row.step;
      return Math.min(row.max, Math.max(row.min, stepped));
    }
    if (row.type === "seg") return row.options.some(o => o.value === v) ? v : fallback;
    if (row.type === "toggle") return typeof v === "boolean" ? v : fallback;
    return v ?? fallback;
  }

  /** Shown now: a row with `visibleIf` asks it (collapseAfter). */
  const visible = (row, values) => row.visibleIf?.(values) ?? true;

  // Tweak keys a custom row owns that differ from their defaults. A
  // `keyPrefix` row counts only `opts.prefixKeys` when given: the keys it
  // renders a control for (a stored key of a removed plugin has no row).
  function ownedChanged(row, values, opts) {
    const d = defaults();
    const changed = (row.keys ?? []).filter(k => k in (values ?? {}) && values[k] !== d[k]);
    if (row.keyPrefix) {
      for (const k of opts?.prefixKeys ?? Object.keys(values ?? {})) {
        if (k.startsWith(row.keyPrefix) && k in (values ?? {}) && values[k] !== row.prefixDefault) changed.push(k);
      }
    }
    return changed;
  }

  /** Changed from its default. Accent compares with the current theme's
   *  own accent (a theme pick resets it); fold modes compare resolved.
   *  `opts.prefixKeys`: see ownedChanged. */
  function isModified(row, values, opts) {
    if (row.kind === "custom") return ownedChanged(row, values, opts).length > 0;
    if (row.key === "accent") return !window.OMP_ACCENT.sameColor(values?.accent, themeAccent(values?.theme));
    return value(row, values) !== value(row, defaults());
  }

  /** Edits for setTweak that put one row back to its default. */
  function resetRow(row, values, opts) {
    const d = defaults();
    if (row.kind === "custom") {
      const edits = {};
      for (const k of ownedChanged(row, values, opts)) edits[k] = row.keyPrefix && k.startsWith(row.keyPrefix) ? row.prefixDefault : d[k];
      return edits;
    }
    if (row.key === "theme") return { theme: d.theme, accent: themeAccent(d.theme) };
    if (row.key === "accent") return { accent: themeAccent(values?.theme) };
    return { [row.key]: d[row.key] };
  }

  const scope = (sectionId) => (sectionId && sectionId !== "all" ? [sectionById(sectionId)].filter(Boolean) : SECTIONS);

  /** Changed visible rows of a section (or of all, for `"all"`/nothing). */
  const modifiedCount = (sectionId, values, opts) =>
    scope(sectionId).flatMap(sectionRows).filter(r => visible(r, values) && isModified(r, values, opts)).length;

  /** Edits for setTweak that reset every changed row of `rows`.
   *  Rows see the edits before them, so a theme reset settles the accent. */
  function resetRows(rows, values, opts) {
    const edits = {};
    for (const r of rows) {
      const next = { ...values, ...edits };
      if (isModified(r, next, opts)) Object.assign(edits, resetRow(r, next, opts));
    }
    return edits;
  }

  /** resetRows over a section (or all). */
  const resetEdits = (sectionId, values, opts) => resetRows(scope(sectionId).flatMap(sectionRows), values, opts);

  // `moreKw`: keywords known only at runtime (the shortcut action names).
  // Custom rows show `label` and `desc` too, plus runtime text of their own;
  // `version` shows runtime text as its desc, `shortcuts` only its editor.
  const searchText = (row) =>
    `${row.label} ${(row.desc ?? "").replace(/`/g, "")} ${row.kw ?? ""} ${row.moreKw?.() ?? ""}`.toLowerCase();

  /** Visible rows whose label, desc or keywords contain the query,
   *  case-insensitive, grouped by section › group in page order. */
  function search(query, values) {
    const q = String(query ?? "").trim().toLowerCase();
    const bySection = Object.fromEntries(SECTIONS.map(s => [s.id, 0]));
    const groups = [];
    let total = 0;
    if (!q) return { total, bySection, groups };
    for (const s of SECTIONS) {
      for (const g of s.groups) {
        const hits = g.rows.filter(r => visible(r, values) && searchText(r).includes(q));
        if (!hits.length) continue;
        groups.push({ sectionId: s.id, sectionTitle: s.title, groupName: g.name, src: g.src, rows: hits });
        bySection[s.id] += hits.length;
        total += hits.length;
      }
    }
    return { total, bySection, groups };
  }

  window.OMP_SETTINGS = Object.freeze({
    SECTIONS, THEMES, ACCENTS, themeAccent,
    rows, value, clamp, visible, isModified, resetRow, modifiedCount, resetRows, resetEdits, search,
  });
})();

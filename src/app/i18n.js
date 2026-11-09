/* ═════════════════════════════════════════════════════════════════════
   app/i18n.js — the window's translation layer (docs/architecture/i18n.md).

   Source strings are the keys: OMP_TR("Close tab") returns the current
   locale's translation, or the source string itself when the dictionary
   has none. English is the source language, so it needs no dictionary and
   an untranslated string is never missing from the UI.

   A locale file registers its strings by calling
   OMP_I18N.add("zh", { "Close tab": "关闭标签页" }); it loads right after
   this file (app/i18n-<code>.js, src/index.html).

   Call OMP_TR at render/call time and never cache the result: it follows
   OMP_I18N.set(). The requested locale is the `locale` tweak ("auto" = the
   OS language); app-live.jsx applies a change in a layout effect and
   subscribes through useLocale(), so the tree repaints before the browser
   paints, and the first paint already reads the stored tweak here, so
   switching or relaunching never flashes English first.

   {name} in a source or translation is filled from the vars object
   (unknown placeholders stay as written). Plurals:
   OMP_I18N.plural(n, one, other, vars) picks the English form for
   |n| === 1 unless the dictionary maps the `other` source string to
   { one, other, … } of Intl.PluralRules categories.

   Wrapped in an IIFE per the project rule for plain <script> tags.
   ═════════════════════════════════════════════════════════════════════ */
(function () {
  // tweaks/use-tweaks.js `STORAGE_KEY` (keep the two in sync); read here so
  // the first render already uses the chosen language (React has not
  // mounted yet).
  const TWEAKS_KEY = "omp-desktop:tweaks";

  const DICTS = Object.create(null); // locale code → { source: translation }
  const CODES = [];                  // registration order, "en" implicit

  const norm = (tag) => String(tag ?? "").replace(/_/g, "-").trim().toLowerCase();
  const primary = (tag) => norm(tag).split("-")[0];

  /** The registered code `tag` names (exact, else the same primary subtag). */
  function match(tag) {
    const full = norm(tag);
    if (!full) return null;
    if (DICTS[full]) return full;
    const p = primary(full);
    return CODES.find(code => primary(code) === p) ?? null;
  }

  function systemTag() {
    try {
      const nav = window.navigator;
      if (!nav) return "";
      return nav.languages?.[0] || nav.language || "";
    } catch {
      return "";
    }
  }

  let requested = "auto"; // "auto" or the code the setting asked for
  let locale = "en";      // resolved: a registered code, or "en"
  const listeners = new Set();
  const subscribe = (listener) => {
    listeners.add(listener);
    return () => listeners.delete(listener);
  };
  const getLocale = () => locale;

  /** The locale `request` would show ("auto" follows the OS language). */
  function resolve(request) {
    const want = String(request ?? "auto");
    if (want !== "auto") return match(want) ?? "en";
    return match(systemTag()) ?? "en";
  }

  function fill(text, vars) {
    return String(text).replace(/\{(\w+)\}/g, (whole, key) =>
      (vars && Object.prototype.hasOwnProperty.call(vars, key) ? String(vars[key]) : whole));
  }

  /** The current locale's entry for `source` (a string, a plural-category
   *  object), or null. */
  function lookup(source) {
    const dict = DICTS[locale];
    return dict && Object.prototype.hasOwnProperty.call(dict, source) ? dict[source] : null;
  }

  /** `source` in the current locale, `{name}` filled from `vars`. */
  function t(source, vars) {
    if (typeof source !== "string") return source;
    const hit = lookup(source);
    return fill(typeof hit === "string" ? hit : source, vars);
  }

  let rules = null;
  let rulesFor = null;

  function pluralRules() {
    if (rulesFor !== locale) {
      rules = null;
      rulesFor = locale;
      try {
        if (typeof Intl !== "undefined" && Intl.PluralRules) rules = new Intl.PluralRules(locale);
      } catch {
        rules = null;
      }
    }
    return rules;
  }

  /** `one`/`other` (English forms) for `n`, using the dictionary's plural
   *  categories when it has them. `n` is also a `{n}` placeholder. */
  function plural(n, one, other, vars) {
    const count = Math.abs(Number(n));
    const all = Object.assign({}, vars, { n });
    const hit = lookup(other);
    if (hit && typeof hit === "object") {
      const cat = pluralRules()?.select(count) ?? (count === 1 ? "one" : "other");
      const form = hit[cat] ?? hit.other ?? hit.one;
      if (typeof form === "string") return fill(form, all);
    }
    if (typeof hit === "string") return fill(hit, all);
    return fill(count === 1 ? one : other, all);
  }

  function add(code, strings) {
    const c = norm(code);
    if (!c || !strings || typeof strings !== "object") return;
    DICTS[c] = Object.assign(DICTS[c] || {}, strings);
    if (!CODES.includes(c)) CODES.push(c);
    // A dictionary loaded after the initial `set` (app/i18n-zh.js follows
    // this file) can make the requested locale resolvable for the first time.
    if (resolve(requested) !== locale) set(requested);
  }

  /** Follow `request` ("auto" = the OS language). Idempotent; returns the
   *  resolved locale and notifies `useLocale` subscribers when it changes. */
  function set(request) {
    const next = resolve(request);
    const changed = next !== locale;
    requested = String(request ?? "auto");
    locale = next;
    const doc = window.document;
    if (doc && doc.documentElement) doc.documentElement.lang = next;
    if (changed) {
      for (const listener of listeners) listener();
    }
    return next;
  }

  /** React subscription for memoized components: a component whose props do
   *  not change still has to repaint when the language does, so components
   *  that render OMP_TR text call OMP_I18N.useLocale(). */
  function useLocale() {
    return React.useSyncExternalStore(subscribe, getLocale);
  }

  function storedLocale() {
    try {
      const store = window.localStorage;
      if (!store) return "auto";
      const raw = store.getItem(TWEAKS_KEY);
      return (raw && JSON.parse(raw)?.locale) || "auto";
    } catch {
      return "auto";
    }
  }

  const api = {
    t, plural, add, set, useLocale,
    get locale() { return locale; },
    get requested() { return requested; },
  };

  window.OMP_I18N = Object.freeze(api);
  // Call-site shorthand: OMP_TR("Close tab"). A global function, not a
  // top-level const, so plain and Babel scripts can call it without a
  // destructure that would have to load after this file.
  window.OMP_TR = t;

  set(storedLocale());

  // The webview can report a new preferred language at runtime; with
  // "auto" that means a new locale (an explicit choice is left alone).
  if (typeof window.addEventListener === "function") {
    window.addEventListener("languagechange", () => {
      if (requested === "auto") set("auto");
    });
  }
})();

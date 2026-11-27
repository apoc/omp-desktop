// Phone protocol helpers. No DOM or network effects; markdown uses the
// desktop's configured marked renderer, never a separate sanitizer.
(function (root) {
  let counter = 0;

  function reduce(state, msg) {
    switch (msg.t) {
      case "hello":
        return { ...state, device: { id: msg.deviceId, name: msg.name } };
      case "tabs":
        return { ...state, tabs: msg.tabs };
      case "theme":
        return { ...state, theme: msg.theme ?? null };
      case "view":
        return { ...state, view: msg.view ?? null };
      case "ack": {
        const pending = { ...state.pending };
        delete pending[msg.reqId];
        return { ...state, pending, error: msg.ok ? state.error : msg.error };
      }
      case "push-key":
        return { ...state, pushKey: msg.key };
      default:
        return state;
    }
  }

  const nextReqId = () => `${Date.now()}-${++counter}`;

  // Rust drops a select without a request id, like any other action.
  function selectFor(tabId) {
    return { t: "select", reqId: nextReqId(), tabId };
  }

  function actionFor(kind, { tabId, text, askId, value }) {
    const action = { t: "action", reqId: nextReqId(), tabId, kind };
    if (kind === "prompt" || kind === "steer") action.text = text;
    if (kind === "answer") Object.assign(action, { askId, value });
    return action;
  }

  function askControls(ask) {
    switch (ask.kind) {
      case "select":
        return (ask.options || []).map(option => typeof option === "string"
          ? { label: option, value: option }
          : { label: option.label, value: option.value ?? option.label });
      case "confirm":
        return [{ label: "Confirm", value: true }, { label: "Deny", value: false }];
      case "input":
      case "editor":
        return { input: true, multiline: ask.kind === "editor" };
      default:
        return [];
    }
  }

  function backoff(attempt) {
    return Math.min(30000, 1000 * 2 ** attempt);
  }

  function renderMarkdown(text) {
    // marked-setup exits before installing its HTML escaping without hljs.
    // Do not silently fall back to unconfigured marked in this token origin.
    if (!root.hljs) throw new Error("highlight.js (hljs) is required for safe markdown");
    if (!root.marked || !root.OMP_MARKDOWN) throw new Error("marked-setup.js must load before the phone client");
    return root.marked.parse(text);
  }

  // Accept only a pairing URL for this origin: <origin>/#pair=<code>.
  // Returns { code } on success, { other: true } when the URL points to a
  // different origin (so the UI can hint "This code is for another server"),
  // and null for anything else.
  function pairCodeFromScan(text, origin) {
    let url;
    try { url = new URL(text); } catch { return null; }
    if (url.origin !== origin) return { other: true };
    const code = new URLSearchParams(url.hash.slice(1)).get("pair");
    if (!code) return null;
    return { code };
  }

  // Identity of a row for the fade-in: its id when it has one, otherwise its
  // role and a hash of its text, so a row whose index-derived id shifts is
  // still the same row.
  function messageKey(message) {
    if (!message.idSynthetic && message.id !== undefined && message.id !== null) return `id:${message.id}`;
    let hash = 2166136261;
    for (const char of String(message.text ?? "")) hash = Math.imul(hash ^ char.codePointAt(0), 16777619) >>> 0;
    return `${message.role}:${hash.toString(36)}`;
  }

  // Which rows (messages and open asks) are new since the last render. Only
  // new rows may play the fade-in; rebuilding every row with it makes a
  // streaming transcript blink. The returned set holds the keys now on screen,
  // so it stays bounded.
  function trackShown(shown, messages, asks = []) {
    const fresh = new Set(), next = new Set();
    const keys = [...messages.map(messageKey), ...asks.map(ask => `ask:${ask.id}`)];
    for (const key of keys) {
      next.add(key);
      if (!shown.has(key)) fresh.add(key);
    }
    return { fresh, shown: next };
  }

  // Whether a view update jumps to the end: another tab, or the desktop's own
  // rule (scroll-pin.js shouldRepin: the user's own message became the tail;
  // a steer echoed back by omp does not move a reader).
  function repinFor(scrollPin, prev, view) {
    if (!view) return false;
    if (view.tabId !== prev.tabId) return true;
    const messages = (view.messages || []).map(m => ({ kind: m.role, echo: m.echo, _id: m.id }));
    return scrollPin.shouldRepin(prev.lastId, messages);
  }

  // Last path segment of a project folder, so the phone shows "omp-desktop"
  // and never a full path. Accepts / and \ separators and trailing ones.
  function projectName(path) {
    if (typeof path !== "string") return "";
    const parts = path.split(/[\\/]+/).filter(Boolean);
    return parts.length ? parts[parts.length - 1] : "";
  }

  // Tabs other than the active one that wait for an answer.
  function otherQuestionCount(tabs, activeId) {
    return (tabs || []).filter(tab => tab.hasAsk && tab.id !== activeId).length;
  }

  // What the one composer button does: send when idle; while running, steer
  // with a draft and stop without one. Whitespace-only counts as empty.
  function composerAction({ busy, draft }) {
    if (!busy) return "send";
    return String(draft ?? "").trim() ? "steer" : "stop";
  }

  const client = { reduce, actionFor, selectFor, askControls, backoff, renderMarkdown, pairCodeFromScan, trackShown, messageKey, repinFor, projectName, otherQuestionCount, composerAction };
  if (typeof window !== "undefined") window.OMP_REMOTE_CLIENT = client;
  if (typeof module !== "undefined" && module.exports) module.exports = client;
})(typeof window !== "undefined" ? window : globalThis);

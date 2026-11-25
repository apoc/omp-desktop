// Standalone phone UI. Only configured markdown enters innerHTML; all other
// remote data is textContent. No desktop bridge or external resources.
(function () {
  const C = window.OMP_REMOTE_CLIENT;
  const TOKEN_KEY = "omp-remote-token";
  let state = { device: null, tabs: [], view: null, pending: {}, error: null, theme: null };
  // A push tap opens `/?tab=<id>`; that id is used for the first connection only.
  let socket, token, selected = null, pendingTab = new URLSearchParams(location.search).get("tab");
  if (pendingTab) history.replaceState(null, "", location.pathname + location.hash);
  let connected = false, attempt = 0, notificationsEnabled = false, notificationsPending = false;
  let connectionText = "Connecting…";
  const sentDrafts = new Map();
  let fallbackView = null, selectReqId = null;
  function node(tag, text, className) {
    const element = document.createElement(tag);
    if (text !== undefined) element.textContent = text;
    if (className) element.className = className;
    return element;
  }
  function button(label, click) {
    const element = node("button", label);
    element.type = "button";
    element.addEventListener("click", click);
    return element;
  }
  const installed = () => Boolean(navigator.standalone) || window.matchMedia("(display-mode: standalone)").matches;
  const app = document.getElementById("app");
  const status = node("p", "", "status");
  status.setAttribute("role", "status");
  const error = node("p", "", "error");
  error.setAttribute("role", "alert");
  const sessions = window.OMP_REMOTE_SESSIONS.createSessions({
    onSelectTab: selectTab,
    onEnableNotifications: enableNotifications,
  });
  const scanner = window.OMP_REMOTE_SCANNER.createScanner({
    onPair: pairFromCode,
    installed,
  });
  const transcript = window.OMP_REMOTE_TRANSCRIPT.createTranscript({
    status,
    scan: scanner.root,
    error,
    onAnswer: (askId, value, origin) => action("answer", { askId, value, ...origin }),
    onError: message => { state = { ...state, error: message }; },
  });
  const composer = node("div", "", "remote-composer");
  const draft = node("textarea", undefined, "composer-field");
  draft.id = "draft";
  draft.rows = 1;
  draft.setAttribute("aria-label", "Message");
  draft.setAttribute("enterkeyhint", "enter");
  const send = button("↑", onComposerButton);
  send.className = "composer-btn";
  composer.append(draft, send);
  app.append(sessions.header, transcript.stage, composer, sessions.backdrop, sessions.sheet);

  function transmit(frame) {
    if (!connected || socket?.readyState !== WebSocket.OPEN) return false;
    socket.send(JSON.stringify(frame));
    return true;
  }
  function action(kind, fields = {}) {
    if (!state.view || !connected) return null;
    const frame = C.actionFor(kind, { tabId: state.view.tabId, ...fields });
    if (!transmit(frame)) return null;
    state = { ...state, pending: { ...state.pending, [frame.reqId]: kind }, error: null };
    updateControls();
    return frame.reqId;
  }
  const currentAction = () => C.composerAction({ busy: Boolean(state.view?.busy), draft: draft.value });
  function onComposerButton() {
    if (currentAction() === "stop") action("abort");
    else submit();
  }
  // Grows with the text; the CSS max-height makes it scroll beyond ~5 lines.
  function fitDraft() {
    draft.style.height = "auto";
    draft.style.height = `${(draft.scrollHeight || 0) + (draft.offsetHeight - draft.clientHeight || 0)}px`;
  }
  function syncComposer() {
    const kind = currentAction();
    draft.placeholder = state.view?.busy ? "Steer…" : "Message…";
    send.textContent = kind === "stop" ? "■" : "↑";
    send.className = `composer-btn ${kind}`;
    send.setAttribute("aria-label", kind === "stop" ? "Stop" : kind === "steer" ? "Steer" : "Send");
    send.disabled = !connected || !state.view || (kind === "send" && !draft.value.trim());
    draft.disabled = !connected || !state.view;
  }
  draft.addEventListener("input", () => { fitDraft(); syncComposer(); });
  function submit() {
    const text = draft.value;
    if (!text.trim()) return;
    if (typeof TextEncoder !== "undefined" && new TextEncoder().encode(text).length > 32768) {
      state = { ...state, error: "Message is too long (max 32 KB)." };
      updateControls();
      return;
    }
    const reqId = action(state.view?.busy ? "steer" : "prompt", { text });
    if (reqId) { sentDrafts.set(reqId, text); draft.value = ""; fitDraft(); updateControls(); }
  }
  function updateControls() {
    status.textContent = connectionText;
    status.hidden = connected;
    error.textContent = state.error || "";
    syncComposer();
    const canPush = installed() && "PushManager" in window && "serviceWorker" in navigator;
    sessions.syncControls({
      connected,
      connectionText,
      canPush,
      pushKey: state.pushKey,
      notificationsEnabled,
      notificationsPending,
    });
    transcript.syncControls(connected);
    scanner.sync(!token && !connected);
  }

  async function pairFromCode(code) {
    try {
      const response = await fetch("/pair", { method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ code, name: navigator.userAgent.slice(0, 120) }) });
      if (!response.ok) throw new Error(`Pairing failed (${response.status}); create a new pairing code on the desktop`);
      const paired = await response.json();
      token = paired.token;
      localStorage.setItem(TOKEN_KEY, token);
      scanner.setHint("");
      updateControls();
      connect();
      return true;
    } catch (err) {
      scanner.setHint(err.message);
      updateControls();
      return false;
    }
  }
  function applyTheme(theme) {
    if (!theme) return;
    window.OMP_ACCENT?.applyThemeTokens(document.documentElement, theme.id, theme.accent);
  }
  applyTheme({ id: "aurora", tone: "dark", accent: "#8AF0C8" });

  const activeTabId = () => selected ?? state.view?.tabId ?? null;
  function selectTab(tabId, closeSheet) {
    const frame = C.selectFor(tabId);
    if (!transmit(frame)) return;
    selected = tabId;
    selectReqId = frame.reqId;
    // The same tab keeps its view: no new view frame is coming for it.
    if (tabId !== state.view?.tabId) {
      if (state.view) fallbackView = state.view;
      state = { ...state, view: null };
    }
    closeSheet(); renderTabs(); renderView(); updateControls();
  }
  function renderTabs() {
    sessions.render(state.tabs, activeTabId());
  }
  // iOS keeps the layout viewport tall under the keyboard; follow the visible one.
  if (window.visualViewport) {
    const fit = () => document.documentElement.style.setProperty("--app-h", `${window.visualViewport.height}px`);
    window.visualViewport.addEventListener("resize", fit);
    window.visualViewport.addEventListener("scroll", () => window.scrollTo(0, 0));
    fit();
  }
  function renderView() {
    transcript.renderView(state.view);
  }
  function connect() {
    connectionText = "Connecting…"; updateControls();
    socket = new WebSocket(`wss://${location.host}/ws`);
    socket.onopen = () => socket.send(JSON.stringify({ t: "auth", token }));
    socket.onmessage = event => {
      try {
        const msg = JSON.parse(event.data);
        state = C.reduce(state, msg);
        if (msg.t === "hello") {
          connected = true; attempt = 0; connectionText = "Connected";
          const wanted = pendingTab ?? selected;
          pendingTab = null;
          if (wanted) transmit(C.selectFor(wanted));
        }
        if (msg.t === "tabs") {
          if (state.view && !state.tabs.some(tab => tab.id === state.view.tabId)) {
            state = { ...state, view: null }; selected = null; renderView();
          }
          if (fallbackView && !state.tabs.some(tab => tab.id === fallbackView.tabId)) fallbackView = null;
          renderTabs();
        }
        if (msg.t === "view") {
          fallbackView = null; selectReqId = null;
          selected = state.view?.tabId ?? null; renderTabs(); renderView();
        }
        if (msg.t === "theme") applyTheme(state.theme);
        if (msg.t === "ack") {
          const sentText = sentDrafts.get(msg.reqId);
          sentDrafts.delete(msg.reqId);
          if (!msg.ok && sentText && !draft.value) { draft.value = sentText; fitDraft(); }
          if (msg.reqId && msg.reqId === selectReqId) {
            selectReqId = null;
            if (!msg.ok && !state.view && fallbackView && state.tabs.some(tab => tab.id === fallbackView.tabId)) {
              state = { ...state, view: fallbackView };
              selected = fallbackView.tabId;
              fallbackView = null;
              renderTabs(); renderView();
            }
          }
        }
        if (msg.t === "ack" && msg.kind === "push") {
          notificationsPending = false;
          if (msg.ok) notificationsEnabled = true;
        }
        updateControls();
      } catch (err) {
        state = { ...state, error: err.message }; updateControls();
      }
    };
    socket.onclose = event => {
      connected = false;
      state = { ...state, device: null, pending: {} };
      sentDrafts.clear(); selectReqId = null;
      notificationsPending = false;
      if (event.code === 4401) {
        token = null;
        notificationsEnabled = false;
        localStorage.removeItem(TOKEN_KEY);
        connectionText = "This device is no longer paired — pair again from the desktop";
      } else {
        connectionText = event.code === 4503 ? "Desktop not ready — reconnecting…"
          : event.code === 4429 ? "Too many connections — reconnecting…" : "Connection lost — reconnecting…";
        setTimeout(connect, C.backoff(attempt++));
      }
      updateControls();
    };
    socket.onerror = () => { connectionText = "Connection failed — reconnecting…"; updateControls(); };
  }

  async function enableNotifications() {
    if (!connected || !state.pushKey) return;
    notificationsPending = true; updateControls();
    try {
      const permission = await Notification.requestPermission();
      if (permission !== "granted") throw new Error("Notification permission was not granted");
      const registration = await navigator.serviceWorker.register("/sw.js");
      // Wait for activation before pushManager.subscribe on a first visit.
      const ready = await navigator.serviceWorker.ready;
      const key = state.pushKey.replace(/-/g, "+").replace(/_/g, "/");
      const applicationServerKey = Uint8Array.from(atob(key), char => char.charCodeAt(0));
      const sub = await registration.pushManager.getSubscription()
        || await ready.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey });
      if (!transmit({ t: "push-subscribe", sub: sub.toJSON() })) throw new Error("Connection lost; enable notifications again after reconnecting");
    } catch (err) { notificationsPending = false; state = { ...state, error: err.message }; }
    updateControls();
  }

  async function start() {
    try {
      const code = new URLSearchParams(location.hash.slice(1)).get("pair");
      if (code) {
        const paired = await pairFromCode(code);
        history.replaceState(null, "", location.pathname);
        // An expired or used code must not hide a token this phone already has.
        if (paired) return;
      }
      token = localStorage.getItem(TOKEN_KEY);
      if (token) connect();
      else { connectionText = "Pair this phone from the desktop"; updateControls(); }
    } catch (err) {
      connectionText = "Unable to connect";
      state = { ...state, error: err.message }; updateControls();
    }
  }
  renderView(); updateControls(); start();
})();

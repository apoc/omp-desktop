/* app/remote-view.js — bounded phone views and serial action dispatch.
   Uses live.js's UI transcript, not omp's raw RPC message shapes. */
(function () {
  "use strict";

  // The phone gets the folder's name only, never the full path.
  function projectName(path) {
    const parts = typeof path === "string" ? path.split(/[\\/]+/).filter(Boolean) : [];
    return parts.length ? parts[parts.length - 1] : "";
  }

  function tabMeta(sessions = []) {
    return sessions.map(s => ({ id: s.id, title: s.name ?? "", project: projectName(s.path) }));
  }

  function askCard(message) {
    const ask = message.ask ?? message;
    if (message.kind !== "ask" && !message.ask) return null;
    if (message.answered || message.cancelled || message.closedByOmp || ask.answered || ask.cancelled || ask.closedByOmp) return null;
    const method = ask.method ?? ask.kind;
    const kind = method === "ask" ? "dialog" : method;
    if (!["select", "confirm", "input", "editor", "dialog"].includes(kind)) return null;
    return {
      id: ask.id ?? message.id, kind, title: ask.title ?? "", message: ask.message ?? "",
      ...(kind === "select" ? { options: ask.options ?? [] } : {}),
      ...(kind === "editor" && typeof (ask.prefill ?? ask.value) === "string" ? { value: ask.prefill ?? ask.value } : {}),
      ...(kind === "dialog" ? { questions: ask.questions ?? [] } : {}),
    };
  }

  function messageText(message) {
    if (typeof message.text === "string") return message.text;
    if (Array.isArray(message.blocks)) {
      return message.blocks.filter(b => b.type === "text").map(b => b.text ?? "").join("\n");
    }
    return message.message ?? message.title ?? message.summary ?? "";
  }

  function toolOutput(message) {
    if (typeof message.outputText === "string") return message.outputText;
    if (typeof message.output === "string") return message.output;
    if (Array.isArray(message.output)) return message.output.map(row => row.line ?? "").join("\n");
    if (Array.isArray(message.cells)) return message.cells.map(cell => cell.output ?? "").join("\n");
    return message.diffText ?? "";
  }

  // Cut at `max` UTF-16 units without leaving half a surrogate pair.
  function clip(text, max) {
    if (text.length <= max) return text;
    const code = text.charCodeAt(max - 1);
    return text.slice(0, code >= 0xd800 && code <= 0xdbff ? max - 1 : max);
  }

  function buildView(snapshot, { maxMessages = 100, maxToolChars = 2000 } = {}) {
    if (!snapshot?.activeSessionId) return null;
    const messages = [], asks = [];
    for (const [index, message] of (snapshot.messages ?? []).entries()) {
      const ask = askCard(message);
      if (ask) asks.push(ask);
      if (window.OMP_TURN_STATUS?.isHidden(message)) continue;
      // Native prompt snapshots belong to desktop context inspection, not the phone transcript.
      if (message.kind === "context") continue;
      if (message.kind === "ask" || message.ask || message.kind === "thinking" || message.role === "thinking") continue;
      const kind = message.kind ?? message.role;
      let role = ["user", "assistant", "tool"].includes(kind) ? kind : "notice";
      let text = messageText(message);
      // A failed run's bubble has no text; its failure is the public message.
      if (role === "assistant" && !text && message.failure) {
        role = "notice";
        text = message.failure.headline ?? message.failure.raw ?? "";
      }
      // A thinking-only assistant bubble has no public text.
      if (role === "assistant" && !text) continue;
      if (role === "notice" && !text) continue;
      const realId = message.id ?? message._toolCallId;
      const id = realId ?? `${kind}:${message.ts ?? index}`;
      messages.push({
        id, role, text,
        ...(realId == null && message.ts == null ? { idSynthetic: true } : {}),
        ...(role === "user" && message.echo ? { echo: true } : {}),
        ...(role === "tool" ? { tool: {
          name: typeof message.tool === "string" ? message.tool : message.tool?.name ?? "",
          summary: message.summary ?? "",
          output: clip(toolOutput(message), maxToolChars),
        } } : {}),
      });
    }
    return { tabId: snapshot.activeSessionId, busy: Boolean(snapshot.isStreaming), messages: messages.slice(-maxMessages), asks };
  }

  // Data-only structural equality; key order does not change a phone view.
  function viewsEqual(a, b) {
    if (a === b) return true;
    if (!a || !b || typeof a !== "object" || typeof b !== "object") return false;
    if (Array.isArray(a) !== Array.isArray(b)) return false;
    const keys = Object.keys(a);
    return keys.length === Object.keys(b).length && keys.every(key => Object.hasOwn(b, key) && viewsEqual(a[key], b[key]));
  }

  function answerCall(ask, value) {
    if (value === null) return { method: "cancelAsk", args: [ask.id] };
    const kind = ask.method ?? ask.kind;
    const method = kind === "confirm" ? "answerConfirm"
      : kind === "ask" || kind === "dialog" ? "answerAskDialog" : "answerAsk";
    return { method, args: [ask.id, value] };
  }

  const nonBlank = value => typeof value === "string" && value.trim() !== "";

  // Mirrors app/ask-dialog.js: one answer per question in order, exact option
  // labels without repeats, one pick unless `multi`, never pick plus typed text.
  function validDialogAnswers(questions, value) {
    if (!Array.isArray(questions) || !Array.isArray(value) || value.length !== questions.length) return false;
    return value.every((a, i) => {
      const q = questions[i];
      if (!a || typeof a !== "object" || Array.isArray(a) || a.id !== q?.id) return false;
      const picks = a.selectedOptions;
      if (!Array.isArray(picks) || new Set(picks).size !== picks.length) return false;
      const labels = (q.options ?? []).map(o => o?.label);
      if (!picks.every(p => typeof p === "string" && labels.includes(p))) return false;
      if (picks.length > 1 && !q.multi) return false;
      if (a.customInput !== undefined && typeof a.customInput !== "string") return false;
      return !(!q.multi && picks.length && a.customInput?.trim());
    });
  }

  // The phone is untrusted input: check the value fits the open ask's kind.
  // null (cancel) is always allowed. Returns an error text or null.
  function invalidAnswer(ask, value) {
    if (value === null) return null;
    const bad = "invalid answer";
    switch (ask.kind) {
      case "confirm": return typeof value === "boolean" ? null : bad;
      case "select": {
        const allowed = (ask.options ?? []).flatMap(o => typeof o === "string" ? [o] : [o?.value ?? o?.label]);
        return typeof value === "string" && allowed.includes(value) ? null : bad;
      }
      case "input": case "editor": return typeof value === "string" ? null : bad;
      case "dialog":
        return validDialogAnswers(ask.questions, value) ? null : bad;
      default: return bad;
    }
  }

  // Rust times an action out after 15 s; older queued work would run after
  // the phone already saw a failure.
  const ACTION_MAX_AGE_MS = 15000;
  const ACTION_QUEUE_MAX = 16;

  // `getStatus` is the latest remote status: a queued action runs only while
  // the server listens, its device is still paired and connected, and it is
  // fresh. The check repeats after every wait, so a revoke during a tab switch
  // or the ask wait stops the action before it reaches omp.
  function makeActionHandler(bridge, getSnapshot, getStatus) {
    let queue = Promise.resolve(), waiting = 0;
    const activeTab = () => bridge.activeSessionId !== undefined ? bridge.activeSessionId : getSnapshot()?.activeSessionId;
    const refusal = (action, enqueuedAt) => {
      const status = getStatus();
      if (!status?.listening) return "remote access disabled";
      if (!status.devices?.some(device => device.id === action.deviceId && device.connected)) return "device revoked";
      const startedAt = typeof action.dispatchedAt === "number" ? Math.min(enqueuedAt, action.dispatchedAt) : enqueuedAt;
      return Date.now() - startedAt > ACTION_MAX_AGE_MS ? "expired" : null;
    };
    async function ensureTab(action, enqueuedAt) {
      if (typeof bridge.waitForActivation === "function") await bridge.waitForActivation();
      if (activeTab() !== action.tabId) {
        try {
          await bridge.activateSession(action.tabId);
        } catch {
          throw new Error("tab not available");
        }
      }
      if (typeof bridge.waitForActivation === "function") await bridge.waitForActivation();
      const reason = refusal(action, enqueuedAt);
      if (reason) throw new Error(reason);
      if (!action.tabId || activeTab() !== action.tabId || getSnapshot()?.activeSessionId !== action.tabId) {
        throw new Error("tab not available");
      }
    }
    async function execute(action, enqueuedAt) {
      const { reqId, tabId, kind } = action;
      const guard = () => {
        const reason = refusal(action, enqueuedAt);
        if (reason) throw new Error(reason);
      };
      try {
        guard();
        await ensureTab(action, enqueuedAt);
        // The bridge reports the IPC hand-off: `false` or a rejection means omp
        // never got the command.
        const deliver = async call => {
          if (typeof bridge.waitForActivation === "function") await bridge.waitForActivation();
          guard();
          if (activeTab() !== tabId || getSnapshot()?.activeSessionId !== tabId) throw new Error("tab not available");
          let result;
          try { result = await call(); } catch { throw new Error("desktop could not deliver"); }
          if (result === false) throw new Error("desktop could not deliver");
          if (result?.ok === false) throw new Error(result.error);
        };
        switch (kind) {
          case "select": break;
          case "prompt":
            if (!nonBlank(action.text)) throw new Error("invalid text");
            await deliver(() => getSnapshot().isStreaming ? bridge.steer(action.text) : bridge.send(action.text));
            break;
          case "steer":
            if (!nonBlank(action.text)) throw new Error("invalid text");
            await deliver(() => bridge.steer(action.text)); break;
          case "abort": await deliver(() => bridge.abort()); break;
          case "answer": {
            const deadline = Date.now() + 5000;
            let ask;
            while (true) {
              guard();
              const snapshot = getSnapshot();
              if (activeTab() !== tabId || snapshot?.activeSessionId !== tabId) throw new Error("tab not available");
              ask = (snapshot.messages ?? []).map(askCard).find(q => q?.id === action.askId);
              if (ask || Date.now() >= deadline) break;
              await new Promise(resolve => setTimeout(resolve, 100));
            }
            if (!ask) throw new Error("question no longer open");
            const invalid = invalidAnswer(ask, action.value);
            if (invalid) throw new Error(invalid);
            const call = answerCall(ask, action.value);
            await deliver(() => bridge[call.method](...call.args));
            break;
          }
          default: throw new Error("unknown remote action");
        }
        await bridge.remoteActionResult(reqId, true);
      } catch (error) {
        await bridge.remoteActionResult(reqId, false, String(error?.message ?? error));
      }
    }
    return action => {
      if (waiting >= ACTION_QUEUE_MAX) return Promise.resolve(bridge.remoteActionResult(action.reqId, false, "busy"));
      waiting++;
      const enqueuedAt = Date.now();
      // A failed result delivery must not poison subsequent actions.
      const next = queue.then(() => execute(action, enqueuedAt)).finally(() => { waiting--; });
      queue = next.catch(() => {});
      return next;
    };
  }

  window.OMP_REMOTE_VIEW = { tabMeta, buildView, viewsEqual, answerCall, invalidAnswer, makeActionHandler };
})();

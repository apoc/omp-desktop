// Live voice is ephemeral and belongs to one omp process, not the chat log.
// Local actions bracket RPC frames so replayed frames cannot start a call.
(function () {
  const LIMITS = Object.freeze({ transcripts: 100, text: 8192 });
  const EMPTY = Object.freeze({
    active: false, phase: "idle", muted: false, input: 0, output: 0,
    transcripts: Object.freeze([]), error: null,
  });
  const PHASES = new Set(["connecting", "listening", "working", "speaking", "muted", "error"]);
  const level = n => typeof n === "number" && Number.isFinite(n) ? Math.max(0, Math.min(1, n)) : 0;
  function bounded(text) {
    if (text.length <= LIMITS.text) return text;
    let end = LIMITS.text;
    const last = text.charCodeAt(end - 1);
    if (last >= 0xd800 && last <= 0xdbff) end--;
    return text.slice(0, end);
  }
  function ended(state, error) {
    const message = typeof error === "string" && error ? error : null;
    return { ...state, active: false, phase: message ? "error" : "idle", muted: false, input: 0, output: 0, error: message };
  }
  function apply(state, event) {
    if (!event || typeof event.type !== "string") return state;
    switch (event.type) {
      case "start":
        return state.active ? state : { ...EMPTY, active: true, phase: "connecting", transcripts: [] };
      case "stop":
        return !state.active || state.phase === "stopping" ? state : { ...state, phase: "stopping", input: 0, output: 0, error: null };
      case "stop_success":
        return state.phase === "stopping" ? ended(state, null) : state;
      case "stop_failure":
        return state.phase === "stopping" ? { ...state, phase: "error", error: event.error || "Could not stop live voice" } : state;
      case "start_failure":
        return state.active && state.phase !== "stopping" ? ended(state, event.error || "Could not start live voice") : state;
      case "mute_success":
        return state.active && state.phase !== "stopping" && typeof event.muted === "boolean"
          ? { ...state, muted: event.muted, error: null, input: event.muted ? 0 : state.input }
          : state;
      case "mute_failure":
        return state.active && state.phase !== "stopping" ? { ...state, error: event.error || "Could not change microphone mute" } : state;
      case "process_exit":
        return state.active || state.error
          ? { ...EMPTY, phase: "error", error: (state.active ? event.error || state.error : state.error) || "The omp process ended during live voice" }
          : EMPTY;
      case "live_end":
        // During an explicit stop omp can report a transport error caused by
        // cancellation. Stop's reply, not that error, decides the outcome.
        if (!state.active || state.phase === "stopping") return state;
        return ended(state, event.error);
      case "live_phase":
        if (!state.active || state.phase === "stopping" || !PHASES.has(event.phase)) return state;
        return { ...state, phase: event.phase, muted: event.phase === "muted" || state.muted,
          input: event.phase === "muted" ? 0 : state.input };
      case "live_levels": {
        if (!state.active || state.phase === "stopping") return state;
        const input = state.muted ? 0 : level(event.input);
        const output = level(event.output);
        return input === state.input && output === state.output ? state : { ...state, input, output };
      }
      case "live_transcript": {
        if (!state.active || (event.role !== "user" && event.role !== "assistant") ||
            !Number.isInteger(event.turn) || event.turn < 0 || typeof event.text !== "string" || typeof event.final !== "boolean") return state;
        const entry = { role: event.role, turn: event.turn, text: bounded(event.text), final: event.final };
        const i = state.transcripts.findIndex(t => t.role === entry.role && t.turn === entry.turn);
        if (i !== -1) {
          const old = state.transcripts[i];
          // A replayed partial must never overwrite a final transcript.
          if (old.final && !entry.final) return state;
          if (old.text === entry.text && old.final === entry.final) return state;
          const transcripts = state.transcripts.slice();
          transcripts[i] = entry;
          return { ...state, transcripts };
        }
        const transcripts = [...state.transcripts, entry].slice(-LIMITS.transcripts);
        return { ...state, transcripts };
      }
      default:
        return state;
    }
  }
  // Dictation is a separate, draft-only capture. Preview frames replace the
  // full preview; the capture id prevents journal replay crossing sessions.
  const DICTATION_EMPTY = Object.freeze({ active: false, phase: "idle", captureId: null, text: "", error: null });
  function applyDictation(state, event) {
    if (!event || typeof event.type !== "string") return state;
    if (event.type === "start") {
      return state.active || !event.captureId ? state : { ...DICTATION_EMPTY, active: true, phase: "starting", captureId: event.captureId };
    }
    if (!state.active) return state;
    if (event.type.startsWith("dictation_") && event.captureId !== state.captureId) return state;
    switch (event.type) {
      case "dictation_state":
        if (!["starting", "recording", "transcribing"].includes(event.state) || state.phase === "stopping") return state;
        return { ...state, phase: event.state };
      case "dictation_transcript":
        return typeof event.text === "string" && event.text !== state.text ? { ...state, text: event.text } : state;
      case "stop":
        return state.phase === "stopping" ? state : { ...state, phase: "stopping", error: null };
      case "stop_failure":
        return { ...state, phase: "error", error: event.error || "Could not stop voice to text" };
      case "start_failure":
      case "process_exit":
      case "dictation_end": {
        const error = typeof event.error === "string" && event.error ? event.error : null;
        return { ...state, active: false, phase: error ? "error" : "idle", text: typeof event.text === "string" ? event.text : state.text, error };
      }
      default:
        return state;
    }
  }
  const DICTATION = Object.freeze({ EMPTY: DICTATION_EMPTY, apply: applyDictation });
  window.OMP_LIVE_VOICE = { EMPTY, LIMITS, apply, DICTATION };
})();

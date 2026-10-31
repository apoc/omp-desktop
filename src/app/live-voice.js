// Voice history belongs to the tab's current coding conversation, not an omp call.
// Local actions bracket RPC frames so replayed frames cannot start a call.
(function () {
  const LIMITS = Object.freeze({ transcripts: 100, text: 8192 });
  // `resumable`: this call connected (or resumed a paused one), so an
  // unexpected end pauses it; a call that never connected ends in error.
  const EMPTY = Object.freeze({
    active: false, paused: false, phase: "idle", muted: false, input: 0, output: 0,
    transcripts: Object.freeze([]), error: null, turnOffset: 0, discardTranscripts: false, resumable: false,
  });
  const CONNECTED_PHASES = new Set(["listening", "working", "speaking", "muted"]);
  const PHASES = new Set(["connecting", "listening", "working", "speaking", "muted", "error"]);
  const level = n => typeof n === "number" && Number.isFinite(n) ? Math.max(0, Math.min(1, n)) : 0;
  // RMS amplitude from omp, not sample peaks: this cannot detect clipping.
  function meterLevel(amplitude) {
    const rms = level(amplitude);
    const db = rms > 0 ? 20 * Math.log10(rms) : -Infinity;
    return {
      value: Math.max(-60, db),
      text: rms === 0 ? "−∞ dBFS" : db < -60 ? "<−60 dBFS" : `${Math.round(db)} dBFS`,
    };
  }
  function bounded(text) {
    if (text.length <= LIMITS.text) return text;
    let end = LIMITS.text;
    const last = text.charCodeAt(end - 1);
    if (last >= 0xd800 && last <= 0xdbff) end--;
    return text.slice(0, end);
  }
  function ended(state, error, paused = false) {
    const message = typeof error === "string" && error ? error : null;
    return { ...state, active: false, paused, phase: paused ? "paused" : message ? "error" : "idle", muted: false, input: 0, output: 0, error: message };
  }
  function apply(state, event) {
    if (!event || typeof event.type !== "string") return state;
    switch (event.type) {
      case "start": {
        if (state.active) return state;
        // Native role-local turn numbers start over on every call. Shift each
        // call beyond all retained turns so existing role+turn keys stay stable.
        const turnOffset = state.transcripts.length ? Math.max(...state.transcripts.map(t => t.turn)) + 1 : 0;
        return { ...state, active: true, paused: false, phase: "connecting", muted: false, input: 0, output: 0,
          error: null, turnOffset, discardTranscripts: false, resumable: state.paused };
      }
      case "stop":
        if (!state.active) return state.paused ? ended(state, null) : state;
        return state.phase === "stopping" ? state : { ...state, phase: "stopping", input: 0, output: 0, error: null };
      case "stop_success":
        return state.phase === "stopping" ? ended(state, null, !!event.paused && !state.discardTranscripts) : state;
      case "stop_failure":
        return state.phase === "stopping" ? { ...state, phase: "error", error: event.error || "Could not stop live voice" } : state;
      case "start_failure":
        return state.active && state.phase !== "stopping" ? ended(state, event.error || "Could not start live voice", !!event.paused) : state;
      case "forget":
        // An in-process conversation change can leave a recorder stopping.
        // Keep it visible, but do not attribute its remaining frames to the new conversation.
        return state.active ? { ...state, transcripts: [], turnOffset: 0, discardTranscripts: true }
          : { ...EMPTY, transcripts: [] };
      case "mute_success":
        return state.active && state.phase !== "stopping" && typeof event.muted === "boolean"
          ? { ...state, muted: event.muted, error: null, input: event.muted ? 0 : state.input }
          : state;
      case "mute_failure":
        return state.active && state.phase !== "stopping" ? { ...state, error: event.error || "Could not change microphone mute" } : state;
      case "process_exit":
        return state.active ? ended(state, event.error || state.error || "The omp process ended during live voice", true) : state;
      case "live_end":
        // During an explicit stop omp can report a transport error caused by
        // cancellation. Stop's reply, not that error, decides the outcome.
        // omp sends this end before its failed `live_start` reply (a missing
        // Codex login), so a never-connected call must not read as paused.
        if (!state.active || state.phase === "stopping") return state;
        return ended(state, event.error, state.resumable);
      case "live_phase":
        if (!state.active || state.phase === "stopping" || !PHASES.has(event.phase)) return state;
        return { ...state, phase: event.phase, muted: event.phase === "muted" || state.muted,
          input: event.phase === "muted" ? 0 : state.input, resumable: state.resumable || CONNECTED_PHASES.has(event.phase) };
      case "live_levels": {
        if (!state.active || state.phase === "stopping") return state;
        const input = state.muted ? 0 : level(event.input);
        const output = level(event.output);
        return input === state.input && output === state.output ? state : { ...state, input, output };
      }
      case "live_transcript": {
        if (state.discardTranscripts || (event.role !== "user" && event.role !== "assistant") ||
            !Number.isSafeInteger(event.turn) || event.turn < 0 || !Number.isSafeInteger(event.turn + state.turnOffset) ||
            typeof event.text !== "string" || typeof event.final !== "boolean") return state;
        const entry = { role: event.role, turn: event.turn + state.turnOffset, text: bounded(event.text), final: event.final };
        const i = state.transcripts.findIndex(t => t.role === entry.role && t.turn === entry.turn);
        // Once the call ends only a final for an existing partial can land;
        // stale replayed frames cannot create new captions in an inactive tab.
        if (!state.active && (!entry.final || i === -1)) return state;
        if (i !== -1) {
          const old = state.transcripts[i];
          if (!state.active && old.final) return state;
          // A replayed partial must never overwrite a final transcript.
          if (old.final && !entry.final) return state;
          if (old.text === entry.text && old.final === entry.final) return state;
          const transcripts = state.transcripts.slice();
          transcripts[i] = entry;
          return { ...state, transcripts, resumable: state.resumable || state.active };
        }
        const transcripts = [...state.transcripts, entry].slice(-LIMITS.transcripts);
        return { ...state, transcripts, resumable: state.resumable || state.active };
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
  window.OMP_LIVE_VOICE = { EMPTY, LIMITS, apply, DICTATION, meterLevel };
})();

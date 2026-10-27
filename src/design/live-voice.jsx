/* Live voice controls and ephemeral captions for the active tab. */
function LiveVoicePanel({ voice, error, onAction }) {
  const active = !!voice?.active;
  const phase = voice?.phase ?? "idle";
  const transcripts = voice?.transcripts ?? [];
  if (!active && !voice?.error && !error && !transcripts.length) return null;

  const level = value => Math.max(0, Math.min(1, Number(value) || 0));
  return (
    <section className="live-voice" aria-label="Live voice">
      <div className="live-voice-head">
        <span className="live-voice-title">live voice</span>
        <span className="live-voice-phase" role="status">{phase}</span>
        {active && <>
          <label>mic <meter min="0" max="1" value={level(voice.input)} aria-label="Microphone level" /></label>
          <label>speaker <meter min="0" max="1" value={level(voice.output)} aria-label="Speaker level" /></label>
        </>}
        <span className="live-voice-spacer" />
        {active ? <>
          <button className="btn outlined" onClick={() => onAction(voice.muted ? "unmute" : "mute")}
            disabled={phase === "connecting" || phase === "stopping"}
            aria-pressed={!!voice.muted}>{voice.muted ? "unmute" : "mute"}</button>
          <button className="btn outlined" onClick={() => onAction("stop")}
            disabled={phase === "stopping"}>{phase === "connecting" ? "cancel" : "end"}</button>
        </> : null}
      </div>
      {(error || voice?.error) && <div className="live-voice-error" role="alert">{error || voice.error}</div>}
      {transcripts.length > 0 && <ol className="live-voice-captions" aria-label="Live voice captions">
        {transcripts.map(item => <li key={`${item.role}-${item.turn}`}>
          <span className="live-voice-role">{item.role === "user" ? "you" : "assistant"}</span>
          <span>{item.text}</span>{!item.final && <span className="live-voice-interim">…</span>}
        </li>)}
      </ol>}
    </section>
  );
}
// Each mode stays in place while active so its button can stop or cancel it.
function VoiceModeButton({ live, dictation, onLiveAction, onDictationAction }) {
  const dictating = !!dictation?.active;
  const calling = !!live?.active;
  const dictationBusy = dictating && (dictation.phase === "starting" || dictation.phase === "stopping");
  const liveBusy = calling && (live.phase === "connecting" || live.phase === "stopping");
  const dictationLabel = dictating ? (dictation.phase === "starting" ? "Cancel voice to text" : "Stop voice to text") : "Start voice to text";
  const liveLabel = calling ? (live.phase === "connecting" ? "Cancel live conversation" : "Stop live conversation") : "Start live conversation";
  return <>
    <button className={`btn icon ghost${dictating ? " live-voice-mic-on" : ""}`}
      title={dictationLabel} aria-label={dictationLabel} aria-pressed={dictating} aria-busy={dictationBusy}
      disabled={calling || (dictating && dictation.phase === "stopping")}
      onClick={() => onDictationAction(dictating ? "stop" : "start")}>
      <window.Icon name="voice" size={13} />
    </button>
    <button className={`btn icon ghost${calling ? " live-voice-mic-on" : ""}`}
      title={liveLabel} aria-label={liveLabel} aria-pressed={calling} aria-busy={liveBusy}
      disabled={dictating || (calling && live.phase === "stopping")}
      onClick={() => onLiveAction(calling ? "stop" : "start")}>
      <window.Icon name="conversation" size={13} />
    </button>
  </>;
}

function DictationPanel({ dictation, error, onAction }) {
  if (!dictation?.active && !dictation?.error && !error) return null;
  const phase = dictation?.phase ?? "idle";
  return <section className="live-voice" aria-label="Voice to text">
    <div className="live-voice-head">
      <span className="live-voice-title">voice to text</span>
      <span className="live-voice-phase" role="status">{phase === "stopping" ? "transcribing" : phase}</span>
      <span className="live-voice-spacer" />
      {dictation?.active && <button className="btn outlined" onClick={() => onAction("stop")} disabled={phase === "stopping"}>
        {phase === "starting" ? "cancel" : "stop"}
      </button>}
    </div>
    {(error || dictation?.error) && <div className="live-voice-error" role="alert">{error || dictation.error}</div>}
    {dictation?.active && dictation.text && <div className="dictation-preview" aria-label="Dictation preview">{dictation.text}</div>}
  </section>;
}

Object.assign(window, { LiveVoicePanel, VoiceModeButton, DictationPanel });

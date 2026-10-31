// The composer's voice spectrum: runs the Rust microphone analyser while
// `active` (OMP_VOICE_SPECTRUM.shouldRun) and keeps its newest frame in a
// ref, so ~30 frames a second never re-render React; the canvas reads it.
// Returns that ref once the analyser started, else null (no microphone, or
// not recording).
function useVoiceSpectrum(bridge, active) {
  const frameRef = React.useRef(null);
  const [running, setRunning] = React.useState(false);
  React.useEffect(() => {
    if (!bridge) return undefined;
    // Also on the first render: a reloaded window may have left one running.
    if (!active) { bridge.voiceSpectrumStop(); return undefined; }
    let live = true;
    const sub = bridge.onVoiceSpectrum(bands => { frameRef.current = bands; });
    bridge.voiceSpectrumStart().then(res => {
      if (!live) return;
      if (res.ok) setRunning(true);
      else console.warn("[voice-spectrum] no microphone analysis:", res.error);
    });
    return () => {
      live = false;
      sub.stop();
      frameRef.current = null;
      setRunning(false);
    };
  }, [bridge, active]);
  return running ? frameRef : null;
}

window.useVoiceSpectrum = useVoiceSpectrum;

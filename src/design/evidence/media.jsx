/* Artifact data comes only from the authorized native media service. */
(function () {
  function Artifact({ evidence, artifact }) {
    const [opened, setOpened] = React.useState(false);
    const [state, setState] = React.useState(null);
    const [error, setError] = React.useState("");
    React.useEffect(() => {
      if (!opened || !artifact?.id) return undefined;
      let active = true;
      setState(null);
      setError("");
      const mime = artifact.mime || "";
      const text =
        mime.startsWith("text/") ||
        [
          "application/json",
          "application/javascript",
          "application/xml",
        ].includes(mime);
      const image = [
        "image/png",
        "image/jpeg",
        "image/gif",
        "image/webp",
      ].includes(mime);
      const video = ["video/mp4", "video/webm"].includes(mime);
      if (!text && !image && !video) {
        setError("This artifact type cannot be previewed safely.");
        return undefined;
      }
      Promise.resolve()
        .then(() =>
          text
            ? evidence.assetText(artifact.id)
            : evidence.assetSource(artifact.id),
        )
        .then((value) => {
          if (active)
            setState({
              type: text ? "text" : image ? "image" : "video",
              value,
            });
        })
        .catch((err) => {
          if (active) setError(err?.message || String(err));
        });
      return () => {
        active = false;
      };
    }, [
      opened,
      artifact?.id,
      artifact?.mime,
      evidence.assetSource,
      evidence.assetText,
    ]);
    if (!artifact) return <p className="ev-note">No artifact attached.</p>;
    return (
      <div className="ev-artifact">
        <div className="ev-row">
          <span>
            {artifact.name || "Artifact"}{" "}
            <span className="ev-meta">
              · {artifact.mime} · {artifact.bytes} bytes
            </span>
          </span>
          <button className="btn ghost" onClick={() => setOpened(!opened)}>
            {opened ? "Hide" : "View"}
          </button>
        </div>
        {artifact.sha256 && (
          <div className="ev-meta ev-break">SHA-256 {artifact.sha256}</div>
        )}
        {opened && (
          <div className="ev-preview">
            {error ? (
              <p className="ev-error" role="alert">
                Artifact unavailable: {error}
              </p>
            ) : !state ? (
              <p className="ev-note">Loading artifact…</p>
            ) : state.type === "text" ? (
              <>
                <pre className="selectable">{state.value.text}</pre>
                {state.value.truncated && (
                  <p className="ev-note">Text preview is truncated.</p>
                )}
              </>
            ) : state.type === "image" ? (
              <img
                src={state.value.url}
                alt={artifact.name || "Evidence image"}
                onError={() => setError("Image could not be loaded.")}
              />
            ) : (
              <video
                controls
                preload="metadata"
                src={state.value.url}
                onError={() => setError("Video could not be loaded.")}
              >
                <p>Video playback is unavailable.</p>
              </video>
            )}
          </div>
        )}
      </div>
    );
  }
  window.EvidenceArtifact = Artifact;
})();

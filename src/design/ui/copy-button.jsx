/* ui/copy-button.jsx — one-click copy for chat output (issue #33).

   - copyText(text): clipboard write, resolves true/false (never rejects).
   - CopyButton: React button for blocks the app renders itself (assistant
     message, tool output, eval cells, diffs); nothing while `text` is empty.
   - CopyHost: a block with a floating CopyButton in its top-right corner.
   - copyCodeBlockClick: delegated click handler for the buttons
     marked-setup.js puts in fenced code blocks. Those come out of a
     `dangerouslySetInnerHTML` string, so they carry no handler of their own
     (the release CSP forbids inline handlers, and build-frontend.mjs fails
     on any `on*=` attribute); the markdown container's onClick resolves the
     button and copies its block's `<code>` text — the fence content exactly,
     since highlight.js only wraps it in spans.

   The icon and the "copied" label are CSS (`.copy-btn` in layout/chat.css),
   so the buttons have no text content: a manual selection across a message
   copies none of them. */

const COPY_FLASH_MS = 1500;

/** Resolves true once `text` is on the clipboard, false otherwise. */
function copyText(text) {
  if (!navigator.clipboard?.writeText) return Promise.resolve(false);
  return navigator.clipboard.writeText(text).then(() => true, (err) => {
    console.warn("[copy] clipboard write failed:", err);
    return false;
  });
}

/** `className` adds placement: `is-floating` (top-right of a `.copy-host`
 *  block, on hover) or a surface's own class. */
function CopyButton({ text, label, className }) {
  // An object, not a string: a repeat click re-creates it, which restarts
  // the reset timer below instead of letting the first click's run out.
  const [flash, setFlash] = React.useState(null);
  React.useEffect(() => {
    if (!flash) return undefined;
    const id = setTimeout(() => setFlash(null), COPY_FLASH_MS);
    return () => clearTimeout(id);
  }, [flash]);
  const onClick = (e) => {
    e.stopPropagation();
    copyText(text).then((ok) => setFlash({ ok }));
  };
  if (!text) return null;
  const state = flash ? (flash.ok ? " is-copied" : " is-failed") : "";
  return (
    <button type="button" className={`copy-btn${className ? " " + className : ""}${state}`}
      aria-label={label} title={label} onClick={onClick} />
  );
}

function CopyHost({ text, label, children }) {
  return (
    <div className="copy-host">
      {children}
      <CopyButton className="is-floating" text={text} label={label} />
    </div>
  );
}

// Reset timers of the marked-rendered buttons; the button may be replaced
// by a re-render (streaming) before its timer fires, which is harmless.
const _copyFlashTimers = new WeakMap();

function copyCodeBlockClick(e) {
  const btn = e.target.closest?.("button.copy-btn");
  if (!btn || !e.currentTarget.contains(btn)) return;
  const code = btn.closest("pre.code-block")?.querySelector("code");
  if (!code) return;
  e.stopPropagation();
  copyText(code.textContent).then((ok) => {
    btn.classList.toggle("is-copied", ok);
    btn.classList.toggle("is-failed", !ok);
    clearTimeout(_copyFlashTimers.get(btn));
    _copyFlashTimers.set(btn, setTimeout(() => btn.classList.remove("is-copied", "is-failed"), COPY_FLASH_MS));
  });
}

Object.assign(window, { copyText, CopyButton, CopyHost, copyCodeBlockClick });

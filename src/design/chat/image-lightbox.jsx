/* ═════════════════════════════════════════════════════════════════════
   chat/image-lightbox.jsx — enlarged view of a message's attached images
   (issue #25). Opens with a FLIP "pop out" from the clicked thumbnail and
   shrinks back into the current one on close.

   Props: { images, index, onIndex, onClose, thumbFor }
     images   — image src strings (data URLs) of one message
     index    — image shown; onIndex(i) switches it
     onClose  — called once the close animation has finished
     thumbFor — i → the thumbnail element to fly from / back into
   ═════════════════════════════════════════════════════════════════════ */
const { Icon: _LB_Icon } = window;
const { fitRect: _LB_fitRect, flipTransform: _LB_flipTransform, stepIndex: _LB_stepIndex } = window.OMP_LIGHTBOX;

const _LB_EASE = "cubic-bezier(0.22, 1, 0.36, 1)"; // --ease-out
const _LB_OPEN_MS = 320;
const _LB_CLOSE_MS = 220;

function _LB_reducedMotion() {
  return window.matchMedia?.("(prefers-reduced-motion: reduce)").matches ?? false;
}

function _LB_viewport() {
  return { w: window.innerWidth, h: window.innerHeight };
}

function ImageLightbox({ images, index, onIndex, onClose, thumbFor }) {
  const count = images.length;
  const [view, setView] = React.useState(_LB_viewport);
  // Natural size of images[index]; tagged with its index so a stale size
  // never lays out the next image while that one is still decoding.
  const [natural, setNatural] = React.useState(null);
  const [closing, setClosing] = React.useState(false);
  const imgRef = React.useRef(null);
  const scrimRef = React.useRef(null);
  const openedRef = React.useRef(false);
  const closingRef = React.useRef(false);
  // Set by the first prev/next: from then on a newly shown image fades in
  // (the first one pops out of its thumbnail instead).
  const [navigated, setNavigated] = React.useState(false);

  const size = natural?.index === index ? natural : null;
  const rect = size ? _LB_fitRect(size.w, size.h, view.w, view.h) : null;
  const rectRef = React.useRef(rect);
  rectRef.current = rect;

  const readNatural = (el) => {
    if (el?.naturalWidth) setNatural({ index, w: el.naturalWidth, h: el.naturalHeight });
  };

  // A data URL the thumbnail already decoded is usually `complete` at
  // mount; reading it here (before paint) avoids a hidden first frame.
  React.useLayoutEffect(() => {
    if (imgRef.current?.complete) readNatural(imgRef.current);
  }, [index]); // eslint-disable-line react-hooks/exhaustive-deps

  // Pop out of the thumbnail — once, on the first laid-out frame.
  React.useLayoutEffect(() => {
    if (openedRef.current || !rect) return;
    openedRef.current = true;
    const thumb = thumbFor(index);
    if (!thumb || _LB_reducedMotion()) return;
    imgRef.current.animate(
      [{ transform: _LB_flipTransform(thumb.getBoundingClientRect(), rect) }, { transform: "none" }],
      { duration: _LB_OPEN_MS, easing: _LB_EASE },
    );
  });

  const close = React.useCallback(() => {
    if (closingRef.current) return;
    closingRef.current = true;
    const rect = rectRef.current;
    const thumb = thumbFor(index);
    if (!rect || !thumb || _LB_reducedMotion()) { onClose(); return; }
    setClosing(true);
    // Closing mid-open (a double-click, or Esc right away): shrink back from
    // where the pop-out has got to, not from full size — the open animation
    // is cancelled, and a new one would otherwise start at `transform: none`.
    const img = imgRef.current;
    const start = getComputedStyle(img).transform;
    img.getAnimations().forEach((a) => a.cancel());
    const anim = img.animate(
      [{ transform: start }, { transform: _LB_flipTransform(thumb.getBoundingClientRect(), rect) }],
      { duration: _LB_CLOSE_MS, easing: _LB_EASE, fill: "forwards" },
    );
    anim.onfinish = onClose;
    anim.oncancel = onClose;
  }, [index, thumbFor, onClose]);

  const step = React.useCallback((delta) => {
    if (count < 2 || closingRef.current) return;
    setNavigated(true);
    onIndex(_LB_stepIndex(index, delta, count));
  }, [count, index, onIndex]);

  // Capture phase + preventDefault: the global keymap dispatcher skips
  // defaultPrevented events, so Escape closes the viewer instead of also
  // interrupting a running turn.
  React.useEffect(() => {
    const onKey = (e) => {
      let handled = true;
      if (e.key === "Escape") close();
      else if (e.key === "ArrowLeft") step(-1);
      else if (e.key === "ArrowRight") step(1);
      else handled = false;
      if (handled) { e.preventDefault(); e.stopPropagation(); }
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [close, step]);

  React.useEffect(() => {
    const onResize = () => setView(_LB_viewport());
    window.addEventListener("resize", onResize);
    return () => window.removeEventListener("resize", onResize);
  }, []);

  // Modal: the app behind (#root — this renders in a portal on <body>) is
  // inert, so Tab can't reach, and Enter can't press, another thumbnail
  // and stack a second viewer. Focus goes back where it was on close.
  React.useEffect(() => {
    const prev = document.activeElement;
    const root = document.getElementById("root");
    if (root) root.inert = true;
    scrimRef.current?.focus();
    return () => {
      if (root) root.inert = false;
      // preventScroll: the thumbnail may have scrolled out of view while the
      // viewer was open (a streaming reply), and scrolling back to it would
      // unpin the chat from the bottom (app/scroll-pin.js).
      if (prev?.isConnected) prev.focus({ preventScroll: true });
    };
  }, []);

  const imgStyle = rect
    ? { left: rect.left, top: rect.top, width: rect.width, height: rect.height }
    : { visibility: "hidden" };
  const nav = (delta) => (e) => { e.stopPropagation(); step(delta); };

  return ReactDOM.createPortal(
    <div
      ref={scrimRef}
      className={`lightbox${closing ? " is-closing" : ""}`}
      role="dialog"
      aria-modal="true"
      aria-label="Attached image"
      tabIndex={-1}
      onClick={close}
    >
      <img
        key={index}
        ref={imgRef}
        className={`lightbox-img${navigated ? " is-swap" : ""}`}
        src={images[index]}
        alt={`attached image ${index + 1} of ${count}`}
        style={imgStyle}
        onLoad={(e) => readNatural(e.currentTarget)}
      />
      <button className="lightbox-btn lightbox-close" title="Close (Esc)" onClick={(e) => { e.stopPropagation(); close(); }}>
        <_LB_Icon name="close" size={14} />
      </button>
      {count > 1 && (
        <React.Fragment>
          <button className="lightbox-btn lightbox-prev" title="Previous (←)" onClick={nav(-1)}>
            <_LB_Icon name="chevR" size={16} />
          </button>
          <button className="lightbox-btn lightbox-next" title="Next (→)" onClick={nav(1)}>
            <_LB_Icon name="chevR" size={16} />
          </button>
          <div className="lightbox-count mono">{index + 1} / {count}</div>
        </React.Fragment>
      )}
    </div>,
    document.body,
  );
}

window.ImageLightbox = ImageLightbox;

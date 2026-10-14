// app/browser-screen.js — DOM side of the browser panel (docs/architecture/browser.md):
// paints the latest screencast frame on a canvas and
// forwards the user's pointer, wheel, key and paste input to the page.
//   createScreen({ view, canvas, send, onResize, onPage, swallowKey })
//     -> { frame(f), size(), destroy() }
// `view` is the focusable wrapper (tabIndex 0) the canvas fills; `send(ev)`
// takes an `InputEvent` (app/browser.js); `onResize(w, h, dpr)` fires 100 ms
// after the view's CSS size settled on a new value; `onPage({cssW, cssH})`
// when the painted frame's CSS size changes; `swallowKey(e)` keeps a key from the
// page (annotate's Esc). Pure mappings live in app/browser.js; DOM scheduling
// and painting have a minimal-stub regression in tests/test-browser-runtime.mjs.
(function () {
  const RESIZE_MS = 100;
  const LINE_PX = 16;

  function bytesOf(b64) {
    const bin = atob(b64);
    const out = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
    return out;
  }

  function createScreen({ view, canvas, send, onResize, onPage, swallowKey }) {
    const B = window.OMP_BROWSER;
    const ctx = canvas.getContext("2d");
    let dead = false;
    let last = null; // newest frame received: its CSS size maps the clicks
    let incoming = null; // newest frame not yet decoded
    let decoding = false;
    let ready = null; // decoded, not yet painted: { bmp, cssW, cssH }
    let shown = null; // painted: { bmp, cssW, cssH }; kept to redraw after a resize
    let paintRaf = 0;
    let published = null; // geometry sent with the last painted frame
    let moveRaf = 0;
    let move = null;
    let pressed = false;
    let resizeTimer = 0;

    const dpr = () => window.devicePixelRatio || 1;
    const sizeNow = () => {
      const r = view.getBoundingClientRect();
      return { width: Math.round(r.width), height: Math.round(r.height), dpr: dpr() };
    };
    let sent = sizeNow();

    // Canvas backing store = view CSS size × dpr (assigning clears it).
    function fit() {
      const r = view.getBoundingClientRect();
      const w = Math.max(1, Math.round(r.width * dpr()));
      const h = Math.max(1, Math.round(r.height * dpr()));
      if (canvas.width !== w) canvas.width = w;
      if (canvas.height !== h) canvas.height = h;
    }

    function paint() {
      paintRaf = 0;
      if (dead) return;
      fit();
      if (ready) {
        shown?.bmp.close();
        shown = ready;
        ready = null;
      }
      if (shown) {
        ctx.drawImage(shown.bmp, 0, 0, canvas.width, canvas.height);
        // Geometry goes out with the bitmap actually painted, not when the
        // frame arrived: markers map what is on screen.
        if (!published || published.cssW !== shown.cssW || published.cssH !== shown.cssH) {
          published = { cssW: shown.cssW, cssH: shown.cssH };
          onPage(published);
        }
      }
    }
    const schedule = () => { if (!paintRaf) paintRaf = requestAnimationFrame(paint); };

    // Decode only the newest frame; frames that arrive meanwhile replace
    // each other, and a decoded one that was never painted is closed.
    async function pump() {
      if (decoding) return;
      decoding = true;
      while (incoming && !dead) {
        const f = incoming;
        incoming = null;
        try {
          const bmp = await createImageBitmap(new Blob([bytesOf(f.b64)], { type: "image/jpeg" }));
          if (dead) { bmp.close(); break; }
          ready?.bmp.close();
          ready = { bmp, cssW: f.cssW, cssH: f.cssH };
          schedule();
        } catch {
          // an undecodable frame is dropped; the next one replaces it
        }
      }
      decoding = false;
    }

    function frame(f) {
      if (dead || !f?.b64) return;
      last = f;
      incoming = f;
      void pump();
    }

    const ro = new ResizeObserver(() => {
      schedule();
      clearTimeout(resizeTimer);
      resizeTimer = setTimeout(() => {
        const s = sizeNow();
        if (dead || !s.width || !s.height) return;
        if (s.width === sent.width && s.height === sent.height && s.dpr === sent.dpr) return;
        sent = s;
        onResize(s.width, s.height, s.dpr);
      }, RESIZE_MS);
    });
    ro.observe(view);

    // ---- input ---------------------------------------------------------------

    const at = (e) => (last ? B.toPageCoords(e, view.getBoundingClientRect(), last) : null);
    const buttonOf = (e) => (e.buttons & 1 ? "left" : e.buttons & 4 ? "middle" : e.buttons & 2 ? "right" : "none");

    function mouse(type, e, button) {
      const p = at(e);
      if (!p) return;
      send({ kind: "mouse", type, x: p.x, y: p.y, button, buttons: e.buttons, clickCount: type === "mouseMoved" ? 0 : Math.max(1, e.detail), modifiers: B.modifiersOf(e) });
    }

    // The coalesced move still in its rAF belongs to the gesture in flight;
    // it goes out before a release or a new press, so a fast drag stays an
    // area pick and a pressed move never follows the release.
    function flushMove() {
      if (!moveRaf) return;
      cancelAnimationFrame(moveRaf);
      moveRaf = 0;
      if (move && !dead) send(move);
      move = null;
    }

    const onDown = (e) => {
      if (e.target !== canvas) return;
      e.preventDefault(); // keeps the page selection ours, so focus is taken by hand
      view.focus();
      pressed = true;
      flushMove();
      mouse("mousePressed", e, ["left", "middle", "right"][e.button] ?? "left");
    };
    const onUp = (e) => {
      if (!pressed) return;
      pressed = false;
      flushMove();
      mouse("mouseReleased", e, ["left", "middle", "right"][e.button] ?? "left");
    };
    // Moves are coalesced to one per frame; a drag keeps reporting after the
    // pointer left the view.
    const onMove = (e) => {
      if (!pressed && e.target !== canvas) return;
      const p = at(e);
      if (!p) return;
      move = { kind: "mouse", type: "mouseMoved", x: p.x, y: p.y, button: buttonOf(e), buttons: e.buttons, clickCount: 0, modifiers: B.modifiersOf(e) };
      if (!moveRaf) {
        moveRaf = requestAnimationFrame(() => {
          moveRaf = 0;
          if (move && !dead) send(move);
          move = null;
        });
      }
    };
    const onWheel = (e) => {
      if (e.target !== canvas) return;
      e.preventDefault();
      const p = at(e);
      if (!p) return;
      const unit = e.deltaMode === 1 ? LINE_PX : e.deltaMode === 2 ? view.clientHeight : 1;
      send({ kind: "wheel", x: p.x, y: p.y, deltaX: e.deltaX * unit, deltaY: e.deltaY * unit, modifiers: B.modifiersOf(e) });
    };
    const onContext = (e) => { if (e.target === canvas) e.preventDefault(); };

    // Only keys typed on the view itself (not in the popover or toolbar).
    const isPaste = (e) => (e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "v";
    const onKey = (type) => (e) => {
      if (e.target !== view || e.isComposing || swallowKey(e) || isPaste(e)) return; // paste arrives as text
      e.preventDefault();
      send(B.keyEventToCdp(e, type));
    };
    const onKeyDown = onKey("keyDown");
    const onKeyUp = onKey("keyUp");
    const onPaste = (e) => {
      const text = e.clipboardData?.getData("text/plain");
      if (e.target !== view || !text) return;
      e.preventDefault();
      send({ kind: "text", text });
    };

    const on = [
      [view, "mousedown", onDown], [window, "mouseup", onUp], [window, "mousemove", onMove],
      [view, "wheel", onWheel, { passive: false }], [view, "contextmenu", onContext],
      [view, "keydown", onKeyDown], [view, "keyup", onKeyUp], [view, "paste", onPaste],
    ];
    for (const [t, type, fn, opt] of on) t.addEventListener(type, fn, opt);

    function destroy() {
      dead = true;
      for (const [t, type, fn, opt] of on) t.removeEventListener(type, fn, opt);
      ro.disconnect();
      clearTimeout(resizeTimer);
      cancelAnimationFrame(paintRaf);
      cancelAnimationFrame(moveRaf);
      ready?.bmp.close();
      shown?.bmp.close();
      ready = shown = null;
    }

    return { frame, size: sizeNow, destroy };
  }

  window.OMP_BROWSER_SCREEN = { createScreen };
})();

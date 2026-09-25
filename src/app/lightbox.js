/* ═════════════════════════════════════════════════════════════════════
   app/lightbox.js — geometry for the attached-image viewer (issue #25).
   Pure functions only; design/chat/image-lightbox.jsx owns the DOM side.
   Rects are { left, top, width, height } in viewport pixels.
   ═════════════════════════════════════════════════════════════════════ */
(function () {
  // Viewport space kept free around the enlarged image: the sides hold the
  // prev/next buttons, top and bottom the close button and the counter.
  const PAD_X = 72;
  const PAD_Y = 56;
  // A screenshot smaller than the viewport is enlarged, but never past this
  // factor — beyond it the upscale blur hides more than it reveals.
  const MAX_UPSCALE = 2;

  // Rect the image is shown at: its natural aspect, as large as the padded
  // viewport allows (capped at MAX_UPSCALE), centred. `null` while the
  // natural size is unknown (image not decoded yet).
  function fitRect(naturalW, naturalH, viewW, viewH) {
    if (!(naturalW > 0 && naturalH > 0)) return null;
    const boxW = Math.max(viewW - 2 * PAD_X, 1);
    const boxH = Math.max(viewH - 2 * PAD_Y, 1);
    const scale = Math.min(boxW / naturalW, boxH / naturalH, MAX_UPSCALE);
    const width = Math.round(naturalW * scale);
    const height = Math.round(naturalH * scale);
    return {
      left: Math.round((viewW - width) / 2),
      top: Math.round((viewH - height) / 2),
      width,
      height,
    };
  }

  // Transform that, applied to an element laid out at `to` with
  // `transform-origin: 0 0`, makes it cover `from` exactly — the "first"
  // frame of a FLIP animation from a thumbnail to the enlarged image (and
  // the last frame of the way back).
  function flipTransform(from, to) {
    const x = from.left - to.left;
    const y = from.top - to.top;
    const sx = from.width / to.width;
    const sy = from.height / to.height;
    return `translate(${x}px, ${y}px) scale(${sx}, ${sy})`;
  }

  // Previous/next image, wrapping around at either end.
  function stepIndex(index, delta, count) {
    return (((index + delta) % count) + count) % count;
  }

  window.OMP_LIGHTBOX = { fitRect, flipTransform, stepIndex };
})();

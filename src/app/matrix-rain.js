// Empty-workspace backdrop: pure "digital rain" + ASCII logo geometry.
//
// Exposes `window.OMP_MATRIX`; wrapped as an IIFE per the project rule for
// plain <script> tags (see CLAUDE.md "IIFE rule"). The canvas, timing and
// colours live in design/empty-workspace.jsx; everything here is pure so
// the fit/step rules are testable (test-matrix-rain.mjs).
(function () {
  // "OMP-DESKTOP" in the ANSI Shadow figlet style. Every row is padded to
  // the same width: the logo is drawn cell by cell, so a short row would
  // shear the letters.
  const LOGO = [
    " ██████╗ ███╗   ███╗██████╗       ██████╗ ███████╗███████╗██╗  ██╗████████╗ ██████╗ ██████╗ ",
    "██╔═══██╗████╗ ████║██╔══██╗      ██╔══██╗██╔════╝██╔════╝██║ ██╔╝╚══██╔══╝██╔═══██╗██╔══██╗",
    "██║   ██║██╔████╔██║██████╔╝█████╗██║  ██║█████╗  ███████╗█████╔╝    ██║   ██║   ██║██████╔╝",
    "██║   ██║██║╚██╔╝██║██╔═══╝ ╚════╝██║  ██║██╔══╝  ╚════██║██╔═██╗    ██║   ██║   ██║██╔═══╝ ",
    "╚██████╔╝██║ ╚═╝ ██║██║           ██████╔╝███████╗███████║██║  ██╗   ██║   ╚██████╔╝██║     ",
    " ╚═════╝ ╚═╝     ╚═╝╚═╝           ╚═════╝ ╚══════╝╚══════╝╚═╝  ╚═╝   ╚═╝    ╚═════╝ ╚═╝     ",
  ];
  const LOGO_COLS = LOGO[0].length;
  const LOGO_ROWS = LOGO.length;

  // Half-width katakana for the classic look, plus code-ish ASCII. Each
  // glyph is drawn alone in its own cell, so a missing font glyph only ever
  // falls back for that one character.
  const GLYPHS = "ｱｲｳｴｵｶｷｸｹｺｻｼｽｾｿﾀﾁﾂﾃﾄﾅﾆﾇﾈﾉﾊﾋﾌﾍﾎﾏﾐﾑﾒﾓﾔﾕﾖﾗﾘﾙﾚﾛﾜﾝ0123456789<>/{}[]=+*#$";

  /** Font size and origin that centre the logo, or `null` when the area is
   *  too small to draw it legibly.
   *
   *  `cellW`/`cellH` are the measured glyph width/height *per 1px of font
   *  size* (monospace, so one pair covers every cell). The logo is capped
   *  at `maxWidthFrac` of the width and `maxHeightFrac` of the height, and
   *  at `maxFont` so it doesn't balloon on a wide monitor. */
  function fitLogo(width, height, { cellW, cellH, maxWidthFrac = 0.8, maxHeightFrac = 0.4, maxFont = 18, minFont = 5 }) {
    if (!(width > 0 && height > 0 && cellW > 0 && cellH > 0)) return null;
    const font = Math.floor(Math.min(
      maxFont,
      (width * maxWidthFrac) / (LOGO_COLS * cellW),
      (height * maxHeightFrac) / (LOGO_ROWS * cellH),
    ));
    if (font < minFont) return null;
    const w = LOGO_COLS * cellW * font;
    const h = LOGO_ROWS * cellH * font;
    return { font, x: (width - w) / 2, y: (height - h) / 2, width: w, height: h };
  }

  /** One drop per rain column, each at a random row above the top edge so
   *  the columns don't start in lockstep. */
  function initDrops(columns, rows, rand) {
    const drops = new Array(Math.max(0, columns));
    for (let i = 0; i < drops.length; i++) drops[i] = 0 - Math.floor(rand() * rows);
    return drops;
  }

  /** Advance every drop by one row. A drop that has left the bottom
   *  restarts at the top with probability `1 - resetOdds` per step, which
   *  staggers the columns over time instead of re-synchronising them. */
  function stepDrops(drops, rows, rand, resetOdds = 0.975) {
    for (let i = 0; i < drops.length; i++) {
      drops[i] = drops[i] > rows && rand() > resetOdds ? 0 : drops[i] + 1;
    }
    return drops;
  }

  function randomGlyph(rand) {
    return GLYPHS[Math.floor(rand() * GLYPHS.length)];
  }

  window.OMP_MATRIX = { LOGO, LOGO_COLS, LOGO_ROWS, GLYPHS, fitLogo, initDrops, stepDrops, randomGlyph };
})();

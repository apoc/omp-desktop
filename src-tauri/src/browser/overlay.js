// The annotate overlay, run in the isolated world "omp-annotate" of every page
// of the browser panel (see `annotate.rs`). It reports through the binding
// `__ompAnnotate`, which Chromium exposes in that world only: the page's own
// scripts can neither call it nor see this file's state.
//
// Everything is drawn with CSSOM (`element.style.x = ...`) and `textContent`,
// never a <style> element, a `style="..."` attribute or markup strings, so a
// page whose CSP forbids inline styles (or demands Trusted Types) cannot block
// it.
(() => {
  'use strict';
  // One overlay per page: frames inside it are not annotated (their picks
  // would be in the frame's own coordinates).
  if (window.top !== window || window.__ompAnnotateSet) return;

  const DRAG_PX = 4;
  const MAX_HTML = 20000;
  const MAX_TEXT = 500;
  const MAX_ANCESTORS = 6;
  const MAX_CLASSES = 2;
  const LAYER = '2147483647';
  // Everything a click or a hover would make the page do. Not `wheel` or keys:
  // the page keeps scrolling, and Esc is the panel's business.
  const SWALLOWED = [
    'pointerdown', 'pointerup', 'pointermove', 'pointerover', 'pointerout',
    'mousedown', 'mouseup', 'mousemove', 'mouseover', 'mouseout',
    'click', 'dblclick', 'auxclick', 'contextmenu',
  ];

  let on = false;
  let host = null;
  let hoverBox = null;
  let hoverLabel = null;
  let dragBox = null;
  let start = null; // { x, y } of a pressed left button
  let dragging = false;

  const box = (parent, look) => {
    const el = document.createElement('div');
    Object.assign(el.style, { position: 'fixed', display: 'none', boxSizing: 'border-box' }, look);
    parent.appendChild(el);
    return el;
  };

  const build = () => {
    host = document.createElement('omp-annotate-overlay');
    Object.assign(host.style, {
      position: 'fixed', top: '0', right: '0', bottom: '0', left: '0',
      pointerEvents: 'none', zIndex: LAYER,
    });
    const shadow = host.attachShadow({ mode: 'closed' });
    hoverBox = box(shadow, {
      border: '2px solid #2f81f7', background: 'rgba(47, 129, 247, 0.15)',
    });
    hoverLabel = document.createElement('div');
    Object.assign(hoverLabel.style, {
      position: 'absolute', left: '-2px', bottom: '100%', maxWidth: '60vw',
      overflow: 'hidden', whiteSpace: 'nowrap', textOverflow: 'ellipsis',
      font: '11px/16px monospace', color: '#fff', background: '#2f81f7', padding: '0 4px',
    });
    hoverBox.appendChild(hoverLabel);
    dragBox = box(shadow, {
      border: '2px dashed #2f81f7', background: 'rgba(47, 129, 247, 0.1)',
    });
  };

  const mount = () => {
    if (!on || (host && host.isConnected)) return;
    if (!document.documentElement) {
      document.addEventListener('DOMContentLoaded', mount, { once: true });
      return;
    }
    if (!host) build();
    document.documentElement.appendChild(host);
  };

  const place = (el, x, y, w, h) => {
    Object.assign(el.style, {
      display: 'block', left: x + 'px', top: y + 'px', width: w + 'px', height: h + 'px',
    });
  };

  const clear = () => {
    start = null;
    dragging = false;
    if (hoverBox) hoverBox.style.display = 'none';
    if (dragBox) dragBox.style.display = 'none';
  };

  const cls = (el) => Array.from(el.classList).slice(0, MAX_CLASSES)
    .map((c) => '.' + CSS.escape(c)).join('');

  // `s.slice(0, n)` may cut between the two 16-bit halves of a surrogate
  // pair (astral code points: emoji, ...); a lone surrogate is invalid
  // UTF-8, so the pick could not leave the webview.
  const trim = (s, n) => {
    if (s.length <= n) return s;
    const cut = s.slice(0, n);
    const last = cut.charCodeAt(cut.length - 1);
    return last >= 0xd800 && last <= 0xdbff
      ? cut.slice(0, -1)
      : cut;
  };

  const segment = (el) => {
    let seg = CSS.escape(el.tagName.toLowerCase()) + cls(el);
    const parent = el.parentElement;
    if (parent) {
      // `:nth-of-type(n)` only when the tag+class still matches a sibling:
      // `button.save` next to `button.cancel` already picks it out.
      const siblings = Array.from(parent.children);
      if (siblings.some((c) => c !== el && c.tagName === el.tagName && c.matches(seg))) {
        const byTag = siblings.filter((c) => c.tagName === el.tagName);
        seg += ':nth-of-type(' + (byTag.indexOf(el) + 1) + ')';
      }
    }
    return seg;
  };

  const unique = (selector, el) => {
    try {
      const found = document.querySelectorAll(selector);
      return found.length === 1 && found[0] === el;
    } catch (_) {
      return false;
    }
  };

  // `#id`, else `[data-testid="..."]`, else the shortest chain of at most six
  // `tag.class:nth-of-type(n)` segments (nearest ancestors first) that finds
  // only this element.
  const selectorOf = (el) => {
    if (el.id) {
      const byId = '#' + CSS.escape(el.id);
      if (unique(byId, el)) return byId;
    }
    const testId = el.getAttribute('data-testid');
    if (testId !== null) {
      const byTestId = '[data-testid="' + testId.replace(/["\\]/g, '\\$&') + '"]';
      if (unique(byTestId, el)) return byTestId;
    }
    const chain = [];
    let node = el;
    for (let i = 0; i < MAX_ANCESTORS && node && node.nodeType === 1; i += 1) {
      chain.unshift(segment(node));
      const selector = chain.join(' > ');
      if (unique(selector, el) || node === document.documentElement) return selector;
      node = node.parentElement;
    }
    return chain.join(' > ');
  };

  const elementAt = (x, y) => {
    const el = document.elementFromPoint(x, y);
    return el && el !== host ? el : null;
  };

  const documentRect = (rect) => ({
    ...rect, x: rect.x + window.scrollX, y: rect.y + window.scrollY,
  });

  const report = (payload) => {
    try {
      window.__ompAnnotate(JSON.stringify(payload));
    } catch (_) {
      // No binding (the panel detached): nothing to tell.
    }
  };

  const reportElement = (el) => {
    const r = el.getBoundingClientRect();
    const text = el.innerText === undefined ? el.textContent : el.innerText;
    report({
      kind: 'element',
      selector: selectorOf(el),
      tag: el.tagName.toLowerCase(),
      rect: { x: r.x, y: r.y, w: r.width, h: r.height },
      docRect: documentRect({ x: r.x, y: r.y, w: r.width, h: r.height }),
      html: trim(el.outerHTML, MAX_HTML),
      text: trim(text || '', MAX_TEXT),
      url: location.href,
    });
  };

  const reportArea = (a, b) => {
    report({
      kind: 'area',
      selector: null, tag: null, html: null, text: null,
      rect: {
        x: Math.min(a.x, b.x), y: Math.min(a.y, b.y),
        w: Math.abs(a.x - b.x), h: Math.abs(a.y - b.y),
      },
      docRect: documentRect({
        x: Math.min(a.x, b.x), y: Math.min(a.y, b.y),
        w: Math.abs(a.x - b.x), h: Math.abs(a.y - b.y),
      }),
      url: location.href,
    });
  };

  const hover = (x, y) => {
    const el = elementAt(x, y);
    if (!el) {
      hoverBox.style.display = 'none';
      return;
    }
    const r = el.getBoundingClientRect();
    place(hoverBox, r.left, r.top, r.width, r.height);
    hoverLabel.textContent = segment(el);
  };

  const onEvent = (e) => {
    if (!on) return;
    // Cancelling a pointerdown would also suppress the mouse events that
    // follow it, which this overlay is driven by: only stop those.
    if (!e.type.startsWith('pointer')) e.preventDefault();
    e.stopPropagation();
    e.stopImmediatePropagation();
    if (!e.isTrusted || e.button > 0 || !e.type.startsWith('mouse')) return;
    const point = { x: e.clientX, y: e.clientY };
    if (e.type === 'mousedown') {
      start = point;
      dragging = false;
    } else if (e.type === 'mousemove') {
      if (start && !dragging && Math.hypot(point.x - start.x, point.y - start.y) > DRAG_PX) {
        dragging = true;
        hoverBox.style.display = 'none';
      }
      if (dragging) {
        place(dragBox, Math.min(start.x, point.x), Math.min(start.y, point.y),
          Math.abs(point.x - start.x), Math.abs(point.y - start.y));
      } else if (!start) {
        hover(point.x, point.y);
      }
    } else if (e.type === 'mouseup' && start) {
      const from = start;
      const wasDragging = dragging;
      clear();
      if (wasDragging) {
        reportArea(from, point);
      } else {
        const el = elementAt(point.x, point.y);
        if (el) reportElement(el);
      }
    }
  };

  // Registered at once, ahead of the page's own scripts where this runs at
  // document start; `on` decides whether they do anything.
  for (const type of SWALLOWED) window.addEventListener(type, onEvent, true);

  window.__ompAnnotateSet = (value) => {
    on = Boolean(value);
    if (on) {
      mount();
    } else {
      clear();
      if (host) host.remove();
    }
  };
})();

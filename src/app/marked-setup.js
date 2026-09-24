// Wires marked 18 (token-object renderer API) for everything the app renders
// through `dangerouslySetInnerHTML` (ui/markdown.jsx, ui/plan-annotations.jsx):
// highlight.js for code blocks, and the two gaps that would otherwise let
// agent output run script in the app's own privileged origin, which exposes
// `window.__TAURI__`:
//
// - Raw HTML. marked passes it through verbatim, and `<img onerror>`,
//   `<svg onload>`, `<details ontoggle>` or a `srcdoc` iframe run their
//   handlers the moment the markup is inserted. It is rendered as text
//   instead — every tag, block or inline, with no allowlist: a hand-written
//   sanitizer is exactly the thing that gets bypassed.
// - `javascript:` (or `data:`/`vbscript:`) link hrefs. They never fire the
//   webview's navigation-policy hook (`on_navigation`,
//   src-tauri/src/navigation_guard.rs): WebKit executes them inline while
//   resolving the click, before a navigation is even attempted (chromium and
//   WebView2 do the same). marked's own `cleanUrl` only `encodeURI`s the
//   href; it never checks the scheme.
//
// A file, not an inline <script>, so the release CSP can drop
// 'unsafe-inline' from script-src (scripts/build-frontend.mjs fails the build
// on any inline script). Loaded right after marked.min.js/highlight.min.js;
// both are parser-blocking, so they are already defined here.
(function () {
  if (!window.marked || !window.hljs) return;
  // Since marked 15, renderers get raw token fields: `href`, `title`,
  // `lang`, raw HTML and an autolink's `text` arrive unescaped and must be
  // escaped here (and the `autolink` flag itself needs marked 18).
  const escapeHtml = (s) => String(s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
  // marked's own text escape (`escape(text, false)`): `<>"'` always, but a
  // well-formed `&…;` reference stays a reference — output is text-node
  // content, where a reference can only ever decode to a character.
  const escapeKeepingRefs = (s) => String(s)
    .replace(/[<>"']|&(?!(?:#\d{1,7}|#[xX][\da-fA-F]{1,6}|\w+);)/g, escapeHtml);
  // CommonMark decodes character references in a link destination or
  // title (`&amp;`, `&#106;`). Decode once, then check *and* emit that
  // same string: checking the raw text would let `&#106;avascript:`
  // pass as a relative URL and then decode to `javascript:` in the
  // attribute. Only `;`-terminated references are decoded, as CommonMark
  // requires — HTML text parsing would also expand legacy forms without
  // `;`, turning `?a=1&currency=USD` into `?a=1¤cy=USD`. Each one goes
  // through a <textarea> (RCDATA: decodes references, never creates
  // elements); a result longer than 2 UTF-16 units means the name was
  // invalid and only a prefix decoded, so the reference stays literal.
  const decoder = document.createElement('textarea');
  const decodeRefs = (s) => s.includes('&')
    ? s.replace(/&(?:#\d{1,7}|#[xX][\da-fA-F]{1,6}|[A-Za-z][A-Za-z\d]{1,31});/g, (ref) => {
        decoder.innerHTML = ref;
        const v = decoder.value;
        return v.length <= 2 ? v : ref;
      })
    : s;
  window.marked.use({
    renderer: {
      // One renderer for both token kinds: a block (`<div>…`, a comment, a
      // `<script>` element on its own lines) and an inline tag inside a
      // paragraph, list item, heading, table cell or link text. A block
      // keeps paragraph spacing; its line breaks collapse like any text.
      html({ text, block }) {
        const shown = escapeHtml(text);
        return block ? '<p>' + shown.trimEnd() + '</p>\n' : shown;
      },
      // The `html` escape above does not stop the lexer from *acting* on a
      // tag: an inline `<pre>`, `<code>`, `<kbd>` or `<script>` switches it
      // into raw-block mode until the matching close tag (across paragraphs,
      // since one lexer queues the whole document), and every text token
      // lexed meanwhile is the raw source flagged `escaped: true`, which the
      // default renderer emits verbatim — so `wrap it in <code>` followed by
      // `<img/src=x onerror=…>` would render live. `escaped` is set nowhere
      // else; every other text token falls through (`false`) to marked's
      // default, which escapes it.
      text(token) {
        return token.escaped && !token.tokens ? escapeKeepingRefs(token.text) : false;
      },
      code({ text, lang }) {
        const code     = text ?? '';
        const language = (lang ?? '').split(/\s/)[0];
        let highlighted;
        try {
          highlighted = language && hljs.getLanguage(language)
            ? hljs.highlight(code, { language }).value
            : hljs.highlightAuto(code).value;
        } catch (_) {
          highlighted = escapeHtml(code);
        }
        const cls = language ? ' language-' + escapeHtml(language) : '';
        return '<pre class="code-block"><code class="hljs' + cls + '">' +
               highlighted + '</code></pre>';
      },
      link({ href, title, tokens, text, autolink }) {
        // Only these schemes can ever be a legitimate chat/diff/plan
        // link; anything else (a script scheme, or an href `new URL`
        // can't even parse) renders as plain text - `inner` is the
        // rendered-safe inner HTML, so no anchor, no navigation
        // attempt, no policy hook to bypass.
        const inner = autolink ? escapeHtml(text) : this.parser.parseInline(tokens);
        // An autolink `<…>` resolves no references, so it stays literal.
        const url = autolink ? href : decodeRefs(href);
        let scheme = null;
        try { scheme = new URL(url, 'https://omp-desktop.invalid/').protocol; }
        catch (_) { /* leave scheme null - falls through to plain text */ }
        if (scheme !== 'http:' && scheme !== 'https:' && scheme !== 'mailto:') {
          return inner;
        }
        let safeHref;
        try { safeHref = escapeHtml(encodeURI(url).replace(/%25/g, '%')); }
        catch (_) { return inner; }
        let out = '<a href="' + safeHref + '"';
        if (title) out += ' title="' + escapeHtml(decodeRefs(title)) + '"';
        return out + '>' + inner + '</a>';
      }
    }
  });
})();

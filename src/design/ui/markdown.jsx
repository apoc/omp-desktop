/* ui/markdown.jsx — Markdown renderer using marked + highlight.js
   when available; falls back to plain text with HTML escaping. */

// ── Markdown renderer — uses marked + highlight.js when available ─────────
const MarkdownContent = ({ text, streaming }) => {
  const html = React.useMemo(() => {
    if (!text) return '';
    if (!window.marked) {
      // marked not loaded — render plain text with escaped HTML
      return '<p>' + text
        .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
        .replace(/\n\n/g, '</p><p>').replace(/\n/g, '<br>') + '</p>';
    }
    try { return window.marked.parse(text); }
    catch (_) { return '<pre>' + text + '</pre>'; }
  }, [text]);

  return (
    <div
      className={`md-content selectable${streaming ? ' md-streaming' : ''}`}
      dangerouslySetInnerHTML={{ __html: html }}
    />
  );
};


Object.assign(window, { MarkdownContent });

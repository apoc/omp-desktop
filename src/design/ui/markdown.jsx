/* ui/markdown.jsx — Markdown renderer using marked + highlight.js
   when available; falls back to plain text with HTML escaping. */

const { copyCodeBlockClick: _MdCopyClick } = window;

const escapeText = (text) =>
  text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

// ── Markdown renderer — uses marked + highlight.js when available ─────────
const MarkdownContent = ({ text, streaming }) => {
  const html = React.useMemo(() => {
    if (!text) return '';
    if (!window.marked) {
      // marked not loaded — render plain text with escaped HTML
      return '<p>' + escapeText(text)
        .replace(/\n\n/g, '</p><p>').replace(/\n/g, '<br>') + '</p>';
    }
    try { return window.marked.parse(text); }
    catch (_) { return '<pre>' + escapeText(text) + '</pre>'; }
  }, [text]);

  // onClick: delegated copy for the code-block buttons in the marked output.
  return (
    <div
      className={`md-content selectable${streaming ? ' md-streaming' : ''}`}
      onClick={_MdCopyClick}
      dangerouslySetInnerHTML={{ __html: html }}
    />
  );
};


Object.assign(window, { MarkdownContent });

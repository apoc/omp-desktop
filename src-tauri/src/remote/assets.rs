//! The phone page and the shared libraries it loads, compiled into the binary.

pub struct Asset {
    pub content_type: &'static str,
    pub body: &'static [u8],
}

const JS: &str = "text/javascript; charset=utf-8";

/// Resolve a request path (no query string). Everything else is `None` (404).
pub fn lookup(path: &str) -> Option<Asset> {
    let (content_type, body): (&'static str, &'static [u8]) = match path {
        "/" | "/index.html" => (
            "text/html; charset=utf-8",
            include_bytes!("../../../src/remote/index.html"),
        ),
        "/remote.js" => (JS, include_bytes!("../../../src/remote/remote.js")),
        "/client.js" => (JS, include_bytes!("../../../src/remote/client.js")),
        "/scanner.js" => (JS, include_bytes!("../../../src/remote/scanner.js")),
        "/sessions.js" => (JS, include_bytes!("../../../src/remote/sessions.js")),
        "/transcript.js" => (JS, include_bytes!("../../../src/remote/transcript.js")),
        "/jsQR.js" => (JS, include_bytes!("../../../src/remote/jsQR.js")),
        "/sw.js" => (JS, include_bytes!("../../../src/remote/sw.js")),
        "/remote.css" => (
            "text/css; charset=utf-8",
            include_bytes!("../../../src/remote/remote.css"),
        ),
        "/styles.css" => (
            "text/css; charset=utf-8",
            include_bytes!("../../../src/design/styles.css"),
        ),
        "/chat.css" => (
            "text/css; charset=utf-8",
            include_bytes!("../../../src/design/layout/chat.css"),
        ),
        "/ask.css" => (
            "text/css; charset=utf-8",
            include_bytes!("../../../src/design/layout/ask.css"),
        ),
        "/composer.css" => (
            "text/css; charset=utf-8",
            include_bytes!("../../../src/design/layout/composer.css"),
        ),
        "/accent.js" => (JS, include_bytes!("../../../src/app/accent.js")),
        "/ask-dialog.js" => (JS, include_bytes!("../../../src/app/ask-dialog.js")),
        "/scroll-pin.js" => (JS, include_bytes!("../../../src/app/scroll-pin.js")),
        "/manifest.json" => (
            "application/manifest+json",
            include_bytes!("../../../src/remote/manifest.json"),
        ),
        "/marked.min.js" => (JS, include_bytes!("../../../src/marked.min.js")),
        "/highlight.min.js" => (JS, include_bytes!("../../../src/highlight.min.js")),
        "/marked-setup.js" => (JS, include_bytes!("../../../src/app/marked-setup.js")),
        _ => return None,
    };
    Some(Asset { content_type, body })
}

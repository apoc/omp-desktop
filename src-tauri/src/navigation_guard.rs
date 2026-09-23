//! Keeps the app webview on the app.
//!
//! A plain `<a href="https://…">` in agent output (marked renders links
//! without a `target`) is a top-level navigation: with nothing intercepting
//! it, the webview itself loads the page and there is no back control, so
//! the only way out is restarting the app and losing every tab's state.
//! The same is true of a relative or absolute-path link the agent renders
//! (`[lib.rs](src/lib.rs)`) — it resolves against the app's own origin, so
//! it needs the exact same guard, not just `http(s)://` links.
//!
//! This plugin's `on_navigation` hook runs for every webview. The app's own
//! single document may load; web and mail links are handed to the system
//! browser and the navigation is cancelled; everything else (`file:`,
//! `data:`, any other app-origin path, custom schemes) is cancelled
//! outright. `open_url_external` goes through the same classification, so
//! the IPC command cannot be used to launch local files or executables.

use tauri::plugin::{Builder, TauriPlugin};
use tauri::{Manager, Runtime, Url};

/// What to do with a URL the webview is about to load or was asked to open.
#[derive(Debug, PartialEq, Eq)]
pub enum Navigation {
    /// The app's own single document - let the webview load it.
    Stay,
    /// A web or mail link - open it in the system default handler.
    OpenExternal,
    /// Neither - never load it and never hand it to the OS.
    Block,
}

/// True for the app's own origin: the `tauri://localhost` custom protocol
/// everywhere, plus the `http(s)://tauri.localhost` workaround Tauri
/// substitutes on Windows/Android (mirroring the platform gate in Tauri's
/// own, private, `tauri_protocol_url`), plus `tauri dev`'s built-in static
/// file server when one is configured (`build.devUrl`, unset - `None` - in
/// a production build, so this arm never matches a shipped binary).
///
/// Deliberately origin-only: whether a document at that origin is safe to
/// load is [`is_app_document`]'s job, not this one.
fn is_app_origin(url: &Url, dev_url: Option<&Url>) -> bool {
    match url.scheme() {
        "tauri" => url.host_str() == Some("localhost"),
        "http" | "https" => {
            let windows_asset_host = cfg!(any(windows, target_os = "android"))
                && url.host_str() == Some("tauri.localhost")
                && url.port().is_none();
            let dev_server = dev_url.is_some_and(|dev| dev.origin() == url.origin());
            windows_asset_host || dev_server
        }
        _ => false,
    }
}

/// True for the app's one and only document. The app is a static
/// single-page load (`src/index.html`, no client-side router), so any other
/// path or a query string at the app origin is not a page the app ever
/// means to navigate to - it is `index.html`'s own asset requests (scripts,
/// styles) hitting the navigation hook because they share the origin
/// `[INFERENCE]`, or a same-origin link in agent output that happens to
/// resolve onto the app's asset tree instead of the outside web.
fn is_app_document(url: &Url) -> bool {
    matches!(url.path(), "" | "/" | "/index.html") && url.query().is_none()
}

/// Classifies `url` for the webview `on_navigation` hook and for
/// `open_url_external`. `dev_url` is `Some` only under `tauri dev`, where
/// the CLI's built-in static server replaces the app's `tauri://localhost`
/// asset origin; it is always `None` in a built app.
pub fn classify(url: &Url, dev_url: Option<&Url>) -> Navigation {
    if is_app_origin(url, dev_url) {
        return if is_app_document(url) {
            Navigation::Stay
        } else {
            Navigation::Block
        };
    }
    match url.scheme() {
        "http" | "https" | "mailto" => Navigation::OpenExternal,
        _ => Navigation::Block,
    }
}

/// Opens a web or mail URL in the system default handler.
///
/// Detached: the navigation hook runs on the UI thread, and some launchers
/// (`xdg-open` wrapping a browser that is not already running) block until
/// the opened application exits instead of returning immediately, which
/// would freeze the webview for as long as the user's browser stays open.
///
/// On Windows this goes through `ShellExecuteExW` (the `open` crate's
/// `shellexecute-on-windows` feature, enabled in `Cargo.toml`) rather than
/// its default `cmd /c start "" "<url>"` fallback: `cmd` expands a bare
/// `%VAR%` even inside double quotes, so a link an agent renders verbatim
/// from untrusted content (e.g. `https://x?k=%ANTHROPIC_API_KEY%`) would
/// otherwise leak an environment variable into the opened URL, and a
/// crafted `mailto:` address could break out of the quoted argument
/// entirely. `ShellExecuteExW` does neither.
///
/// On Unix, `open::that_detached` forks and drops the child without
/// `wait()`-ing on it, which is the crate's own documented trade-off for
/// "outlive your app" semantics; the process becomes defunct (a PID-table
/// slot, not a resource leak) until this app exits and it is reparented to
/// init. Acceptable here: a click is a rare, user-initiated event, not a
/// hot path.
///
/// # Errors
/// The URL is app-local or not a web/mail URL, or the launcher failed to
/// start.
pub fn open_external(url: &Url) -> Result<(), String> {
    match classify(url, None) {
        Navigation::OpenExternal => open::that_detached(url.as_str()).map_err(|e| e.to_string()),
        Navigation::Stay | Navigation::Block => Err(format!("refusing to open {url} externally")),
    }
}

/// The plugin enforcing [`classify`] on every webview navigation.
pub fn init<R: Runtime>() -> TauriPlugin<R> {
    Builder::new("navigation-guard")
        .on_navigation(|webview, url| {
            let dev_url = webview.config().build.dev_url.clone();
            match classify(url, dev_url.as_ref()) {
                Navigation::Stay => true,
                Navigation::OpenExternal => {
                    if let Err(e) = open_external(url) {
                        eprintln!("[omp-desktop] failed to open link externally: {e}");
                    }
                    false
                }
                Navigation::Block => {
                    eprintln!("[omp-desktop] blocked webview navigation to {url}");
                    false
                }
            }
        })
        .build()
}

#[cfg(test)]
mod tests {
    use super::*;

    fn classify_str(url: &str) -> Navigation {
        classify(&Url::parse(url).expect("test URL parses"), None)
    }

    #[test]
    fn app_document_stays_on_every_platform_form() {
        assert_eq!(classify_str("tauri://localhost"), Navigation::Stay);
        assert_eq!(classify_str("tauri://localhost/"), Navigation::Stay);
        assert_eq!(
            classify_str("tauri://localhost/index.html"),
            Navigation::Stay
        );
        assert_eq!(
            classify_str("tauri://localhost/index.html#anchor"),
            Navigation::Stay
        );
        if cfg!(windows) {
            assert_eq!(classify_str("http://tauri.localhost/"), Navigation::Stay);
            assert_eq!(
                classify_str("http://tauri.localhost/index.html"),
                Navigation::Stay
            );
        } else {
            // Tauri only substitutes the `http(s)://tauri.localhost` workaround
            // URL on Windows/Android; on Linux/macOS it is an ordinary (and,
            // via `nss-myhostname`, loopback-resolvable) network host.
            assert_eq!(
                classify_str("http://tauri.localhost/"),
                Navigation::OpenExternal
            );
        }
    }

    #[test]
    fn app_origin_non_document_paths_are_blocked_not_opened_in_place() {
        // A relative or absolute-path link in agent output
        // (`[lib.rs](src/lib.rs)`) resolves onto the app's own asset tree;
        // letting the webview navigate there would reboot the SPA in place
        // exactly like the original bug, so it must not be `Stay`, and it
        // must not silently become `OpenExternal` either (a `tauri://` URL
        // cannot be opened in a browser, and the equivalent
        // `http://tauri.localhost/src/lib.rs` is not a real web resource).
        assert_eq!(
            classify_str("tauri://localhost/src/lib.rs"),
            Navigation::Block
        );
        assert_eq!(
            classify_str("tauri://localhost/index.html?x=1"),
            Navigation::Block
        );
    }

    #[test]
    fn dev_server_origin_stays_only_for_the_document_path() {
        let dev = Url::parse("http://127.0.0.1:1430").unwrap();
        let stay = Url::parse("http://127.0.0.1:1430/index.html").unwrap();
        let asset_path = Url::parse("http://127.0.0.1:1430/src/lib.rs").unwrap();
        let different_port = Url::parse("http://127.0.0.1:9999/index.html").unwrap();

        assert_eq!(classify(&stay, Some(&dev)), Navigation::Stay);
        assert_eq!(classify(&asset_path, Some(&dev)), Navigation::Block);
        assert_eq!(
            classify(&different_port, Some(&dev)),
            Navigation::OpenExternal
        );
    }

    #[test]
    fn web_and_mail_links_open_externally() {
        assert_eq!(
            classify_str("https://github.com/apoc/omp-desktop/issues/14"),
            Navigation::OpenExternal
        );
        assert_eq!(classify_str("http://example.com"), Navigation::OpenExternal);
        assert_eq!(
            classify_str("mailto:someone@example.com"),
            Navigation::OpenExternal
        );
    }

    #[test]
    fn lookalike_app_hosts_are_never_silently_trusted() {
        assert_eq!(
            classify_str("https://tauri.localhost.evil.com/"),
            Navigation::OpenExternal
        );
        assert_eq!(classify_str("http://localhost/"), Navigation::OpenExternal);
        assert_eq!(classify_str("tauri://evil.com/"), Navigation::Block);
    }

    #[test]
    fn local_and_script_schemes_are_blocked() {
        for url in [
            "file:///etc/passwd",
            "file:///C:/Windows/System32/calc.exe",
            "data:text/html,<h1>x</h1>",
            "javascript:alert(1)",
            "about:blank",
            "vscode://file/tmp/x",
        ] {
            assert_eq!(classify_str(url), Navigation::Block, "{url}");
        }
    }

    #[test]
    fn open_external_refuses_non_web_urls_without_launching() {
        for url in ["file:///etc/passwd", "tauri://localhost/index.html"] {
            let err = open_external(&Url::parse(url).expect("test URL parses"))
                .expect_err("must refuse before reaching the launcher");
            assert!(err.contains("refusing"), "{err}");
        }
    }
}

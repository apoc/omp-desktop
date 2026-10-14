//! Annotate mode: the overlay script running in an isolated world of the
//! shown page, the picks it reports, and area capture.
//!
//! The script (`overlay.js`) is installed on every page session the view
//! attaches to. Chromium creates its world as an execution context named
//! [`WORLD`]; the view turns the overlay on and off by evaluating in those
//! contexts, and a context created later (a new document) is switched on by
//! the event handler itself while annotate is on. The binding is exposed in
//! that world only, so a page script cannot forge a pick.

use std::collections::{HashMap, HashSet};

use serde::Serialize;
use serde_json::{json, Value};

use super::emit::{Pick, Rect};
use super::lock;
use super::view_core::Core;

const OVERLAY: &str = include_str!("overlay.js");
const WORLD: &str = "omp-annotate";
const BINDING: &str = "__ompAnnotate";

/// What a binding call may carry (the overlay sends at most 20 000 chars of
/// HTML and 500 of text, escaped).
const MAX_PAYLOAD: usize = 256 * 1024;
const MAX_HTML: usize = 20_000;
const MAX_TEXT: usize = 500;
const MAX_FIELD: usize = 8192;
/// Largest side of a captured area, in CSS pixels.
const MAX_CAPTURE_EDGE: f64 = 8192.0;

/// The events [`Core::on_overlay_event`] takes, on the reader thread.
pub(super) const EVENTS: [&str; 4] = [
    "Runtime.executionContextCreated",
    "Runtime.executionContextDestroyed",
    "Runtime.executionContextsCleared",
    "Runtime.bindingCalled",
];

/// An area screenshot, base64 like the frontend's image attachments.
#[derive(Serialize, Debug, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct CapturedImage {
    pub data: String,
    pub mime_type: String,
}

/// Annotate state of one view. Locked briefly, never across a blocking CDP
/// call: the reader thread takes it too. Notifications stay under the lock
/// so a release or toggle cannot be followed by a stale enable.
#[derive(Default)]
pub(super) struct Annotate {
    pub(super) on: bool,
    /// Every explicit toggle, including a redundant off, supersedes captures.
    generation: u64,
    /// Page sessions the overlay is (being) installed on.
    installed: HashSet<String>,
    /// The overlay world's contexts per installed session.
    contexts: HashMap<String, Vec<i64>>,
}

impl Annotate {
    /// Whether `on`, after recording a context of `session` (ignored for a
    /// session the overlay is not installed on).
    fn add_context(&mut self, session: &str, id: i64) -> bool {
        if !self.installed.contains(session) {
            return false;
        }
        let contexts = self.contexts.entry(session.to_owned()).or_default();
        if !contexts.contains(&id) {
            contexts.push(id);
        }
        self.on
    }

    fn owns(&self, session: &str, id: i64) -> bool {
        self.contexts.get(session).is_some_and(|c| c.contains(&id))
    }

    fn contexts_of(&self, session: &str) -> Vec<i64> {
        self.contexts.get(session).cloned().unwrap_or_default() // owned: used after the lock
    }

    fn forget(&mut self, session: &str) {
        self.installed.remove(session);
        self.contexts.remove(session);
    }
}

fn set_params(on: bool, context: i64) -> Value {
    json!({
        "expression": format!("window.__ompAnnotateSet && window.__ompAnnotateSet({on})"),
        "contextId": context,
    })
}

/// A pick from the overlay's report, bounded; `None` for anything the
/// overlay would not send.
fn parse_pick(payload: &str) -> Option<Pick> {
    if payload.len() > MAX_PAYLOAD {
        return None;
    }
    let mut pick: Pick = serde_json::from_str(payload).ok()?;
    let r = &pick.rect;
    if ![r.x, r.y, r.w, r.h].iter().all(|v| v.is_finite()) || r.w < 0.0 || r.h < 0.0 {
        return None;
    }
    if let Some(r) = &pick.doc_rect {
        if ![r.x, r.y, r.w, r.h].iter().all(|v| v.is_finite()) || r.w < 0.0 || r.h < 0.0 {
            return None;
        }
    }
    cap_chars(&mut pick.url, MAX_FIELD);
    match pick.kind.as_str() {
        "element" => {
            let (selector, tag) = (pick.selector.as_mut()?, pick.tag.as_mut()?);
            cap_chars(selector, MAX_FIELD);
            cap_chars(tag, MAX_FIELD);
            if let Some(html) = pick.html.as_mut() {
                cap_chars(html, MAX_HTML);
            }
            if let Some(text) = pick.text.as_mut() {
                cap_chars(text, MAX_TEXT);
            }
        }
        "area" => {
            if pick.rect.w <= 0.0 || pick.rect.h <= 0.0 {
                return None;
            }
            (pick.selector, pick.tag, pick.html, pick.text) = (None, None, None, None);
        }
        _ => return None,
    }
    Some(pick)
}

/// Keep at most `max` chars of `s`.
fn cap_chars(s: &mut String, max: usize) {
    if let Some((end, _)) = s.char_indices().nth(max) {
        s.truncate(end);
    }
}

/// `Page.captureScreenshot`'s clip for `rect`, in document CSS pixels; a
/// viewport-relative pick is shifted by the page's scroll in [`Core::capture`].
fn clip(rect: &Rect) -> Result<Value, String> {
    let sane = [rect.x, rect.y].iter().all(|v| v.abs() <= 1e7)
        && (1.0..=MAX_CAPTURE_EDGE).contains(&rect.w)
        && (1.0..=MAX_CAPTURE_EDGE).contains(&rect.h);
    if !sane {
        return Err("invalid capture area".into());
    }
    Ok(json!({ "x": rect.x, "y": rect.y, "width": rect.w, "height": rect.h, "scale": 1 }))
}

impl Core {
    /// Install the overlay on page session `session`. Idempotent. Not under
    /// the annotate lock, whose holders must not wait on the reader thread.
    pub fn install_overlay(&self, session: &str) -> Result<(), String> {
        let _installing = lock(&self.overlay_install);
        if !lock(&self.annotate).installed.insert(session.to_owned()) {
            return Ok(());
        }
        // `Runtime.enable` first: it reports the world `runImmediately` makes.
        let steps = [
            ("Runtime.enable", json!({})),
            (
                "Runtime.addBinding",
                json!({ "name": BINDING, "executionContextName": WORLD }),
            ),
            (
                "Page.addScriptToEvaluateOnNewDocument",
                json!({ "source": OVERLAY, "worldName": WORLD, "runImmediately": true }),
            ),
        ];
        for (method, params) in steps {
            if let Err(e) = self.call(Some(session), method, params) {
                lock(&self.annotate).forget(session);
                return Err(format!("annotate overlay: {e}"));
            }
        }
        Ok(())
    }

    /// Annotate on or off for the shown page, and for every page shown later.
    pub fn set_annotate(&self, on: bool) -> Result<(), String> {
        // Target switches install the new world's contexts using this flag.
        // Keep the session, flag and context updates in the same order.
        let _switching = lock(&self.switch);
        self.set_annotate_locked(on)
    }

    /// Caller holds `switch` through the flag and context updates.
    fn set_annotate_locked(&self, on: bool) -> Result<(), String> {
        if self.is_closed() {
            return Err("view closed".into());
        }
        let session = self.active_session()?;
        self.install_overlay(&session)?;
        let contexts = {
            let mut annotate = lock(&self.annotate);
            if self.is_closed() {
                return Err("view closed".into());
            }
            annotate.on = on;
            annotate.generation = annotate.generation.wrapping_add(1);
            annotate.contexts_of(&session)
        };
        // A context that appears from now on sees the flag. One that is gone
        // fails: the page navigated, and its successor is switched on.
        for context in contexts {
            let _ = self.call(Some(&session), "Runtime.evaluate", set_params(on, context));
        }
        Ok(())
    }

    /// Switch the overlay of `session` off and forget it (the session is
    /// about to be detached); the annotate flag stays.
    pub fn release_overlay(&self, session: &str) {
        let mut annotate = lock(&self.annotate);
        let contexts = annotate.contexts_of(session);
        annotate.forget(session);
        if let Some(client) = self.client.get() {
            for context in contexts {
                client.notify(
                    Some(session),
                    "Runtime.evaluate",
                    set_params(false, context),
                );
            }
        }
        drop(annotate); // Keep release notifications ordered with late contexts.
    }

    /// The reader thread's share: bookkeeping and one notification at most.
    pub fn on_overlay_event(&self, session: Option<&str>, method: &str, params: &Value) {
        if self.is_closed() {
            return;
        }
        let Some(session) = session else {
            return;
        };
        match method {
            "Runtime.executionContextCreated" => {
                let context = &params["context"];
                let Some(id) = context["id"].as_i64().filter(|_| context["name"] == WORLD) else {
                    return;
                };
                let mut annotate = lock(&self.annotate);
                if self.is_closed() {
                    return;
                }
                let on = annotate.add_context(session, id);
                if let (true, Some(client)) = (on, self.client.get()) {
                    client.notify(Some(session), "Runtime.evaluate", set_params(true, id));
                }
                drop(annotate); // No stale enable may follow a release or toggle.
            }
            "Runtime.executionContextDestroyed" => {
                if let Some(id) = params["executionContextId"].as_i64() {
                    if let Some(contexts) = lock(&self.annotate).contexts.get_mut(session) {
                        contexts.retain(|c| *c != id);
                    }
                }
            }
            "Runtime.executionContextsCleared" => {
                if let Some(contexts) = lock(&self.annotate).contexts.get_mut(session) {
                    contexts.clear();
                }
            }
            "Runtime.bindingCalled" => self.on_binding(session, params),
            _ => {}
        }
    }

    fn on_binding(&self, session: &str, params: &Value) {
        let from_overlay = params["name"] == BINDING
            && params["executionContextId"]
                .as_i64()
                .is_some_and(|id| lock(&self.annotate).owns(session, id));
        if !from_overlay {
            return;
        }
        if let Some(pick) = params["payload"].as_str().and_then(parse_pick) {
            // Activation emits its tabs event under `inner`, like frames.
            // Recheck after parsing and hold that lock through the pick.
            let inner = lock(&self.inner);
            if inner.active.as_ref().is_some_and(|a| a.session == session) {
                self.emit_pick(&pick);
            }
        }
    }

    /// A PNG of `rect` (viewport-relative CSS pixels of the page shown):
    /// the clip is shifted into the page's (document's) pixels, and the
    /// overlay is out of the way for the screenshot, whatever the outcome.
    pub fn capture(&self, rect: &Rect) -> Result<CapturedImage, String> {
        // Picks use viewport CSS pixels; CDP's clip uses document CSS pixels.
        let offset = self.call_active(
            "Runtime.evaluate",
            json!({
                "expression": "({ x: window.scrollX, y: window.scrollY })",
                "returnByValue": true,
            }),
        )?;
        let value = &offset["result"]["value"];
        let (Some(sx), Some(sy)) = (
            value["x"].as_f64().filter(|v| v.is_finite()),
            value["y"].as_f64().filter(|v| v.is_finite()),
        ) else {
            return Err("could not read the page's scroll".into());
        };
        let clip = clip(&Rect {
            x: rect.x + sx,
            y: rect.y + sy,
            ..*rect
        })?;
        // Hiding and recording the generation share the toggle lock. A user
        // toggle during the shot (even another off) supersedes restoration.
        let hidden_generation = {
            let _switching = lock(&self.switch);
            let was_on = lock(&self.annotate).on;
            if was_on {
                self.set_annotate_locked(false)?;
                Some(lock(&self.annotate).generation)
            } else {
                None
            }
        };
        let shot = self.call_active(
            "Page.captureScreenshot",
            json!({ "format": "png", "clip": clip, "captureBeyondViewport": false }),
        );
        // Restore before inspecting CDP errors, unless a newer toggle won.
        let restored = {
            let _switching = lock(&self.switch);
            if hidden_generation
                .is_some_and(|generation| lock(&self.annotate).generation == generation)
                && !self.is_closed()
            {
                self.set_annotate_locked(true)
            } else {
                Ok(())
            }
        };
        let shot = shot?;
        restored?;
        let data = shot["data"].as_str().ok_or("capture returned no image")?;
        Ok(CapturedImage {
            data: data.to_owned(),
            mime_type: "image/png".to_owned(),
        })
    }

    /// Scroll the page shown now to a pick's absolute document CSS rect.
    pub fn scroll_to(&self, rect: &Rect) -> Result<(), String> {
        let sane = [rect.x, rect.y, rect.w, rect.h]
            .iter()
            .all(|v| v.is_finite() && v.abs() <= 1e7)
            && rect.w >= 0.0
            && rect.h >= 0.0;
        if !sane {
            return Err("invalid area".into());
        }
        // Only validated rect numbers travel in the expression; no selector
        // or other page-supplied text is interpolated.
        let expression = format!(
            r"window.scrollTo({{
                left: {x} + {w} / 2 - window.innerWidth / 2,
                top: {y} + {h} / 2 - window.innerHeight / 2,
                behavior: 'instant'
            }})",
            x = rect.x,
            y = rect.y,
            w = rect.w,
            h = rect.h,
        );
        self.call_active(
            "Runtime.evaluate",
            json!({ "expression": expression, "returnByValue": true }),
        )
        .map(drop)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn pick(kind: &str, w: f64, extra: Value) -> String {
        let mut p = json!({
            "kind": kind, "selector": null, "tag": null, "html": null, "text": null,
            "rect": { "x": 1.0, "y": 2.0, "w": w, "h": 4.0 }, "url": "http://a/",
        });
        for (key, value) in extra.as_object().unwrap() {
            p[key] = value.clone(); // building a fixture
        }
        p.to_string()
    }

    #[test]
    fn an_element_pick_is_parsed_and_bounded() {
        let long = "é".repeat(MAX_HTML + 5);
        let payload = pick(
            "element",
            3.0,
            json!({ "selector": "button.save", "tag": "button", "html": long, "text": long }),
        );
        let p = parse_pick(&payload).unwrap();
        assert_eq!(p.selector.as_deref(), Some("button.save"));
        assert_eq!(p.html.unwrap().chars().count(), MAX_HTML);
        assert_eq!(p.text.unwrap().chars().count(), MAX_TEXT);
        assert_eq!(
            p.rect,
            Rect {
                x: 1.0,
                y: 2.0,
                w: 3.0,
                h: 4.0
            }
        );
    }

    #[test]
    fn document_rect_is_optional_but_validated_and_serialized_as_camel_case() {
        let old = parse_pick(&pick("area", 3.0, json!({}))).unwrap();
        assert!(old.doc_rect.is_none(), "older payloads still parse");
        let document = json!({ "x": 100.0, "y": 1200.0, "w": 3.0, "h": 4.0 });
        let parsed = parse_pick(&pick("area", 3.0, json!({ "docRect": document }))).unwrap();
        let encoded = serde_json::to_value(parsed).unwrap();
        assert_eq!(encoded["docRect"], document);
        assert!(encoded.get("doc_rect").is_none());
        for invalid in [
            json!({ "x": 0.0, "y": 0.0, "w": -1.0, "h": 4.0 }),
            json!({ "x": 0.0, "y": 0.0, "w": 3.0, "h": -1.0 }),
            json!({ "x": "NaN", "y": 0.0, "w": 3.0, "h": 4.0 }),
        ] {
            assert!(parse_pick(&pick("area", 3.0, json!({ "docRect": invalid }))).is_none());
        }
    }

    #[test]
    fn an_area_pick_carries_no_element_fields() {
        let payload = pick("area", 3.0, json!({ "selector": "x", "html": "<b>" }));
        let p = parse_pick(&payload).unwrap();
        assert_eq!(
            (p.selector, p.tag, p.html, p.text),
            (None, None, None, None)
        );
    }

    #[test]
    fn malformed_picks_are_refused() {
        assert!(parse_pick("not json").is_none());
        assert!(parse_pick(&pick("other", 3.0, json!({}))).is_none());
        assert!(
            parse_pick(&pick("element", 3.0, json!({}))).is_none(),
            "an element without selector and tag"
        );
        assert!(
            parse_pick(&pick("area", 0.0, json!({}))).is_none(),
            "empty area"
        );
        assert!(parse_pick(&pick("area", -1.0, json!({}))).is_none());
        let huge = pick("area", 3.0, json!({ "url": "x".repeat(MAX_PAYLOAD) }));
        assert!(parse_pick(&huge).is_none(), "over the payload bound");
    }

    #[test]
    fn contexts_are_kept_only_for_installed_sessions() {
        let mut a = Annotate::default();
        assert!(!a.add_context("s", 1), "off");
        assert!(!a.owns("s", 1), "not installed: ignored");
        a.installed.insert("s".into());
        a.on = true;
        assert!(a.add_context("s", 1), "on: the caller switches it on");
        assert!(a.add_context("s", 1));
        assert_eq!(a.contexts_of("s"), [1], "no duplicate");
        assert!(a.owns("s", 1) && !a.owns("s", 2) && !a.owns("t", 1));
        a.forget("s");
        assert_eq!(a.contexts_of("s"), Vec::<i64>::new());
        assert!(!a.add_context("s", 3), "forgotten: never switch it on");
        assert!(!a.owns("s", 3), "forgotten: ignored");
    }

    #[test]
    fn released_overlay_ignores_late_contexts_while_annotate_stays_on() {
        let emit = std::sync::Arc::new(PickLockProbe::default());
        let core = Core::new("s1", emit);
        {
            let mut annotate = lock(&core.annotate);
            annotate.on = true;
            annotate.installed.insert("sa".into());
            annotate.add_context("sa", 1);
        }
        core.release_overlay("sa");
        core.on_overlay_event(
            Some("sa"),
            "Runtime.executionContextCreated",
            &json!({ "context": { "id": 2, "name": WORLD } }),
        );
        let mut annotate = lock(&core.annotate);
        assert!(annotate.on, "the next shown page still uses annotate");
        assert!(!annotate.owns("sa", 1));
        assert!(!annotate.owns("sa", 2));
        assert!(
            !annotate.add_context("sa", 3),
            "a released world's late context must never enable its overlay"
        );
        drop(annotate);
    }

    #[test]
    fn closing_resets_annotate_and_ignores_late_contexts() {
        let emit = std::sync::Arc::new(PickLockProbe::default());
        let core = Core::new("s1", emit);
        {
            let mut annotate = lock(&core.annotate);
            annotate.on = true;
            annotate.installed.insert("sa".into());
        }
        assert!(core.mark_closed());
        assert!(!lock(&core.annotate).on, "closing clears the flag");
        core.on_overlay_event(
            Some("sa"),
            "Runtime.executionContextCreated",
            &json!({ "context": { "id": 1, "name": WORLD } }),
        );
        assert!(
            !lock(&core.annotate).owns("sa", 1),
            "a closed view ignores late contexts"
        );
    }

    #[derive(Default)]
    struct PickLockProbe {
        core: std::sync::OnceLock<std::sync::Weak<Core>>,
        picks: std::sync::Mutex<Vec<String>>,
    }

    impl super::super::emit::BrowserEmit for PickLockProbe {
        fn frame(&self, _: &str, _: &super::super::emit::Frame) {}
        fn tabs(&self, _: &str, _: &[super::super::emit::TabInfo]) {}
        fn state(&self, _: &str, _: &super::super::emit::ViewState) {}
        fn pick(&self, _: &str, pick: &Pick) {
            let core = self.core.get().unwrap().upgrade().unwrap();
            assert!(
                core.inner.try_lock().is_err(),
                "activation must stay locked through pick emission"
            );
            lock(&self.picks).push(pick.url.clone());
        }
    }

    #[test]
    fn picks_are_emitted_under_the_activation_lock() {
        let seen = std::sync::Arc::new(PickLockProbe::default());
        let emit: std::sync::Arc<dyn super::super::emit::BrowserEmit> = seen.clone();
        let core = std::sync::Arc::new(Core::new("s1", emit));
        seen.core.set(std::sync::Arc::downgrade(&core)).unwrap();
        lock(&core.inner).set_active("a", "sa");
        {
            let mut annotate = lock(&core.annotate);
            annotate.installed.insert("sa".into());
            annotate.add_context("sa", 1);
        }
        let params = json!({
            "name": BINDING, "executionContextId": 1,
            "payload": pick("area", 3.0, json!({})),
        });
        core.on_binding("sa", &params);
        lock(&core.inner).set_active("b", "sb");
        core.on_binding("sa", &params);
        assert_eq!(*lock(&seen.picks), ["http://a/"]);
    }

    #[test]
    fn capture_areas_are_bounded() {
        let area = |x, y, w, h| clip(&Rect { x, y, w, h });
        assert_eq!(
            area(0.0, 0.0, 50.0, 20.0).unwrap(),
            json!({ "x": 0.0, "y": 0.0, "width": 50.0, "height": 20.0, "scale": 1 })
        );
        for bad in [
            area(0.0, 0.0, 0.0, 20.0),
            area(0.0, 0.0, 50.0, 0.5),
            area(0.0, 0.0, 9000.0, 20.0),
            area(f64::NAN, 0.0, 5.0, 5.0),
            area(0.0, f64::INFINITY, 5.0, 5.0),
            area(0.0, 0.0, f64::NAN, 5.0),
        ] {
            assert!(bad.is_err(), "{bad:?}");
        }
    }

    #[test]
    fn toggle_off_during_capture_is_not_undone_by_restoration() {
        use std::sync::{mpsc, Arc};
        use std::time::Duration;
        use tungstenite::Message;

        let listener = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
        let port = listener.local_addr().unwrap().port();
        let (started, shot_started) = mpsc::channel();
        let (finish, release_shot) = mpsc::channel();
        let server = std::thread::spawn(move || {
            let (stream, _) = listener.accept().unwrap();
            let mut ws = tungstenite::accept(stream).unwrap();
            let mut pending_shot = None;
            while let Ok(Message::Text(text)) = ws.read() {
                let request: Value = serde_json::from_str(text.as_str()).unwrap();
                if request["method"] == "Page.captureScreenshot" {
                    pending_shot = Some(request["id"].clone());
                    started.send(()).unwrap();
                    continue;
                }
                let result = if request["params"]["expression"]
                    == "({ x: window.scrollX, y: window.scrollY })"
                {
                    json!({ "result": { "value": { "x": 0, "y": 0 } } })
                } else {
                    json!({})
                };
                ws.send(Message::text(
                    json!({ "id": request["id"], "result": result }).to_string(),
                ))
                .unwrap();
                if let Some(id) = pending_shot.take() {
                    release_shot.recv_timeout(Duration::from_secs(3)).unwrap();
                    ws.send(Message::text(
                        json!({ "id": id, "result": { "data": "image" } }).to_string(),
                    ))
                    .unwrap();
                }
            }
        });
        let core = Arc::new(Core::new("s1", Arc::new(PickLockProbe::default())));
        lock(&core.inner).set_active("a", "sa");
        {
            let mut annotate = lock(&core.annotate);
            annotate.installed.insert("sa".into());
            annotate.add_context("sa", 1);
        }
        let client = super::super::cdp::CdpClient::connect(
            &format!("ws://127.0.0.1:{port}/devtools/browser/test"),
            Box::new(|_, _, _| {}),
        )
        .unwrap();
        assert!(core.client.set(client).is_ok());
        core.set_annotate(true).unwrap();
        let capturing = Arc::clone(&core);
        let shot = std::thread::spawn(move || {
            capturing.capture(&Rect {
                x: 0.0,
                y: 0.0,
                w: 20.0,
                h: 20.0,
            })
        });
        shot_started.recv_timeout(Duration::from_secs(3)).unwrap();
        core.set_annotate(false).unwrap();
        finish.send(()).unwrap();
        assert_eq!(shot.join().unwrap().unwrap().data, "image");
        assert!(
            !lock(&core.annotate).on,
            "capture must not undo the user's toggle-off"
        );
        core.client.get().unwrap().close();
        server.join().unwrap();
    }

    #[test]
    fn non_finite_document_scroll_rects_are_rejected_before_cdp() {
        let core = Core::new("s1", std::sync::Arc::new(PickLockProbe::default()));
        for number in [f64::NAN, f64::INFINITY, f64::NEG_INFINITY] {
            for rect in [
                Rect {
                    x: number,
                    y: 0.0,
                    w: 1.0,
                    h: 1.0,
                },
                Rect {
                    x: 0.0,
                    y: number,
                    w: 1.0,
                    h: 1.0,
                },
                Rect {
                    x: 0.0,
                    y: 0.0,
                    w: number,
                    h: 1.0,
                },
                Rect {
                    x: 0.0,
                    y: 0.0,
                    w: 1.0,
                    h: number,
                },
            ] {
                assert_eq!(core.scroll_to(&rect), Err("invalid area".to_owned()));
            }
        }
    }
}

//! Annotate state and capture against a fake Chromium, and the overlay
//! against a real Chromium (skipped when none is installed).

use std::collections::HashMap;
use std::io::{Read, Write};
use std::net::TcpListener;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex, OnceLock, Weak};

use base64::Engine;
use serde_json::{json, Value};

use crate::test_support::eventually;

use super::super::broker::BrokerClient;
use super::super::cdp::CdpClient;
use super::super::tests::{
    cdp_error, cdp_result, fake_cdp, mouse, panel, CHROMIUM, CHROMIUM_EVENT,
};
use super::super::view::{BrowserEmit, Core, Frame, Pick, Rect, TabInfo, View, ViewState};
use super::super::{lock, BrowserManager};
use super::{CapturedImage, BINDING, WORLD};

fn rect(x: f64, y: f64, w: f64, h: f64) -> Rect {
    Rect { x, y, w, h }
}

/// Emits nothing (for tests that only look at the state).
pub(super) struct NoEmit;

impl BrowserEmit for NoEmit {
    fn frame(&self, _: &str, _: &Frame) {}
    fn tabs(&self, _: &str, _: &[TabInfo]) {}
    fn state(&self, _: &str, _: &ViewState) {}
    fn pick(&self, _: &str, _: &Pick) {}
}

/// Records the urls of picks, checking that each is emitted under the
/// activation lock, and the annotate flag of every state.
#[derive(Default)]
struct Probe {
    core: OnceLock<Weak<Core>>,
    picks: Mutex<Vec<String>>,
    annotate: Mutex<Vec<bool>>,
}

impl BrowserEmit for Probe {
    fn frame(&self, _: &str, _: &Frame) {}
    fn tabs(&self, _: &str, _: &[TabInfo]) {}
    fn state(&self, _: &str, state: &ViewState) {
        lock(&self.annotate).push(state.annotate);
    }
    fn pick(&self, _: &str, pick: &Pick) {
        if let Some(core) = self.core.get().and_then(Weak::upgrade) {
            assert!(
                core.inner.try_lock().is_err(),
                "activation must stay locked through pick emission"
            );
        }
        lock(&self.picks).push(pick.url.clone()); // the probe owns what it records
    }
}

/// A view core reporting to a probe, connected through `client` if given.
fn core(client: Option<BrokerClient>) -> (Arc<Core>, Arc<Probe>) {
    let probe = Arc::new(Probe::default());
    let core = Arc::new(Core::new("s1", Arc::clone(&probe) as Arc<dyn BrowserEmit>));
    assert!(probe.core.set(Arc::downgrade(&core)).is_ok());
    if let Some(client) = client {
        let client = CdpClient::connect(client, Box::new(|_, _, _| {})).unwrap();
        assert!(core.client.set(client).is_ok());
    }
    (core, probe)
}

/// Page session `sa` shown, its overlay context 7 on, and a pick made in it.
fn picked(core: &Core) {
    lock(&core.inner).set_active("a", "sa");
    let mut annotate = lock(&core.annotate);
    annotate.on = true;
    annotate.install("sa");
    annotate.add_context("sa", 7);
    annotate.picked = Some(("sa".into(), 7));
}

fn binding(name: &str, context: i64) -> Value {
    let area = json!({ "x": 1.0, "y": 2.0, "w": 3.0, "h": 4.0 });
    let payload = json!({
        "kind": "area", "selector": null, "tag": null, "html": null, "text": null,
        "rect": area, "docRect": area, "url": "http://a/",
    });
    json!({ "name": name, "executionContextId": context, "payload": payload.to_string() })
}

#[test]
fn contexts_are_kept_only_for_installed_sessions() {
    let mut a = super::Annotate::default();
    assert!(!a.add_context("s", 1), "off");
    assert!(!a.owns("s", 1), "not installed: ignored");
    assert!(a.install("s"));
    assert!(!a.install("s"), "already installed");
    a.on = true;
    assert!(a.add_context("s", 1), "on: the caller switches it on");
    assert!(a.add_context("s", 1));
    assert_eq!(a.contexts_of("s"), [1], "no duplicate");
    assert!(a.owns("s", 1) && !a.owns("s", 2) && !a.owns("t", 1));
    a.picked = Some(("s".into(), 1));
    assert_eq!(a.picked_context("s"), Some(1));
    assert_eq!(a.picked_context("t"), None, "another page");
    a.forget("s");
    assert_eq!(a.contexts_of("s"), Vec::<i64>::new());
    assert_eq!(a.picked_context("s"), None, "forgotten with its session");
    assert!(!a.add_context("s", 3), "forgotten: never switch it on");
    assert!(!a.owns("s", 3), "forgotten: ignored");
}

#[test]
fn released_overlay_ignores_late_contexts_while_annotate_stays_on() {
    let (core, _) = core(None);
    picked(&core);
    core.release_overlay("sa");
    core.on_overlay_event(
        Some("sa"),
        "Runtime.executionContextCreated",
        &json!({ "context": { "id": 8, "name": WORLD } }),
    );
    let mut annotate = lock(&core.annotate);
    assert!(annotate.on, "the next shown page still uses annotate");
    assert!(!annotate.owns("sa", 7) && !annotate.owns("sa", 8));
    assert!(
        !annotate.add_context("sa", 9),
        "a released world's late context must never enable its overlay"
    );
    drop(annotate);
}

#[test]
fn closing_resets_annotate_and_ignores_late_contexts() {
    let (core, _) = core(None);
    picked(&core);
    assert!(core.mark_closed());
    assert!(!lock(&core.annotate).on, "closing clears the flag");
    core.on_overlay_event(
        Some("sa"),
        "Runtime.executionContextCreated",
        &json!({ "context": { "id": 8, "name": WORLD } }),
    );
    assert!(
        !lock(&core.annotate).owns("sa", 8),
        "a closed view ignores late contexts"
    );
}

#[test]
fn turning_off_without_a_page_clears_the_flag_and_tells_the_panel() {
    let (core, probe) = core(None);
    lock(&core.annotate).on = true;
    core.update_state(|s| s.annotate = true);
    assert_eq!(
        core.set_annotate(false),
        Ok(()),
        "no page, no connection: still off"
    );
    assert!(!lock(&core.annotate).on);
    // A later document must not come up in annotate mode.
    lock(&core.annotate).install("sb");
    assert!(!lock(&core.annotate).add_context("sb", 1));
    assert_eq!(lock(&probe.annotate).last(), Some(&false));
}

#[test]
fn turning_on_fails_when_the_overlay_cannot_be_installed_and_stays_off() {
    let (core, probe) = core(None);
    assert_eq!(core.set_annotate(true), Err("no page open".to_owned()));
    lock(&core.inner).set_active("a", "sa");
    assert_eq!(
        core.set_annotate(true),
        Err("annotate overlay: cdp not connected".to_owned())
    );
    assert!(!lock(&core.annotate).on);
    assert!(!lock(&probe.annotate).contains(&true));
}

#[test]
fn picks_are_emitted_under_the_activation_lock_for_the_shown_page_only() {
    let (core, probe) = core(None);
    picked(&core);
    core.note_panel_release();
    core.on_binding("sa", &binding(BINDING, 7));
    lock(&core.inner).set_active("b", "sb");
    core.note_panel_release();
    core.on_binding("sa", &binding(BINDING, 7));
    assert_eq!(*lock(&probe.picks), ["http://a/"]);
}

#[test]
fn bindings_from_unowned_contexts_or_by_another_name_are_ignored() {
    let (core, probe) = core(None);
    picked(&core);
    // The page's main world, announced on the installed session.
    core.on_overlay_event(
        Some("sa"),
        "Runtime.executionContextCreated",
        &json!({ "context": { "id": 8, "name": "" } }),
    );
    core.note_panel_release();
    core.on_binding("sa", &binding(BINDING, 8)); // a page script, say
    core.on_binding("sb", &binding(BINDING, 7)); // another session's context 7
    core.on_binding("sa", &binding("__other", 7));
    assert!(lock(&probe.picks).is_empty());
}

#[test]
fn a_click_the_panel_did_not_send_is_no_pick() {
    let (core, probe) = core(None);
    picked(&core);
    core.on_binding("sa", &binding(BINDING, 7)); // the agent's trusted click
    assert!(lock(&probe.picks).is_empty());
}

#[test]
fn a_pick_still_queued_when_annotate_went_off_is_dropped() {
    let (core, probe) = core(None);
    picked(&core);
    core.note_panel_release();
    assert_eq!(core.set_annotate(false), Ok(()));
    core.on_binding("sa", &binding(BINDING, 7));
    assert!(lock(&probe.picks).is_empty());
}

/// The overlay's viewport reply: 400×300 at scroll (0, 0).
fn viewport(request: &Value) -> Value {
    let value = json!({ "x": 0, "y": 0, "w": 400, "h": 300, "dpr": 1 });
    cdp_result(
        request,
        json!({ "result": { "type": "object", "value": value } }),
    )
}

/// A fake Chromium answering with `reply`, the requests it saw, and the
/// view's probe.
fn fake(
    mut reply: impl FnMut(&Value) -> Value + Send + 'static,
) -> (Arc<Core>, Arc<Mutex<Vec<Value>>>, Arc<Probe>) {
    let seen = Arc::new(Mutex::new(Vec::new()));
    let log = Arc::clone(&seen);
    let client = fake_cdp(move |request| {
        lock(&log).push(request.clone()); // the test inspects what was sent
        Some(vec![reply(request)])
    });
    let (core, probe) = core(Some(client));
    picked(&core);
    (core, seen, probe)
}

/// The expressions evaluated during a capture, with their contexts.
fn evaluations(seen: &Mutex<Vec<Value>>) -> Vec<(String, i64)> {
    lock(seen)
        .iter()
        .filter(|r| r["method"] == "Runtime.evaluate")
        .filter_map(|r| {
            let params = &r["params"];
            Some((
                params["expression"].as_str()?.to_owned(),
                params["contextId"].as_i64()?,
            ))
        })
        .collect()
}

#[test]
fn a_screenshot_error_still_shows_the_overlay_again_and_annotate_stays_on() {
    let (core, seen, _) = fake(|request| match request["method"].as_str() {
        Some("Page.captureScreenshot") => cdp_error(request, "boom"),
        Some("Runtime.evaluate") => viewport(request),
        _ => cdp_result(request, json!({})),
    });
    assert!(core.capture(&rect(10.0, 10.0, 20.0, 20.0)).is_err());
    assert_eq!(
        evaluations(&seen),
        [
            (super::capture::HIDE.to_owned(), 7),
            (super::capture::SHOW.to_owned(), 7)
        ],
        "hidden and shown again in the pick's world, never switched off"
    );
    assert!(lock(&core.annotate).on);
}

#[test]
fn a_failed_show_does_not_discard_the_shot() {
    let (core, seen, _) = fake(|request| {
        if request["method"] == "Page.captureScreenshot" {
            let clip = &request["params"]["clip"];
            assert_eq!(
                clip["width"],
                json!(20.0),
                "clipped to the viewport: {clip}"
            );
            assert_eq!(
                clip["height"],
                json!(10.0),
                "clipped to the viewport: {clip}"
            );
            cdp_result(request, json!({ "data": "image" }))
        } else if request["params"]["expression"] == super::capture::SHOW {
            cdp_error(request, "Cannot find context with specified id")
        } else if request["method"] == "Runtime.evaluate" {
            viewport(request)
        } else {
            cdp_result(request, json!({}))
        }
    });
    let image = core.capture(&rect(10.0, 290.0, 20.0, 40.0)).unwrap();
    assert_eq!(image.data, "image");
    assert_eq!(evaluations(&seen).len(), 2);
}

#[test]
fn a_failed_hide_still_shows_the_overlay_again() {
    // A timed-out hide may still run in the page: the show must follow it.
    let (core, seen, _) = fake(|request| {
        if request["params"]["expression"] == super::capture::HIDE {
            cdp_error(request, "cdp Runtime.evaluate: timed out")
        } else {
            cdp_result(request, json!({}))
        }
    });
    assert_eq!(
        core.capture(&rect(0.0, 0.0, 5.0, 5.0)),
        Err("the page changed since the pick".to_owned())
    );
    assert_eq!(
        evaluations(&seen),
        [
            (super::capture::HIDE.to_owned(), 7),
            (super::capture::SHOW.to_owned(), 7)
        ]
    );
}

#[test]
fn a_capture_after_the_pick_s_document_is_gone_fails_without_hiding() {
    let (core, seen, _) = fake(|request| cdp_result(request, json!({})));
    core.on_overlay_event(
        Some("sa"),
        "Runtime.executionContextDestroyed",
        &json!({ "executionContextId": 7 }),
    );
    assert_eq!(
        core.capture(&rect(0.0, 0.0, 5.0, 5.0)),
        Err("the page changed since the pick".to_owned())
    );
    picked(&core);
    lock(&core.inner).set_active("b", "sb");
    assert_eq!(
        core.capture(&rect(0.0, 0.0, 5.0, 5.0)),
        Err("the page changed since the pick".to_owned()),
        "another page shown"
    );
    assert!(
        evaluations(&seen).is_empty(),
        "nothing evaluated: not hidden"
    );
}

/// The last annotate flag each overlay context was sent.
fn last_flags(seen: &Mutex<Vec<Value>>) -> HashMap<i64, String> {
    evaluations(seen)
        .into_iter()
        .filter(|(expression, _)| expression.starts_with("window.__ompAnnotateSet"))
        .map(|(expression, context)| (context, expression))
        .collect()
}

#[test]
fn a_close_while_turning_on_leaves_the_page_and_the_panel_off() {
    let shown: Arc<OnceLock<Weak<Core>>> = Arc::default();
    let closer = Arc::clone(&shown);
    let enabled_once = AtomicBool::new(false);
    let (core, seen, probe) = fake(move |request| {
        // `View::close` on another thread, as soon as the first enable
        // reaches the page.
        let enable = request["params"]["expression"]
            .as_str()
            .is_some_and(|e| e.starts_with("window.__ompAnnotateSet") && e.ends_with("(true)"));
        if enable && !enabled_once.swap(true, Ordering::SeqCst) {
            if let Some(core) = closer.get().and_then(Weak::upgrade) {
                assert!(core.mark_closed());
                core.update_state(|s| s.annotate = false);
                core.release_overlay("sa");
            }
        }
        cdp_result(request, json!({}))
    });
    assert!(shown.set(Arc::downgrade(&core)).is_ok());
    lock(&core.annotate).on = false;
    lock(&core.annotate).add_context("sa", 8);
    let _ = core.set_annotate(true);
    // Answered after everything sent before it, the release included.
    let _ = core.call(
        Some("sa"),
        "Runtime.evaluate",
        json!({ "expression": "'end'" }),
    );
    let off = super::set_params(false, 0)["expression"]
        .as_str()
        .map(str::to_owned);
    let flags = last_flags(&seen);
    assert_eq!(flags.len(), 2, "both contexts were told: {flags:?}");
    assert!(
        flags.values().all(|e| Some(e) == off.as_ref()),
        "no enable after the release: {flags:?}"
    );
    assert!(
        !lock(&probe.annotate).contains(&true),
        "the panel is never told annotate is on after the close"
    );
}

// ---- against a real Chromium ----

/// Records the picks the view emits, and its tabs.
#[derive(Default)]
struct Picks(Mutex<Vec<Pick>>, Mutex<Vec<TabInfo>>);

impl Picks {
    fn all(&self) -> Vec<Pick> {
        lock(&self.0).clone() // a snapshot for the test to inspect
    }

    fn tabs(&self) -> Vec<TabInfo> {
        lock(&self.1).clone() // a snapshot for the test to inspect
    }

    /// The picks, once there are at least `n`.
    fn wait(&self, n: usize) -> Vec<Pick> {
        eventually(CHROMIUM_EVENT, || {
            Some(self.all()).filter(|all| all.len() >= n)
        })
        .expect("the picks")
    }
}

impl BrowserEmit for Picks {
    fn frame(&self, _: &str, _: &Frame) {}
    fn tabs(&self, _: &str, tabs: &[TabInfo]) {
        let mut kept = lock(&self.1);
        kept.clear();
        kept.extend_from_slice(tabs); // the probe keeps the latest tabs for the test
    }
    fn state(&self, _: &str, _: &ViewState) {}
    fn pick(&self, _: &str, p: &Pick) {
        lock(&self.0).push(p.clone()); // the log owns what it records
    }
}

fn open(name: &str) -> Option<(BrowserManager, Arc<View>, Arc<Picks>)> {
    let picks = Arc::new(Picks::default());
    let (m, view) = panel(name, 1.0, Arc::clone(&picks) as Arc<dyn BrowserEmit>)?;
    Some((m, view, picks))
}

fn eval(view: &View, expression: &str) -> Value {
    view.evaluate_for_test(expression).unwrap_or(Value::Null)
}

/// Load `url` and wait until its document (with `marker` in it) is loaded:
/// `navigate` returns before the commit.
fn goto(view: &View, url: &str, marker: &str) {
    view.navigate(url).unwrap();
    let found = format!(
        "document.readyState === 'complete' && !!document.querySelector({})",
        serde_json::to_string(marker).unwrap()
    );
    eventually(CHROMIUM_EVENT, || {
        (eval(view, &found) == json!(true)).then_some(())
    })
    .expect("the page loaded");
}

/// The page is loaded and, with `annotate`, the overlay is up and visible in
/// it (its host element is in the document, whatever the world).
fn ready(view: &View, annotate: bool) {
    let overlay = "(o => o ? o.style.visibility !== 'hidden' : false)\
                   (document.querySelector('omp-annotate-overlay'))";
    let up = eventually(CHROMIUM_EVENT, || {
        let loaded = eval(view, "document.readyState") == json!("complete");
        (loaded && eval(view, overlay) == json!(annotate)).then_some(())
    });
    assert!(up.is_some(), "page loaded, overlay {annotate}");
}

/// Centre of the first `selector` match.
fn center(view: &View, selector: &str) -> (f64, f64) {
    let r = eval(
        view,
        &format!(
            "(r => [r.x + r.width / 2, r.y + r.height / 2])(document.querySelector('{selector}').getBoundingClientRect())"
        ),
    );
    (r[0].as_f64().unwrap(), r[1].as_f64().unwrap())
}

fn click(view: &View, (x, y): (f64, f64)) {
    for kind in ["mouseMoved", "mousePressed", "mouseReleased"] {
        view.input(&mouse(kind, x, y)).unwrap();
    }
}

/// Whether `selector` finds exactly the element `target` finds.
fn resolves(view: &View, selector: &str, target: &str) -> bool {
    let selector = serde_json::to_string(selector).unwrap();
    let target = serde_json::to_string(target).unwrap();
    eval(
        view,
        &format!(
            "(() => {{ const found = document.querySelectorAll({selector}); \
             return found.length === 1 && found[0] === document.querySelector({target}); }})()"
        ),
    ) == json!(true)
}

/// RGB channels of the centre pixel of a captured PNG.
fn center_pixel(image: &CapturedImage) -> [u8; 3] {
    let data = base64::engine::general_purpose::STANDARD
        .decode(&image.data)
        .expect("the capture is base64");
    let mut reader = png::Decoder::new(std::io::Cursor::new(data))
        .read_info()
        .expect("the capture has a PNG header");
    let mut frame = vec![0; reader.output_buffer_size().expect("bounded PNG")];
    let info = reader.next_frame(&mut frame).expect("PNG pixels");
    assert_eq!(info.bit_depth, png::BitDepth::Eight);
    let stride = match info.color_type {
        png::ColorType::Rgb => 3,
        png::ColorType::Rgba => 4,
        other => panic!("unexpected capture colour type: {other:?}"),
    };
    let offset = usize::try_from(info.height / 2).unwrap() * info.line_size
        + usize::try_from(info.width / 2).unwrap() * stride;
    frame[offset..offset + 3].try_into().unwrap()
}

const BUTTON_PAGE: &str = "data:text/html,<main><button class=save \
                           onclick=\"document.title='clicked'\">Save</button></main>";

#[test]
fn element_pick_reports_selector_and_swallows_the_click() {
    let _chromium = lock(&CHROMIUM);
    let Some((m, view, picks)) = open("annotate-element") else {
        return;
    };
    goto(&view, BUTTON_PAGE, "button");
    view.annotate(true).unwrap();
    ready(&view, true);
    click(&view, center(&view, "button"));
    // A second pick after it: a duplicate of the first would come between.
    click(&view, center(&view, "main"));
    let all = picks.wait(2);
    assert_eq!(all.len(), 2, "one pick per click");
    let pick = &all[0];
    assert_eq!(pick.kind, "element");
    assert_eq!(pick.selector.as_deref(), Some("button.save"));
    assert_eq!(pick.tag.as_deref(), Some("button"));
    assert!(pick.html.as_deref().unwrap().contains("Save"));
    assert_eq!(pick.text.as_deref(), Some("Save"));
    assert!(pick.url.starts_with("data:text/html"));
    assert!(pick.rect.w > 0.0 && pick.rect.h > 0.0, "{:?}", pick.rect);
    assert_eq!(all[1].tag.as_deref(), Some("main"));
    assert_eq!(
        eval(&view, "document.title"),
        json!(""),
        "the page's own click handler did not fire"
    );
    // Off again: the overlay is gone and the page gets its click.
    view.annotate(false).unwrap();
    ready(&view, false);
    click(&view, center(&view, "button"));
    let clicked = eventually(CHROMIUM_EVENT, || {
        (eval(&view, "document.title") == json!("clicked")).then_some(())
    });
    assert!(
        clicked.is_some(),
        "without annotate the click reaches the page"
    );
    assert_eq!(picks.all().len(), 2, "and reports nothing");
    m.release("s1");
}

#[test]
fn the_page_cannot_see_the_overlay_world_and_its_synthetic_clicks_pass() {
    let _chromium = lock(&CHROMIUM);
    let Some((m, view, picks)) = open("annotate-isolated") else {
        return;
    };
    goto(&view, BUTTON_PAGE, "button");
    view.annotate(true).unwrap();
    ready(&view, true);
    assert_eq!(
        eval(
            &view,
            "[typeof window.__ompAnnotate, typeof window.__ompAnnotateSet, typeof window.__ompAnnotateHide]"
        ),
        json!(["undefined", "undefined", "undefined"]),
        "binding and controls live in the isolated world only"
    );
    // `el.click()` (a page script, the agent's evaluate) is not the user's.
    eval(&view, "document.querySelector('button').click()");
    assert_eq!(eval(&view, "document.title"), json!("clicked"));
    // A real click after it is a pick; nothing came before it.
    click(&view, center(&view, "button"));
    let all = picks.wait(1);
    assert_eq!(all.len(), 1);
    assert_eq!(all[0].selector.as_deref(), Some("button.save"));
    m.release("s1");
}

/// A same-process frame over the top-left corner whose button titles the
/// page.
const FRAME_PAGE: &str = "data:text/html,<iframe style='position:absolute;left:0;top:0;\
                          width:300px;height:200px;border:0' srcdoc=\"<button \
                          style='width:200px;height:100px' \
                          onclick='top.document.title=&quot;framed&quot;'>Go</button>\">\
                          </iframe>";

#[test]
fn clicks_inside_a_frame_are_swallowed_too_and_make_no_pick() {
    let _chromium = lock(&CHROMIUM);
    let Some((m, view, picks)) = open("annotate-frame") else {
        return;
    };
    goto(&view, FRAME_PAGE, "iframe");
    let framed = "!!document.querySelector('iframe').contentDocument.querySelector('button')";
    let loaded = eventually(CHROMIUM_EVENT, || {
        (eval(&view, framed) == json!(true)).then_some(())
    });
    assert!(loaded.is_some(), "the frame's button is there");
    view.annotate(true).unwrap();
    ready(&view, true);
    click(&view, (100.0, 50.0));
    // A pick outside the frame after it: the frame's click was handled
    // first (CDP keeps the order).
    click(&view, (350.0, 250.0));
    assert_eq!(
        picks.wait(1).len(),
        1,
        "only the click outside the frame picks"
    );
    assert_eq!(
        eval(&view, "document.title"),
        json!(""),
        "the frame's own click handler did not fire"
    );
    view.annotate(false).unwrap();
    ready(&view, false);
    click(&view, (100.0, 50.0));
    let clicked = eventually(CHROMIUM_EVENT, || {
        (eval(&view, "document.title") == json!("framed")).then_some(())
    });
    assert!(
        clicked.is_some(),
        "without annotate the frame gets its click"
    );
    assert_eq!(picks.all().len(), 1, "and reports nothing");
    m.release("s1");
}

/// Two same-tag buttons, different classes: the class alone already
/// distinguishes them, so the selector must not carry `:nth-of-type`.
const BUTTONS_PAGE: &str = "data:text/html,<main>\
                           <button class=cancel onclick=\"document.title='cancel'\">Cancel</button>\
                           <button class=save onclick=\"document.title='save'\">Save</button>\
                           </main>";

#[test]
fn sibling_buttons_get_minimal_selectors() {
    let _chromium = lock(&CHROMIUM);
    let Some((m, view, picks)) = open("annotate-siblings") else {
        return;
    };
    goto(&view, BUTTONS_PAGE, "button.save");
    view.annotate(true).unwrap();
    ready(&view, true);
    click(&view, center(&view, "button.save"));
    let all = picks.wait(1);
    assert_eq!(all[0].kind, "element");
    assert_eq!(all[0].selector.as_deref(), Some("button.save"));
    m.release("s1");
}

#[test]
fn overlapping_sibling_classes_still_resolve_to_the_picked_element() {
    let _chromium = lock(&CHROMIUM);
    let Some((m, view, picks)) = open("annotate-overlapping-classes") else {
        return;
    };
    goto(
        &view,
        "data:text/html,<ul><li class=item>Pick me</li><li class='item active'>Other</li></ul>",
        "li",
    );
    view.annotate(true).unwrap();
    ready(&view, true);
    click(&view, center(&view, "li.item"));
    let all = picks.wait(1);
    assert!(resolves(&view, all[0].selector.as_deref().unwrap(), "li"));
    m.release("s1");
}

#[test]
fn namespaced_and_svg_tags_get_selectors_that_match() {
    let _chromium = lock(&CHROMIUM);
    let Some((m, view, picks)) = open("annotate-namespaced-tags") else {
        return;
    };
    goto(
        &view,
        "data:text/html,<main><o:p>First</o:p> <o:p>Pick me</o:p></main><div>a</div>\
         <svg width=200 height=60><foreignObject width=200 height=60>\
         <div style='height:60px'>b</div></foreignObject></svg>",
        "svg div",
    );
    view.annotate(true).unwrap();
    ready(&view, true);
    click(&view, center(&view, "main > :nth-child(2)"));
    click(&view, center(&view, "svg div"));
    let all = picks.wait(2);
    assert_eq!(all[0].tag.as_deref(), Some("o:p"));
    assert_eq!(all[0].text.as_deref(), Some("Pick me"));
    assert!(resolves(
        &view,
        all[0].selector.as_deref().unwrap(),
        "main > :nth-child(2)"
    ));
    assert_eq!(
        all[1].selector.as_deref(),
        Some("foreignObject > div"),
        "an SVG name keeps its case"
    );
    assert!(resolves(
        &view,
        all[1].selector.as_deref().unwrap(),
        "svg div"
    ));
    m.release("s1");
}

#[test]
fn ids_and_test_ids_are_escaped() {
    let _chromium = lock(&CHROMIUM);
    let Some((m, view, picks)) = open("annotate-escaping") else {
        return;
    };
    goto(
        &view,
        "data:text/html,<p class=a>one</p><p class=b>two</p>",
        "p.b",
    );
    view.annotate(true).unwrap();
    ready(&view, true);
    eval(
        &view,
        r#"(() => {
            document.querySelector('p.a').id = '1st "a" b:c';
            document.querySelector('p.b').dataset.testid = 'say "hi" \\ there';
        })()"#,
    );
    click(&view, center(&view, "p.a"));
    click(&view, center(&view, "p.b"));
    let all = picks.wait(2);
    let (by_id, by_test_id) = (
        all[0].selector.as_deref().unwrap(),
        all[1].selector.as_deref().unwrap(),
    );
    assert!(by_id.starts_with('#'), "{by_id}");
    assert!(resolves(&view, by_id, "p.a"), "{by_id}");
    assert!(by_test_id.starts_with("[data-testid="), "{by_test_id}");
    assert!(resolves(&view, by_test_id, "p.b"), "{by_test_id}");
    m.release("s1");
}

#[test]
fn long_text_pick_keeps_a_complete_pair_at_the_cut_boundary() {
    let _chromium = lock(&CHROMIUM);
    let Some((m, view, picks)) = open("annotate-complete-emoji") else {
        return;
    };
    goto(&view, "data:text/html,<p>x</p>", "p");
    view.annotate(true).unwrap();
    ready(&view, true);
    eval(
        &view,
        "document.querySelector('p').textContent = 'a'.repeat(498) + '\u{1F600}' + 'more'",
    );
    click(&view, center(&view, "p"));
    let expected = format!("{}\u{1F600}", "a".repeat(498));
    assert_eq!(picks.wait(1)[0].text.as_deref(), Some(expected.as_str()));
    m.release("s1");
}

/// A text longer than `MAX_TEXT` whose boundary falls inside a surrogate
/// pair, and a lone surrogate elsewhere: the pick still arrives.
#[test]
fn long_text_pick_keeps_surrogate_pairs_intact_and_text_well_formed() {
    let _chromium = lock(&CHROMIUM);
    let Some((m, view, picks)) = open("annotate-emoji") else {
        return;
    };
    goto(
        &view,
        "data:text/html,<p class=long style=\"font-size:10px;padding:20px\">x</p>",
        "p.long",
    );
    view.annotate(true).unwrap();
    ready(&view, true);
    eval(
        &view,
        "document.querySelector('p.long').textContent = '\\ud800' + 'a'.repeat(498) + '\u{1F600}'",
    );
    click(&view, center(&view, "p.long"));
    let pick = &picks.wait(1)[0];
    assert_eq!(pick.kind, "element");
    // The lone surrogate becomes U+FFFD; 1 + 498 'a' + one emoji is 501
    // UTF-16 units, so the 500-unit cut would land on the emoji's high
    // surrogate: the report drops it.
    let expected = format!("\u{FFFD}{}", "a".repeat(498));
    assert_eq!(pick.text.as_deref(), Some(expected.as_str()));
    m.release("s1");
}

#[test]
fn area_pick_reports_rect_and_a_flat_drag_is_an_element_pick() {
    let _chromium = lock(&CHROMIUM);
    let Some((m, view, picks)) = open("annotate-area") else {
        return;
    };
    goto(
        &view,
        "data:text/html,<body class=tall style=height:2000px>",
        "body.tall",
    );
    view.annotate(true).unwrap();
    ready(&view, true);
    let drag = |from: (f64, f64), to: (f64, f64)| {
        for event in [
            mouse("mouseMoved", from.0, from.1),
            mouse("mousePressed", from.0, from.1),
            mouse(
                "mouseMoved",
                f64::midpoint(from.0, to.0),
                f64::midpoint(from.1, to.1),
            ),
            mouse("mouseMoved", to.0, to.1),
            mouse("mouseReleased", to.0, to.1),
        ] {
            view.input(&event).unwrap();
        }
    };
    drag((10.0, 10.0), (110.0, 60.0));
    drag((10.0, 100.0), (110.0, 100.0)); // horizontal: no area
    let all = picks.wait(2);
    let pick = &all[0];
    assert_eq!(pick.kind, "area");
    assert_eq!(
        (&pick.selector, &pick.tag, &pick.html, &pick.text),
        (&None, &None, &None, &None)
    );
    let Rect { x, y, w, h } = pick.rect;
    for (got, want) in [(x, 10.0), (y, 10.0), (w, 100.0), (h, 50.0)] {
        assert!((got - want).abs() <= 1.0, "{:?}", pick.rect);
    }
    assert_eq!(all[1].kind, "element");
    assert_eq!(all[1].tag.as_deref(), Some("body"));
    m.release("s1");
}

/// Serves `page` with a strict CSP from a thread until the guard drops.
struct Server {
    port: u16,
    stop: Arc<AtomicBool>,
}

impl Server {
    fn start(page: &'static str) -> Self {
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        let port = listener.local_addr().unwrap().port();
        let stop = Arc::new(AtomicBool::new(false));
        let stopped = Arc::clone(&stop);
        std::thread::spawn(move || {
            for stream in listener.incoming() {
                if stopped.load(Ordering::SeqCst) {
                    break;
                }
                let Ok(mut stream) = stream else { continue };
                let mut request = [0u8; 2048];
                let _ = stream.read(&mut request);
                let response = format!(
                    "HTTP/1.1 200 OK\r\nContent-Type: text/html\r\nContent-Security-Policy: \
                     default-src 'self'; style-src 'self'; script-src 'self'\r\n\
                     Content-Length: {}\r\nConnection: close\r\n\r\n{page}",
                    page.len()
                );
                let _ = stream.write_all(response.as_bytes());
            }
        });
        Self { port, stop }
    }
}

impl Drop for Server {
    fn drop(&mut self) {
        self.stop.store(true, Ordering::SeqCst);
        let _ = std::net::TcpStream::connect(("127.0.0.1", self.port)); // wakes the accept
    }
}

#[test]
fn annotate_works_under_strict_csp() {
    let _chromium = lock(&CHROMIUM);
    let Some((m, view, picks)) = open("annotate-csp") else {
        return;
    };
    let server = Server::start("<main><button class=save>Save</button></main>");
    goto(
        &view,
        &format!("http://127.0.0.1:{}/", server.port),
        "button.save",
    );
    view.annotate(true).unwrap();
    ready(&view, true);
    click(&view, center(&view, "button"));
    assert_eq!(picks.wait(1)[0].selector.as_deref(), Some("button.save"));
    m.release("s1");
}

#[test]
fn annotate_survives_navigation_and_tab_switches() {
    let _chromium = lock(&CHROMIUM);
    let Some((m, view, picks)) = open("annotate-nav") else {
        return;
    };
    goto(&view, "data:text/html,<p>one</p>", "p");
    view.annotate(true).unwrap();
    ready(&view, true);
    goto(&view, BUTTON_PAGE, "button"); // a new document: the overlay is switched on again
    ready(&view, true);
    click(&view, center(&view, "button"));
    picks.wait(1);
    // A tab opened while annotate is on has the overlay too.
    let first_tab = picks.tabs().swap_remove(0).target_id;
    view.tab_new().unwrap();
    goto(&view, BUTTON_PAGE, "button");
    ready(&view, true);
    click(&view, center(&view, "button"));
    picks.wait(2);
    // Back on the first tab: annotate is still on there.
    view.tab_activate(&first_tab).unwrap();
    ready(&view, true);
    view.annotate(false).unwrap();
    ready(&view, false);
    m.release("s1");
}

#[test]
fn concurrent_target_switch_and_toggle_leave_shown_overlay_matching_flag() {
    let _chromium = lock(&CHROMIUM);
    let Some((m, view, picks)) = open("annotate-toggle-switch") else {
        return;
    };
    goto(&view, BUTTON_PAGE, "button");
    view.annotate(true).unwrap();
    ready(&view, true);
    let first = picks.tabs().swap_remove(0).target_id;
    view.tab_new().unwrap();
    goto(&view, BUTTON_PAGE, "button");
    ready(&view, true);
    let second = picks
        .tabs()
        .into_iter()
        .find(|tab| tab.target_id != first)
        .expect("a second target")
        .target_id;
    for _ in 0..4 {
        for (target, on) in [(&first, false), (&second, true)] {
            let start = Arc::new(std::sync::Barrier::new(2));
            let toggled = Arc::clone(&view);
            let toggle_start = Arc::clone(&start);
            let toggle = std::thread::spawn(move || {
                toggle_start.wait();
                toggled.annotate(on).unwrap();
            });
            start.wait();
            view.tab_activate(target).unwrap();
            toggle.join().unwrap();
            ready(&view, on);
        }
    }
    view.annotate(false).unwrap();
    ready(&view, false);
    click(&view, center(&view, "button"));
    eventually(CHROMIUM_EVENT, || {
        (eval(&view, "document.title") == json!("clicked")).then_some(())
    })
    .expect("toggle-off leaves clicks reaching the shown page");
    assert!(picks.all().is_empty(), "no swallowed click becomes a pick");
    m.release("s1");
}

const TALL_PAGE: &str = "data:text/html,<body style='margin:0;height:2400px'>\
                        <div id=block style='position:absolute;left:40px;top:1200px;\
                        width:120px;height:80px;background:rgb(20,180,60)'></div>";

#[test]
fn capture_returns_a_png_of_the_pick_and_refuses_an_empty_area() {
    let _chromium = lock(&CHROMIUM);
    let Some((m, view, picks)) = open("annotate-capture") else {
        return;
    };
    goto(&view, "data:text/html,<h1>hi</h1>", "h1");
    view.annotate(true).unwrap();
    ready(&view, true);
    click(&view, center(&view, "h1"));
    let pick = picks.wait(1).swap_remove(0);
    let doc_rect = pick.doc_rect.expect("a document rect");
    let image = view.capture(&doc_rect).unwrap();
    assert_eq!(image.mime_type, "image/png");
    assert!(
        image.data.starts_with("iVBORw0KGgo"),
        "base64 of the PNG magic \\x89PNG\\r\\n\\x1a\\n: {}",
        &image.data[..image.data.len().min(20)]
    );
    // Refused, and the overlay is shown again.
    assert!(view.capture(&rect(0.0, 0.0, 0.0, 20.0)).is_err());
    ready(&view, true);
    m.release("s1");
}

#[test]
fn capture_scrolled_pick_has_clean_block_pixels_also_concurrently() {
    let _chromium = lock(&CHROMIUM);
    let Some((m, view, picks)) = open("annotate-capture-scroll") else {
        return;
    };
    goto(&view, TALL_PAGE, "#block");
    view.annotate(true).unwrap();
    ready(&view, true);
    eval(&view, "window.scrollTo(0, 1100)");
    assert_eq!(eval(&view, "window.scrollY"), json!(1100));
    click(&view, center(&view, "#block"));
    let pick = picks.wait(1).swap_remove(0);
    assert_eq!(pick.selector.as_deref(), Some("#block"));
    assert!((pick.rect.y - 100.0).abs() < 1.0, "viewport-relative pick");
    let doc_rect = pick.doc_rect.expect("a document rect");
    // A fresh hover leaves the blue tint visible: failing to hide the overlay
    // during capture changes the centre pixel even if the scroll is correct.
    let (x, y) = center(&view, "#block");
    view.input(&mouse("mouseMoved", 10.0, 10.0)).unwrap();
    eventually(CHROMIUM_EVENT, || {
        (eval(&view, "!!document.querySelector('#block:hover')") == json!(false)).then_some(())
    })
    .expect("hover input left the block");
    view.input(&mouse("mouseMoved", x + 1.0, y)).unwrap();
    eventually(CHROMIUM_EVENT, || {
        (eval(&view, "!!document.querySelector('#block:hover')") == json!(true)).then_some(())
    })
    .expect("hover input reached the block");
    // Chromium may return an old compositor tile after scrolling. Wait on
    // actual pixels, not a fixed delay or DOM readiness.
    eventually(CHROMIUM_EVENT, || {
        let image = view.capture(&doc_rect).unwrap();
        (center_pixel(&image) == [20, 180, 60]).then_some(())
    })
    .expect("the captured block has its untinted RGB colour");
    // Two at once: neither shows the other's restored overlay.
    let shots: Vec<_> = (0..2)
        .map(|_| {
            let view = Arc::clone(&view);
            let doc_rect = doc_rect.clone(); // each thread owns its area
            std::thread::spawn(move || view.capture(&doc_rect))
        })
        .collect();
    for shot in shots {
        assert_eq!(center_pixel(&shot.join().unwrap().unwrap()), [20, 180, 60]);
    }
    ready(&view, true);
    m.release("s1");
}

#[test]
fn scroll_to_brings_below_fold_rect_into_view() {
    let _chromium = lock(&CHROMIUM);
    let Some((m, view, picks)) = open("annotate-scroll-to") else {
        return;
    };
    goto(&view, TALL_PAGE, "#block");
    view.annotate(true).unwrap();
    ready(&view, true);
    eval(&view, "window.scrollTo(0, 1100)");
    click(&view, center(&view, "#block"));
    let document_rect = picks
        .wait(1)
        .swap_remove(0)
        .doc_rect
        .expect("a document rect");
    assert_eq!(document_rect, rect(40.0, 1200.0, 120.0, 80.0));
    view.annotate(false).unwrap();
    let visible = "(() => { const r = document.querySelector('#block').getBoundingClientRect(); \
                   return r.top >= 0 && r.bottom <= window.innerHeight; })()";
    for scroll in [0, 1800, 700] {
        eval(&view, &format!("window.scrollTo(0, {scroll})"));
        view.scroll_to(&document_rect).unwrap();
        assert_eq!(
            eval(&view, visible),
            json!(true),
            "saved document rect remains valid after scrolling to {scroll}"
        );
    }
    m.release("s1");
}

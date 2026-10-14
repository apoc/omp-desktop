//! Annotate mode and area capture against a real Chromium (skipped when none
//! is installed).

use std::io::{Read, Write};
use std::net::TcpListener;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use base64::Engine;
use serde_json::{json, Value};

use super::annotate::CapturedImage;
use super::emit::{BrowserEmit, Frame, Pick, Rect, TabInfo, ViewState};
use super::tests::manager_with_chromium;
use super::view::{InputEvent, View};
use super::{lock, BrowserManager};

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
}

impl BrowserEmit for Picks {
    fn frame(&self, _: &str, _: &Frame) {}
    fn tabs(&self, _: &str, tabs: &[TabInfo]) {
        *lock(&self.1) = tabs.to_vec();
    }
    fn state(&self, _: &str, _: &ViewState) {}
    fn pick(&self, _: &str, p: &Pick) {
        lock(&self.0).push(p.clone()); // the log owns what it records
    }
}

fn eventually<T>(secs: u64, mut check: impl FnMut() -> Option<T>) -> Option<T> {
    let deadline = Instant::now() + Duration::from_secs(secs);
    loop {
        if let Some(found) = check() {
            return Some(found);
        }
        if Instant::now() >= deadline {
            return None;
        }
        std::thread::sleep(Duration::from_millis(20));
    }
}

fn panel(name: &str) -> Option<(BrowserManager, Arc<View>, Arc<Picks>)> {
    let m = manager_with_chromium(name)?;
    m.allocate("s1", None).unwrap();
    let picks = Arc::new(Picks::default());
    let emit: Arc<dyn BrowserEmit> = Arc::clone(&picks) as Arc<dyn BrowserEmit>;
    m.open_panel("s1", 400, 300, 1.0, emit).unwrap();
    let view = m.panel("s1").unwrap();
    Some((m, view, picks))
}

fn mouse(kind: &str, x: f64, y: f64) -> InputEvent {
    let moved = kind == "mouseMoved";
    InputEvent::Mouse {
        r#type: kind.into(),
        x,
        y,
        button: if moved { "none" } else { "left" }.into(),
        buttons: u32::from(kind == "mousePressed"),
        click_count: u32::from(!moved),
        modifiers: 0,
    }
}

fn eval(view: &View, expression: &str) -> Value {
    view.evaluate_for_test(expression).unwrap_or(Value::Null)
}

/// The page is loaded and, with `annotate`, the overlay is up in it (its
/// host element is in the document, whatever the world).
fn ready(view: &View, annotate: bool) {
    let up = eventually(5, || {
        let loaded = eval(view, "document.readyState") == json!("complete");
        let overlay = eval(view, "!!document.querySelector('omp-annotate-overlay')");
        (loaded && overlay == json!(annotate)).then_some(())
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
fn element_pick_reports_selector() {
    let Some((m, view, picks)) = panel("annotate-element") else {
        eprintln!("skip: no chromium");
        return;
    };
    view.navigate(BUTTON_PAGE).unwrap();
    view.annotate(true).unwrap();
    ready(&view, true);
    click(&view, center(&view, "button"));
    let all = eventually(3, || (!picks.all().is_empty()).then(|| picks.all())).expect("a pick");
    std::thread::sleep(Duration::from_millis(300));
    assert_eq!(picks.all().len(), 1, "one pick for one click");
    let pick = &all[0];
    assert_eq!(pick.kind, "element");
    assert_eq!(pick.selector.as_deref(), Some("button.save"));
    assert_eq!(pick.tag.as_deref(), Some("button"));
    assert!(pick.html.as_deref().unwrap().contains("Save"));
    assert_eq!(pick.text.as_deref(), Some("Save"));
    assert!(pick.url.starts_with("data:text/html"));
    assert!(pick.rect.w > 0.0 && pick.rect.h > 0.0, "{:?}", pick.rect);
    assert_eq!(
        eval(&view, "document.title"),
        json!(""),
        "the page's own click handler did not fire"
    );
    // Off again: the overlay is gone and the page gets its click.
    view.annotate(false).unwrap();
    ready(&view, false);
    click(&view, center(&view, "button"));
    let clicked = eventually(3, || {
        (eval(&view, "document.title") == json!("clicked")).then_some(())
    });
    assert!(
        clicked.is_some(),
        "without annotate the click reaches the page"
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
    let Some((m, view, picks)) = panel("annotate-siblings") else {
        eprintln!("skip: no chromium");
        return;
    };
    view.navigate(BUTTONS_PAGE).unwrap();
    view.annotate(true).unwrap();
    ready(&view, true);
    click(&view, center(&view, "button.save"));
    let all = eventually(3, || (!picks.all().is_empty()).then(|| picks.all())).expect("a pick");
    assert_eq!(picks.all().len(), 1, "one pick for one click");
    let pick = &all[0];
    assert_eq!(pick.kind, "element");
    assert_eq!(pick.selector.as_deref(), Some("button.save"));
    m.release("s1");
}

#[test]
fn overlapping_sibling_classes_still_resolve_to_the_picked_element() {
    let Some((m, view, picks)) = panel("annotate-overlapping-classes") else {
        eprintln!("skip: no chromium");
        return;
    };
    view.navigate(
        "data:text/html,<ul><li class=item>Pick me</li><li class='item active'>Other</li></ul>",
    )
    .unwrap();
    view.annotate(true).unwrap();
    ready(&view, true);
    click(&view, center(&view, "li.item"));
    let all = eventually(3, || (!picks.all().is_empty()).then(|| picks.all())).expect("a pick");
    let selector = serde_json::to_string(all[0].selector.as_ref().unwrap()).unwrap();
    assert_eq!(
        eval(&view, &format!("(() => {{ const found = document.querySelectorAll({selector}); return found.length === 1 && found[0] === document.querySelector('li'); }})()")),
        json!(true),
        "selector uniquely resolves to the picked sibling"
    );
    m.release("s1");
}

#[test]
fn namespaced_tag_siblings_still_deliver_a_resolvable_pick() {
    let Some((m, view, picks)) = panel("annotate-namespaced-tags") else {
        eprintln!("skip: no chromium");
        return;
    };
    view.navigate("data:text/html,<main><o:p>First</o:p> <o:p>Pick me</o:p></main>")
        .unwrap();
    view.annotate(true).unwrap();
    ready(&view, true);
    click(&view, center(&view, "main > :nth-child(2)"));
    let all = eventually(3, || (!picks.all().is_empty()).then(|| picks.all()))
        .expect("a pick from a namespaced-looking tag");
    assert_eq!(all.len(), 1, "one pick for one click");
    assert_eq!(all[0].kind, "element");
    assert_eq!(all[0].tag.as_deref(), Some("o:p"));
    assert_eq!(all[0].text.as_deref(), Some("Pick me"));
    let selector = serde_json::to_string(all[0].selector.as_ref().unwrap()).unwrap();
    assert_eq!(
        eval(&view, &format!("(() => {{ const found = document.querySelectorAll({selector}); return found.length === 1 && found[0] === document.querySelector('main > :nth-child(2)'); }})()")),
        json!(true),
        "selector uniquely resolves to the picked namespaced-looking sibling"
    );
    m.release("s1");
}

#[test]
fn long_text_pick_keeps_a_complete_pair_at_the_cut_boundary() {
    let Some((m, view, picks)) = panel("annotate-complete-emoji") else {
        eprintln!("skip: no chromium");
        return;
    };
    view.navigate("data:text/html,<p>x</p>").unwrap();
    view.annotate(true).unwrap();
    ready(&view, true);
    eval(
        &view,
        "document.querySelector('p').textContent = 'a'.repeat(498) + '\u{1F600}' + 'more'",
    );
    click(&view, center(&view, "p"));
    let all = eventually(3, || (!picks.all().is_empty()).then(|| picks.all())).expect("a pick");
    let expected = format!("{}\u{1F600}", "a".repeat(498));
    assert_eq!(all[0].text.as_deref(), Some(expected.as_str()));
    m.release("s1");
}

/// A text longer than `MAX_TEXT` whose boundary falls inside a surrogate
/// pair must not split the pair: the pick still arrives, whole code points.
#[test]
fn long_text_pick_keeps_surrogate_pair_intact() {
    let Some((m, view, picks)) = panel("annotate-emoji") else {
        eprintln!("skip: no chromium");
        return;
    };
    view.navigate("data:text/html,<p class=long style=\"font-size:10px;padding:20px\">x</p>")
        .unwrap();
    view.annotate(true).unwrap();
    ready(&view, true);
    eval(
        &view,
        "document.querySelector('p.long').textContent = 'a'.repeat(499) + '\u{1F600}'",
    );
    click(&view, center(&view, "p.long"));
    let all = eventually(3, || (!picks.all().is_empty()).then(|| picks.all())).expect("a pick");
    let pick = &all[0];
    assert_eq!(pick.kind, "element");
    // 499 'a' + one emoji is 501 UTF-16 units; the 500-unit cut would land
    // on the lone high surrogate, so the report drops it and the emoji.
    let expected = "a".repeat(499);
    assert_eq!(pick.text.as_deref(), Some(expected.as_str()));
    m.release("s1");
}

#[test]
fn area_pick_reports_rect() {
    let Some((m, view, picks)) = panel("annotate-area") else {
        eprintln!("skip: no chromium");
        return;
    };
    view.navigate("data:text/html,<body style=height:2000px>")
        .unwrap();
    view.annotate(true).unwrap();
    ready(&view, true);
    for event in [
        mouse("mouseMoved", 10.0, 10.0),
        mouse("mousePressed", 10.0, 10.0),
        mouse("mouseMoved", 60.0, 30.0),
        mouse("mouseMoved", 110.0, 60.0),
        mouse("mouseReleased", 110.0, 60.0),
    ] {
        view.input(&event).unwrap();
    }
    let all = eventually(3, || (!picks.all().is_empty()).then(|| picks.all())).expect("a pick");
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
    let Some((m, view, picks)) = panel("annotate-csp") else {
        eprintln!("skip: no chromium");
        return;
    };
    let server = Server::start("<main><button class=save>Save</button></main>");
    view.navigate(&format!("http://127.0.0.1:{}/", server.port))
        .unwrap();
    view.annotate(true).unwrap();
    ready(&view, true);
    click(&view, center(&view, "button"));
    let all = eventually(3, || (!picks.all().is_empty()).then(|| picks.all()));
    let all = all.expect("a pick under a strict CSP");
    assert_eq!(all[0].selector.as_deref(), Some("button.save"));
    m.release("s1");
}

#[test]
fn annotate_survives_navigation_and_tab_switches() {
    let Some((m, view, picks)) = panel("annotate-nav") else {
        eprintln!("skip: no chromium");
        return;
    };
    view.navigate("data:text/html,<p>one</p>").unwrap();
    view.annotate(true).unwrap();
    ready(&view, true);
    view.navigate(BUTTON_PAGE).unwrap(); // a new document: the overlay is switched on again
    ready(&view, true);
    click(&view, center(&view, "button"));
    let first = eventually(3, || (!picks.all().is_empty()).then_some(()));
    assert!(first.is_some(), "a pick after navigating");
    // A tab opened while annotate is on has the overlay too.
    view.tab_new(Some(BUTTON_PAGE)).unwrap();
    ready(&view, true);
    click(&view, center(&view, "button"));
    let second = eventually(3, || (picks.all().len() == 2).then_some(()));
    assert!(second.is_some(), "a pick in the new tab");
    // Back on the first tab: annotate is still on there.
    let first_tab = picks.tabs()[0].target_id.clone(); // outlives the snapshot
    view.tab_activate(&first_tab).unwrap();
    ready(&view, true);
    view.annotate(false).unwrap();
    ready(&view, false);
    m.release("s1");
}

#[test]
fn concurrent_target_switch_and_toggle_leave_shown_overlay_matching_flag() {
    let Some((m, view, picks)) = panel("annotate-toggle-switch") else {
        eprintln!("skip: no chromium");
        return;
    };
    view.navigate(BUTTON_PAGE).unwrap();
    view.annotate(true).unwrap();
    ready(&view, true);
    let first = picks.tabs()[0].target_id.clone();
    view.tab_new(Some(BUTTON_PAGE)).unwrap();
    ready(&view, true);
    let second = picks
        .tabs()
        .iter()
        .find(|tab| tab.target_id != first)
        .expect("a second target")
        .target_id
        .clone();
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
    eventually(3, || {
        (eval(&view, "document.title") == json!("clicked")).then_some(())
    })
    .expect("toggle-off leaves agent clicks reaching the shown page");
    assert!(picks.all().is_empty(), "no swallowed click becomes a pick");
    m.release("s1");
}

#[test]
fn capture_returns_png() {
    let Some((m, view, _picks)) = panel("annotate-capture") else {
        eprintln!("skip: no chromium");
        return;
    };
    view.navigate("data:text/html,<h1>hi</h1>").unwrap();
    ready(&view, false);
    let image = view
        .capture(&Rect {
            x: 0.0,
            y: 0.0,
            w: 50.0,
            h: 20.0,
        })
        .unwrap();
    assert_eq!(image.mime_type, "image/png");
    assert!(
        image.data.starts_with("iVBORw0KGgo"),
        "base64 of the PNG magic \\x89PNG\\r\\n\\x1a\\n: {}",
        &image.data[..image.data.len().min(20)]
    );
    assert!(view
        .capture(&Rect {
            x: 0.0,
            y: 0.0,
            w: 0.0,
            h: 20.0
        })
        .is_err());
    ready(&view, false);
    m.release("s1");
}

const TALL_PAGE: &str = "data:text/html,<body style='margin:0;height:2400px'>\
                        <div id=block style='position:absolute;left:40px;top:1200px;\
                        width:120px;height:80px;background:rgb(20,180,60)'></div>";

#[test]
fn capture_scrolled_pick_has_clean_block_pixels() {
    let Some((m, view, picks)) = panel("annotate-capture-scroll") else {
        eprintln!("skip: no chromium");
        return;
    };
    view.navigate(TALL_PAGE).unwrap();
    view.annotate(true).unwrap();
    ready(&view, true);
    eval(&view, "window.scrollTo(0, 1100)");
    assert_eq!(eval(&view, "window.scrollY"), json!(1100));
    click(&view, center(&view, "#block"));
    let all = eventually(3, || (!picks.all().is_empty()).then(|| picks.all())).expect("a pick");
    let rect = &all[0].rect;
    assert_eq!(all[0].selector.as_deref(), Some("#block"));
    assert!((rect.y - 100.0).abs() < 1.0, "viewport-relative pick");
    // A fresh hover leaves the blue tint visible: failing to hide the overlay
    // during capture changes the centre pixel even if the scroll is correct.
    let (x, y) = center(&view, "#block");
    view.input(&mouse("mouseMoved", 10.0, 10.0)).unwrap();
    eventually(3, || {
        (eval(&view, "!!document.querySelector('#block:hover')") == json!(false)).then_some(())
    })
    .expect("hover input left the block");
    view.input(&mouse("mouseMoved", x + 1.0, y)).unwrap();
    eventually(3, || {
        (eval(&view, "!!document.querySelector('#block:hover')") == json!(true)).then_some(())
    })
    .expect("hover input reached the block");
    // Chromium can return an old compositor tile while parallel browser tests
    // are starting. Wait on actual pixels, not a fixed delay or DOM readiness.
    let image = eventually(3, || {
        let image = view.capture(rect).unwrap();
        (center_pixel(&image) == [20, 180, 60]).then_some(image)
    })
    .expect("the captured block has its untinted RGB colour");
    assert_eq!(center_pixel(&image), [20, 180, 60]);
    ready(&view, true);
    m.release("s1");
}

#[test]
fn scroll_to_brings_below_fold_rect_into_view() {
    let Some((m, view, picks)) = panel("annotate-scroll-to") else {
        eprintln!("skip: no chromium");
        return;
    };
    view.navigate(TALL_PAGE).unwrap();
    ready(&view, false);
    view.annotate(true).unwrap();
    ready(&view, true);
    eval(&view, "window.scrollTo(0, 1100)");
    click(&view, center(&view, "#block"));
    let all = eventually(3, || (!picks.all().is_empty()).then(|| picks.all())).expect("a pick");
    let pick: Value = serde_json::to_value(&all[0]).unwrap();
    assert_eq!(
        pick["docRect"],
        json!({ "x": 40.0, "y": 1200.0, "w": 120.0, "h": 80.0 })
    );
    let document_rect: Rect = serde_json::from_value(pick["docRect"].clone()).unwrap();
    view.annotate(false).unwrap();
    for scroll in [0, 1800, 700] {
        eval(&view, &format!("window.scrollTo(0, {scroll})"));
        view.scroll_to(&document_rect).unwrap();
        assert_eq!(
            eval(&view, "(() => { const r = document.querySelector('#block').getBoundingClientRect(); return r.top >= 0 && r.bottom <= window.innerHeight; })()"),
            json!(true),
            "saved document rect remains valid after scrolling to {scroll}"
        );
    }
    eventually(3, || {
        eval(&view, "window.scrollY").as_f64().filter(|y| *y > 0.0)
    })
    .expect("page scrolled down");
    assert_eq!(
        eval(&view, "(() => { const r = document.querySelector('#block').getBoundingClientRect(); return r.top >= 0 && r.bottom <= window.innerHeight; })()"),
        json!(true),
        "the entire block is visible"
    );
    ready(&view, false);
    m.release("s1");
}

#[test]
fn invalid_capture_preserves_annotate_overlay() {
    let Some((m, view, _picks)) = panel("annotate-capture-error") else {
        eprintln!("skip: no chromium");
        return;
    };
    view.navigate(TALL_PAGE).unwrap();
    view.annotate(true).unwrap();
    ready(&view, true);
    // Validation errors leave annotate enabled as well.
    let error = view.capture(&Rect {
        x: 0.0,
        y: 0.0,
        w: 0.0,
        h: 20.0,
    });
    assert!(error.is_err(), "zero-width capture must fail");
    ready(&view, true);
    m.release("s1");
}

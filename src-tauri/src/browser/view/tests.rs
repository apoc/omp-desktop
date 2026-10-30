//! The panel against a real Chromium (skipped when none is installed), the
//! URL policy, and a view core against a fake Chromium for the other
//! view tests.

use std::net::{TcpListener, TcpStream};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex, OnceLock, Weak};
use std::time::{Duration, Instant};

use serde_json::{json, Value};
use tungstenite::{Message, WebSocket};

use super::super::cdp::CdpClient;
use super::super::tests::{
    cdp_result, fake_cdp, http_get, manager, manager_with_chromium, mouse, CHROMIUM,
};
use super::super::{lock, BrowserManager};
use super::{
    checked_url, BrowserEmit, Core, Frame, InputEvent, Pick, Status, TabInfo, View, ViewState,
};
use crate::test_support::eventually;

#[derive(Debug)]
enum Seen {
    Frame(Frame),
    Tabs(Vec<TabInfo>),
    State(ViewState),
}

/// Records everything the view emits, in order, and acks every frame as
/// the webview does once it painted it. Read under its lock: frames carry
/// whole JPEGs, so only what a test asks for is copied out.
#[derive(Default)]
struct Collect {
    log: Mutex<Vec<Seen>>,
    view: OnceLock<Weak<View>>,
}

impl Collect {
    /// The first frame, oldest first, for which `pick` gives `Some`.
    fn find_frame<T>(&self, mut pick: impl FnMut(&Frame) -> Option<T>) -> Option<T> {
        lock(&self.log).iter().find_map(|s| match s {
            Seen::Frame(f) => pick(f),
            _ => None,
        })
    }

    /// `read` of the newest frame.
    fn last_frame<T>(&self, read: impl FnOnce(&Frame) -> T) -> Option<T> {
        lock(&self.log)
            .iter()
            .rev()
            .find_map(|s| match s {
                Seen::Frame(f) => Some(f),
                _ => None,
            })
            .map(read)
    }

    fn frame_seqs(&self) -> Vec<u64> {
        lock(&self.log)
            .iter()
            .filter_map(|s| match s {
                Seen::Frame(f) => Some(f.seq),
                _ => None,
            })
            .collect()
    }

    fn frame_count(&self) -> usize {
        lock(&self.log)
            .iter()
            .filter(|s| matches!(s, Seen::Frame(_)))
            .count()
    }

    fn last_tabs(&self) -> Vec<TabInfo> {
        lock(&self.log)
            .iter()
            .rev()
            .find_map(|s| match s {
                Seen::Tabs(t) => Some(t.clone()), // the test reads it after the lock
                _ => None,
            })
            .unwrap_or_default()
    }

    fn last_state(&self) -> Option<ViewState> {
        lock(&self.log).iter().rev().find_map(|s| match s {
            Seen::State(s) => Some(s.clone()), // the test reads it after the lock
            _ => None,
        })
    }
}

impl BrowserEmit for Collect {
    fn frame(&self, _: &str, f: &Frame) {
        lock(&self.log).push(Seen::Frame(f.clone())); // the log owns what it records
        if let Some(view) = self.view.get().and_then(Weak::upgrade) {
            view.frame_ack(f.seq);
        }
    }
    fn tabs(&self, _: &str, tabs: &[TabInfo]) {
        lock(&self.log).push(Seen::Tabs(tabs.to_vec()));
    }
    fn state(&self, _: &str, s: &ViewState) {
        lock(&self.log).push(Seen::State(s.clone())); // the log owns what it records
    }
    fn pick(&self, _: &str, _: &Pick) {}
}

/// A manager with a panel open on session `s1` (400×300 at 2x) whose frames
/// are acked, or `None` without Chromium.
fn panel(name: &str) -> Option<(BrowserManager, Arc<View>, Arc<Collect>)> {
    let seen = Arc::new(Collect::default());
    let emit: Arc<dyn BrowserEmit> = Arc::clone(&seen) as Arc<dyn BrowserEmit>;
    let (m, view) = super::super::tests::panel(name, 2.0, emit)?;
    seen.view.set(Arc::downgrade(&view)).unwrap();
    Some((m, view, seen))
}

/// Every state a view core emitted.
#[derive(Default)]
pub(super) struct States(Mutex<Vec<ViewState>>);

impl States {
    /// The error of the last state emitted.
    pub(super) fn last_error(&self) -> Option<String> {
        lock(&self.0).last().and_then(|s| s.error.clone()) // the test reads it after the lock
    }
}

impl BrowserEmit for States {
    fn frame(&self, _: &str, _: &Frame) {}
    fn tabs(&self, _: &str, _: &[TabInfo]) {}
    fn state(&self, _: &str, s: &ViewState) {
        lock(&self.0).push(s.clone()); // the log owns what it records
    }
    fn pick(&self, _: &str, _: &Pick) {}
}

/// A view core connected to a fake Chromium with page `a` listed, what
/// it emitted, and the methods it sent. `reply` may answer a request
/// (`None`: a new session per attach, a one-entry history, else an empty
/// result).
pub(super) fn fake_core(
    mut reply: impl FnMut(&Value) -> Option<Value> + Send + 'static,
) -> (Core, Arc<States>, Arc<Mutex<Vec<String>>>) {
    let sent = Arc::new(Mutex::new(Vec::new()));
    let log = Arc::clone(&sent);
    let mut sessions = 0;
    let fake = fake_cdp(move |request| {
        let method = request["method"].as_str().unwrap_or_default();
        lock(&log).push(method.to_owned());
        let answer = reply(request).unwrap_or_else(|| match method {
            "Target.attachToTarget" => {
                sessions += 1;
                cdp_result(request, json!({ "sessionId": format!("s{sessions}") }))
            }
            "Page.getNavigationHistory" => cdp_result(
                request,
                json!({ "currentIndex": 0, "entries": [{ "id": 1, "url": "about:blank" }] }),
            ),
            _ => cdp_result(request, json!({})),
        });
        Some(vec![answer])
    });
    let states = Arc::new(States::default());
    let core = Core::new("s1", Arc::clone(&states) as Arc<dyn BrowserEmit>);
    let client = CdpClient::connect(fake, Box::new(|_, _, _| {})).unwrap();
    assert!(core.client.set(client).is_ok());
    lock(&core.inner).upsert_page(&json!({ "targetId": "a", "url": "about:blank" }));
    (core, states, sent)
}

/// How many `method` requests were sent.
pub(super) fn sent_count(sent: &Mutex<Vec<String>>, method: &str) -> usize {
    lock(sent).iter().filter(|m| *m == method).count()
}

const SECS_3: Duration = Duration::from_secs(3);

/// How long the view's state may take to follow a navigation: on a loaded
/// runner Chromium's page events trail it by seconds (locally under a CPU
/// burn: up to 5.5s, and the former 3s/5s waits failed 3 of 18 runs; CI's
/// Windows runner failed the same way). The waits end once the state is there.
const NAVIGATION_STATE: Duration = Duration::from_secs(20);

/// Wait until the shown page has loaded a document where `condition` (JS)
/// holds: `navigate` returns before the old document is gone.
fn loaded(view: &View, condition: &str) {
    let expression = format!("document.readyState === 'complete' && !!({condition})");
    eventually(SECS_3, || {
        (view.evaluate_for_test(&expression).ok()? == json!(true)).then_some(())
    })
    .unwrap_or_else(|| panic!("page with {condition} loaded"));
}

fn active_tab(seen: &Collect) -> Option<String> {
    lock(&seen.log)
        .iter()
        .rev()
        .find_map(|s| match s {
            Seen::Tabs(tabs) => Some(tabs),
            _ => None,
        })?
        .iter()
        .find(|t| t.active)
        .map(|t| t.target_id.clone()) // the test reads it after the lock
}

/// Wait until no frame has come for a while (a still page), and give back
/// how many there are.
fn settled(seen: &Collect) -> usize {
    eventually(Duration::from_secs(10), || {
        let before = seen.frame_count();
        std::thread::sleep(Duration::from_millis(400));
        (seen.frame_count() == before).then_some(before)
    })
    .expect("the screencast goes quiet on a still page")
}

#[test]
fn only_web_inline_and_blank_urls_are_loaded() {
    for url in [
        "https://example.com/",
        "HTTP://localhost:3000/x",
        " data:text/html,<h1>hi</h1> ",
        "about:blank",
        "About:Blank",
    ] {
        assert_eq!(checked_url(url), Ok(url.trim()), "{url}");
    }
    for url in [
        "javascript:alert(1)",
        "file:///etc/passwd",
        "chrome://kill",
        "about:config",
        "view-source:https://example.com/",
        "example.com",
    ] {
        assert_eq!(
            checked_url(url),
            Err("unsupported url scheme".to_owned()),
            "{url}"
        );
    }
    let long = format!("https://{}", "a".repeat(8200));
    for url in ["", "   ", "https://x/\u{7}y", &long] {
        assert_eq!(checked_url(url), Err("invalid url".to_owned()), "{url:?}");
    }
}

#[test]
fn screencast_emits_numbered_frames_of_the_panel_size() {
    let _chromium = lock(&CHROMIUM);
    let Some((m, view, seen)) = panel("view-frames") else {
        return;
    };
    view.navigate("data:text/html,<h1>hi</h1>").unwrap();
    let frame = eventually(SECS_3, || {
        seen.find_frame(|f| {
            (f.css_w == 400).then(|| (f.css_h, f.w, f.h, f.css_w, f.b64.starts_with("/9j/")))
        })
    });
    let (css_h, w, h, css_w, jpeg) = frame.expect("a frame of the 400 px wide page");
    assert_eq!(css_h, 300);
    assert_eq!(w * css_h, h * css_w, "the image has the page's proportions");
    assert!(jpeg, "a base64 JPEG");
    // Chromium may capture its whole window surface for a moment after a
    // navigation; the view restarts the screencast, so the latest frame is
    // the page's size again.
    let size = eventually(Duration::from_secs(5), || {
        (seen.last_frame(|f| (f.css_w, f.css_h))? == (400, 300)).then_some(())
    });
    assert!(size.is_some(), "settled on the panel size");
    let seqs = seen.frame_seqs();
    assert!(seqs.windows(2).all(|w| w[0] < w[1]), "{seqs:?}");
    assert_eq!(seen.last_state().unwrap().status, Status::Running);
    m.release("s1");
}

#[test]
fn frames_keep_coming_while_the_page_changes() {
    let _chromium = lock(&CHROMIUM);
    let Some((m, view, seen)) = panel("view-ack") else {
        return;
    };
    // Chromium stops sending while frames are not acknowledged; the acks
    // follow the webview's.
    view.navigate(
        "data:text/html,<body><script>setInterval(()=>{document.body.style.background=\
         'rgb('+(Date.now()&255)+',0,0)'},20)</script>",
    )
    .unwrap();
    let flowing = eventually(Duration::from_secs(4), || {
        (seen.frame_count() >= 15).then_some(())
    });
    assert!(flowing.is_some(), "only {} frames", seen.frame_count());
    m.release("s1");
}

#[test]
fn refresh_frame_brings_a_newer_frame_of_a_still_page() {
    let _chromium = lock(&CHROMIUM);
    let Some((m, view, seen)) = panel("view-refresh-frame") else {
        return;
    };
    view.navigate("data:text/html,<h1>still</h1>").unwrap();
    loaded(&view, "document.querySelector('h1')");
    let before = settled(&seen);
    let newest = seen.last_frame(|f| f.seq).unwrap_or(0);
    view.core.refresh_frame();
    let fresh = eventually(SECS_3, || {
        seen.find_frame(|f| (f.seq > newest && f.css_w == 400).then_some(()))
    });
    assert!(
        fresh.is_some(),
        "a new frame after {before}, though nothing changed on the page"
    );
    m.release("s1");
}

#[test]
fn the_tab_title_follows_the_page() {
    let _chromium = lock(&CHROMIUM);
    let Some((m, view, seen)) = panel("view-title") else {
        return;
    };
    let titled = |title: &str| {
        eventually(SECS_3, || {
            seen.last_tabs()
                .iter()
                .any(|t| t.active && t.title == title)
                .then_some(())
        })
    };
    view.navigate("data:text/html,<title>Demo Shop</title><p>shop")
        .unwrap();
    assert!(titled("Demo Shop").is_some(), "{:?}", seen.last_tabs());
    // A single-page app: a new title with a same-document navigation.
    view.evaluate_for_test("document.title = 'Cart'; history.pushState({}, '', '#cart')")
        .unwrap();
    assert!(titled("Cart").is_some(), "{:?}", seen.last_tabs());
    m.release("s1");
}

#[test]
fn input_reaches_the_page() {
    let _chromium = lock(&CHROMIUM);
    let Some((m, view, _seen)) = panel("view-input") else {
        return;
    };
    let page = "data:text/html,<input id=i><button onclick=\"document.title='clicked'\" \
                style=\"position:absolute;left:100px;top:100px;width:100px;height:50px\">go</button>";
    view.navigate(page).unwrap();
    loaded(&view, "document.getElementById('i')");
    focus_input(&view);
    view.input(&InputEvent::Text { text: "abc".into() })
        .unwrap();
    let typed = eventually(SECS_3, || {
        let value = view
            .evaluate_for_test("document.getElementById('i').value")
            .ok()?;
        (value == json!("abc")).then_some(value)
    });
    assert!(typed.is_some(), "typed text reached the input");
    for event in [
        mouse("mouseMoved", 150.0, 125.0),
        mouse("mousePressed", 150.0, 125.0),
        mouse("mouseReleased", 150.0, 125.0),
    ] {
        view.input(&event).unwrap();
    }
    let clicked = eventually(SECS_3, || {
        let title = view.evaluate_for_test("document.title").ok()?;
        (title == json!("clicked")).then_some(title)
    });
    assert!(clicked.is_some(), "click reached the button");
    assert!(
        view.core.panel_released_within(Duration::from_secs(10)),
        "the release was stamped"
    );
    m.release("s1");
}

#[test]
fn acting_on_the_page_holds_the_view_but_hovering_does_not() {
    let _chromium = lock(&CHROMIUM);
    let Some((m, view, _seen)) = panel("view-input-hold") else {
        return;
    };
    let may_follow = || lock(&view.core.inner).may_follow();
    assert!(may_follow(), "nothing held yet");
    view.input(&mouse("mouseMoved", 10.0, 10.0)).unwrap();
    assert!(may_follow(), "hovering is not acting");
    view.input(&InputEvent::Text { text: "x".into() }).unwrap();
    assert!(!may_follow(), "typing holds the view");
    lock(&view.core.inner).user_activated = None;
    view.navigate("data:text/html,typed").unwrap();
    assert!(!may_follow(), "the address field holds the view");
    m.release("s1");
}

#[test]
fn tabs_and_history() {
    let _chromium = lock(&CHROMIUM);
    let Some((m, view, seen)) = panel("view-tabs") else {
        return;
    };
    assert_eq!(seen.last_tabs().len(), 1, "the initial blank tab");
    view.tab_new().unwrap();
    let two = eventually(SECS_3, || (seen.last_tabs().len() == 2).then_some(()));
    assert!(two.is_some(), "{:?}", seen.last_tabs());
    assert!(seen.last_tabs()[1].active, "the new tab is shown");
    view.navigate("data:text/html,a").unwrap();
    loaded(&view, "location.href.endsWith(',a')");
    view.navigate("data:text/html,b").unwrap();
    let on_b = eventually(SECS_3, || {
        let state = seen.last_state()?;
        (state.url.ends_with(",b") && state.can_back).then_some(())
    });
    assert!(on_b.is_some(), "{:?}", seen.last_state());
    assert!(!seen.last_state().unwrap().can_forward);
    view.history(-1).unwrap();
    let back = eventually(SECS_3, || {
        let state = seen.last_state()?;
        (state.can_forward && state.url.ends_with(",a")).then_some(())
    });
    assert!(back.is_some(), "{:?}", seen.last_state());
    let second = seen.last_tabs().swap_remove(1).target_id;
    view.tab_close(&second).unwrap();
    let one = eventually(SECS_3, || {
        let tabs = seen.last_tabs();
        (tabs.len() == 1 && tabs[0].active).then_some(())
    });
    assert!(one.is_some(), "{:?}", seen.last_tabs());
    m.release("s1");
}

#[test]
fn a_slow_server_is_not_a_failed_navigation_and_a_failed_load_is_told() {
    let _chromium = lock(&CHROMIUM);
    let Some((m, view, seen)) = panel("view-navigate") else {
        return;
    };
    // Accepts and never answers, like a dev server compiling its first route.
    let slow = TcpListener::bind("127.0.0.1:0").unwrap();
    let slow_port = slow.local_addr().unwrap().port();
    let started = Instant::now();
    assert_eq!(
        view.navigate(&format!("http://127.0.0.1:{slow_port}/")),
        Ok(())
    );
    assert!(
        started.elapsed() < Duration::from_secs(2),
        "returns once sent"
    );
    let loading = eventually(NAVIGATION_STATE, || {
        seen.last_state()?.loading.then_some(())
    });
    assert!(loading.is_some(), "{:?}", seen.last_state());
    drop(slow);
    // Nothing listens here: the load fails.
    let closed = TcpListener::bind("127.0.0.1:0").unwrap();
    let closed_port = closed.local_addr().unwrap().port();
    drop(closed);
    view.navigate(&format!("http://127.0.0.1:{closed_port}/"))
        .unwrap();
    let failed = eventually(NAVIGATION_STATE, || {
        seen.last_state()?
            .error
            .filter(|e| e.contains(&format!("127.0.0.1:{closed_port}")))
    });
    assert!(failed.is_some(), "{:?}", seen.last_state());
    view.navigate("data:text/html,fine").unwrap();
    let cleared = eventually(NAVIGATION_STATE, || {
        let state = seen.last_state()?;
        (state.error.is_none() && state.url.ends_with(",fine")).then_some(())
    });
    assert!(cleared.is_some(), "{:?}", seen.last_state());
    assert_eq!(
        view.navigate("javascript:alert(1)"),
        Err("unsupported url scheme".to_owned())
    );
    m.release("s1");
}

/// The agent's side: a raw CDP client through the placeholder port (the
/// proxy, as omp connects), on the browser connection or (`page`) on one
/// page's own. Calls are answered in order; events in between are skipped.
struct Agent {
    ws: Mutex<WebSocket<TcpStream>>,
    next_id: AtomicU64,
}

impl Agent {
    fn call(&self, session: Option<&str>, method: &str, params: Value) -> Result<Value, String> {
        let id = self.next_id.fetch_add(1, Ordering::Relaxed);
        let mut message = json!({ "id": id, "method": method, "params": params });
        if let Some(session) = session {
            message["sessionId"] = Value::from(session);
        }
        let mut reply = roundtrip(&mut lock(&self.ws), id, message.to_string())?;
        if let Some(error) = reply.get("error") {
            return Err(error["message"].as_str().unwrap_or("cdp error").to_owned());
        }
        Ok(reply["result"].take())
    }

    fn close(&self) {
        let _ = lock(&self.ws).close(None);
    }
}

/// Send `text` and read until the reply with `id` comes.
fn roundtrip(ws: &mut WebSocket<TcpStream>, id: u64, text: String) -> Result<Value, String> {
    ws.send(Message::text(text)).map_err(|e| e.to_string())?;
    loop {
        let Message::Text(text) = ws.read().map_err(|e| e.to_string())? else {
            continue;
        };
        let reply: Value = serde_json::from_str(text.as_str()).map_err(|e| e.to_string())?;
        if reply["id"] == id {
            return Ok(reply);
        }
    }
}

fn agent(m: &BrowserManager, page: Option<&str>) -> Agent {
    let port = m.port("s1").unwrap();
    let url = page.map_or_else(
        || {
            let version: Value =
                serde_json::from_str(&http_get(port, "/json/version").unwrap()).unwrap();
            version["webSocketDebuggerUrl"].as_str().unwrap().to_owned()
        },
        |id| format!("ws://127.0.0.1:{port}/devtools/page/{id}"),
    );
    let stream = TcpStream::connect(("127.0.0.1", port)).unwrap();
    stream
        .set_read_timeout(Some(Duration::from_secs(10)))
        .unwrap();
    let (ws, _) = tungstenite::client(url.as_str(), stream)
        .unwrap_or_else(|e| panic!("agent handshake: {e}"));
    Agent {
        ws: Mutex::new(ws),
        next_id: AtomicU64::new(1),
    }
}

/// Attach as puppeteer does and give back the page session.
fn attach(agent: &Agent, target: &str) -> String {
    let attached = agent
        .call(
            None,
            "Target.attachToTarget",
            json!({ "targetId": target, "flatten": true }),
        )
        .unwrap();
    attached["sessionId"].as_str().unwrap().to_owned()
}

fn navigate(agent: &Agent, session: &str, url: &str) {
    agent
        .call(Some(session), "Page.navigate", json!({ "url": url }))
        .unwrap();
}

fn create_page(agent: &Agent, url: &str) -> String {
    let created = agent
        .call(None, "Target.createTarget", json!({ "url": url }))
        .unwrap();
    created["targetId"].as_str().unwrap().to_owned()
}

/// Manager, view, what it emitted, the pages A and B, and when the user's
/// choice of A began to hold the view (measured before the choice).
struct TwoTabs {
    m: BrowserManager,
    view: Arc<View>,
    seen: Arc<Collect>,
    a: String,
    b: String,
    held_from: Instant,
}

/// A panel on page A with a second page B listed, the user's last choice
/// being A; `hold` is how long that choice keeps the view from following.
fn panel_on_a_next_to_b(name: &str, hold: Duration) -> Option<TwoTabs> {
    let (m, view, seen) = panel(name)?;
    lock(&view.core.inner).follow_hold = hold;
    let a = active_tab(&seen).unwrap();
    view.tab_new().unwrap();
    view.navigate("data:text/html,b").unwrap();
    let b = active_tab(&seen).unwrap();
    assert_ne!(a, b);
    let held_from = Instant::now();
    view.tab_activate(&a).unwrap();
    Some(TwoTabs {
        m,
        view,
        seen,
        a,
        b,
        held_from,
    })
}

impl TwoTabs {
    /// Wait out the user's hold.
    fn hold_over(&self) {
        let over = eventually(Duration::from_secs(5), || {
            lock(&self.view.core.inner).may_follow().then_some(())
        });
        assert!(over.is_some(), "the hold ends");
    }
}

/// Whether the view shows `target`: a frame was logged after a `tabs` event
/// marking it active, with no event marking another page active since
/// (frames after an activation's `tabs` event are of its page, see
/// `Core::emit_order`).
fn shows(seen: &Collect, target: &str) -> bool {
    let mut framed = false;
    for s in lock(&seen.log).iter().rev() {
        match s {
            Seen::Frame(_) => framed = true,
            Seen::Tabs(tabs) => {
                if !tabs.iter().any(|t| t.active && t.target_id == target) {
                    return false;
                }
                if framed {
                    return true;
                }
            }
            Seen::State(_) => {}
        }
    }
    false
}

#[test]
fn follows_an_agent_that_navigates_an_existing_page() {
    let _chromium = lock(&CHROMIUM);
    let Some(t) = panel_on_a_next_to_b("view-follow-nav", Duration::from_millis(200)) else {
        return;
    };
    t.hold_over();
    let agent = agent(&t.m, None);
    let session = attach(&agent, &t.b);
    std::thread::sleep(Duration::from_millis(600)); // what must not happen has time to
    assert_eq!(
        active_tab(&t.seen).as_deref(),
        Some(t.a.as_str()),
        "attached is not worked in: puppeteer stays attached to every page"
    );
    navigate(&agent, &session, "data:text/html,agent-b");
    let followed = eventually(SECS_3, || shows(&t.seen, &t.b).then_some(()));
    assert!(
        followed.is_some(),
        "the view follows the agent to B and shows it"
    );
    agent.close();
    t.m.release("s1");
}

#[test]
fn the_agents_work_during_a_hold_is_shown_when_the_hold_ends() {
    let _chromium = lock(&CHROMIUM);
    let hold = Duration::from_secs(3);
    let Some(t) = panel_on_a_next_to_b("view-follow-hold", hold) else {
        return;
    };
    let agent = agent(&t.m, None);
    let session = attach(&agent, &t.b);
    navigate(&agent, &session, "data:text/html,agent-b");
    let followed = eventually(hold + SECS_3, || shows(&t.seen, &t.b).then(Instant::now));
    let followed = followed.expect("the agent's last step is shown once the hold is over");
    assert!(
        followed.duration_since(t.held_from) >= hold,
        "not within the hold: after {:?}",
        followed.duration_since(t.held_from)
    );
    agent.close();
    t.m.release("s1");
}

#[test]
fn follows_a_page_the_agent_creates() {
    let _chromium = lock(&CHROMIUM);
    let Some(t) = panel_on_a_next_to_b("view-follow-create", Duration::from_millis(200)) else {
        return;
    };
    t.hold_over();
    let agent = agent(&t.m, None);
    let created = create_page(&agent, "data:text/html,agent-new");
    let followed = eventually(SECS_3, || shows(&t.seen, &created).then_some(()));
    assert!(
        followed.is_some(),
        "the view follows the agent to its new page"
    );
    agent.close();
    t.m.release("s1");
}

#[test]
fn follows_an_agent_on_a_page_level_connection() {
    let _chromium = lock(&CHROMIUM);
    let Some(t) = panel_on_a_next_to_b("view-follow-page-ws", Duration::from_millis(200)) else {
        return;
    };
    t.hold_over();
    let agent = agent(&t.m, Some(&t.b));
    agent.call(None, "Page.bringToFront", json!({})).unwrap();
    let followed = eventually(SECS_3, || shows(&t.seen, &t.b).then_some(()));
    assert!(
        followed.is_some(),
        "bringToFront on B's own connection is work in B"
    );
    agent.close();
    t.m.release("s1");
}

#[test]
fn a_flood_of_follow_reports_costs_one_switch_to_the_last_page() {
    let _chromium = lock(&CHROMIUM);
    let Some(t) = panel_on_a_next_to_b("view-follow-flood", Duration::from_millis(200)) else {
        return;
    };
    t.hold_over();
    let shown_before = lock(&t.view.core.inner).activations();
    {
        let _paused = lock(&t.view.core.follow_gate);
        for i in 0..10_000 {
            t.view.follow_agent(if i % 2 == 0 { &t.a } else { &t.b }); // ends on B, the view shows A
        }
    }
    let followed = eventually(SECS_3, || shows(&t.seen, &t.b).then_some(()));
    assert!(
        followed.is_some(),
        "the view ends on the last page reported"
    );
    std::thread::sleep(Duration::from_millis(500)); // what must not happen has time to
    assert_eq!(
        lock(&t.view.core.inner).activations(),
        shown_before + 1,
        "one switch, not one per report"
    );
    t.m.release("s1");
}

#[test]
fn the_agent_acting_ends_annotate_mode() {
    let _chromium = lock(&CHROMIUM);
    let Some((m, view, seen)) = panel("view-annotate-off") else {
        return;
    };
    let annotate =
        |on: bool| eventually(SECS_3, || (seen.last_state()?.annotate == on).then_some(()));
    view.annotate(true).unwrap();
    assert!(annotate(true).is_some(), "{:?}", seen.last_state());
    view.follow_agent(&active_tab(&seen).unwrap());
    assert!(annotate(false).is_some(), "{:?}", seen.last_state());
    assert!(!lock(&view.core.annotate).on);
    m.release("s1");
}

#[test]
fn a_panel_opened_after_the_agent_browsed_starts_on_its_page() {
    let _chromium = lock(&CHROMIUM);
    let Some(m) = manager_with_chromium("view-open-on-agent") else {
        return;
    };
    m.allocate("s1").unwrap();
    let agent = agent(&m, None);
    let b = create_page(&agent, "data:text/html,b");
    let c = create_page(&agent, "data:text/html,c"); // the newest page, not the agent's choice
    let session = attach(&agent, &b);
    navigate(&agent, &session, "data:text/html,agent-b");
    let told = eventually(SECS_3, || {
        (m.last_agent_target_for_test("s1").as_deref() == Some(b.as_str())).then_some(())
    });
    assert!(told.is_some(), "the manager remembers the agent's page");
    let seen = Arc::new(Collect::default());
    let emit: Arc<dyn BrowserEmit> = Arc::clone(&seen) as Arc<dyn BrowserEmit>;
    m.open_panel("s1", 400, 300, 2.0, emit).unwrap();
    assert!(
        seen.last_tabs().iter().any(|t| t.target_id == c),
        "C is listed too"
    );
    // The first page the panel ever showed, not just where it ended up.
    let first_shown = lock(&seen.log).iter().find_map(|s| match s {
        Seen::Tabs(tabs) => tabs.iter().find(|t| t.active).map(|t| t.target_id.clone()), // compared after the lock
        _ => None,
    });
    assert_eq!(first_shown, Some(b), "the panel starts on the agent's page");
    agent.close();
    m.release("s1");
}

#[test]
fn release_closes_the_view_before_chromium_goes() {
    let _chromium = lock(&CHROMIUM);
    let Some((m, view, seen)) = panel("view-release") else {
        return;
    };
    m.release("s1");
    assert!(view.navigate("data:text/html,x").is_err());
    assert_eq!(seen.last_state().unwrap().status, Status::Idle);
    // Chromium gone first would have the worker report a lost connection.
    let lost = lock(&seen.log).iter().any(|s| {
        matches!(s, Seen::State(state) if state.status == Status::Stopped || state.error.is_some())
    });
    assert!(!lost, "the view was closed before its connection dropped");
    assert!(m.panel("s1").is_err());
}

#[test]
fn panel_commands_need_an_allocated_browser() {
    let m = manager("view-none");
    let emit: Arc<dyn BrowserEmit> = Arc::new(Collect::default());
    assert_eq!(
        m.open_panel("nope", 400, 300, 1.0, emit).unwrap_err(),
        "no browser for session"
    );
    assert_eq!(
        m.panel("nope").err().as_deref(),
        Some("no browser for session")
    );
    assert_eq!(
        m.close_panel("nope"),
        Err("no browser for session".to_owned())
    );
}

#[test]
fn a_bad_panel_size_is_refused_before_chromium_is_launched() {
    let m = manager("view-bad-size");
    m.allocate("s1").unwrap();
    for (w, h, dpr) in [(0, 300, 1.0), (4096, 300, 4.0)] {
        let emit: Arc<dyn BrowserEmit> = Arc::new(Collect::default());
        assert_eq!(
            m.open_panel("s1", w, h, dpr, emit),
            Err(format!("invalid panel size {w}x{h} at {dpr}x"))
        );
    }
    assert_eq!(m.profile_dir_for_test("s1"), None, "nothing was launched");
    m.release("s1");
}

#[test]
fn reopening_a_panel_replaces_the_view() {
    let _chromium = lock(&CHROMIUM);
    let Some((m, first, seen)) = panel("view-reopen") else {
        return;
    };
    let seen2 = Arc::new(Collect::default());
    let emit: Arc<dyn BrowserEmit> = Arc::clone(&seen2) as Arc<dyn BrowserEmit>;
    m.open_panel("s1", 300, 200, 1.0, emit).unwrap();
    assert!(
        first.navigate("data:text/html,x").is_err(),
        "the old view is closed"
    );
    let second = m.panel("s1").unwrap();
    seen2.view.set(Arc::downgrade(&second)).unwrap(); // its frames are acked to it
    second.navigate("data:text/html,y").unwrap();
    assert!(
        eventually(SECS_3, || seen2
            .find_frame(|f| (f.css_w == 300).then_some(())))
        .is_some(),
        "frames of the new size"
    );
    assert!(
        seen.find_frame(|f| (f.css_w == 300).then_some(()))
            .is_none(),
        "the old panel's sink gets nothing of the new view"
    );
    m.close_panel("s1").unwrap();
    assert!(m.panel("s1").is_err());
    m.release("s1");
}

#[test]
fn a_close_during_a_pending_open_wins() {
    let _chromium = lock(&CHROMIUM);
    let Some(m) = manager_with_chromium("view-open-close") else {
        return;
    };
    m.allocate("s1").unwrap();
    let seen = Arc::new(Collect::default());
    let emit: Arc<dyn BrowserEmit> = Arc::clone(&seen) as Arc<dyn BrowserEmit>;
    let (reached, wait_reached) = std::sync::mpsc::channel();
    let (release, wait_release) = std::sync::mpsc::channel::<()>();
    let (view_out, view_in) = std::sync::mpsc::channel();
    let opened = std::thread::scope(|scope| {
        let opening = scope.spawn(|| {
            m.open_panel_with("s1", 400, 300, 2.0, emit, move |view| {
                view_out.send(Arc::clone(view)).unwrap();
                reached.send(()).unwrap();
                let _ = wait_release.recv_timeout(Duration::from_secs(30));
            })
        });
        wait_reached
            .recv_timeout(Duration::from_secs(30))
            .expect("the open got as far as installing");
        m.close_panel("s1").unwrap();
        release.send(()).unwrap();
        opening.join().unwrap()
    });
    assert_eq!(opened, Err("panel closed".to_owned()));
    assert!(
        m.panel("s1").is_err(),
        "no view was installed after the close"
    );
    let view = view_in.recv().unwrap();
    assert!(
        view.navigate("data:text/html,x").is_err(),
        "the late view's connection is closed"
    );
    assert_eq!(seen.last_state().unwrap().status, Status::Idle);
    m.release("s1");
}

const INPUT_PAGE: &str = "data:text/html,<input id=i autofocus>";

/// Document readiness does not imply that Chromium has applied autofocus.
fn focus_input(view: &View) {
    view.evaluate_for_test("document.getElementById('i').focus()")
        .unwrap();
    eventually(SECS_3, || {
        (view
            .evaluate_for_test("document.activeElement === document.getElementById('i')")
            .ok()?
            == json!(true))
        .then_some(())
    })
    .expect("input focused before sending text");
}

#[test]
fn queued_input_is_not_sent_to_the_page_shown_later() {
    let _chromium = lock(&CHROMIUM);
    let Some((m, view, seen)) = panel("view-stale-input") else {
        return;
    };
    let a = active_tab(&seen).unwrap();
    view.navigate(INPUT_PAGE).unwrap();
    loaded(&view, "document.getElementById('i')");
    view.tab_new().unwrap();
    let b = active_tab(&seen).unwrap();
    assert_ne!(a, b);
    view.navigate(INPUT_PAGE).unwrap();
    loaded(&view, "document.getElementById('i')");
    view.tab_activate(&a).unwrap();

    let paused = lock(&view.core.input_gate);
    view.input(&InputEvent::Text { text: "abc".into() })
        .unwrap(); // made for A
    view.tab_activate(&b).unwrap();
    // B's input has focus before the queue drains: "abc" sent to B by
    // mistake would land in it, not vanish.
    focus_input(&view);
    drop(paused);

    // Input is sent in order: once "xyz" has arrived, "abc" has been dealt with.
    view.input(&InputEvent::Text { text: "xyz".into() })
        .unwrap();
    let typed = eventually(SECS_3, || {
        let value = view
            .evaluate_for_test("document.getElementById('i').value")
            .ok()?;
        (value != json!("")).then_some(value)
    });
    assert_eq!(typed, Some(json!("xyz")), "nothing made for A reached B");
    m.release("s1");
}

#[test]
fn a_tab_that_is_not_listed_is_refused_and_the_shown_one_stays() {
    let _chromium = lock(&CHROMIUM);
    let Some((m, view, seen)) = panel("view-unknown-tab") else {
        return;
    };
    let a = active_tab(&seen).unwrap();
    let state_before = seen.last_state();
    assert_eq!(
        view.tab_activate("no-such-target"),
        Err("no such tab".to_owned())
    );
    assert_eq!(
        view.tab_close("no-such-target"),
        Err("no such tab".to_owned())
    );
    assert_eq!(seen.last_state(), state_before, "nothing changed");
    assert_eq!(active_tab(&seen), Some(a), "still showing the same page");
    let frames_before = seen.frame_count();
    view.navigate("data:text/html,still-here").unwrap();
    let framed = eventually(SECS_3, || {
        (seen.frame_count() > frames_before).then_some(())
    });
    assert!(framed.is_some(), "its screencast keeps running");
    m.release("s1");
}

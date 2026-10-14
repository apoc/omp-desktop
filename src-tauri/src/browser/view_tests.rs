//! The panel against a real Chromium (skipped when none is installed).

use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use serde_json::{json, Value};

use super::cdp::{browser_ws_url, CdpClient};
use super::emit::{BrowserEmit, Frame, Pick, TabInfo, ViewState};
use super::tests::{manager_with_chromium, CHROMIUM};
use super::view::{InputEvent, View};
use super::{lock, BrowserManager};

#[derive(Clone, Debug)]
enum Seen {
    Frame(Frame),
    Tabs(Vec<TabInfo>),
    State(ViewState),
}

/// Records everything the view emits, in order.
#[derive(Default)]
struct Collect(Mutex<Vec<Seen>>);

impl Collect {
    fn log(&self) -> Vec<Seen> {
        lock(&self.0).clone() // a snapshot for the test to inspect
    }

    fn frames(&self) -> Vec<Frame> {
        self.log()
            .into_iter()
            .filter_map(|s| match s {
                Seen::Frame(f) => Some(f),
                _ => None,
            })
            .collect()
    }

    fn last_tabs(&self) -> Vec<TabInfo> {
        self.log()
            .into_iter()
            .rev()
            .find_map(|s| match s {
                Seen::Tabs(t) => Some(t),
                _ => None,
            })
            .unwrap_or_default()
    }

    fn last_state(&self) -> Option<ViewState> {
        self.log().into_iter().rev().find_map(|s| match s {
            Seen::State(s) => Some(s),
            _ => None,
        })
    }
}

impl BrowserEmit for Collect {
    fn frame(&self, _: &str, f: &Frame) {
        lock(&self.0).push(Seen::Frame(f.clone())); // the log owns what it records
    }
    fn tabs(&self, _: &str, tabs: &[TabInfo]) {
        lock(&self.0).push(Seen::Tabs(tabs.to_vec()));
    }
    fn state(&self, _: &str, s: &ViewState) {
        lock(&self.0).push(Seen::State(s.clone())); // the log owns what it records
    }
    fn pick(&self, _: &str, _: &Pick) {}
}

/// Poll `check` until it returns `Some`, for at most `secs`.
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

/// A manager with a panel open on session `s1`, or `None` without Chromium.
fn panel(name: &str) -> Option<(BrowserManager, Arc<View>, Arc<Collect>)> {
    let m = manager_with_chromium(name)?;
    m.allocate("s1", None).unwrap();
    let seen = Arc::new(Collect::default());
    let emit: Arc<dyn BrowserEmit> = Arc::clone(&seen) as Arc<dyn BrowserEmit>;
    m.open_panel("s1", 400, 300, 2.0, emit).unwrap();
    let view = m.panel("s1").unwrap();
    Some((m, view, seen))
}

/// A left-button gesture step: `mouseMoved` has no button, the other two do.
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

#[test]
fn screencast_emits_frames() {
    let _chromium = lock(&CHROMIUM);
    let Some((m, view, seen)) = panel("view-frames") else {
        eprintln!("skip: no chromium");
        return;
    };
    view.navigate("data:text/html,<h1>hi</h1>").unwrap();
    let frame = eventually(3, || seen.frames().into_iter().find(|f| f.css_w == 400));
    let frame = frame.expect("a frame of the 400 px wide page");
    assert_eq!(frame.css_h, 300);
    assert_eq!(
        frame.w * frame.css_h,
        frame.h * frame.css_w,
        "the image has the page's proportions"
    );
    assert!(frame.b64.starts_with("/9j/"), "a base64 JPEG");
    // Chromium may capture its whole window surface for a moment after a
    // navigation; the view restarts the screencast, so the latest frame is
    // the page's size again.
    std::thread::sleep(Duration::from_millis(2500));
    let last = seen.frames().pop().unwrap();
    assert_eq!(
        (last.css_w, last.css_h),
        (400, 300),
        "settled on the panel size"
    );
    assert_eq!(
        seen.last_state().unwrap().status,
        super::emit::Status::Running
    );
    m.release("s1");
}

#[test]
fn frames_keep_coming_while_the_page_changes() {
    let _chromium = lock(&CHROMIUM);
    let Some((m, view, seen)) = panel("view-ack") else {
        eprintln!("skip: no chromium");
        return;
    };
    // Chromium stops sending after a few frames that are not acknowledged.
    view.navigate(
        "data:text/html,<body><script>setInterval(()=>{document.body.style.background=\
         'rgb('+(Date.now()&255)+',0,0)'},20)</script>",
    )
    .unwrap();
    let flowing = eventually(4, || (seen.frames().len() >= 15).then_some(()));
    assert!(flowing.is_some(), "only {} frames", seen.frames().len());
    m.release("s1");
}

#[test]
fn input_reaches_the_page() {
    let _chromium = lock(&CHROMIUM);
    let Some((m, view, _seen)) = panel("view-input") else {
        eprintln!("skip: no chromium");
        return;
    };
    let page = "data:text/html,<input id=i><button onclick=\"document.title='clicked'\" \
                style=\"position:absolute;left:100px;top:100px;width:100px;height:50px\">go</button>";
    view.navigate(page).unwrap();
    page_loaded(&view);
    focus_input(&view);
    view.input(&InputEvent::Text { text: "abc".into() })
        .unwrap();
    let typed = eventually(3, || {
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
    let clicked = eventually(3, || {
        let title = view.evaluate_for_test("document.title").ok()?;
        (title == json!("clicked")).then_some(title)
    });
    assert!(clicked.is_some(), "click reached the button");
    m.release("s1");
}

#[test]
fn tabs_and_history() {
    let _chromium = lock(&CHROMIUM);
    let Some((m, view, seen)) = panel("view-tabs") else {
        eprintln!("skip: no chromium");
        return;
    };
    assert_eq!(seen.last_tabs().len(), 1, "the initial blank tab");
    view.tab_new(Some("data:text/html,a")).unwrap();
    let two = eventually(3, || (seen.last_tabs().len() == 2).then_some(()));
    assert!(two.is_some(), "{:?}", seen.last_tabs());
    assert!(seen.last_tabs()[1].active, "the new tab is shown");
    view.navigate("data:text/html,b").unwrap();
    let on_b = eventually(3, || {
        let state = seen.last_state()?;
        (state.url.ends_with(",b") && state.can_back).then_some(())
    });
    assert!(on_b.is_some(), "{:?}", seen.last_state());
    assert!(!seen.last_state().unwrap().can_forward);
    view.history(-1).unwrap();
    let back = eventually(3, || {
        let state = seen.last_state()?;
        (state.can_forward && state.url.ends_with(",a")).then_some(())
    });
    assert!(back.is_some(), "{:?}", seen.last_state());
    let second = seen.last_tabs()[1].target_id.clone(); // the id outlives the log snapshot
    view.tab_close(&second).unwrap();
    let one = eventually(3, || {
        let tabs = seen.last_tabs();
        (tabs.len() == 1 && tabs[0].active).then_some(())
    });
    assert!(one.is_some(), "{:?}", seen.last_tabs());
    m.release("s1");
}

/// The agent's side: a raw client through the placeholder port, on the
/// browser connection or (`page`) on one page's own.
fn agent(m: &BrowserManager, page: Option<&str>) -> CdpClient {
    let port = m.port("s1").unwrap();
    let ws = page.map_or_else(
        || browser_ws_url(port).unwrap(),
        |id| format!("ws://127.0.0.1:{port}/devtools/page/{id}"),
    );
    CdpClient::connect(&ws, Box::new(|_, _, _: &Value| {})).unwrap()
}

/// Attach as puppeteer does and give back the page session.
fn attach(agent: &CdpClient, target: &str) -> String {
    let attached = agent
        .call(
            None,
            "Target.attachToTarget",
            json!({ "targetId": target, "flatten": true }),
        )
        .unwrap();
    attached["sessionId"].as_str().unwrap().to_owned()
}

fn navigate(agent: &CdpClient, session: &str, url: &str) {
    agent
        .call(Some(session), "Page.navigate", json!({ "url": url }))
        .unwrap();
}

fn create_page(agent: &CdpClient, url: &str) -> String {
    let created = agent
        .call(None, "Target.createTarget", json!({ "url": url }))
        .unwrap();
    created["targetId"].as_str().unwrap().to_owned()
}

/// Manager, view, what it emitted, and the pages A and B.
type TwoTabs = (BrowserManager, Arc<View>, Arc<Collect>, String, String);

/// A panel on page A with a second page B listed, the user's last choice
/// being A; `hold` is how long that choice keeps the view from following.
fn panel_on_a_next_to_b(name: &str, hold: Duration) -> Option<TwoTabs> {
    let (m, view, seen) = panel(name)?;
    view.set_follow_hold_for_test(hold);
    let a = active_tab(&seen).unwrap();
    view.tab_new(Some("data:text/html,b")).unwrap();
    let b = active_tab(&seen).unwrap();
    assert_ne!(a, b);
    view.tab_activate(&a).unwrap();
    Some((m, view, seen, a, b))
}

/// Whether the view shows `target` and has framed it since `frames_before`.
fn shows(seen: &Collect, target: &str, frames_before: usize) -> bool {
    active_tab(seen).as_deref() == Some(target) && seen.frames().len() > frames_before
}

#[test]
fn follows_an_agent_that_navigates_an_existing_page() {
    let _chromium = lock(&CHROMIUM);
    let hold = Duration::from_millis(200);
    let Some((m, _view, seen, a, b)) = panel_on_a_next_to_b("view-follow-nav", hold) else {
        eprintln!("skip: no chromium");
        return;
    };
    std::thread::sleep(hold + Duration::from_millis(100));
    let agent = agent(&m, None);
    let session = attach(&agent, &b);
    std::thread::sleep(Duration::from_millis(600));
    assert_eq!(
        active_tab(&seen).as_deref(),
        Some(a.as_str()),
        "attached is not worked in: puppeteer stays attached to every page"
    );
    let frames_before = seen.frames().len();
    navigate(&agent, &session, "data:text/html,agent-b");
    let followed = eventually(3, || shows(&seen, &b, frames_before).then_some(()));
    assert!(
        followed.is_some(),
        "the view follows the agent to B and shows it"
    );
    agent.close();
    m.release("s1");
}

#[test]
fn a_tab_the_user_picked_holds_the_view_for_a_while() {
    let _chromium = lock(&CHROMIUM);
    let hold = Duration::from_millis(1500);
    let Some((m, _view, seen, a, b)) = panel_on_a_next_to_b("view-follow-hold", hold) else {
        eprintln!("skip: no chromium");
        return;
    };
    let held_from = Instant::now();
    let agent = agent(&m, None);
    let session = attach(&agent, &b);
    navigate(&agent, &session, "data:text/html,agent-b");
    std::thread::sleep(Duration::from_millis(600));
    assert!(held_from.elapsed() < hold, "too slow to mean anything");
    assert_eq!(
        active_tab(&seen).as_deref(),
        Some(a.as_str()),
        "within the hold the view stays on the page the user picked"
    );
    std::thread::sleep(hold.saturating_sub(held_from.elapsed()) + Duration::from_millis(200));
    let frames_before = seen.frames().len();
    navigate(&agent, &session, "data:text/html,agent-b-again");
    let followed = eventually(3, || shows(&seen, &b, frames_before).then_some(()));
    assert!(
        followed.is_some(),
        "the hold is over: the agent's next step is followed"
    );
    agent.close();
    m.release("s1");
}

#[test]
fn follows_a_page_the_agent_creates() {
    let _chromium = lock(&CHROMIUM);
    let hold = Duration::from_millis(200);
    let Some((m, _view, seen, _a, _b)) = panel_on_a_next_to_b("view-follow-create", hold) else {
        eprintln!("skip: no chromium");
        return;
    };
    std::thread::sleep(hold + Duration::from_millis(100));
    let frames_before = seen.frames().len();
    let agent = agent(&m, None);
    let created = create_page(&agent, "data:text/html,agent-new");
    let followed = eventually(3, || shows(&seen, &created, frames_before).then_some(()));
    assert!(
        followed.is_some(),
        "the view follows the agent to its new page"
    );
    agent.close();
    m.release("s1");
}

#[test]
fn follows_an_agent_on_a_page_level_connection() {
    let _chromium = lock(&CHROMIUM);
    let hold = Duration::from_millis(200);
    let Some((m, _view, seen, _a, b)) = panel_on_a_next_to_b("view-follow-page-ws", hold) else {
        eprintln!("skip: no chromium");
        return;
    };
    std::thread::sleep(hold + Duration::from_millis(100));
    let frames_before = seen.frames().len();
    let agent = agent(&m, Some(&b));
    agent.call(None, "Page.bringToFront", json!({})).unwrap();
    let followed = eventually(3, || shows(&seen, &b, frames_before).then_some(()));
    assert!(
        followed.is_some(),
        "bringToFront on B's own connection is work in B"
    );
    agent.close();
    m.release("s1");
}

#[test]
fn a_flood_of_follow_reports_costs_one_switch_to_the_last_page() {
    let _chromium = lock(&CHROMIUM);
    let hold = Duration::from_millis(200);
    let Some((m, view, seen, a, b)) = panel_on_a_next_to_b("view-follow-flood", hold) else {
        eprintln!("skip: no chromium");
        return;
    };
    std::thread::sleep(hold + Duration::from_millis(100));
    let shown_before = view.activations_for_test();
    let frames_before = seen.frames().len();
    {
        let _paused = view.pause_follow_for_test();
        for i in 0..10_000 {
            view.follow_agent(if i % 2 == 0 { &a } else { &b }); // ends on B, the view shows A
        }
    }
    let followed = eventually(3, || shows(&seen, &b, frames_before).then_some(()));
    assert!(
        followed.is_some(),
        "the view ends on the last page reported"
    );
    std::thread::sleep(Duration::from_millis(500));
    assert_eq!(
        view.activations_for_test(),
        shown_before + 1,
        "one switch, not one per report"
    );
    m.release("s1");
}

#[test]
fn a_panel_opened_after_the_agent_browsed_starts_on_its_page() {
    let _chromium = lock(&CHROMIUM);
    let Some(m) = manager_with_chromium("view-open-on-agent") else {
        eprintln!("skip: no chromium");
        return;
    };
    m.allocate("s1", None).unwrap();
    let agent = agent(&m, None);
    let b = create_page(&agent, "data:text/html,b");
    let c = create_page(&agent, "data:text/html,c"); // the newest page, not the agent's choice
    let session = attach(&agent, &b);
    navigate(&agent, &session, "data:text/html,agent-b");
    let told = eventually(3, || {
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
    let first_shown = seen.log().into_iter().find_map(|s| match s {
        Seen::Tabs(tabs) => tabs.into_iter().find(|t| t.active).map(|t| t.target_id),
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
        eprintln!("skip: no chromium");
        return;
    };
    m.release("s1");
    assert!(view.navigate("data:text/html,x").is_err());
    assert_eq!(seen.last_state().unwrap().status, super::emit::Status::Idle);
    assert!(m.panel("s1").is_err());
}

#[test]
fn panel_commands_need_an_allocated_browser() {
    let m =
        BrowserManager::new(super::tests::tempdir("view-none"), super::tests::home_dir()).unwrap();
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
fn reopening_a_panel_replaces_the_view() {
    let _chromium = lock(&CHROMIUM);
    let Some((m, first, seen)) = panel("view-reopen") else {
        eprintln!("skip: no chromium");
        return;
    };
    let emit: Arc<dyn BrowserEmit> = Arc::clone(&seen) as Arc<dyn BrowserEmit>;
    m.open_panel("s1", 300, 200, 1.0, emit).unwrap();
    assert!(
        first.navigate("data:text/html,x").is_err(),
        "the old view is closed"
    );
    let second = m.panel("s1").unwrap();
    second.navigate("data:text/html,y").unwrap();
    assert!(
        eventually(3, || seen
            .frames()
            .iter()
            .any(|f| f.css_w == 300)
            .then_some(()))
        .is_some(),
        "frames of the new size"
    );
    m.close_panel("s1").unwrap();
    assert!(m.panel("s1").is_err());
    m.release("s1");
}

fn active_tab(seen: &Collect) -> Option<String> {
    seen.last_tabs()
        .into_iter()
        .find(|t| t.active)
        .map(|t| t.target_id)
}

#[test]
fn a_close_during_a_pending_open_wins() {
    let _chromium = lock(&CHROMIUM);
    let Some(m) = manager_with_chromium("view-open-close") else {
        eprintln!("skip: no chromium");
        return;
    };
    m.allocate("s1", None).unwrap();
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
    assert_eq!(seen.last_state().unwrap().status, super::emit::Status::Idle);
    m.release("s1");
}

const INPUT_PAGE: &str = "data:text/html,<input id=i autofocus>";

fn page_loaded(view: &View) {
    eventually(3, || {
        (view.evaluate_for_test("document.readyState").ok()? == json!("complete")).then_some(())
    })
    .expect("page loaded");
}

/// Document readiness does not imply that Chromium has applied autofocus.
fn focus_input(view: &View) {
    view.evaluate_for_test("document.getElementById('i').focus()")
        .unwrap();
    eventually(3, || {
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
        eprintln!("skip: no chromium");
        return;
    };
    let a = active_tab(&seen).unwrap();
    view.navigate(INPUT_PAGE).unwrap();
    page_loaded(&view);
    view.tab_new(Some(INPUT_PAGE)).unwrap();
    let b = active_tab(&seen).unwrap();
    assert_ne!(a, b);
    page_loaded(&view);
    view.tab_activate(&a).unwrap();

    let paused = view.pause_input_for_test();
    view.input(&InputEvent::Text { text: "abc".into() })
        .unwrap(); // made for A
    view.tab_activate(&b).unwrap();
    drop(paused);

    focus_input(&view);
    // Input is sent in order: once "xyz" has arrived, "abc" has been dealt with.
    view.input(&InputEvent::Text { text: "xyz".into() })
        .unwrap();
    let typed = eventually(3, || {
        let value = view
            .evaluate_for_test("document.getElementById('i').value")
            .ok()?;
        (value != json!("")).then_some(value)
    });
    assert_eq!(typed, Some(json!("xyz")), "nothing made for A reached B");
    m.release("s1");
}

#[test]
fn a_page_that_cannot_be_attached_leaves_the_shown_one_alone() {
    let _chromium = lock(&CHROMIUM);
    let Some((m, view, seen)) = panel("view-failed-switch") else {
        eprintln!("skip: no chromium");
        return;
    };
    let a = active_tab(&seen).unwrap();
    assert!(view.tab_activate("no-such-target").is_err());
    let state = seen.last_state().unwrap();
    assert_eq!(state.status, super::emit::Status::Running);
    assert!(state.error.is_some(), "the panel is told: {state:?}");
    assert_eq!(active_tab(&seen), Some(a), "still showing the same page");
    assert_eq!(
        view.evaluate_for_test("1+1").unwrap(),
        json!(2),
        "and it still works"
    );
    let frames_before = seen.frames().len();
    view.navigate("data:text/html,still-here").unwrap();
    let framed = eventually(3, || (seen.frames().len() > frames_before).then_some(()));
    assert!(framed.is_some(), "its screencast keeps running");

    view.tab_new(None).unwrap();
    assert!(
        seen.last_state().unwrap().error.is_none(),
        "a switch that worked clears the message"
    );
    m.release("s1");
}

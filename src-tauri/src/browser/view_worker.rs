//! The view's worker thread: reacts to target and page events with the CDP
//! calls the reader thread must not make.

use std::sync::mpsc::Receiver;
use std::thread;

use serde_json::{json, Value};

use super::cdp::DISCONNECTED;
use super::emit::Status;
use super::lock;
use super::view_core::Core;
use super::view_events::Event;

pub(super) fn run_worker(core: &Core, events: &Receiver<Event>) {
    for event in events {
        match event {
            Event::Stop => break,
            Event::Follow => on_follow(core),
            Event::Barrier(done) => {
                let _ = done.send(());
            }
            Event::Restart => {
                let wait = lock(&core.inner).restart_wait();
                thread::sleep(wait);
                let size = {
                    let mut inner = lock(&core.inner);
                    inner.restart_started();
                    inner.size
                };
                if let Ok(session) = core.active_session() {
                    let _ = core.resize_to(&session, size);
                }
            }
            Event::Cdp {
                session,
                method,
                params,
            } => handle(core, session.as_deref(), &method, &params),
        }
    }
}

fn handle(core: &Core, session: Option<&str>, method: &str, params: &Value) {
    match method {
        "Target.targetCreated" | "Target.targetInfoChanged" => {
            on_target_event(core, method, params);
        }
        "Target.targetDestroyed" => on_target_destroyed(core, params["targetId"].as_str()),
        DISCONNECTED => {
            if !core.is_closed() {
                core.update_state(|s| {
                    s.status = Status::Stopped;
                    s.error = Some("browser connection lost".into());
                });
            }
        }
        _ if session.is_some_and(|s| core.is_active_session(s)) => {
            on_page_event(core, method, params);
        }
        _ => {}
    }
}

fn on_page_event(core: &Core, method: &str, params: &Value) {
    match method {
        "Page.frameNavigated" => {
            let frame = &params["frame"];
            if frame.get("parentId").is_none() {
                if let Some(url) = frame["url"].as_str() {
                    core.update_state(|s| url.clone_into(&mut s.url));
                }
                let _ = core.refresh_history();
            }
        }
        "Page.frameStartedLoading" => core.update_state(|s| s.loading = true),
        "Page.frameStoppedLoading" => core.update_state(|s| s.loading = false),
        "Page.loadEventFired" => {
            core.update_state(|s| s.loading = false);
            let _ = core.refresh_history();
        }
        "Page.navigatedWithinDocument" => {
            let _ = core.refresh_history();
        }
        _ => {}
    }
}

/// A target event: the model keeps the pages current, and names the page the
/// agent was waiting for when it has just appeared.
fn on_target_event(core: &Core, method: &str, params: &Value) {
    let mut inner = lock(&core.inner);
    let follow = inner.apply_target_event(method, params);
    core.publish_tabs(&mut inner);
    drop(inner);
    if let Some(id) = follow {
        let _ = core.switch_to(&id);
    }
}

/// The agent worked in the page in the follow slot (see `tap.rs`): show it,
/// or show it when it is listed.
fn on_follow(core: &Core) {
    #[cfg(test)]
    drop(lock(&core.follow_gate)); // a test holds it to keep the worker from taking the slot
    let Some(target) = core.follow.take() else {
        return;
    };
    let follow = lock(&core.inner).request_follow(&target);
    if follow {
        let _ = core.switch_to(&target);
    }
}

/// A closed page: drop it, and show the newest remaining one (a blank one
/// when none is left) if it was the active page.
fn on_target_destroyed(core: &Core, target_id: Option<&str>) {
    let Some(target_id) = target_id else {
        return;
    };
    let next = {
        let mut inner = lock(&core.inner);
        let before = inner.pages.len();
        inner.pages.retain(|p| p.target_id != target_id);
        let was_active = inner
            .active
            .as_ref()
            .is_some_and(|a| a.target_id == target_id);
        if was_active {
            if let Some(gone) = inner.active.take() {
                core.release_overlay(&gone.session); // its session is gone with it
            }
        }
        core.publish_tabs(&mut inner);
        (before != inner.pages.len() && was_active)
            .then(|| inner.pages.last().map(|p| p.target_id.clone())) // owned: the lock must not span the switch
    };
    match next {
        Some(Some(id)) => {
            let _ = core.switch_to(&id);
        }
        Some(None) => {
            let created = core.call(None, "Target.createTarget", json!({ "url": "about:blank" }));
            if let Some(id) = created
                .ok()
                .and_then(|c| c["targetId"].as_str().map(str::to_owned))
            {
                let _ = core.switch_to(&id);
            }
        }
        None => {}
    }
}

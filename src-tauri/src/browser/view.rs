//! The panel's view of a tab's Chromium: one browser-level CDP connection
//! (`Target.attachToTarget { flatten: true }`, so one socket serves every
//! page session), the page targets, and the screencast of the active one.
//!
//! Threads: the connection's reader runs [`view_events::handler`] (frames
//! and quick bookkeeping only), a worker thread does everything that needs
//! a CDP call in answer to an event, one thread emits frames and one sends
//! input in order. Locks: `Core::inner` is never held across a CDP call;
//! `Core::switch` serialises target switches and viewport changes.

use std::sync::mpsc::{self, Sender, SyncSender, TrySendError};
use std::sync::Arc;
use std::time::Duration;

use serde_json::json;

use super::annotate::CapturedImage;
use super::cdp::{browser_ws_url, CdpClient};
use super::emit::{BrowserEmit, Rect, Status};
use super::lock;
use super::view_core::Core;
use super::view_events::{self, Event, InputItem};
pub use super::view_input::InputEvent;
use super::view_model::Size;

const MAX_URL_LEN: usize = 8192;
/// Input events waiting for the page; a hung page drops the rest.
const INPUT_QUEUE: usize = 512;

/// The panel's session on one tab's Chromium.
pub struct View {
    core: Arc<Core>,
    events: Sender<Event>,
    input: SyncSender<InputItem>,
}

impl View {
    /// Connect to the Chromium on `port` (its own port, not the proxy's).
    pub fn connect(sid: &str, port: u16, emit: Arc<dyn BrowserEmit>) -> Result<Self, String> {
        let url = browser_ws_url(port)?;
        let core = Arc::new(Core::new(sid, emit));
        let (events, queue) = mpsc::channel();
        let handler = view_events::handler(Arc::downgrade(&core), events.clone()); // the view keeps one sender for `Barrier` and `Stop`
        let client = CdpClient::connect(&url, handler)?;
        if core.client.set(client).is_err() {
            return Err("cdp client already set".into());
        }
        let (input, input_queue) = mpsc::sync_channel(INPUT_QUEUE);
        view_events::spawn(&core, queue, input_queue)?;
        Ok(Self {
            core,
            events,
            input,
        })
    }

    /// Discover the pages, show the one the agent last worked in if it is
    /// still there (`start_on`) or else the newest (a blank one when there is
    /// none), and start following the agent.
    pub fn open(
        &self,
        width: u32,
        height: u32,
        dpr: f64,
        start_on: Option<&str>,
    ) -> Result<(), String> {
        let core = &self.core;
        lock(&core.inner).size = Size::new(width, height, dpr)?;
        core.call(
            None,
            "Target.setDiscoverTargets",
            json!({ "discover": true }),
        )?;
        self.barrier()?;
        let targets = core.call(None, "Target.getTargets", json!({}))?;
        let first = {
            let mut inner = lock(&core.inner);
            for info in targets["targetInfos"].as_array().into_iter().flatten() {
                if info["type"] == "page" {
                    inner.upsert_page(info);
                }
            }
            // Owned: the lock must not span the switch.
            let first = start_on
                .filter(|t| inner.pages.iter().any(|p| p.target_id == *t))
                .map(str::to_owned)
                .or_else(|| inner.pages.last().map(|p| p.target_id.clone()));
            drop(inner);
            first
        };
        let target = match first {
            Some(target) => target,
            None => self.create_page("about:blank")?,
        };
        core.update_state(|s| s.status = Status::Running);
        core.switch_to(&target)?;
        lock(&core.inner).following = true;
        Ok(())
    }

    /// The agent worked in page `target`: the view switches to it unless the
    /// user picked a tab a moment ago, or when it appears if it is not
    /// listed yet. Callers are proxy threads: this only records the page in
    /// the follow slot (a newer report replaces an older one the worker has
    /// not taken) and wakes the worker if no wake-up is queued.
    pub fn follow_agent(&self, target: &str) {
        if self.core.follow.put(target) {
            let _ = self.events.send(Event::Follow);
        }
    }

    /// Wait until the worker has handled everything received so far.
    fn barrier(&self) -> Result<(), String> {
        let (done, wait) = mpsc::channel();
        self.events
            .send(Event::Barrier(done))
            .map_err(|_| "browser view closed")?;
        wait.recv_timeout(Duration::from_secs(10))
            .map_err(|_| "browser view did not answer".to_owned())
    }

    /// Turn annotate mode on or off (for this view's pages, shown now and
    /// later); a closed view has it off.
    pub fn annotate(&self, on: bool) -> Result<(), String> {
        self.core.set_annotate(on)
    }

    /// A PNG of `rect` (viewport-relative CSS pixels of the page shown).
    pub fn capture(&self, rect: &Rect) -> Result<CapturedImage, String> {
        self.core.capture(rect)
    }

    /// Scroll the shown page so that the absolute document `rect` is visible.
    pub fn scroll_to(&self, rect: &Rect) -> Result<(), String> {
        self.core.scroll_to(rect)
    }

    /// Stop the screencast and drop the connection; Chromium keeps running.
    /// Idempotent.
    pub fn close(&self) {
        let core = &self.core;
        if !core.mark_closed() {
            return;
        }
        core.update_state(|s| s.status = Status::Idle);
        if let (Some(client), Ok(session)) = (core.client.get(), core.active_session()) {
            core.release_overlay(&session); // the page keeps running: no overlay left in it
                                            // No waiting: the connection ends right after, which detaches the
                                            // session anyway.
            client.notify(Some(&session), "Page.stopScreencast", json!({}));
            client.notify(
                None,
                "Target.detachFromTarget",
                json!({ "sessionId": session }),
            );
        }
        let _ = self.events.send(Event::Stop);
        core.frames.close();
        if let Some(client) = core.client.get() {
            client.close();
        }
    }

    pub fn resize(&self, width: u32, height: u32, dpr: f64) -> Result<(), String> {
        let size = Size::new(width, height, dpr)?;
        let session = {
            let mut inner = lock(&self.core.inner);
            inner.size = size;
            inner.active.as_ref().map(|a| a.session.clone()) // owned: used after the lock
        };
        session.map_or(Ok(()), |session| self.core.resize_to(&session, size))
    }

    pub fn navigate(&self, url: &str) -> Result<(), String> {
        let url = url.trim();
        if url.is_empty() || url.len() > MAX_URL_LEN || url.chars().any(char::is_control) {
            return Err("invalid url".into());
        }
        let result = self
            .core
            .call_active("Page.navigate", json!({ "url": url }))?;
        result["errorText"]
            .as_str()
            .map_or(Ok(()), |error| Err(error.to_owned()))
    }

    /// Go `delta` entries back (negative) or forward; out of range does
    /// nothing.
    pub fn history(&self, delta: i32) -> Result<(), String> {
        let history = self
            .core
            .call_active("Page.getNavigationHistory", json!({}))?;
        let current = history["currentIndex"].as_i64().unwrap_or(0);
        let entries = history["entries"].as_array().map_or(&[][..], Vec::as_slice);
        let target = usize::try_from(current + i64::from(delta)).ok();
        let Some(entry) = target.and_then(|i| entries.get(i)) else {
            return Ok(());
        };
        self.core
            .call_active(
                "Page.navigateToHistoryEntry",
                json!({ "entryId": entry["id"] }),
            )
            .map(drop)
    }

    fn create_page(&self, url: &str) -> Result<String, String> {
        let created = self
            .core
            .call(None, "Target.createTarget", json!({ "url": url }))?;
        let target = created["targetId"]
            .as_str()
            .ok_or("createTarget returned no target")?
            .to_owned();
        lock(&self.core.inner).upsert_page(&json!({ "targetId": target, "url": url }));
        Ok(target)
    }

    /// Open a tab and show it.
    pub fn tab_new(&self, url: Option<&str>) -> Result<(), String> {
        self.core.stamp_user_activation(); // the new page is the user's choice, not the agent's
        let target = self.create_page(url.map_or("about:blank", str::trim))?;
        self.core.switch_to(&target)
    }

    /// Close a tab; the last one is replaced by a blank page.
    pub fn tab_close(&self, target_id: &str) -> Result<(), String> {
        self.core.stamp_user_activation();
        let only = lock(&self.core.inner).pages.len() <= 1;
        if only {
            self.create_page("about:blank")?;
        }
        self.core
            .call(None, "Target.closeTarget", json!({ "targetId": target_id }))
            .map(drop)
    }

    pub fn tab_activate(&self, target_id: &str) -> Result<(), String> {
        self.core.stamp_user_activation();
        self.core.switch_to(target_id)
    }

    /// Queue an input event for the page shown now; events are sent in
    /// order, and one still queued when another page is shown is dropped,
    /// not sent to that page.
    pub fn input(&self, event: &InputEvent) -> Result<(), String> {
        let (method, params) = event.to_command()?;
        let (session, generation) = self.core.activation()?;
        let item = InputItem {
            session,
            generation,
            method,
            params,
        };
        self.input.try_send(item).map_err(|e| match e {
            TrySendError::Full(_) => "browser is busy".to_owned(),
            TrySendError::Disconnected(_) => "browser view closed".to_owned(),
        })
    }

    /// `Runtime.evaluate` of `expression` in the active page.
    #[cfg(test)]
    pub(super) fn evaluate_for_test(&self, expression: &str) -> Result<serde_json::Value, String> {
        let result = self.core.call_active(
            "Runtime.evaluate",
            json!({ "expression": expression, "returnByValue": true }),
        )?;
        Ok(result["result"]["value"].clone())
    }

    /// Keeps the input sender from sending while the guard lives.
    #[cfg(test)]
    pub(super) fn pause_input_for_test(&self) -> std::sync::MutexGuard<'_, ()> {
        lock(&self.core.input_gate)
    }

    /// Shorten (or lengthen) how long a tab the user picked is kept.
    #[cfg(test)]
    pub(super) fn set_follow_hold_for_test(&self, hold: Duration) {
        lock(&self.core.inner).follow_hold = hold;
    }

    /// Keeps the worker from taking a follow report while the guard lives.
    #[cfg(test)]
    pub(super) fn pause_follow_for_test(&self) -> std::sync::MutexGuard<'_, ()> {
        lock(&self.core.follow_gate)
    }

    /// How many pages the view has shown so far.
    #[cfg(test)]
    pub(super) fn activations_for_test(&self) -> u64 {
        lock(&self.core.inner).activations()
    }
}

impl Drop for View {
    fn drop(&mut self) {
        self.close();
    }
}

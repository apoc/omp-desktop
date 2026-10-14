//! The state and CDP plumbing a [`View`](super::view::View) and its threads
//! share: viewport, screencast and target switching.

use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex, OnceLock};
use std::time::Instant;

use serde_json::{json, Value};

use super::annotate::Annotate;
use super::cdp::CdpClient;
use super::emit::{BrowserEmit, Frame, Pick, ViewState};
use super::lock;
use super::view_events::{FollowSlot, FrameSlot, InputItem};
use super::view_model::{Inner, Size};

pub(super) struct Core {
    pub sid: String,
    emit: Arc<dyn BrowserEmit>,
    pub inner: Mutex<Inner>,
    pub frames: FrameSlot,
    pub follow: FollowSlot,
    /// Serialises target switches and annotate toggles; never taken by the
    /// reader thread, whose notifications do not block on CDP responses.
    pub switch: Mutex<()>,
    pub client: OnceLock<CdpClient>,
    closed: AtomicBool,
    /// Annotate mode, see `annotate.rs`.
    pub annotate: Mutex<Annotate>,
    /// Serialises overlay installs (taken before `annotate`, never by the
    /// reader thread).
    pub overlay_install: Mutex<()>,
    /// Held by a test to keep the input sender from sending.
    #[cfg(test)]
    pub input_gate: Mutex<()>,
    /// Held by a test to keep the worker from handling a follow.
    #[cfg(test)]
    pub follow_gate: Mutex<()>,
}

impl Core {
    pub fn new(sid: &str, emit: Arc<dyn BrowserEmit>) -> Self {
        Self {
            sid: sid.to_owned(),
            emit,
            inner: Mutex::new(Inner::new()),
            frames: FrameSlot::default(),
            follow: FollowSlot::default(),
            switch: Mutex::new(()),
            client: OnceLock::new(),
            closed: AtomicBool::new(false),
            annotate: Mutex::new(Annotate::default()),
            overlay_install: Mutex::new(()),
            #[cfg(test)]
            input_gate: Mutex::new(()),
            #[cfg(test)]
            follow_gate: Mutex::new(()),
        }
    }

    pub fn is_closed(&self) -> bool {
        self.closed.load(Ordering::SeqCst)
    }

    /// Mark the view closed; `false` when it already was.
    pub fn mark_closed(&self) -> bool {
        let mut annotate = lock(&self.annotate);
        let was_open = !self.closed.swap(true, Ordering::SeqCst);
        annotate.on = false;
        was_open
    }

    pub fn call(
        &self,
        session: Option<&str>,
        method: &str,
        params: Value,
    ) -> Result<Value, String> {
        self.client
            .get()
            .ok_or("cdp not connected")?
            .call(session, method, params)
    }

    pub fn active_session(&self) -> Result<String, String> {
        lock(&self.inner)
            .active
            .as_ref()
            .map(|a| a.session.clone()) // owned: the lock must not span the CDP call
            .ok_or_else(|| "no page open".to_owned())
    }

    pub fn is_active_session(&self, session: &str) -> bool {
        lock(&self.inner)
            .active
            .as_ref()
            .is_some_and(|a| a.session == session)
    }

    pub fn call_active(&self, method: &str, params: Value) -> Result<Value, String> {
        let session = self.active_session()?;
        self.call(Some(&session), method, params)
    }

    /// Emit `tabs` when the list differs from the last one. Emitting under
    /// the lock keeps events in the order of the changes.
    pub fn publish_tabs(&self, inner: &mut Inner) {
        if let Some(tabs) = inner.tabs_if_changed() {
            self.emit.tabs(&self.sid, tabs);
        }
    }

    /// Tell the panel about a pick, unless the view is closed.
    pub fn emit_pick(&self, pick: &Pick) {
        if !self.is_closed() {
            self.emit.pick(&self.sid, pick);
        }
    }

    pub fn update_state(&self, change: impl FnOnce(&mut ViewState)) {
        let mut inner = lock(&self.inner);
        let mut next = inner.state.clone(); // compared with the previous state below
        change(&mut next);
        if next != inner.state {
            self.emit.state(&self.sid, &next);
            inner.state = next;
        }
    }

    /// Emit a frame captured for activation `generation`; one of an earlier
    /// activation is dropped. The check holds the lock an activation takes
    /// to emit its `tabs` event, so no frame of the old page follows the
    /// event that marks the new one active.
    pub fn emit_frame(&self, generation: u64, frame: &Frame) {
        let inner = lock(&self.inner);
        if inner
            .active
            .as_ref()
            .is_some_and(|a| a.generation == generation)
        {
            self.emit.frame(&self.sid, frame);
        }
    }

    /// `url` and back/forward availability from the navigation history.
    pub fn refresh_history(&self) -> Result<(), String> {
        let history = self.call_active("Page.getNavigationHistory", json!({}))?;
        let entries = history["entries"].as_array().map_or(&[][..], Vec::as_slice);
        let current = history["currentIndex"]
            .as_u64()
            .and_then(|i| usize::try_from(i).ok())
            .unwrap_or(0);
        let url = entries
            .get(current)
            .and_then(|e| e["url"].as_str())
            .map(str::to_owned);
        self.update_state(|s| {
            s.can_back = current > 0;
            s.can_forward = current + 1 < entries.len();
            if let Some(url) = url {
                s.url = url;
            }
        });
        Ok(())
    }

    /// Make the panel `size`, in effect for new frames of `session`.
    pub fn resize_to(&self, session: &str, size: Size) -> Result<(), String> {
        let _switching = lock(&self.switch);
        self.apply_viewport(session, size)
    }

    /// (Re)start the screencast of `session` at `size`.
    fn apply_viewport(&self, session: &str, size: Size) -> Result<(), String> {
        let _ = self.call(Some(session), "Page.stopScreencast", json!({}));
        self.call(
            Some(session),
            "Emulation.setDeviceMetricsOverride",
            json!({ "width": size.w, "height": size.h, "deviceScaleFactor": size.dpr, "mobile": false }),
        )?;
        // The page shows as focused (carets, `:focus`) though headless
        // Chromium has no window focus; not every build supports it.
        let _ = self.call(
            Some(session),
            "Emulation.setFocusEmulationEnabled",
            json!({ "enabled": true }),
        );
        self.frames.clear();
        self.call(
            Some(session),
            "Page.startScreencast",
            json!({
                "format": "jpeg", "quality": 70,
                "maxWidth": size.px(size.w), "maxHeight": size.px(size.h),
                "everyNthFrame": 1,
            }),
        )?;
        Ok(())
    }

    /// The page session the next input event is made for, with its
    /// activation.
    pub fn activation(&self) -> Result<(String, u64), String> {
        lock(&self.inner)
            .active
            .as_ref()
            .map(|a| (a.session.clone(), a.generation)) // owned: used after the lock
            .ok_or_else(|| "no page open".to_owned())
    }

    /// Send a queued gesture to the page session it was made for. One of an
    /// earlier activation is dropped, not sent to the page shown now.
    pub fn send_input(&self, item: InputItem) -> Result<(), String> {
        let current = lock(&self.inner)
            .active
            .as_ref()
            .is_some_and(|a| a.generation == item.generation && a.session == item.session);
        if !current {
            return Ok(());
        }
        self.call(Some(&item.session), item.method, item.params)
            .map(drop)
    }

    /// Attach to `target_id` and give back the page session.
    fn attach(&self, target_id: &str) -> Result<String, String> {
        self.call(
            None,
            "Target.attachToTarget",
            json!({ "targetId": target_id, "flatten": true }),
        )
        .and_then(|attached| {
            attached["sessionId"]
                .as_str()
                .map(str::to_owned)
                .ok_or_else(|| "attachToTarget returned no session".to_owned())
        })
    }

    /// Show `target_id`: attach to it first, so a page that cannot be
    /// attached leaves the shown one as it is (the panel is told in the
    /// state's `error`); then stop the old page's screencast, detach it and
    /// start the new one. The `tabs` event marking it active precedes its
    /// frames.
    pub fn switch_to(&self, target_id: &str) -> Result<(), String> {
        let _switching = lock(&self.switch);
        let size = {
            let inner = lock(&self.inner);
            if inner
                .active
                .as_ref()
                .is_some_and(|a| a.target_id == target_id)
            {
                return Ok(());
            }
            inner.size
        };
        let session = self.attach(target_id).inspect_err(|e| {
            self.update_state(|s| s.error = Some(format!("cannot show the page: {e}")));
        })?;
        let mut inner = lock(&self.inner);
        let old = inner.active.as_ref().map(|a| a.session.clone()); // owned: used after the swap
        inner.set_active(target_id, &session);
        self.publish_tabs(&mut inner);
        drop(inner);
        if let Some(old) = old {
            self.release_overlay(&old); // the old page must not stay in annotate mode
            let _ = self.call(Some(&old), "Page.stopScreencast", json!({}));
            let _ = self.call(None, "Target.detachFromTarget", json!({ "sessionId": old }));
        }
        let _ = self.call(
            None,
            "Target.activateTarget",
            json!({ "targetId": target_id }),
        );
        self.call(Some(&session), "Page.enable", json!({}))?;
        // Best effort: turning annotate on installs it again and says why not.
        let _ = self.install_overlay(&session);
        self.apply_viewport(&session, size)?;
        self.update_state(|s| {
            s.loading = false;
            s.error = None;
            s.url.clear();
        });
        self.refresh_history()
    }

    pub fn stamp_user_activation(&self) {
        lock(&self.inner).user_activated = Some(Instant::now());
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::browser::emit::{Pick, TabInfo};

    /// Records the base64 of every frame emitted.
    #[derive(Default)]
    struct Frames(Mutex<Vec<String>>);

    impl BrowserEmit for Frames {
        fn frame(&self, _: &str, f: &Frame) {
            lock(&self.0).push(f.b64.clone()); // the log owns what it records
        }
        fn tabs(&self, _: &str, _: &[TabInfo]) {}
        fn state(&self, _: &str, _: &ViewState) {}
        fn pick(&self, _: &str, _: &Pick) {}
    }

    fn core() -> (Core, Arc<Frames>) {
        let seen = Arc::new(Frames::default());
        let emit: Arc<dyn BrowserEmit> = Arc::clone(&seen) as Arc<dyn BrowserEmit>;
        (Core::new("s1", emit), seen)
    }

    #[test]
    fn a_frame_of_an_earlier_activation_is_not_emitted() {
        let (core, seen) = core();
        let first = lock(&core.inner).set_active("a", "sa");
        core.emit_frame(first, &Frame::new("on-a".into(), 1, 1));
        let second = lock(&core.inner).set_active("b", "sb");
        core.emit_frame(first, &Frame::new("late-a".into(), 1, 1));
        core.emit_frame(second, &Frame::new("on-b".into(), 1, 1));
        assert_eq!(*lock(&seen.0), ["on-a", "on-b"]);
    }

    #[test]
    fn annotate_toggle_waits_for_target_switch_serialisation() {
        let (core, _) = core();
        let core = Arc::new(core);
        lock(&core.inner).set_active("a", "sa");
        let switching = lock(&core.switch);
        let (started_tx, started_rx) = std::sync::mpsc::channel();
        let (done_tx, done_rx) = std::sync::mpsc::channel();
        let toggled = Arc::clone(&core);
        let worker = std::thread::spawn(move || {
            started_tx.send(()).unwrap();
            done_tx.send(toggled.set_annotate(false)).unwrap();
        });
        started_rx.recv().unwrap();
        let early = done_rx.recv_timeout(std::time::Duration::from_millis(100));
        lock(&core.inner).set_active("b", "sb");
        drop(switching);
        worker.join().unwrap();
        assert!(
            matches!(early, Err(std::sync::mpsc::RecvTimeoutError::Timeout)),
            "the toggle must not finish while a target switch owns the lock: {early:?}"
        );
        assert_eq!(
            done_rx.recv().unwrap(),
            Err("annotate overlay: cdp not connected".to_owned()),
            "after the switch the toggle attempts the current page"
        );
    }

    #[test]
    fn input_of_an_earlier_activation_is_dropped_not_sent() {
        let (core, _seen) = core();
        let item = |session: &str, generation| InputItem {
            session: session.to_owned(),
            generation,
            method: "Input.insertText",
            params: json!({ "text": "x" }),
        };
        let first = lock(&core.inner).set_active("a", "sa");
        let second = lock(&core.inner).set_active("b", "sb");
        assert_eq!(core.send_input(item("sa", first)), Ok(()), "dropped");
        assert_eq!(
            core.send_input(item("sb", second)),
            Err("cdp not connected".to_owned()),
            "the current page's input is sent (there is no connection here)"
        );
    }
}

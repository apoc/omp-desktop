//! The browser panel's face: the panel half of [`BrowserManager`] (the
//! per-session [`View`]) and the Tauri commands over it. All commands but
//! `browser_input` do their CDP round trips off the IPC thread.

use std::sync::atomic::Ordering;
use std::sync::{Arc, Mutex};

use tauri::{AppHandle, Manager, State};

use super::annotate::CapturedImage;
use super::emit::{BrowserEmit, Rect, Status, TauriBrowserEmit, ViewState};
use super::view::{InputEvent, View};
use super::{lock, BrowserManager, Entry};

/// Panel commands for a session that was never allocated a browser.
const NO_BROWSER: &str = "no browser for session";

/// What an open that lost to a close says.
const PANEL_CLOSED: &str = "panel closed";

/// The session's panel: its view while open, a generation that
/// [`close`](Self::close) advances, and the page the agent last worked in. An
/// open captures the generation when it starts and installs its view only if
/// it is still the same when it is done, so a close that came in between wins.
#[derive(Default)]
pub(super) struct PanelSlot {
    view: Option<Arc<View>>,
    generation: u64,
    /// What the proxy last reported (`tap.rs`); a panel opened later starts
    /// there.
    last_agent_target: Option<String>,
}

impl PanelSlot {
    /// Empty the slot and make the opens still in flight stale.
    pub const fn close(&mut self) -> Option<Arc<View>> {
        self.generation += 1;
        self.view.take()
    }

    /// The agent worked in page `target` (reported from a proxy thread):
    /// remember it, and let the open view follow.
    pub fn agent_worked_in(&mut self, target: &str) {
        target.clone_into(self.last_agent_target.get_or_insert_with(String::new));
        if let Some(view) = &self.view {
            view.follow_agent(target);
        }
    }
}

pub(super) type ViewSlot = Mutex<PanelSlot>;

impl BrowserManager {
    fn entry(&self, session_id: &str) -> Result<Arc<Entry>, String> {
        self.state()
            .entries
            .get(session_id)
            .map(Arc::clone)
            .ok_or_else(|| NO_BROWSER.to_owned())
    }

    /// Open the session's panel: make sure its Chromium runs, connect to it
    /// and start the screencast. Replaces an earlier view of the session.
    pub fn open_panel(
        &self,
        session_id: &str,
        width: u32,
        height: u32,
        dpr: f64,
        emit: Arc<dyn BrowserEmit>,
    ) -> Result<(), String> {
        self.open_panel_with(session_id, width, height, dpr, emit, |_| {})
    }

    /// [`open_panel`](Self::open_panel); `before_install` runs once the view
    /// is open, just before it is installed (a test holds the open there).
    pub(super) fn open_panel_with(
        &self,
        session_id: &str,
        width: u32,
        height: u32,
        dpr: f64,
        emit: Arc<dyn BrowserEmit>,
        before_install: impl FnOnce(&Arc<View>),
    ) -> Result<(), String> {
        let entry = self.entry(session_id)?;
        let (generation, old, last_agent) = {
            let mut panel = lock(&entry.view);
            // Owned: the lock must not span the open.
            (
                panel.generation,
                panel.view.take(),
                panel.last_agent_target.clone(),
            )
        };
        if let Some(old) = old {
            old.close();
        }
        emit.state(session_id, &ViewState::new(Status::Starting));
        let started = self.chromium_port(session_id).and_then(|port| {
            let view = Arc::new(View::connect(session_id, port, Arc::clone(&emit))?);
            match view.open(width, height, dpr, last_agent.as_deref()) {
                Ok(()) => Ok(view),
                Err(e) => {
                    view.close();
                    Err(e)
                }
            }
        });
        let installed = started.and_then(|view| {
            before_install(&view);
            let mut panel = lock(&entry.view);
            // `Entry::close` marks the slot closed before it takes the view.
            let refused = if entry.slot.closed.load(Ordering::SeqCst) {
                Some("browser closed")
            } else if panel.generation != generation {
                Some(PANEL_CLOSED)
            } else {
                None
            };
            if let Some(refused) = refused {
                drop(panel);
                view.close();
                return Err(refused.to_owned());
            }
            let replaced = panel.view.replace(Arc::clone(&view)); // the slot and this scope both hold it
            if let Some(target) = &panel.last_agent_target {
                view.follow_agent(target); // a report that came in while the view opened
            }
            drop(panel);
            if let Some(replaced) = replaced {
                replaced.close(); // a concurrent open of the same session
            }
            Ok(())
        });
        match &installed {
            // The panel was closed meanwhile: the closed view said `idle`.
            Err(e) if e != PANEL_CLOSED => {
                let mut state = ViewState::new(Status::Error);
                state.error = Some(e.clone()); // the state event and the caller each own it
                emit.state(session_id, &state);
            }
            _ => {}
        }
        installed
    }

    /// Close the session's panel view; Chromium keeps running. An open still
    /// in flight does not install its view afterwards.
    pub fn close_panel(&self, session_id: &str) -> Result<(), String> {
        let view = lock(&self.entry(session_id)?.view).close();
        if let Some(view) = view {
            view.close();
        }
        Ok(())
    }

    /// The session's open view.
    pub fn panel(&self, session_id: &str) -> Result<Arc<View>, String> {
        lock(&self.entry(session_id)?.view)
            .view
            .as_ref()
            .map(Arc::clone)
            .ok_or_else(|| "panel not open".to_owned())
    }

    /// The page the proxy last reported for the session.
    #[cfg(test)]
    pub(super) fn last_agent_target_for_test(&self, session_id: &str) -> Option<String> {
        lock(&self.entry(session_id).ok()?.view)
            .last_agent_target
            .clone()
    }
}

async fn blocking<T: Send + 'static>(
    work: impl FnOnce() -> Result<T, String> + Send + 'static,
) -> Result<T, String> {
    tauri::async_runtime::spawn_blocking(work)
        .await
        .map_err(|e| format!("join error: {e}"))?
}

/// Run `action` on the session's open view, off the IPC thread.
async fn with_view<T: Send + 'static>(
    app: AppHandle,
    session_id: String,
    action: impl FnOnce(&View) -> Result<T, String> + Send + 'static,
) -> Result<T, String> {
    blocking(move || {
        let view = app.state::<BrowserManager>().panel(&session_id)?;
        action(&view)
    })
    .await
}

#[tauri::command]
pub async fn browser_open_panel(
    session_id: String,
    width: u32,
    height: u32,
    dpr: f64,
    app: AppHandle,
) -> Result<(), String> {
    blocking(move || {
        // The emitter keeps its own handle for the view's threads.
        let emit = Arc::new(TauriBrowserEmit(app.clone()));
        app.state::<BrowserManager>()
            .open_panel(&session_id, width, height, dpr, emit)
    })
    .await
}

#[tauri::command]
pub async fn browser_close_panel(session_id: String, app: AppHandle) -> Result<(), String> {
    blocking(move || app.state::<BrowserManager>().close_panel(&session_id)).await
}

#[tauri::command]
pub async fn browser_resize(
    session_id: String,
    width: u32,
    height: u32,
    dpr: f64,
    app: AppHandle,
) -> Result<(), String> {
    with_view(app, session_id, move |v| v.resize(width, height, dpr)).await
}

#[tauri::command]
pub async fn browser_navigate(
    session_id: String,
    url: String,
    app: AppHandle,
) -> Result<(), String> {
    with_view(app, session_id, move |v| v.navigate(&url)).await
}

#[tauri::command]
pub async fn browser_history(session_id: String, delta: i32, app: AppHandle) -> Result<(), String> {
    with_view(app, session_id, move |v| v.history(delta)).await
}

#[tauri::command]
pub async fn browser_tab_new(session_id: String, app: AppHandle) -> Result<(), String> {
    with_view(app, session_id, |v| v.tab_new(None)).await
}

#[tauri::command]
pub async fn browser_tab_close(
    session_id: String,
    target_id: String,
    app: AppHandle,
) -> Result<(), String> {
    with_view(app, session_id, move |v| v.tab_close(&target_id)).await
}

#[tauri::command]
pub async fn browser_tab_activate(
    session_id: String,
    target_id: String,
    app: AppHandle,
) -> Result<(), String> {
    with_view(app, session_id, move |v| v.tab_activate(&target_id)).await
}

/// Synchronous on purpose: it only queues the event, and invocations from
/// the frontend reach the queue in the order they were sent (a `spawn_blocking`
/// per event could reorder a press and its release).
#[tauri::command]
pub fn browser_input(
    session_id: String,
    event: InputEvent,
    browser: State<'_, BrowserManager>,
) -> Result<(), String> {
    browser.panel(&session_id)?.input(&event)
}

#[tauri::command]
pub async fn browser_annotate(session_id: String, on: bool, app: AppHandle) -> Result<(), String> {
    with_view(app, session_id, move |v| v.annotate(on)).await
}

#[tauri::command]
pub async fn browser_capture(
    session_id: String,
    rect: Rect,
    app: AppHandle,
) -> Result<CapturedImage, String> {
    with_view(app, session_id, move |v| v.capture(&rect)).await
}

#[tauri::command]
pub async fn browser_scroll_to(
    session_id: String,
    rect: Rect,
    app: AppHandle,
) -> Result<(), String> {
    with_view(app, session_id, move |v| v.scroll_to(&rect)).await
}

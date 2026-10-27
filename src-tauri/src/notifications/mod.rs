//! Opt-in desktop notifications, driven by the live tracker for every tab.
//! The stdout hook only queues; native delivery runs on a bounded worker.

use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{mpsc, Arc, Mutex, PoisonError};
use std::thread::JoinHandle;

use serde::Deserialize;
use tauri::{AppHandle, Manager, State};
#[cfg(not(target_os = "macos"))]
use tauri_plugin_notification::NotificationExt;

use crate::remote::tracker::{tracker, TrackerSink, Transition};

#[cfg(target_os = "macos")]
mod macos;

#[derive(Clone, Copy, Debug, PartialEq, Eq, serde::Serialize)]
#[serde(rename_all = "lowercase")]
pub enum Permission {
    Granted,
    #[cfg(target_os = "macos")]
    Denied,
    #[cfg(target_os = "macos")]
    Prompt,
}

#[derive(Default, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Configuration {
    finished: bool,
    questions: bool,
    viewed_session: Option<String>,
    tabs: Vec<Tab>,
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct Tab {
    id: String,
    title: String,
}

impl Configuration {
    const fn enabled(&self, transition: Transition) -> bool {
        match transition {
            Transition::QuestionOpened => self.questions,
            Transition::TurnFinished { .. } => self.finished,
        }
    }

    fn notice(
        &self,
        sid: &str,
        transition: Transition,
        live: Option<&(bool, usize)>,
        focused: bool,
    ) -> Option<(&str, &'static str)> {
        if !self.enabled(transition) || (focused && self.viewed_session.as_deref() == Some(sid)) {
            return None;
        }
        let &(busy, questions) = live?;
        let body = match transition {
            Transition::QuestionOpened if questions > 0 => "Your input is needed.",
            Transition::TurnFinished { .. } if !busy && questions == 0 => "Conversation finished.",
            _ => return None,
        };
        let tab = self.tabs.iter().find(|tab| tab.id == sid)?;
        Some((&tab.title, body))
    }
}

struct Pending {
    sid: String,
    transition: Transition,
    revision: u64,
}

#[derive(Default)]
struct Control {
    configuration: Configuration,
    revision: u64,
    sender: Option<mpsc::SyncSender<Pending>>,
}

pub struct Notifications {
    control: Mutex<Control>,
    worker: Mutex<Option<JoinHandle<()>>>,
    focused: AtomicBool,
    remote: Option<Arc<dyn TrackerSink>>,
}

impl Notifications {
    fn channel(remote: Option<Arc<dyn TrackerSink>>) -> (Arc<Self>, mpsc::Receiver<Pending>) {
        let (sender, receiver) = mpsc::sync_channel(32);
        let notifications = Arc::new(Self {
            control: Mutex::new(Control {
                sender: Some(sender),
                ..Control::default()
            }),
            worker: Mutex::new(None),
            focused: AtomicBool::new(false),
            remote,
        });
        (notifications, receiver)
    }

    fn configure(&self, mut configuration: Configuration) -> Result<(), String> {
        if configuration.tabs.len() > 1024
            || configuration
                .tabs
                .iter()
                .any(|tab| tab.id.is_empty() || tab.id.len() > 256)
            || configuration
                .viewed_session
                .as_ref()
                .is_some_and(|id| id.len() > 256)
        {
            return Err("invalid desktop notification tab identity".into());
        }
        for tab in &mut configuration.tabs {
            // Notification titles carry only bounded tab names, never transcript text.
            tab.title
                .truncate(crate::text::prefix_within(&tab.title, 256).len());
            if tab.title.trim().is_empty() {
                "New conversation".clone_into(&mut tab.title);
            }
        }
        let mut control = self.control.lock().unwrap_or_else(PoisonError::into_inner);
        control.revision = control.revision.wrapping_add(1);
        control.configuration = configuration;
        drop(control);
        Ok(())
    }

    fn stop(&self) {
        {
            let mut control = self.control.lock().unwrap_or_else(PoisonError::into_inner);
            control.revision = control.revision.wrapping_add(1);
            control.configuration = Configuration::default();
            control.sender.take();
        }
        let worker = self
            .worker
            .lock()
            .unwrap_or_else(PoisonError::into_inner)
            .take();
        if let Some(worker) = worker {
            let _ = worker.join();
        }
    }

    fn message(
        &self,
        pending: &Pending,
        live: Option<&(bool, usize)>,
        focused: bool,
    ) -> Option<(String, &'static str)> {
        let control = self.control.lock().unwrap_or_else(PoisonError::into_inner);
        if control.revision != pending.revision {
            return None;
        }
        control
            .configuration
            .notice(&pending.sid, pending.transition, live, focused)
            .map(|(title, body)| (format!("OMP · {title}"), body))
    }

    fn deliver(&self, _app: &AppHandle, pending: &Pending) {
        // Native focus events maintain this bit; querying the window here could
        // wait on the main thread while it joins this worker during shutdown.
        let focused = self.focused.load(Ordering::Acquire);
        let snapshot = tracker().snapshot();
        // Release configuration locks before invoking any native/platform API.
        if let Some((title, body)) = self.message(pending, snapshot.get(&pending.sid), focused) {
            #[cfg(target_os = "macos")]
            macos::show(&pending.sid, &title, body);
            #[cfg(not(target_os = "macos"))]
            if let Err(error) = _app.notification().builder().title(title).body(body).show() {
                eprintln!("[notifications] could not submit desktop notification: {error}");
            }
        }
    }
}

impl TrackerSink for Notifications {
    fn changed(&self, sid: &str, transition: Option<Transition>) {
        if let Some(remote) = &self.remote {
            remote.changed(sid, transition);
        }
        let Some(transition) = transition else { return };
        // Configuration or delivery must never stall an agent's stdout reader.
        let Ok(control) = self.control.try_lock() else {
            return;
        };
        if !control.configuration.enabled(transition) {
            return;
        }
        if let Some(sender) = &control.sender {
            // A full queue drops this alert rather than delaying agent stdout.
            let _ = sender.try_send(Pending {
                sid: sid.to_owned(),
                transition,
                revision: control.revision,
            });
        }
    }
}

#[tauri::command]
pub fn desktop_notifications_configure(
    configuration: Configuration,
    notifications: State<'_, Arc<Notifications>>,
) -> Result<(), String> {
    notifications.configure(configuration)
}

/// A read never prompts; only the Settings enable action requests permission.
#[tauri::command]
pub async fn desktop_notifications_permission(request: bool) -> Result<Permission, String> {
    #[cfg(target_os = "macos")]
    return macos::permission(request).await;
    #[cfg(not(target_os = "macos"))]
    {
        // Windows/Linux have no equivalent per-app authorization popup.
        // Their notification settings remain authoritative over delivery.
        let _ = request;
        Ok(Permission::Granted)
    }
}

pub fn install(app: &tauri::App, remote: Option<Arc<dyn TrackerSink>>) {
    #[cfg(target_os = "macos")]
    macos::install();
    let (notifications, receiver) = Notifications::channel(remote);
    notifications.focused.store(
        app.get_webview_window("main")
            .is_some_and(|window| window.is_focused().unwrap_or(false)),
        Ordering::Release,
    );
    let weak = Arc::downgrade(&notifications);
    let handle = app.handle().clone(); // The worker needs an app handle until explicit shutdown.
    match std::thread::Builder::new()
        .name("desktop-notifications".into())
        .spawn(move || {
            while let Ok(pending) = receiver.recv() {
                let Some(notifications) = weak.upgrade() else {
                    break;
                };
                notifications.deliver(&handle, &pending);
            }
        }) {
        Ok(worker) => {
            *notifications
                .worker
                .lock()
                .unwrap_or_else(PoisonError::into_inner) = Some(worker);
        }
        Err(error) => {
            eprintln!("[notifications] could not start desktop notification worker: {error}");
        }
    }
    // The tracker keeps the dispatcher alive; the app owns its shutdown handle.
    tracker().set_sink(Arc::clone(&notifications) as Arc<dyn TrackerSink>);
    app.manage(notifications);
}

pub fn focus_changed(app: &AppHandle, focused: bool) {
    if let Some(notifications) = app.try_state::<Arc<Notifications>>() {
        notifications.focused.store(focused, Ordering::Release);
    }
}

pub fn reset(app: &AppHandle) {
    if let Some(notifications) = app.try_state::<Arc<Notifications>>() {
        let _ = notifications.configure(Configuration::default());
    }
}

pub fn stop(app: &AppHandle) {
    if let Some(notifications) = app.try_state::<Arc<Notifications>>() {
        notifications.stop();
    }
}

#[cfg(test)]
mod tests;

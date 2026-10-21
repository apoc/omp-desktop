//! Web Push to the paired phones when a tab asks a question or finishes a
//! long turn. The tracker's reader thread only enqueues; a worker thread
//! encrypts and POSTs, so neither the reader nor the hub ever waits on a
//! push service.

use std::collections::HashMap;
use std::sync::mpsc::{self, Receiver, SyncSender, TrySendError};
use std::sync::{Arc, Mutex, PoisonError};
use std::time::{Duration, Instant};

use serde_json::json;

use super::devices::DeviceStore;
use super::lock::screen_locked;
use super::push_contact::contact_uri;
use super::push_crypto::Vapid;
use super::push_send::send;
use super::push_subs::endpoint_ok;
use super::settings::PushSettings;
use super::tracker::{TrackerSink, Transition};

const QUEUE: usize = 32;
const THROTTLE: Duration = Duration::from_secs(30);
/// Shorter turns finish while the user is most likely still looking.
const MIN_TURN: Duration = Duration::from_secs(30);
const REQUEST_TIMEOUT: Duration = Duration::from_secs(10);
const MAX_TITLE_CHARS: usize = 80;

/// Why a phone is being told something.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Kind {
    Question,
    Finished,
}

impl Kind {
    const fn body(self) -> &'static str {
        match self {
            Self::Question => "Question waiting",
            Self::Finished => "Finished",
        }
    }

    /// A question blocks the agent; a finished turn can wait.
    const fn urgency(self) -> &'static str {
        match self {
            Self::Question => "high",
            Self::Finished => "normal",
        }
    }
}

/// The title of a tab, looked up when a trigger fires.
pub type TitleOf = Arc<dyn Fn(&str) -> Option<String> + Send + Sync>;
/// Called after the last push error changed, so the status can follow.
pub type OnChange = Arc<dyn Fn() + Send + Sync>;

struct Message {
    tab: String,
    title: String,
    body: &'static str,
    urgency: &'static str,
    /// When the throttle slot for `tab` was taken.
    queued_at: Instant,
}

enum Job {
    Notify(Message),
    Test(SyncSender<Result<(), String>>),
}

struct Shared {
    dir: std::path::PathBuf,
    devices: Arc<DeviceStore>,
    settings: Mutex<PushSettings>,
    vapid: Mutex<Option<Arc<Vapid>>>,
    error: Mutex<Option<String>>,
    changed: OnChange,
    /// Checked before every send; tests swap it to reach a local server.
    endpoint_ok: fn(&str) -> bool,
    /// Read by the worker right before a trigger push is delivered.
    lock_probe: fn() -> Option<bool>,
    /// When each tab last had a push queued, for the per-tab throttle.
    last_sent: Mutex<HashMap<String, Instant>>,
}

fn locked<T>(mutex: &Mutex<T>) -> std::sync::MutexGuard<'_, T> {
    mutex.lock().unwrap_or_else(PoisonError::into_inner)
}

impl Shared {
    fn set_error(&self, error: Option<String>) {
        let differs = {
            let mut slot = locked(&self.error);
            let differs = *slot != error;
            *slot = error;
            differs
        };
        if differs {
            (self.changed)();
        }
    }

    /// "Only while locked" is on and the desktop is known to be unlocked.
    fn skip_while_unlocked(&self) -> bool {
        // Read the flag first: the probe asks WindowServer and must not run
        // under the settings lock that `changed`, `configure` and `test` take.
        let only_when_locked = locked(&self.settings).only_when_locked;
        only_when_locked && (self.lock_probe)() == Some(false)
    }

    /// Give `tab` its throttle slot back after a push was dropped, unless a
    /// newer push has taken it since.
    fn release_throttle(&self, tab: &str, queued_at: Instant) {
        let mut sent = locked(&self.last_sent);
        if sent.get(tab) == Some(&queued_at) {
            sent.remove(tab);
        }
    }
}

pub struct Pusher {
    shared: Arc<Shared>,
    titles: TitleOf,
    tx: SyncSender<Job>,
}

impl Pusher {
    /// `dir` is the app config dir that holds the VAPID key.
    pub fn new(
        dir: std::path::PathBuf,
        devices: Arc<DeviceStore>,
        titles: TitleOf,
        changed: OnChange,
    ) -> Self {
        Self::with_probes(dir, devices, titles, changed, endpoint_ok, screen_locked)
    }

    fn with_probes(
        dir: std::path::PathBuf,
        devices: Arc<DeviceStore>,
        titles: TitleOf,
        changed: OnChange,
        endpoint_ok: fn(&str) -> bool,
        lock_probe: fn() -> Option<bool>,
    ) -> Self {
        let shared = Arc::new(Shared {
            dir,
            devices,
            settings: Mutex::new(PushSettings::default()),
            vapid: Mutex::new(None),
            error: Mutex::new(None),
            changed,
            endpoint_ok,
            lock_probe,
            last_sent: Mutex::new(HashMap::new()),
        });
        let (tx, rx) = mpsc::sync_channel(QUEUE);
        let worker = Arc::clone(&shared);
        let spawned = std::thread::Builder::new()
            .name("remote-push".to_owned())
            .spawn(move || work(&worker, &rx));
        if let Err(error) = spawned {
            eprintln!("[omp-desktop] could not start the push worker: {error}");
        }
        Self { shared, titles, tx }
    }

    /// Apply the push settings; returns the public key phones subscribe
    /// with while push is on and the key is usable.
    pub fn configure(&self, settings: &PushSettings) -> Option<String> {
        if !settings.enabled {
            *locked(&self.shared.settings) = settings.clone(); // the worker reads its own copy
            self.shared.set_error(None);
            return None;
        }
        let key = {
            // One lock for check and create: no second key can be written.
            let mut slot = locked(&self.shared.vapid);
            if slot.is_none() {
                match Vapid::load_or_create(&self.shared.dir) {
                    Ok(vapid) => *slot = Some(Arc::new(vapid)),
                    Err(error) => {
                        drop(slot);
                        *locked(&self.shared.settings) = settings.clone(); // the worker reads its own copy
                        self.shared.set_error(Some(error));
                        return None;
                    }
                }
            }
            slot.as_ref().map(|vapid| vapid.public_b64.clone()) // returned to the caller
        };
        *locked(&self.shared.settings) = settings.clone(); // the worker reads its own copy
        self.shared.set_error(contact_uri(&settings.contact).err());
        key
    }

    pub fn last_error(&self) -> Option<String> {
        locked(&self.shared.error).clone() // owned snapshot for the status
    }

    /// Queue a push for `tab`; at most one per tab every 30 s.
    pub fn notify(&self, tab: &str, title: &str, kind: Kind) {
        let now = Instant::now();
        let mut sent = locked(&self.shared.last_sent);
        if sent
            .get(tab)
            .is_some_and(|last| now.saturating_duration_since(*last) < THROTTLE)
        {
            return;
        }
        let title = if title.is_empty() {
            "OMP".to_owned()
        } else {
            let shown: String = title.chars().take(MAX_TITLE_CHARS).collect();
            format!("OMP \u{b7} {shown}")
        };
        let job = Job::Notify(Message {
            tab: tab.to_owned(),
            title,
            body: kind.body(),
            urgency: kind.urgency(),
            queued_at: now,
        });
        match self.tx.try_send(job) {
            Ok(()) => {
                if sent.len() >= QUEUE * 2 {
                    sent.retain(|_, last| now.saturating_duration_since(*last) < THROTTLE);
                }
                sent.insert(tab.to_owned(), now);
                drop(sent);
            }
            Err(TrySendError::Full(_)) => eprintln!("[omp-desktop] push queue full; dropped"),
            Err(TrySendError::Disconnected(_)) => {}
        }
    }

    /// Send "Test notification" to every subscription of every device and
    /// wait for the outcome.
    pub fn test(&self) -> Result<(), String> {
        if !locked(&self.shared.settings).enabled {
            return Err("push notifications are off".to_owned());
        }
        let subscriptions: usize = self
            .shared
            .devices
            .list()
            .iter()
            .map(|device| device.push.len())
            .sum();
        // Sends are sequential, each bounded by the timeout; account for any
        // jobs already queued ahead of the test in the channel.
        let batches = u32::try_from(QUEUE + 1)
            .unwrap_or(u32::MAX)
            .saturating_mul(u32::try_from(subscriptions.max(1)).unwrap_or(u32::MAX));
        let wait = REQUEST_TIMEOUT.saturating_mul(batches);
        let (reply, outcome) = mpsc::sync_channel(1);
        self.tx
            .try_send(Job::Test(reply))
            .map_err(|_| "the push queue is busy".to_owned())?;
        outcome
            .recv_timeout(wait)
            .map_err(|_| "the push test did not finish".to_owned())?
    }
}

impl TrackerSink for Pusher {
    fn changed(&self, sid: &str, transition: Option<Transition>) {
        let kind = match transition {
            Some(Transition::QuestionOpened) => Kind::Question,
            Some(Transition::TurnFinished { ran }) if ran >= MIN_TURN => Kind::Finished,
            _ => return,
        };
        {
            let settings = locked(&self.shared.settings);
            let wanted = match kind {
                Kind::Question => settings.questions,
                Kind::Finished => settings.finished,
            };
            if !settings.enabled || !wanted {
                return;
            }
        }
        let title = (self.titles)(sid).unwrap_or_default();
        self.notify(sid, &title, kind);
    }
}

fn work(shared: &Shared, jobs: &Receiver<Job>) {
    // Explicit, so TLS never depends on which provider the tree enabled.
    let _ = rustls::crypto::ring::default_provider().install_default();
    let client = reqwest::blocking::Client::builder()
        .timeout(REQUEST_TIMEOUT)
        .redirect(reqwest::redirect::Policy::none())
        .build()
        .map_err(|error| format!("push client: {error}"));
    while let Ok(job) = jobs.recv() {
        let (payload, urgency, reply) = match job {
            Job::Notify(message) => {
                if shared.skip_while_unlocked() {
                    shared.release_throttle(&message.tab, message.queued_at);
                    continue;
                }
                (
                    json!({
                        "title": message.title, "body": message.body,
                        "tag": message.tab, "tab": message.tab,
                    }),
                    message.urgency,
                    None,
                )
            }
            Job::Test(reply) => (
                json!({
                    "title": "OMP", "body": "Test notification", "tag": "test", "tab": "",
                }),
                "high",
                Some(reply),
            ),
        };
        let result = client
            .as_ref()
            .map_err(Clone::clone)
            .and_then(|client| deliver(shared, client, payload.to_string().as_bytes(), urgency));
        if let Err(error) = &result {
            eprintln!("[omp-desktop] push failed: {error}");
        }
        shared.set_error(result.clone().err());
        if let Some(reply) = reply {
            let _ = reply.send(result.and_then(|sent| {
                if sent == 0 {
                    Err("no device has push notifications enabled".to_owned())
                } else {
                    Ok(())
                }
            }));
        }
    }
}

/// Send to every subscription; the number delivered, or the first failure.
fn deliver(
    shared: &Shared,
    client: &reqwest::blocking::Client,
    payload: &[u8],
    urgency: &str,
) -> Result<usize, String> {
    let settings = locked(&shared.settings).clone(); // the worker owns its copy
    if !settings.enabled {
        return Ok(0);
    }
    let contact = contact_uri(&settings.contact)?;
    let vapid = locked(&shared.vapid)
        .clone() // shared with the settings thread
        .ok_or("push is not configured")?;
    let mut sent = 0;
    let mut failure = None;
    for device in shared.devices.list() {
        for sub in &device.push {
            if !locked(&shared.settings).enabled {
                return Ok(sent);
            }
            if !(shared.endpoint_ok)(&sub.endpoint) {
                forget(shared, &device.id, &sub.endpoint);
                continue;
            }
            // Revoked or unsubscribed while this batch ran: nothing goes out.
            if !shared.devices.has_push(&device.id, &sub.endpoint) {
                continue;
            }
            match send(client, &vapid, &contact, sub, payload, urgency) {
                Ok(200..=299) => sent += 1,
                Ok(404 | 410) => forget(shared, &device.id, &sub.endpoint),
                Ok(status) => {
                    failure.get_or_insert_with(|| format!("push service answered {status}"));
                }
                Err(error) => {
                    failure.get_or_insert(error);
                }
            }
        }
    }
    failure.map_or(Ok(sent), Err)
}

/// The subscription is gone for good: drop it from its device.
fn forget(shared: &Shared, device_id: &str, endpoint: &str) {
    match shared.devices.remove_push(device_id, endpoint) {
        Ok(true) => (shared.changed)(),
        Ok(false) => {}
        Err(error) => eprintln!("[omp-desktop] could not drop a push subscription: {error}"),
    }
}

#[cfg(test)]
#[path = "push_tests.rs"]
mod tests;

//! Internal state of [`super::Hub`]: active sockets, published tabs/view/theme,
//! pending actions, and change tracking for the desktop webview.

use std::collections::{HashMap, HashSet};
use std::net::{Shutdown, TcpStream};
use std::sync::mpsc::{SyncSender, TrySendError};

use serde_json::{json, Value};

use super::actions::Pending;
use super::{Out, TabMeta};
use crate::remote::tracker::tracker;

pub(super) struct Entry {
    pub device_id: String,
    pub tx: SyncSender<Out>,
    /// The raw socket, to cut it when the hub gives up on the connection.
    pub tcp: Option<TcpStream>,
}

#[derive(Default)]
pub(super) struct State {
    pub next_conn: u64,
    pub next_action: u64,
    pub ready: bool,
    /// Bumped by `close_all`: a connection of an older server generation is
    /// refused at `register`.
    pub generation: u64,
    pub conns: HashMap<u64, Entry>,
    /// Devices revoked while this hub runs: a socket that authenticated just
    /// before is refused at `register` without asking the store under the lock.
    pub revoked: HashSet<String>,
    pub tabs: Vec<TabMeta>,
    pub view: Option<Value>,
    pub theme: Option<Value>,
    /// Merged tabs as last broadcast; unchanged tabs are not re-sent.
    pub sent_tabs: Value,
    /// The VAPID public key phones subscribe with, while push is on.
    pub push_key: Option<String>,
    pub watched: Vec<String>,
    pub connected: Vec<String>,
    pub pending: HashMap<String, Pending>,
}

/// What changed for the webview while the state was locked.
pub(super) struct Changes {
    pub watch: Option<Vec<String>>,
    pub connected: Option<Vec<String>>,
}

impl State {
    pub(super) fn merged_tabs(&self) -> Value {
        let live = tracker().snapshot();
        let tabs: Vec<Value> = self
            .tabs
            .iter()
            .map(|tab| {
                let (busy, asks) = live
                    .sessions
                    .get(&tab.id)
                    .map_or((false, 0), |s| (s.busy, s.asks));
                json!({
                    "id": tab.id, "title": tab.title, "project": tab.project,
                    "busy": busy, "hasAsk": asks > 0,
                })
            })
            .collect();
        Value::Array(tabs)
    }

    pub(super) fn send(&mut self, conn: u64, out: Out) {
        let Some(entry) = self.conns.get(&conn) else {
            return;
        };
        match entry.tx.try_send(out) {
            Ok(()) => {}
            Err(TrySendError::Full(_) | TrySendError::Disconnected(_)) => self.remove(conn),
        }
    }

    pub(super) fn broadcast(&mut self, text: &str) {
        let mut dropped = false;
        self.conns.retain(|_, entry| {
            if entry.tx.try_send(Out::Text(text.to_owned())).is_ok() {
                true
            } else {
                if let Some(tcp) = entry.tcp.take() {
                    let _ = tcp.shutdown(Shutdown::Both);
                }
                dropped = true;
                false
            }
        });
        if dropped {
            self.pending
                .retain(|_, pending| self.conns.contains_key(&pending.conn));
        }
    }

    /// Forget the registration and physically cut the socket. Dropping only
    /// the sender cannot interrupt a reader stuck inside an incomplete frame.
    pub(super) fn remove(&mut self, conn: u64) {
        if let Some(tcp) = self.conns.remove(&conn).and_then(|entry| entry.tcp) {
            let _ = tcp.shutdown(Shutdown::Both);
        }
        self.pending.retain(|_, pending| pending.conn != conn);
    }

    /// Queue a close frame and forget the connection: it gets no more
    /// messages and its late actions are ignored.
    pub(super) fn close(&mut self, conn: u64, code: u16) {
        self.send(conn, Out::Close(code));
        self.remove(conn);
    }

    pub(super) fn close_all(&mut self, code: u16) {
        for (_, entry) in self.conns.drain() {
            let _ = entry.tx.try_send(Out::Close(code));
            if let Some(tcp) = entry.tcp {
                let _ = tcp.shutdown(Shutdown::Both);
            }
        }
        self.pending.clear();
    }

    /// Broadcast the merged tab list if it differs from the last one sent.
    pub(super) fn sync_tabs(&mut self) {
        let merged = self.merged_tabs();
        if merged != self.sent_tabs {
            let text = json!({ "t": "tabs", "tabs": merged }).to_string();
            self.sent_tabs = merged;
            self.broadcast(&text);
        }
    }

    pub(super) fn connected_devices(&self) -> Vec<String> {
        let mut ids: Vec<String> = self
            .conns
            .values()
            .map(|entry| entry.device_id.clone()) // owned for the caller
            .collect();
        ids.sort();
        ids.dedup();
        ids
    }

    /// Watch list and connected devices, each when it differs from the last
    /// one handed out.
    pub(super) fn take_changes(&mut self) -> Changes {
        let connected = self.connected_devices();
        let connected_change = (connected != self.connected).then(|| {
            self.connected.clone_from(&connected);
            connected
        });
        let ids: Vec<String> = if self.conns.is_empty() {
            Vec::new()
        } else {
            // Owned ids for the emit call made after the lock is released.
            self.tabs.iter().map(|tab| tab.id.clone()).collect()
        };
        let watch = (ids != self.watched).then(|| {
            // The hub keeps its own copy to detect the next change.
            self.watched.clone_from(&ids);
            ids
        });
        Changes {
            watch,
            connected: connected_change,
        }
    }
}

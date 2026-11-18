//! Paired devices in `remote-devices.json`; bearer tokens never reach disk.

use std::fs;
use std::path::PathBuf;
use std::sync::{Mutex, MutexGuard, PoisonError};
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

use serde::{Deserialize, Serialize};

use super::rand::{ct_eq, random_b64};
use super::tls::write_private;
use omp_desktop_core::json_store;

const LAST_SEEN_INTERVAL: Duration = Duration::from_secs(60);
/// The phone sends the first 120 characters of its user agent; longer names
/// are cut, not refused, and empty names are rejected.
pub const MAX_DEVICE_NAME_CHARS: usize = 64;

pub fn normalize_device_name(name: &str) -> Result<String, String> {
    let name: String = name.trim().chars().take(MAX_DEVICE_NAME_CHARS).collect();
    if name.is_empty() {
        return Err("device name is empty".to_owned());
    }
    Ok(name)
}

#[derive(Serialize, Deserialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct Device {
    pub id: String,
    pub name: String,
    pub token_hash: String,
    pub paired_at: u64,
    pub last_seen: u64,
    #[serde(default)]
    pub push: Vec<PushSubscription>,
}

#[derive(Serialize, Deserialize, Clone, PartialEq, Eq)]
pub struct PushSubscription {
    pub endpoint: String,
    pub p256dh: String,
    pub auth: String,
}

pub struct DeviceStore {
    path: PathBuf,
    lock: PathBuf,
    inner: Mutex<Vec<Device>>,
    // Separate from last_seen: authentication refreshes memory on every call,
    // but persistence is throttled by a monotonic clock for the whole store.
    last_persisted: Mutex<Instant>,
}

impl DeviceStore {
    pub fn load(path: PathBuf) -> Self {
        let devices = json_store::read_or_default(&path);
        Self {
            lock: path.with_extension("lock"),
            path,
            inner: Mutex::new(devices),
            last_persisted: Mutex::new(Instant::now()),
        }
    }

    fn devices(&self) -> MutexGuard<'_, Vec<Device>> {
        self.inner.lock().unwrap_or_else(PoisonError::into_inner)
    }

    pub fn add(&self, name: &str) -> Result<(Device, String), String> {
        let name = normalize_device_name(name)?;
        let id = random_b64(9)?;
        let token = random_b64(32)?;
        let now = unix_seconds();
        let device = Device {
            id,
            name,
            token_hash: json_store::hex_sha256(token.as_bytes()),
            paired_at: now,
            last_seen: now,
            push: Vec::new(),
        };
        let mut cache = self.devices();
        self.update(&mut cache, Instant::now(), |devices| {
            // The caller gets device metadata; the store retains its own copy.
            devices.push(device.clone());
            Ok(())
        })?;
        Ok((device, token))
    }

    pub fn authenticate(&self, token: &str) -> Option<Device> {
        self.authenticate_at(token, unix_seconds(), Instant::now())
    }

    fn authenticate_at(&self, token: &str, now: u64, clock: Instant) -> Option<Device> {
        let hash = json_store::hex_sha256(token.as_bytes());
        let mut devices = self.devices();
        let mut matched = None;
        // Do not stop at the first mismatch or match.
        for (index, device) in devices.iter().enumerate() {
            if ct_eq(hash.as_bytes(), device.token_hash.as_bytes()) {
                matched = Some(index);
            }
        }
        let index = matched?;
        devices[index].last_seen = now;
        // The connection owns its snapshot even if a flush refreshes the cache.
        let device = devices[index].clone();
        let last_persisted = *self
            .last_persisted
            .lock()
            .unwrap_or_else(PoisonError::into_inner);
        let result = if clock.saturating_duration_since(last_persisted) >= LAST_SEEN_INTERVAL {
            self.update(&mut devices, clock, |_| Ok(()))
        } else {
            Ok(())
        };
        drop(devices);
        if let Err(error) = result {
            // Metadata persistence must not reject a valid bearer token.
            eprintln!("[omp-desktop] could not save remote device last seen: {error}");
        }
        Some(device)
    }

    fn update_device(
        &self,
        id: &str,
        modify: impl FnOnce(&mut Device) -> Result<(), String>,
    ) -> Result<(), String> {
        self.update(&mut self.devices(), Instant::now(), |devices| {
            let device = devices
                .iter_mut()
                .find(|device| device.id == id)
                .ok_or_else(|| "remote device not found".to_string())?;
            modify(device)
        })
    }

    pub fn rename(&self, id: &str, name: &str) -> Result<(), String> {
        let name = normalize_device_name(name)?;
        self.update_device(id, |device| {
            device.name = name;
            Ok(())
        })
    }

    /// False means no durable revocation occurred (unknown id or write error).
    pub fn revoke(&self, id: &str) -> bool {
        self.update(&mut self.devices(), Instant::now(), |devices| {
            let index = devices
                .iter()
                .position(|device| device.id == id)
                .ok_or_else(|| "remote device not found".to_string())?;
            devices.remove(index);
            Ok(())
        })
        .is_ok()
    }

    pub fn add_push(&self, id: &str, sub: PushSubscription, max: usize) -> Result<(), String> {
        self.update_device(id, |device| {
            if let Some(slot) = device
                .push
                .iter_mut()
                .find(|known| known.endpoint == sub.endpoint)
            {
                *slot = sub;
            } else if device.push.len() >= max {
                return Err("too many push subscriptions".to_owned());
            } else {
                device.push.push(sub);
            }
            Ok(())
        })
    }

    pub fn set_push(&self, id: &str, subs: Vec<PushSubscription>) -> Result<(), String> {
        self.update_device(id, |device| {
            device.push = subs;
            Ok(())
        })
    }

    /// Drop one subscription inside the locked update; returns whether one was
    /// actually removed. A missing device is already gone.
    pub fn remove_push(&self, id: &str, endpoint: &str) -> Result<bool, String> {
        let mut removed = false;
        self.update(&mut self.devices(), Instant::now(), |devices| {
            if let Some(device) = devices.iter_mut().find(|device| device.id == id) {
                let before = device.push.len();
                device.push.retain(|sub| sub.endpoint != endpoint);
                removed = device.push.len() != before;
            }
            Ok(())
        })?;
        Ok(removed)
    }

    pub fn list(&self) -> Vec<Device> {
        // IPC/push workers own their snapshots independently of the locked cache.
        self.devices().clone()
    }

    /// Whether `id` is still paired and still holds a subscription for `endpoint`.
    pub fn has_push(&self, id: &str, endpoint: &str) -> bool {
        self.devices()
            .iter()
            .find(|device| device.id == id)
            .is_some_and(|device| device.push.iter().any(|sub| sub.endpoint == endpoint))
    }

    /// Refuse to overwrite an unreadable store; commit memory only after disk.
    fn update(
        &self,
        cache: &mut Vec<Device>,
        clock: Instant,
        modify: impl FnOnce(&mut Vec<Device>) -> Result<(), String>,
    ) -> Result<(), String> {
        if let Some(parent) = self.path.parent().filter(|p| !p.as_os_str().is_empty()) {
            fs::create_dir_all(parent).map_err(|error| error.to_string())?;
        }
        json_store::with_lock_str(&self.lock, || {
            let mut devices: Vec<Device> = json_store::read_strict(&self.path)?;
            for device in &mut devices {
                if let Some(cached) = cache.iter().find(|cached| cached.id == device.id) {
                    device.last_seen = device.last_seen.max(cached.last_seen);
                }
            }
            modify(&mut devices)?;
            self.persist(&devices, clock)?;
            *cache = devices;
            Ok(())
        })
    }

    fn persist(&self, devices: &[Device], clock: Instant) -> Result<(), String> {
        let bytes = serde_json::to_vec_pretty(devices).map_err(|error| error.to_string())?;
        write_private(&self.path, &bytes)?;
        *self
            .last_persisted
            .lock()
            .unwrap_or_else(PoisonError::into_inner) = clock;
        Ok(())
    }
}

pub(super) fn unix_seconds() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_secs()
}

#[cfg(test)]
#[path = "devices_tests.rs"]
mod tests;

//! Startup cancellation is independent of the slow workspace lifecycle guard.
use super::Registry;
use std::collections::HashMap;
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::{Arc, Mutex, MutexGuard, PoisonError, Weak};

pub struct Admission {
    generation: u64,
    cancelled: Arc<AtomicBool>,
}

#[derive(Default)]
pub struct WorkspaceManager {
    pub(super) registry: Mutex<Registry>,
    pending: Mutex<HashMap<String, Weak<AtomicBool>>>,
    generation: AtomicU64,
    closed: AtomicBool,
}

impl WorkspaceManager {
    /// A single guard covers ref checks, any checkout, tab registration and
    /// agent spawn. Close uses the same guard until all children have stopped.
    pub fn lock(&self) -> MutexGuard<'_, Registry> {
        self.registry.lock().unwrap_or_else(PoisonError::into_inner)
    }

    /// Capture admission without waiting for filesystem or lifecycle work.
    /// Starts and shell opens for the same tab share its cancellation flag.
    pub fn ticket(&self, id: &str) -> Result<Admission, String> {
        let mut pending = self.pending.lock().unwrap_or_else(PoisonError::into_inner);
        if self.closed.load(Ordering::SeqCst) {
            return Err("application is shutting down".to_string());
        }
        // The flag and reload generation must be captured under the same lock.
        let generation = self.generation.load(Ordering::SeqCst);
        pending.retain(|_, flag| flag.strong_count() > 0);
        let cancelled = pending.get(id).and_then(Weak::upgrade).unwrap_or_else(|| {
            let flag = Arc::new(AtomicBool::new(false));
            // Weak entries track queued work without retaining completed tab ids.
            pending.insert(id.to_string(), Arc::downgrade(&flag));
            flag
        });
        drop(pending);
        Ok(Admission {
            generation,
            cancelled,
        })
    }

    pub fn check_ticket(&self, ticket: &Admission) -> Result<(), String> {
        if self.closed.load(Ordering::SeqCst)
            || self.generation.load(Ordering::SeqCst) != ticket.generation
            || ticket.cancelled.load(Ordering::SeqCst)
        {
            return Err("session start was cancelled by tab cleanup".to_string());
        }
        Ok(())
    }

    pub fn cancel_pending<S: AsRef<str>>(&self, ids: &[S]) {
        let mut pending = self.pending.lock().unwrap_or_else(PoisonError::into_inner);
        for id in ids {
            if let Some(flag) = pending.remove(id.as_ref()).and_then(|flag| flag.upgrade()) {
                flag.store(true, Ordering::SeqCst);
            }
        }
    }

    pub fn invalidate_pending(&self) {
        let mut pending = self.pending.lock().unwrap_or_else(PoisonError::into_inner);
        self.generation.fetch_add(1, Ordering::SeqCst);
        pending.clear();
    }

    pub fn shutdown(&self) {
        self.closed.store(true, Ordering::SeqCst);
        self.invalidate_pending();
    }
}

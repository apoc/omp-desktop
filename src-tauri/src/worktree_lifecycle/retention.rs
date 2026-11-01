//! One native worker checks expiry without renewing conversation activity.
use std::sync::{Arc, Condvar, Mutex};
use std::thread::{self, JoinHandle};
use std::time::Duration;
use tauri::AppHandle;

pub(super) struct Retention {
    stop: Arc<(Mutex<bool>, Condvar)>,
    thread: Mutex<Option<JoinHandle<()>>>,
}

impl Retention {
    pub fn start(app: AppHandle) -> Self {
        let stop = Arc::new((Mutex::new(false), Condvar::new()));
        // Both controller and worker must wake/observe the same stop signal.
        let signal = Arc::clone(&stop);
        let worker = thread::Builder::new()
            .name("workspace-retention".to_string())
            .spawn(move || {
                // Let the document register restored tabs before the first check.
                let mut delay = Duration::from_secs(60);
                let mut previous_error = None;
                loop {
                    let (lock, wake) = &*signal;
                    let Ok(stopped) = lock.lock() else { break };
                    let Ok((stopped, _)) =
                        wake.wait_timeout_while(stopped, delay, |stopped| !*stopped)
                    else {
                        break;
                    };
                    if *stopped {
                        break;
                    }
                    drop(stopped);
                    let error = super::sweep(&app).err();
                    if error != previous_error {
                        if let Some(error) = &error {
                            eprintln!("[omp-desktop] workspace retention unavailable: {error}");
                        }
                        previous_error = error;
                    }
                    delay = Duration::from_hours(1);
                }
            });
        let worker = match worker {
            Ok(worker) => Some(worker),
            Err(error) => {
                eprintln!("[omp-desktop] workspace retention could not start: {error}");
                None
            }
        };
        Self {
            stop,
            thread: Mutex::new(worker),
        }
    }

    pub fn stop(&self) {
        let (lock, wake) = &*self.stop;
        if let Ok(mut stopped) = lock.lock() {
            *stopped = true;
            wake.notify_all();
        }
        if let Ok(mut worker) = self.thread.lock() {
            if let Some(worker) = worker.take() {
                if worker.join().is_err() {
                    eprintln!("[omp-desktop] workspace retention worker exited unexpectedly");
                }
            }
        }
    }
}

impl Drop for Retention {
    fn drop(&mut self) {
        self.stop();
    }
}

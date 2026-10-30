//! Platform requests are made and released on the same worker thread. They
//! inhibit idle sleep only, not explicit sleep, screen locks, or policy.

pub(super) trait Inhibitor {
    /// Keep ownership on failure so a later transition can retry release.
    fn release(&mut self) -> Result<(), String>;
}

#[cfg(target_os = "macos")]
mod imp {
    use objc2_core_foundation::CFString;

    use super::Inhibitor;

    // IOKit kIOPMAssertionLevelOn, from IOPMLib.h.
    const ASSERTION_LEVEL_ON: u32 = 255;

    #[link(name = "IOKit", kind = "framework")]
    extern "C" {
        fn IOPMAssertionCreateWithName(
            kind: *const CFString,
            level: u32,
            name: *const CFString,
            id: *mut u32,
        ) -> i32;
        fn IOPMAssertionRelease(id: u32) -> i32;
    }

    pub struct Native {
        display: Option<u32>,
        idle: Option<u32>,
    }

    fn create(kind: &'static str) -> Result<u32, String> {
        let kind = CFString::from_static_str(kind);
        let reason = CFString::from_static_str("OMP Desktop agent work");
        let mut id = 0;
        // SAFETY: Both CFStrings and the output pointer live through the synchronous IOKit call.
        let status = unsafe {
            IOPMAssertionCreateWithName(
                &raw const *kind,
                ASSERTION_LEVEL_ON,
                &raw const *reason,
                &raw mut id,
            )
        };
        if status == 0 {
            Ok(id)
        } else {
            Err(format!("IOKit assertion failed: {status:#x}"))
        }
    }

    fn release_one(id: &mut Option<u32>) -> Result<(), String> {
        if let Some(value) = *id {
            // SAFETY: This assertion ID was created by this process and has not been released.
            let status = unsafe { IOPMAssertionRelease(value) };
            if status != 0 {
                return Err(format!("IOKit assertion release failed: {status:#x}"));
            }
            *id = None;
        }
        Ok(())
    }

    impl Native {
        pub fn acquire() -> Result<Self, String> {
            let mut native = Self {
                display: None,
                idle: None,
            };
            native.display = Some(create("PreventUserIdleDisplaySleep")?);
            let idle =
                create("PreventUserIdleSystemSleep").map_err(|error| match native.release() {
                    Ok(()) => error,
                    Err(cleanup) => format!("{error}; partial assertion cleanup failed: {cleanup}"),
                })?;
            native.idle = Some(idle);
            Ok(native)
        }
    }

    impl Inhibitor for Native {
        fn release(&mut self) -> Result<(), String> {
            let display = release_one(&mut self.display);
            let idle = release_one(&mut self.idle);
            display.and(idle)
        }
    }

    impl Drop for Native {
        fn drop(&mut self) {
            let _ = self.release();
        }
    }
}

#[cfg(target_os = "windows")]
mod imp {
    use windows_sys::Win32::System::Power::{
        SetThreadExecutionState, ES_CONTINUOUS, ES_DISPLAY_REQUIRED, ES_SYSTEM_REQUIRED,
    };

    use super::Inhibitor;

    pub struct Native {
        previous: Option<u32>,
    }

    impl Native {
        pub fn acquire() -> Result<Self, String> {
            // SAFETY: The flags are valid and this worker thread also restores its execution state.
            let previous = unsafe {
                SetThreadExecutionState(ES_CONTINUOUS | ES_DISPLAY_REQUIRED | ES_SYSTEM_REQUIRED)
            };
            if previous == 0 {
                Err(format!(
                    "SetThreadExecutionState failed: {}",
                    std::io::Error::last_os_error()
                ))
            } else {
                Ok(Self {
                    previous: Some(previous),
                })
            }
        }
    }

    impl Inhibitor for Native {
        fn release(&mut self) -> Result<(), String> {
            if let Some(previous) = self.previous {
                // SAFETY: `previous` came from the successful call on this same worker thread.
                if unsafe { SetThreadExecutionState(previous | ES_CONTINUOUS) } == 0 {
                    return Err(format!(
                        "SetThreadExecutionState release failed: {}",
                        std::io::Error::last_os_error()
                    ));
                }
                self.previous = None;
            }
            Ok(())
        }
    }

    impl Drop for Native {
        fn drop(&mut self) {
            let _ = self.release();
        }
    }
}

#[cfg(target_os = "linux")]
mod imp {
    use std::future::Future;
    use std::time::Duration;

    use zbus::{connection::Builder, zvariant::OwnedFd, Connection, Proxy};

    use super::Inhibitor;

    const REASON: &str = "OMP Desktop agent work";
    const SCREEN_SERVICE: &str = "org.freedesktop.ScreenSaver";
    const SCREEN_PATH: &str = "/org/freedesktop/ScreenSaver";
    const LOGIN_SERVICE: &str = "org.freedesktop.login1";
    const LOGIN_PATH: &str = "/org/freedesktop/login1";
    const TIMEOUT: Duration = Duration::from_secs(3);

    // Cover connection establishment and authentication as well as each
    // method call: zbus's method_timeout alone does not bound the handshake.
    fn timed<T>(operation: &str, work: impl Future<Output = zbus::Result<T>>) -> Result<T, String> {
        timed_for(operation, work, TIMEOUT)
    }

    fn timed_for<T>(
        operation: &str,
        work: impl Future<Output = zbus::Result<T>>,
        timeout: Duration,
    ) -> Result<T, String> {
        async_io::block_on(futures_lite::future::or(
            async { work.await.map_err(|error| format!("{operation}: {error}")) },
            async {
                async_io::Timer::after(timeout).await;
                Err(format!("{operation} timed out"))
            },
        ))
    }

    pub struct Native {
        session: Option<Connection>,
        cookie: Option<u32>,
        system: Option<Connection>,
        idle: Option<OwnedFd>,
    }

    impl Native {
        fn cleanup_error(&mut self, error: String) -> String {
            match self.release() {
                Ok(()) => error,
                Err(cleanup) => format!("{error}; partial inhibition cleanup failed: {cleanup}"),
            }
        }

        pub fn acquire() -> Result<Self, String> {
            let mut native = Self {
                session: None,
                cookie: None,
                system: None,
                idle: None,
            };
            let session = timed("session D-Bus", async {
                Builder::session()?.method_timeout(TIMEOUT).build().await
            })?;
            let cookie: u32 = timed("display inhibition", async {
                let screen =
                    Proxy::new(&session, SCREEN_SERVICE, SCREEN_PATH, SCREEN_SERVICE).await?;
                screen.call("Inhibit", &("com.omp.desktop", REASON)).await
            })?;
            native.session = Some(session);
            native.cookie = Some(cookie);
            let system = timed("system D-Bus", async {
                Builder::system()?.method_timeout(TIMEOUT).build().await
            })
            .map_err(|error| native.cleanup_error(error))?;
            let idle: OwnedFd = timed("idle inhibition", async {
                let login = Proxy::new(
                    &system,
                    LOGIN_SERVICE,
                    LOGIN_PATH,
                    "org.freedesktop.login1.Manager",
                )
                .await?;
                login
                    .call("Inhibit", &("idle", "OMP Desktop", REASON, "block"))
                    .await
            })
            .map_err(|error| native.cleanup_error(error))?;
            native.system = Some(system);
            native.idle = Some(idle);
            Ok(native)
        }
    }

    impl Inhibitor for Native {
        fn release(&mut self) -> Result<(), String> {
            if let (Some(session), Some(cookie)) = (&self.session, self.cookie) {
                timed("display inhibition release", async {
                    let screen =
                        Proxy::new(session, SCREEN_SERVICE, SCREEN_PATH, SCREEN_SERVICE).await?;
                    screen.call::<_, _, ()>("UnInhibit", &(cookie,)).await
                })?;
                self.cookie = None;
            }
            // Dropping the fd releases logind's idle inhibitor.
            self.idle.take();
            self.session.take();
            self.system.take();
            Ok(())
        }
    }

    impl Drop for Native {
        fn drop(&mut self) {
            // Disconnect even if the desktop service is gone; its cookie is
            // scoped to this D-Bus connection and logind's fd closes on drop.
            let _ = self.release();
        }
    }

    #[cfg(test)]
    #[test]
    fn timeout_bounds_an_unresponsive_bus_operation() {
        let started = std::time::Instant::now();
        let result = timed_for(
            "bus",
            std::future::pending::<zbus::Result<()>>(),
            Duration::from_millis(20),
        );
        assert!(result.unwrap_err().contains("timed out"));
        assert!(started.elapsed() < Duration::from_secs(5));
    }
}

#[cfg(not(any(target_os = "macos", target_os = "windows", target_os = "linux")))]
mod imp {
    use super::Inhibitor;
    pub struct Native;
    impl Native {
        pub fn acquire() -> Result<Self, String> {
            Err("idle inhibition is unsupported on this platform".into())
        }
    }
    impl Inhibitor for Native {
        fn release(&mut self) -> Result<(), String> {
            Ok(())
        }
    }
}

pub(super) fn acquire() -> Result<impl Inhibitor, String> {
    imp::Native::acquire()
}

//! Helpers the test suites of several modules share.

use std::path::Path;
use std::sync::Arc;
use std::time::{Duration, Instant};

// Also used by `omp-desktop-core`'s own suites: one copy there, re-exported
// here so existing `crate::test_support::…` call sites stay unchanged.
pub use omp_desktop_core::test_support::{executable, tempdir, TempDir};

/// Poll `check` every 10 ms until it returns `Some`, for at most `timeout`.
pub fn eventually<T>(timeout: Duration, mut check: impl FnMut() -> Option<T>) -> Option<T> {
    let deadline = Instant::now() + timeout;
    loop {
        if let Some(found) = check() {
            return Some(found);
        }
        if Instant::now() >= deadline {
            return None;
        }
        std::thread::sleep(Duration::from_millis(10));
    }
}

/// Poll `condition` until it holds (`true`) or `timeout` passes (`false`).
pub fn wait_until(timeout: Duration, mut condition: impl FnMut() -> bool) -> bool {
    eventually(timeout, || condition().then_some(())).is_some()
}

/// `script` run by the platform shell: `cmd /C` on Windows, `sh -c` on unix.
pub fn shell(script: &str) -> std::process::Command {
    let (program, flag) = if cfg!(windows) {
        ("cmd", "/C")
    } else {
        ("sh", "-c")
    };
    let mut cmd = std::process::Command::new(program);
    cmd.args([flag, script]);
    cmd
}

/// A TLS client that trusts only the certificate in `cert_pem`, the one the
/// remote server generated for the test.
pub fn tls_client_config(cert_pem: &Path) -> Arc<rustls::ClientConfig> {
    use rustls::pki_types::{pem::PemObject, CertificateDer};
    let pem = std::fs::read(cert_pem).unwrap();
    let mut roots = rustls::RootCertStore::empty();
    roots
        .add(CertificateDer::from_pem_slice(&pem).unwrap())
        .unwrap();
    Arc::new(
        rustls::ClientConfig::builder_with_provider(Arc::new(
            rustls::crypto::ring::default_provider(),
        ))
        .with_safe_default_protocol_versions()
        .unwrap()
        .with_root_certificates(roots)
        .with_no_client_auth(),
    )
}

use std::io::{BufRead, BufReader, Write};
use std::process::{Child, Command, Stdio};
use std::sync::{Arc, Mutex};
use std::thread;
use tauri::{AppHandle, Emitter};

struct BridgeInner {
    stdin: Option<std::process::ChildStdin>,
    child: Option<Child>,
}

pub struct AgentBridge {
    inner: Arc<Mutex<BridgeInner>>,
}

impl AgentBridge {
    pub fn new() -> Self {
        Self {
            inner: Arc::new(Mutex::new(BridgeInner {
                stdin: None,
                child: None,
            })),
        }
    }

    pub fn start(&self, app: AppHandle) -> Result<(), String> {
        // Kill any process left over from a previous start (hot-reload safety).
        self.stop_inner();

        let mut child = spawn_omp()?;

        let stdin  = child.stdin.take().expect("stdin piped");
        let stdout = child.stdout.take().expect("stdout piped");
        let stderr = child.stderr.take().expect("stderr piped");

        {
            let mut g = self.inner.lock().unwrap();
            g.stdin = Some(stdin);
            g.child = Some(child);
        }

        let inner_out = self.inner.clone();
        let app_out   = app.clone();
        thread::spawn(move || {
            let reader = BufReader::new(stdout);
            for line in reader.lines() {
                match line {
                    Ok(l) if !l.trim().is_empty() => {
                        app_out.emit("agent://line", l).ok();
                    }
                    Ok(_) => {}   // blank line — skip, keep reading
                    Err(_) => break, // IO error — process exited
                }
            }
            // Clear the child handle so Drop doesn't try to kill an already-dead process.
            if let Ok(mut g) = inner_out.lock() {
                g.child = None;
                g.stdin = None;
            }
            app_out.emit("agent://exit", ()).ok();
        });

        thread::spawn(move || {
            let reader = BufReader::new(stderr);
            for line in reader.lines() {
                if let Ok(l) = line {
                    eprintln!("[omp] {l}");
                }
            }
        });

        Ok(())
    }

    /// Kill the managed child process and close its stdin.
    pub fn stop(&self) {
        self.stop_inner();
    }

    fn stop_inner(&self) {
        if let Ok(mut g) = self.inner.lock() {
            g.stdin = None; // close stdin first (signals EOF to omp)
            if let Some(mut child) = g.child.take() {
                child.kill().ok();
                child.wait().ok(); // reap so it doesn't linger as a zombie
            }
        }
    }

    pub fn send(&self, line: &str) -> Result<(), String> {
        let mut g = self.inner.lock().map_err(|_| "lock poisoned".to_string())?;
        match g.stdin.as_mut() {
            Some(stdin) => writeln!(stdin, "{line}").map_err(|e| e.to_string()),
            None        => Err("agent not running".to_string()),
        }
    }
}

impl Drop for AgentBridge {
    fn drop(&mut self) {
        self.stop_inner();
    }
}

fn spawn_omp() -> Result<Child, String> {
    let try_direct = Command::new("omp")
        .args(["--mode", "rpc"])
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn();

    if let Ok(child) = try_direct {
        return Ok(child);
    }

    #[cfg(target_os = "windows")]
    {
        return Command::new("cmd")
            .args(["/C", "omp", "--mode", "rpc"])
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .spawn()
            .map_err(|e| format!("failed to spawn omp: {e}"));
    }

    #[allow(unreachable_code)]
    Err("omp not found in PATH.".to_string())
}

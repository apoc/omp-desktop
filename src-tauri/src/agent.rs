use std::collections::HashMap;
use std::io::{BufRead, BufReader, Write};
use std::process::{Child, Command, Stdio};
use std::sync::{Arc, Mutex};
use std::thread;
use tauri::{AppHandle, Emitter};

struct BridgeInner {
    stdin: Option<std::process::ChildStdin>,
    child: Option<Child>,
}

/// Manages one omp process per tab session.
/// Events are emitted as "agent://line/{session_id}" and "agent://exit/{session_id}".
pub struct AgentBridge {
    sessions: Arc<Mutex<HashMap<String, BridgeInner>>>,
}

impl AgentBridge {
    pub fn new() -> Self {
        Self {
            sessions: Arc::new(Mutex::new(HashMap::new())),
        }
    }

    /// Spawn omp for a new session. If a session with this ID already exists it is
    /// killed first (hot-reload / restart safety).
    pub fn start_session(
        &self,
        session_id: String,
        cwd: Option<String>,
        app: AppHandle,
    ) -> Result<(), String> {
        self.stop_session_inner(&session_id);

        let mut child = spawn_omp(cwd.as_deref())?;

        let stdin  = child.stdin.take().expect("stdin piped");
        let stdout = child.stdout.take().expect("stdout piped");
        let stderr = child.stderr.take().expect("stderr piped");

        {
            let mut sessions = self.sessions.lock().unwrap();
            sessions.insert(
                session_id.clone(),
                BridgeInner { stdin: Some(stdin), child: Some(child) },
            );
        }

        // Stdout reader — emits "agent://line/{session_id}" for each JSON line
        let sessions_out  = self.sessions.clone();
        let sid_out       = session_id.clone();
        let app_out       = app.clone();
        thread::spawn(move || {
            let reader     = BufReader::new(stdout);
            let line_event = format!("agent://line/{sid_out}");
            let exit_event = format!("agent://exit/{sid_out}");
            for line in reader.lines() {
                match line {
                    Ok(l) if !l.trim().is_empty() => {
                        app_out.emit(&line_event, l).ok();
                    }
                    Ok(_)  => {}          // blank line — skip
                    Err(_) => break,      // IO error — process exited
                }
            }
            // Clear handles so send() fails cleanly after process death
            if let Ok(mut sessions) = sessions_out.lock() {
                if let Some(inner) = sessions.get_mut(&sid_out) {
                    inner.stdin = None;
                    inner.child = None;
                }
            }
            app_out.emit(&exit_event, ()).ok();
        });

        // Stderr reader — logs to terminal only
        let sid_err = session_id.clone();
        thread::spawn(move || {
            let reader = BufReader::new(stderr);
            for line in reader.lines() {
                if let Ok(l) = line {
                    eprintln!("[omp/{sid_err}] {l}");
                }
            }
        });

        Ok(())
    }

    pub fn stop_session(&self, session_id: &str) {
        self.stop_session_inner(session_id);
    }

    pub fn send(&self, session_id: &str, line: &str) -> Result<(), String> {
        let mut sessions = self.sessions.lock().map_err(|_| "lock poisoned".to_string())?;
        match sessions.get_mut(session_id) {
            Some(inner) => match inner.stdin.as_mut() {
                Some(stdin) => writeln!(stdin, "{line}").map_err(|e| e.to_string()),
                None        => Err("agent not running".to_string()),
            },
            None => Err(format!("session '{session_id}' not found")),
        }
    }

    fn stop_session_inner(&self, session_id: &str) {
        if let Ok(mut sessions) = self.sessions.lock() {
            if let Some(mut inner) = sessions.remove(session_id) {
                inner.stdin = None;
                if let Some(mut child) = inner.child.take() {
                    child.kill().ok();
                    child.wait().ok();
                }
            }
        }
    }
}

impl Drop for AgentBridge {
    fn drop(&mut self) {
        if let Ok(mut sessions) = self.sessions.lock() {
            for (_, mut inner) in sessions.drain() {
                inner.stdin = None;
                if let Some(mut child) = inner.child.take() {
                    child.kill().ok();
                    child.wait().ok();
                }
            }
        }
    }
}

fn spawn_omp(cwd: Option<&str>) -> Result<Child, String> {
    let mut cmd = Command::new("omp");
    cmd.args(["--mode", "rpc"])
       .stdin(Stdio::piped())
       .stdout(Stdio::piped())
       .stderr(Stdio::piped());
    if let Some(dir) = cwd {
        if !dir.is_empty() {
            cmd.current_dir(dir);
        }
    }

    if let Ok(child) = cmd.spawn() {
        return Ok(child);
    }

    #[cfg(target_os = "windows")]
    {
        let mut cmd2 = Command::new("cmd");
        cmd2.args(["/C", "omp", "--mode", "rpc"])
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped());
        if let Some(dir) = cwd {
            if !dir.is_empty() {
                cmd2.current_dir(dir);
            }
        }
        return cmd2.spawn()
            .map_err(|e| format!("failed to spawn omp: {e}"));
    }

    #[allow(unreachable_code)]
    Err("omp not found in PATH.".to_string())
}

use omp_desktop_core::child_path::{child_path_dirs, locate_program};
use omp_desktop_core::json_store::write_atomic;
use omp_desktop_core::persona_protocol::{read_line_capped, LineRead};
use omp_desktopd::{
    core::Core,
    paths::{ensure_private_dir, pipe_name, socket_name, Paths},
    scheduler::Now,
    server::{Server, StartError},
    session::Launch,
};
use std::io::{BufReader, Write};
use std::process::ExitCode;

const EXTENSION: &str = include_str!("../persona/extension.mjs");
const INSTRUCTIONS: &str = include_str!("../persona/instructions.md");

fn main() -> ExitCode {
    let cmd = std::env::args().nth(1).unwrap_or_else(|| "run".into());
    let result = match cmd.as_str() {
        "run" => run(),
        "status" => status(),
        "install" => std::env::current_exe()
            .map_err(|e| e.to_string())
            .and_then(|exe| omp_desktopd::autostart::install(&exe)),
        "uninstall" => omp_desktopd::autostart::uninstall(),
        other => Err(format!(
            "unknown command `{other}`; use run, status, install or uninstall"
        )),
    };
    match result {
        Ok(()) => ExitCode::SUCCESS,
        Err(e) => {
            eprintln!("omp-desktopd: {e}");
            ExitCode::FAILURE
        }
    }
}

fn run() -> Result<(), String> {
    let paths = Paths::resolve()?;
    ensure_private_dir(&paths.persona).map_err(|e| e.to_string())?;
    let ext = paths.persona.join("extension.mjs");
    if !paths.instructions.exists() {
        std::fs::write(&paths.instructions, INSTRUCTIONS).map_err(|e| e.to_string())?;
    }
    let omp = locate_program(&child_path_dirs(), "omp")?;
    let home = dirs::home_dir().ok_or("no home directory")?;
    let socket_env = if cfg!(windows) {
        format!(r"\\.\pipe\{}", pipe_name())
    } else {
        paths.socket.display().to_string()
    };
    // The core event channel is unbounded on purpose: every producer is
    // already byte-bounded before it queues (per-connection outbound queues
    // drop a client over 32 MiB, and the session replay ring is byte-bounded
    // at 8 MiB), so the queue only holds short-lived references. Bounding it
    // here could stall the omp stdout reader on a full channel and, with it,
    // omp itself — the one thing the queue limits must never do.
    let (tx, rx) = std::sync::mpsc::channel();
    let _server = match Server::start(&paths, tx.clone()) {
        Ok(s) => s,
        Err(StartError::AlreadyRunning) => {
            eprintln!("omp-desktopd: already running");
            return Ok(());
        }
        Err(StartError::Io(e)) => return Err(e),
    };
    write_atomic(&ext, EXTENSION.as_bytes()).map_err(|e| e.to_string())?;
    let launch = Launch {
        program: omp.binary,
        home,
        // Core retains `paths`, so Launch owns its own copies of these paths.
        sessions: paths.sessions.clone(),
        extension: ext,
        instructions: paths.instructions.clone(),
        socket_env,
        env: vec![],
    };
    let core = Core::new(
        paths,
        launch,
        Box::new(|| {
            let now = chrono::Local::now();
            Now {
                utc_ms: now.timestamp_millis(),
                local: now.naive_local(),
            }
        }),
    );
    core.run(rx, tx);
    Ok(())
}

fn status_data(reply: &serde_json::Value) -> Result<&serde_json::Value, String> {
    if reply["ok"] == false {
        return Err(reply["error"]
            .as_str()
            .unwrap_or("status request failed")
            .to_owned());
    }
    Ok(&reply["data"])
}

fn status() -> Result<(), String> {
    use interprocess::local_socket::{prelude::*, Stream};

    let paths = Paths::resolve()?;
    let stream = Stream::connect(socket_name(&paths).map_err(|e| e.to_string())?)
        .map_err(|_| "not running".to_owned())?;
    let mut reader = BufReader::new(stream);
    reader.get_mut().write_all(
        b"{\"req\":0,\"type\":\"hello\",\"protocol\":1,\"client\":\"app\"}\n{\"req\":1,\"type\":\"status\"}\n",
    ).map_err(|e| e.to_string())?;
    let mut buf = Vec::new();
    loop {
        match read_line_capped(&mut reader, &mut buf).map_err(|e| e.to_string())? {
            LineRead::Line => {
                let value: serde_json::Value =
                    serde_json::from_slice(&buf).map_err(|e| e.to_string())?;
                if value["type"] == "reply" && value["req"] == 1 {
                    let pretty = serde_json::to_string_pretty(status_data(&value)?)
                        .map_err(|e| e.to_string())?;
                    println!("{pretty}");
                    return Ok(());
                }
            }
            _ => return Err("service closed the connection".into()),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn failed_status_reply_returns_service_error() {
        let reply = json!({"type":"reply","req":1,"ok":false,"error":"daemon busy"});
        assert_eq!(status_data(&reply), Err("daemon busy".to_owned()));
    }

    #[test]
    fn successful_status_reply_returns_data() {
        let reply = json!({"type":"reply","req":1,"ok":true,"data":{"state":"running"}});
        assert_eq!(status_data(&reply), Ok(&json!({"state":"running"})));
    }
}

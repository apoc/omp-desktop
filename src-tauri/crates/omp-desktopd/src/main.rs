use omp_desktop_core::json_store::write_atomic;
use omp_desktop_core::persona_paths::{ensure_private_dir, socket_name, Paths};
use omp_desktop_core::persona_protocol::{read_line_capped, LineRead};
use omp_desktopd::{
    core::Core,
    scheduler::Now,
    server::{Server, StartError},
    session::{Launch, ProgramSource},
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
        "restart" => std::env::current_exe()
            .map_err(|e| e.to_string())
            .and_then(|exe| omp_desktopd::autostart::restart(&exe)),
        "uninstall" => omp_desktopd::autostart::uninstall(),
        other => Err(format!(
            "unknown command `{other}`; use run, status, install, restart or uninstall"
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
    // `status` and `install` keep console output; `run` is normally started by
    // the logon task and must not leave a console window behind. The binary
    // stays console-subsystem so those two commands work from a terminal.
    #[cfg(windows)]
    detach_own_console();
    let paths = Paths::resolve()?;
    ensure_private_dir(&paths.persona).map_err(|e| e.to_string())?;
    let ext = paths.persona.join("extension.mjs");
    if !paths.instructions.exists() {
        std::fs::write(&paths.instructions, INSTRUCTIONS).map_err(|e| e.to_string())?;
    }
    let home = dirs::home_dir().ok_or("no home directory")?;
    #[cfg(windows)]
    let socket_env = format!(
        r"\\.\pipe\{}",
        omp_desktop_core::persona_paths::pipe_name().map_err(|e| e.to_string())?
    );
    #[cfg(not(windows))]
    let socket_env = paths.socket.display().to_string();
    // The core event channel is unbounded on purpose. Client traffic is
    // byte-bounded per connection before it is queued (inbound and outbound
    // both drop the client over 32 MiB), so that producer cannot grow the
    // queue. Session events are not bounded here: a queued event owns its
    // frame, so replay-ring eviction cannot free it, and the rate follows
    // omp's own output. Bounding the channel could stall the omp stdout
    // reader on a full queue and, with it, omp itself — the one thing the
    // queue limits must never do.
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
        program: ProgramSource::Locate("omp".into()),
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

/// Detaches from a console window this process owns alone.
///
/// A `Hidden` logon task still gives a console-subsystem binary a fresh
/// console. `GetConsoleProcessList` counts the processes attached to it; a
/// count of one means nobody else loses output when this process detaches. A
/// terminal launch shares the console with the shell, so it is left alone.
#[cfg(windows)]
fn detach_own_console() {
    use windows_sys::Win32::System::Console::{FreeConsole, GetConsoleProcessList};

    let mut pids = [0u32; 2];
    // SAFETY: the pointer and count describe this local buffer.
    let attached = unsafe { GetConsoleProcessList(pids.as_mut_ptr(), pids.len() as u32) };
    if attached == 1 {
        // SAFETY: no other process is attached to this console.
        unsafe {
            FreeConsole();
        }
    }
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

use omp_desktop_core::child_path::{child_path_dirs, locate_program};
use omp_desktop_core::persona_protocol::{read_line_capped, LineRead};
use omp_desktopd::{
    core::Core,
    paths::{ensure_private_dir, socket_name, Paths},
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
    std::fs::write(&ext, EXTENSION).map_err(|e| e.to_string())?;
    if !paths.instructions.exists() {
        std::fs::write(&paths.instructions, INSTRUCTIONS).map_err(|e| e.to_string())?;
    }
    let omp = locate_program(&child_path_dirs(), "omp")?;
    let home = dirs::home_dir().ok_or("no home directory")?;
    let socket_env = if cfg!(windows) {
        format!(
            r"\\.\pipe\omp-desktopd-{}",
            std::env::var("USERNAME").unwrap_or_default()
        )
    } else {
        paths.socket.display().to_string()
    };
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
    let (tx, rx) = std::sync::mpsc::channel();
    let _server = match Server::start(&paths, tx.clone()) {
        Ok(s) => s,
        Err(StartError::AlreadyRunning) => {
            eprintln!("omp-desktopd: already running");
            return Ok(());
        }
        Err(StartError::Io(e)) => return Err(e),
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
                    let pretty =
                        serde_json::to_string_pretty(&value["data"]).map_err(|e| e.to_string())?;
                    println!("{pretty}");
                    return Ok(());
                }
            }
            _ => return Err("service closed the connection".into()),
        }
    }
}

//! Local socket server: one thread accepts, one reader thread and one
//! writer thread per connection. Parsed messages go to the core; the core
//! answers through the connection's [`Outbound`] sender.
use crate::core::CoreMsg;
use crate::paths::{ensure_private_dir, socket_name, Paths};
use interprocess::local_socket::{prelude::*, ListenerOptions, Stream};
use omp_desktop_core::persona_protocol::{
    read_line_capped, write_msg, ClientKind, ClientMsg, Envelope, LineRead, ServerMsg, PROTOCOL,
};
use std::io::{self, BufReader, Read, Write};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::mpsc::{self, Sender};
use std::sync::Arc;

pub type ConnId = u64;
pub type Outbound = Sender<ServerMsg>;

#[derive(Debug)]
pub struct Inbound {
    pub conn: ConnId,
    pub req: Option<u64>,
    pub client: ClientKind,
    pub msg: ClientMsg,
}

#[derive(Debug)]
pub enum StartError {
    AlreadyRunning,
    Io(String),
}

pub struct Server {
    _accept: std::thread::JoinHandle<()>,
}

static NEXT_CONN: AtomicU64 = AtomicU64::new(1);

/// Errors after the handshake go through the writer thread, so replies keep
/// their line order.
fn send_err(out: &Sender<ServerMsg>, error: &str) {
    let _ = out.send(ServerMsg::Reply {
        req: 0,
        ok: false,
        data: None,
        error: Some(error.into()),
    });
}

fn reply_err(out: &mut impl Write, req: Option<u64>, error: &str) {
    let _ = write_msg(
        out,
        &ServerMsg::Reply {
            req: req.unwrap_or(0),
            ok: false,
            data: None,
            error: Some(error.into()),
        },
    );
}

impl Server {
    /// Binds the socket and starts accepting clients.
    ///
    /// # Errors
    ///
    /// Returns [`StartError::AlreadyRunning`] when another instance answers
    /// on the socket, and [`StartError::Io`] when the socket cannot be bound
    /// or the accept thread cannot be started.
    pub fn start(paths: &Paths, to_core: Sender<CoreMsg>) -> Result<Self, StartError> {
        ensure_private_dir(&paths.persona).map_err(|e| StartError::Io(e.to_string()))?;
        let name = socket_name(paths).map_err(|e| StartError::Io(e.to_string()))?;
        if Stream::connect(name.clone()).is_ok() {
            return Err(StartError::AlreadyRunning);
        }
        #[cfg(unix)]
        let _ = std::fs::remove_file(&paths.socket);
        let listener = ListenerOptions::new()
            .name(name)
            .create_sync()
            .map_err(|e| StartError::Io(e.to_string()))?;
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            std::fs::set_permissions(&paths.socket, std::fs::Permissions::from_mode(0o600))
                .map_err(|e| StartError::Io(e.to_string()))?;
        }
        let accept = std::thread::Builder::new()
            .name("ompy-accept".into())
            .spawn(move || {
                for conn in listener.incoming().flatten() {
                    let to_core = to_core.clone();
                    let _ = std::thread::Builder::new()
                        .name("ompy-conn".into())
                        .spawn(move || serve(conn, to_core));
                }
            })
            .map_err(|e| StartError::Io(e.to_string()))?;
        Ok(Self { _accept: accept })
    }
}

/// `&Stream` implements `Read` and `Write`; `split` is deprecated, so the
/// reader and writer threads share one `Arc<Stream>` through this adapter.
struct Shared(Arc<Stream>);

impl Read for Shared {
    fn read(&mut self, buf: &mut [u8]) -> io::Result<usize> {
        let mut stream: &Stream = &self.0;
        stream.read(buf)
    }
}

impl Write for Shared {
    fn write(&mut self, buf: &[u8]) -> io::Result<usize> {
        let mut stream: &Stream = &self.0;
        stream.write(buf)
    }

    fn flush(&mut self) -> io::Result<()> {
        let mut stream: &Stream = &self.0;
        stream.flush()
    }
}

#[allow(clippy::needless_pass_by_value)] // Moved into the connection thread; a reference cannot cross that boundary.
fn serve(conn: Stream, to_core: Sender<CoreMsg>) {
    let id = NEXT_CONN.fetch_add(1, Ordering::Relaxed);
    let conn = Arc::new(conn);
    let mut reader = BufReader::new(Shared(Arc::clone(&conn)));
    let mut writer = Shared(conn);
    let mut buf = Vec::new();
    // Handshake before the writer thread exists.
    let client = match read_line_capped(&mut reader, &mut buf) {
        Ok(LineRead::Line) => match serde_json::from_slice::<Envelope<ClientMsg>>(&buf) {
            Ok(Envelope {
                req,
                body: ClientMsg::Hello { protocol, client },
            }) => {
                if protocol != PROTOCOL {
                    reply_err(&mut writer, req, "protocol 1 required");
                    return;
                }
                if write_msg(&mut writer, &ServerMsg::Hello { protocol: PROTOCOL }).is_err() {
                    return;
                }
                client
            }
            Ok(Envelope { req, .. }) => {
                reply_err(&mut writer, req, "hello first");
                return;
            }
            Err(e) => {
                reply_err(&mut writer, None, &e.to_string());
                return;
            }
        },
        _ => return,
    };
    let (out_tx, out_rx) = mpsc::channel::<ServerMsg>();
    let _ = std::thread::Builder::new()
        .name("ompy-write".into())
        .spawn(move || {
            for msg in out_rx {
                if write_msg(&mut writer, &msg).is_err() {
                    break;
                }
            }
        });
    if to_core
        .send(CoreMsg::Connected {
            conn: id,
            out: out_tx.clone(),
            client,
        })
        .is_err()
    {
        return;
    }
    loop {
        match read_line_capped(&mut reader, &mut buf) {
            Ok(LineRead::Line) => match serde_json::from_slice::<Envelope<ClientMsg>>(&buf) {
                Ok(Envelope { req, body }) => {
                    if to_core
                        .send(CoreMsg::Inbound(Inbound {
                            conn: id,
                            req,
                            client,
                            msg: body,
                        }))
                        .is_err()
                    {
                        break;
                    }
                }
                Err(e) => send_err(&out_tx, &e.to_string()),
            },
            Ok(LineRead::TooLong) => send_err(&out_tx, "line too long"),
            _ => break,
        }
    }
    let _ = to_core.send(CoreMsg::Disconnected(id));
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::paths::Paths;
    use interprocess::local_socket::Stream;
    use omp_desktop_core::persona_protocol::{read_line_capped, LineRead};
    use std::io::{BufReader, Write};
    use std::sync::mpsc;
    use std::time::Duration;

    /// Short temp root: a unix socket path may not exceed the 104 bytes of
    /// `sun_path`, and the per-user `TMPDIR` plus a descriptive test name
    /// does not fit.
    fn temp_paths(tag: &str) -> Paths {
        #[cfg(unix)]
        let root = std::path::Path::new("/tmp").join(format!("ompy6-{tag}-{}", std::process::id()));
        #[cfg(not(unix))]
        let root = omp_desktop_core::test_support::tempdir("omp-desktopd", tag);
        let _ = std::fs::remove_dir_all(&root);
        Paths::under(&root)
    }

    fn line(r: &mut BufReader<Stream>) -> serde_json::Value {
        let mut buf = Vec::new();
        assert!(matches!(
            read_line_capped(r, &mut buf).unwrap(),
            LineRead::Line
        ));
        serde_json::from_slice(&buf).unwrap()
    }

    #[cfg_attr(windows, ignore = "user-wide pipe name")]
    #[test]
    fn second_instance_is_refused() {
        let p = temp_paths("single");
        let (tx, _rx) = mpsc::channel();
        let _a = Server::start(&p, tx.clone()).unwrap();
        assert!(matches!(
            Server::start(&p, tx),
            Err(StartError::AlreadyRunning)
        ));
    }

    #[cfg_attr(windows, ignore = "user-wide pipe name")]
    #[test]
    fn hello_is_required_and_unknown_message_keeps_connection() {
        let p = temp_paths("hello");
        let (tx, rx) = mpsc::channel();
        let _s = Server::start(&p, tx).unwrap();
        let s = Stream::connect(crate::paths::socket_name(&p).unwrap()).unwrap();
        let mut r = BufReader::new(s);
        r.get_mut()
            .write_all(b"{\"req\":1,\"type\":\"hello\",\"protocol\":1,\"client\":\"app\"}\n")
            .unwrap();
        assert_eq!(line(&mut r)["type"], "hello");
        // Core sees `Connected`; `hello` itself does not reach it.
        assert!(matches!(
            rx.recv_timeout(Duration::from_secs(2)).unwrap(),
            crate::core::CoreMsg::Connected { .. }
        ));
        r.get_mut().write_all(b"{\"type\":\"nope\"}\n").unwrap();
        let err = line(&mut r);
        assert_eq!(
            (err["type"].as_str(), err["ok"].as_bool()),
            (Some("reply"), Some(false))
        );
        r.get_mut()
            .write_all(b"{\"req\":2,\"type\":\"status\"}\n")
            .unwrap();
        assert!(matches!(
            rx.recv_timeout(Duration::from_secs(2)).unwrap(),
            crate::core::CoreMsg::Inbound(_)
        ));
    }

    #[test]
    fn wrong_protocol_closes() {
        let p = temp_paths("proto");
        let (tx, _rx) = mpsc::channel();
        let _s = Server::start(&p, tx).unwrap();
        let s = Stream::connect(crate::paths::socket_name(&p).unwrap()).unwrap();
        let mut r = BufReader::new(s);
        r.get_mut()
            .write_all(b"{\"req\":1,\"type\":\"hello\",\"protocol\":9,\"client\":\"app\"}\n")
            .unwrap();
        assert_eq!(line(&mut r)["error"], "protocol 1 required");
        let mut buf = Vec::new();
        assert!(matches!(
            read_line_capped(&mut r, &mut buf).unwrap(),
            LineRead::Eof
        ));
    }

    #[cfg(unix)]
    #[test]
    fn socket_is_private() {
        use std::os::unix::fs::PermissionsExt;
        let p = temp_paths("perm");
        let (tx, _rx) = mpsc::channel();
        let _s = Server::start(&p, tx).unwrap();
        assert_eq!(
            std::fs::metadata(&p.socket).unwrap().permissions().mode() & 0o777,
            0o600
        );
        assert_eq!(
            std::fs::metadata(&p.persona).unwrap().permissions().mode() & 0o777,
            0o700
        );
    }

    #[cfg(unix)]
    #[test]
    fn stale_socket_file_is_replaced() {
        let p = temp_paths("stale");
        crate::paths::ensure_private_dir(&p.persona).unwrap();
        std::fs::write(&p.socket, b"").unwrap();
        let (tx, _rx) = mpsc::channel();
        assert!(Server::start(&p, tx).is_ok());
    }
}

//! Messages from the socket server to the persona core.

use crate::server::{ConnId, Inbound, Outbound};

/// One event the server hands to the core thread.
pub enum CoreMsg {
    /// A client completed the handshake; `out` writes to that connection.
    Connected { conn: ConnId, out: Outbound },
    /// A parsed client message.
    Inbound(Inbound),
    /// The client closed the connection.
    Disconnected(ConnId),
}

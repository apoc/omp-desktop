//! Incremental decoder of one direction of a WebSocket (RFC 6455 framing):
//! bytes in, complete text messages out. Used by the proxy's
//! [`Tap`](super::tap::Tap), which only reads along.
//!
//! Frames are decoded as they stream by, so a message over the size cap is
//! discarded without being buffered, and decoding stays in sync behind it.
//! Control frames (which may interleave with the fragments of a message) and
//! binary messages are dropped. A stream the decoder cannot follow - broken
//! framing, or an RSV bit that announces a negotiated extension - is
//! [`Lost`].

const OP_CONT: u8 = 0x0;
const OP_TEXT: u8 = 0x1;
const OP_BINARY: u8 = 0x2;
/// Control frames have the high bit of the opcode set.
const OP_CONTROL: u8 = 0x8;
const OP_CLOSE: u8 = 0x8;
const OP_PING: u8 = 0x9;
const OP_PONG: u8 = 0xA;
/// Largest payload of a control frame.
const MAX_CONTROL: u64 = 125;

/// The stream cannot be followed any more.
#[derive(Debug, PartialEq, Eq)]
pub(super) struct Lost;

/// A frame whose header is read; `remaining` payload bytes are to come.
struct Frame {
    opcode: u8,
    fin: bool,
    mask: Option<[u8; 4]>,
    remaining: u64,
    /// Payload bytes of this frame decoded so far, modulo 4 (the mask phase).
    phase: usize,
}

pub(super) struct Messages {
    /// Whether the peer sending this direction must mask (clients do,
    /// servers do not).
    masked: bool,
    max: usize,
    /// The header bytes read so far of the next frame.
    head: Vec<u8>,
    frame: Option<Frame>,
    /// The data message being assembled.
    message: Vec<u8>,
    /// A data message is open: its final fragment has not come yet.
    open: bool,
    /// The open message is not wanted (binary, or over the cap).
    skipping: bool,
}

impl Messages {
    /// A decoder for the client-to-server direction (`from_client`) or the
    /// other; messages over `max` bytes are skipped.
    pub fn new(from_client: bool, max: usize) -> Self {
        Self {
            masked: from_client,
            max,
            head: Vec::with_capacity(14),
            frame: None,
            message: Vec::new(),
            open: false,
            skipping: false,
        }
    }

    /// Decode `bytes`, appending each text message that completes to `out`.
    pub fn feed(&mut self, mut bytes: &[u8], out: &mut Vec<Vec<u8>>) -> Result<(), Lost> {
        while !bytes.is_empty() {
            let Some(mut frame) = self.frame.take() else {
                self.head.push(bytes[0]);
                bytes = &bytes[1..];
                if let Some(frame) = parse_header(&self.head, self.masked)? {
                    self.head.clear();
                    self.start(&frame)?;
                    self.continue_or_end(frame, out);
                }
                continue;
            };
            let take = usize::try_from(frame.remaining).map_or(bytes.len(), |r| r.min(bytes.len()));
            let (chunk, rest) = bytes.split_at(take);
            bytes = rest;
            self.payload(&mut frame, chunk);
            frame.remaining -= chunk.len() as u64;
            self.continue_or_end(frame, out);
        }
        Ok(())
    }

    /// Keep `frame` for its payload, or finish it when none is left.
    fn continue_or_end(&mut self, frame: Frame, out: &mut Vec<Vec<u8>>) {
        if frame.remaining > 0 {
            self.frame = Some(frame);
        } else if frame.opcode < OP_CONTROL && frame.fin {
            self.open = false;
            let message = std::mem::take(&mut self.message);
            if !self.skipping {
                out.push(message);
            }
        }
    }

    /// A frame header is complete: check it fits the message in progress.
    fn start(&mut self, frame: &Frame) -> Result<(), Lost> {
        match frame.opcode {
            OP_CONT if !self.open => Err(Lost),
            OP_TEXT | OP_BINARY if self.open => Err(Lost),
            OP_TEXT | OP_BINARY => {
                self.open = true;
                self.skipping = frame.opcode == OP_BINARY;
                self.message.clear();
                Ok(())
            }
            _ => Ok(()),
        }
    }

    /// Unmask `chunk` of the data frame into the message, unless it is
    /// skipped or grows over the cap.
    fn payload(&mut self, frame: &mut Frame, chunk: &[u8]) {
        if frame.opcode >= OP_CONTROL || self.skipping {
            return;
        }
        if self.message.len() + chunk.len() > self.max {
            self.skipping = true;
            self.message = Vec::new(); // give the memory back
            return;
        }
        let from = self.message.len();
        self.message.extend_from_slice(chunk);
        if let Some(key) = frame.mask {
            for (i, byte) in self.message[from..].iter_mut().enumerate() {
                *byte ^= key[(frame.phase + i) % 4];
            }
        }
        frame.phase = (frame.phase + chunk.len()) % 4;
    }
}

/// The frame whose header is `head`; `None` while `head` is incomplete.
fn parse_header(head: &[u8], masked: bool) -> Result<Option<Frame>, Lost> {
    let [first, second, rest @ ..] = head else {
        return Ok(None);
    };
    if first & 0x70 != 0 {
        return Err(Lost); // an RSV bit: a negotiated extension
    }
    let (fin, opcode) = (first & 0x80 != 0, first & 0x0F);
    if !matches!(
        opcode,
        OP_CONT | OP_TEXT | OP_BINARY | OP_CLOSE | OP_PING | OP_PONG
    ) || (second & 0x80 != 0) != masked
    {
        return Err(Lost);
    }
    let (length, rest) = match second & 0x7F {
        126 => match rest.split_first_chunk::<2>() {
            Some((len, rest)) => (u64::from(u16::from_be_bytes(*len)), rest),
            None => return Ok(None),
        },
        127 => match rest.split_first_chunk::<8>() {
            Some((len, rest)) => {
                let length = u64::from_be_bytes(*len);
                if length >> 63 != 0 {
                    return Err(Lost);
                }
                (length, rest)
            }
            None => return Ok(None),
        },
        short => (u64::from(short), rest),
    };
    if opcode >= OP_CONTROL && (length > MAX_CONTROL || !fin) {
        return Err(Lost);
    }
    let mask = if masked {
        match rest.first_chunk::<4>() {
            Some(key) => Some(*key),
            None => return Ok(None),
        }
    } else {
        None
    };
    Ok(Some(Frame {
        opcode,
        fin,
        mask,
        remaining: length,
        phase: 0,
    }))
}

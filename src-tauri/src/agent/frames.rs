//! Physical stdout lines → the logical RPC frames the reader pipeline runs
//! (#94): protocol-v2 chunk reassembly, lone-surrogate repair, parsing past
//! serde's nesting limit up to [`MAX_FRAME_DEPTH`], and the fixed diagnostic
//! frame that replaces anything unusable.
//!
//! omp splits a logical frame of 1 MiB or more into a run of
//! `{type:"rpc_chunk", chunkId, index, count, byteLength, data}` lines, each
//! carrying at most 256 KiB of the frame's UTF-8 bytes as padded base64, in
//! order and never interleaved with another frame (`encodeChunkedRpcFrames`,
//! `oh-my-pi/packages/coding-agent/src/modes/rpc/rpc-frame.ts` 153-177). The
//! reader rebuilds the frame here before redaction or any consumer sees it, so
//! nothing downstream ever handles an envelope.
//!
//! [`ChunkAssembler`] mirrors omp's own client, `RpcFrameDecoder.push`
//! (rpc-frame.ts 196-248), check for check:
//! - metadata (206-220): `chunkId` a string of 1..=128 UTF-16 units; `index`,
//!   `count`, `byteLength` integers with `0 <= index < count`,
//!   `2 <= count <= 64 MiB / 256 KiB`, `1 MiB <= byteLength <= 64 MiB`;
//! - data (183-193, 222): non-empty canonical padded base64 (no whitespace,
//!   zero trailing bits: omp's regex plus its re-encode round trip), decoding
//!   to at most 256 KiB;
//! - sequence (224-235): a run starts at index 0, indexes are consecutive, and
//!   `chunkId`, `count`, `byteLength` match the run's first chunk;
//! - length (239, 241): the running total never exceeds `byteLength`, and the
//!   final total equals it.
//!
//! The payload checks of 244-246 (strict UTF-8, JSON, an object) are
//! [`logical_frames`]'s. Two differences from omp, both failing closed: an
//! integer must be written as a JSON integer (omp's `Number.isSafeInteger`
//! also takes `2.0`, which `JSON.stringify` never writes), and the bytes land
//! in the buffer only after the length check, so it never grows past
//! `byteLength` (omp appends first, then checks). omp's decoder throws on the
//! first failure; here the run is dropped, one diagnostic is reported, and the
//! failed run's remaining chunks are dropped without one each.

use std::borrow::Cow;

use base64::engine::general_purpose::STANDARD;
use base64::Engine;
use serde_json::Value;

/// omp's `MAX_RPC_FRAME_BYTES`: a smaller frame is never chunked.
const MIN_CHUNKED_BYTES: usize = 1024 * 1024;
/// omp's `MAX_RPC_REASSEMBLED_BYTES`.
const MAX_REASSEMBLED_BYTES: usize = 64 * 1024 * 1024;
/// omp's `RPC_CHUNK_PAYLOAD_BYTES`: decoded bytes per chunk.
const CHUNK_PAYLOAD_BYTES: usize = 256 * 1024;
const MAX_CHUNK_COUNT: u64 = (MAX_REASSEMBLED_BYTES / CHUNK_PAYLOAD_BYTES) as u64;
/// omp bounds `chunkId.length`, which counts UTF-16 code units.
const MAX_CHUNK_ID_UNITS: usize = 128;
/// The shallowest nesting `serde_json`'s default recursion limit refuses: its
/// budget of 128 runs out on the 128th open `[`/`{`.
const SERDE_DEPTH_LIMIT: usize = 128;
/// Deepest nesting of `[`/`{` a frame may have (#94, D94-7). omp and
/// `JSON.parse` take deeper JSON than serde's default (a model's nested
/// tool-call arguments, echoed in `message_end` and every `get_messages`),
/// so such a frame is parsed without serde's limit up to this ceiling; the
/// reader thread's stack is sized for it (`reader::READER_STACK_BYTES`).
pub(super) const MAX_FRAME_DEPTH: usize = 1024;

/// Why a line produced the diagnostic frame instead of itself. The frame
/// carries only this fixed token: no raw bytes, no chunk data, no ids.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(super) enum FrameError {
    /// A chunk failed validation, or a reassembled run its length check.
    ChunkInvalid,
    /// A run was cut short by another line, or by the end of the stream.
    ChunkInterrupted,
    /// A line or reassembled payload that is not JSON (or, for a payload,
    /// not UTF-8 or not an object), even after lone-surrogate repair, or
    /// one nested deeper than [`MAX_FRAME_DEPTH`].
    Unparsable,
}

impl FrameError {
    /// The diagnostic frame's text, journaled and emitted like any line.
    pub(super) const fn text(self) -> &'static str {
        match self {
            Self::ChunkInvalid => r#"{"type":"desktop_frame_error","reason":"chunk_invalid"}"#,
            Self::ChunkInterrupted => {
                r#"{"type":"desktop_frame_error","reason":"chunk_interrupted"}"#
            }
            Self::Unparsable => r#"{"type":"desktop_frame_error","reason":"unparsable"}"#,
        }
    }
}

/// One logical frame for the reader pipeline.
pub(super) enum Logical<'a> {
    /// A parsed frame, not yet redacted. `verbatim` is its exact text when
    /// that may be forwarded unchanged (nothing repaired); `None` means the
    /// text must be re-serialized from `value`.
    Frame {
        value: Value,
        verbatim: Option<Cow<'a, [u8]>>,
    },
    Error(FrameError),
}

/// Turn one physical line (CR/LF stripped, non-empty) into the logical
/// frames it yields, in order: none (a chunk inside a run), one, or two (a
/// line interrupting a run yields the run's diagnostic, then itself).
pub(super) fn logical_frames<'a>(
    assembler: &mut ChunkAssembler,
    line: &'a [u8],
    mut each: impl FnMut(Logical<'a>),
) {
    let parsed = parse(line);
    if let Some((value, _)) = &parsed {
        if is_chunk(value) {
            match assembler.push(value) {
                Push::Pending | Push::Discarded => {}
                Push::Invalid => each(Logical::Error(FrameError::ChunkInvalid)),
                Push::Complete(payload) => each(payload_frame(payload)),
            }
            return;
        }
    }
    if assembler.interrupt() {
        each(Logical::Error(FrameError::ChunkInterrupted));
    }
    each(parsed.map_or(
        Logical::Error(FrameError::Unparsable),
        |(value, repaired)| Logical::Frame {
            value,
            verbatim: (!repaired).then_some(Cow::Borrowed(line)),
        },
    ));
}

/// A reassembled run's bytes as a frame: UTF-8 JSON holding an object
/// (rpc-frame.ts 244-246), lone surrogates repaired as for a line.
fn payload_frame<'a>(payload: Vec<u8>) -> Logical<'a> {
    match parse(&payload) {
        Some((value, repaired)) if value.is_object() => Logical::Frame {
            value,
            verbatim: (!repaired).then_some(Cow::Owned(payload)),
        },
        _ => Logical::Error(FrameError::Unparsable),
    }
}

/// Parse `raw` as JSON. When serde rejects it: once more after
/// [`repair_lone_surrogates`], then (repaired or not) once more without
/// serde's recursion limit when the text nests deeper than that limit allows
/// but no deeper than [`MAX_FRAME_DEPTH`]. Both retries run only on this
/// failure path. The flag says whether the repair was needed.
fn parse(raw: &[u8]) -> Option<(Value, bool)> {
    if let Ok(value) = serde_json::from_slice(raw) {
        return Some((value, false));
    }
    let repaired = repair_lone_surrogates(raw);
    let text = repaired.as_deref().unwrap_or(raw);
    let value = repaired
        .as_ref()
        .and_then(|_| serde_json::from_slice(text).ok())
        .or_else(|| parse_deep(text))?;
    Some((value, repaired.is_some()))
}

/// `raw` parsed without serde's recursion limit, if its nesting is beyond
/// that limit and within [`MAX_FRAME_DEPTH`]; any other text is not retried.
fn parse_deep(raw: &[u8]) -> Option<Value> {
    if !(SERDE_DEPTH_LIMIT..=MAX_FRAME_DEPTH).contains(&max_depth(raw)) {
        return None;
    }
    let mut deserializer = serde_json::Deserializer::from_slice(raw);
    deserializer.disable_recursion_limit();
    let value = serde::Deserialize::deserialize(&mut deserializer).ok()?;
    deserializer.end().ok()?;
    Some(value)
}

/// The deepest nesting of `[`/`{` in `raw`, counting only brackets outside
/// strings. Escape-aware like [`repair_lone_surrogates`], so a `[` or an
/// escaped quote inside a string counts for nothing. Malformed text gets
/// some number; serde then rejects it.
fn max_depth(raw: &[u8]) -> usize {
    let (mut depth, mut max) = (0usize, 0usize);
    let mut in_string = false;
    let mut i = 0;
    while i < raw.len() {
        match (in_string, raw[i]) {
            (_, b'"') => in_string = !in_string,
            // Skip the escaped byte so `\"` never closes the string.
            (true, b'\\') => i += 1,
            (false, b'[' | b'{') => {
                depth += 1;
                max = max.max(depth);
            }
            (false, b']' | b'}') => depth = depth.saturating_sub(1),
            _ => {}
        }
        i += 1;
    }
    max
}

/// Rewrite every `\uD800`-`\uDFFF` escape inside a JSON string that is not
/// half of a valid high+low pair to `\uFFFD`. `JSON.parse` accepts such
/// escapes, so omp can send them; serde rejects them. Escape-aware: an
/// escaped backslash (`\\ud800`) is literal text, and nothing outside a
/// string is touched. `None` when there was nothing to repair.
pub(super) fn repair_lone_surrogates(raw: &[u8]) -> Option<Vec<u8>> {
    let mut out: Option<Vec<u8>> = None;
    let mut copied = 0;
    let mut in_string = false;
    let mut i = 0;
    while i < raw.len() {
        match (in_string, raw[i]) {
            // Opens a string outside one; an unescaped quote closes it.
            (_, b'"') => in_string = !in_string,
            (true, b'\\') => {
                let Some(unit) = escaped_unit(raw, i) else {
                    // Any other escape, `\\` and `\"` included: skip the
                    // escaped byte so it is never read as a quote or an
                    // escape of its own.
                    i += 2;
                    continue;
                };
                let paired = (0xD800..0xDC00).contains(&unit)
                    && escaped_unit(raw, i + 6).is_some_and(|low| (0xDC00..0xE000).contains(&low));
                if paired {
                    i += 12;
                    continue;
                }
                if (0xD800..0xE000).contains(&unit) {
                    let buf = out.get_or_insert_with(|| Vec::with_capacity(raw.len()));
                    buf.extend_from_slice(&raw[copied..i]);
                    buf.extend_from_slice(br"\uFFFD");
                    copied = i + 6;
                }
                i += 6;
                continue;
            }
            _ => {}
        }
        i += 1;
    }
    out.map(|mut buf| {
        buf.extend_from_slice(&raw[copied..]);
        buf
    })
}

/// The code unit of a `\uXXXX` escape starting at `at`, if there is one.
fn escaped_unit(raw: &[u8], at: usize) -> Option<u16> {
    let escape = raw.get(at..at + 6)?;
    if escape[0] != b'\\' || escape[1] != b'u' {
        return None;
    }
    let hex = std::str::from_utf8(&escape[2..]).ok()?;
    u16::from_str_radix(hex, 16)
        .ok()
        .filter(|_| hex.bytes().all(|b| b.is_ascii_hexdigit()))
}

/// omp's `isRpcChunkFrame`: an object whose `type` is `rpc_chunk`.
fn is_chunk(frame: &Value) -> bool {
    frame.get("type").and_then(Value::as_str) == Some("rpc_chunk")
}

/// What [`ChunkAssembler::push`] made of one chunk.
#[derive(Debug, PartialEq, Eq)]
pub(super) enum Push {
    /// Accepted; the run needs more chunks.
    Pending,
    /// The run's last chunk: the logical frame's bytes, not yet checked as
    /// UTF-8, JSON or an object.
    Complete(Vec<u8>),
    /// Failed validation; the open run, if any, is dropped.
    Invalid,
    /// A later chunk of a run that already failed: dropped silently, so one
    /// broken run reports one diagnostic.
    Discarded,
}

/// The run being reassembled.
struct Run {
    chunk_id: String,
    count: u64,
    byte_length: usize,
    next_index: u64,
    bytes: Vec<u8>,
}

/// A chunk's metadata, validated as rpc-frame.ts 206-220 does.
struct Meta<'a> {
    chunk_id: &'a str,
    index: u64,
    count: u64,
    byte_length: usize,
}

impl<'a> Meta<'a> {
    fn of(chunk: &'a Value) -> Option<Self> {
        let chunk_id = chunk.get("chunkId")?.as_str()?;
        let index = chunk.get("index")?.as_u64()?;
        let count = chunk.get("count")?.as_u64()?;
        let byte_length = usize::try_from(chunk.get("byteLength")?.as_u64()?).ok()?;
        (valid_chunk_id(chunk_id)
            && (2..=MAX_CHUNK_COUNT).contains(&count)
            && index < count
            && (MIN_CHUNKED_BYTES..=MAX_REASSEMBLED_BYTES).contains(&byte_length))
        .then_some(Self {
            chunk_id,
            index,
            count,
            byte_length,
        })
    }
}

/// omp bounds `chunkId.length`, which counts UTF-16 code units.
fn valid_chunk_id(id: &str) -> bool {
    let units = id.encode_utf16().take(MAX_CHUNK_ID_UNITS + 1).count();
    (1..=MAX_CHUNK_ID_UNITS).contains(&units)
}

/// Exact decoded size of `data` if it can be canonical padded base64;
/// [`STANDARD`]'s decode checks the alphabet, padding and trailing bits.
fn decoded_len(data: &str) -> Option<usize> {
    let bytes = data.as_bytes();
    if bytes.is_empty() || bytes.len() % 4 != 0 {
        return None;
    }
    let padding = bytes
        .iter()
        .rev()
        .take(2)
        .take_while(|&&b| b == b'=')
        .count();
    Some(bytes.len() / 4 * 3 - padding)
}

/// Rebuilds one protocol-v2 chunk run at a time; see the module doc.
#[derive(Default)]
pub(super) struct ChunkAssembler {
    run: Option<Run>,
    /// The `chunkId` of the run that failed last, whose later chunks
    /// (index above 0) are [`Push::Discarded`]. Cleared by any other line.
    failed: Option<String>,
}

impl ChunkAssembler {
    /// Feed one `rpc_chunk` frame.
    pub(super) fn push(&mut self, chunk: &Value) -> Push {
        let chunk_id = chunk.get("chunkId").and_then(Value::as_str);
        let continues = chunk.get("index").and_then(Value::as_u64) != Some(0);
        if continues && chunk_id.is_some() && chunk_id == self.failed.as_deref() {
            return Push::Discarded;
        }
        self.failed = None;
        self.accept(chunk).unwrap_or_else(|| {
            self.run = None;
            self.failed = chunk_id.filter(|id| valid_chunk_id(id)).map(str::to_owned);
            Push::Invalid
        })
    }

    /// A line that is not a chunk, or the end of the stream: drops the open
    /// run and says whether there was one.
    pub(super) fn interrupt(&mut self) -> bool {
        self.failed = None;
        self.run.take().is_some()
    }

    /// `None` = invalid; the caller drops the run.
    fn accept(&mut self, chunk: &Value) -> Option<Push> {
        let meta = Meta::of(chunk)?;
        let data = chunk.get("data")?.as_str()?;
        let len = decoded_len(data).filter(|&len| len <= CHUNK_PAYLOAD_BYTES)?;
        if self.run.is_none() {
            if meta.index != 0 {
                return None;
            }
            self.run = Some(Run {
                chunk_id: meta.chunk_id.to_owned(),
                count: meta.count,
                byte_length: meta.byte_length,
                next_index: 0,
                // Grown as chunks arrive, never sized from metadata.
                bytes: Vec::new(),
            });
        }
        let run = self.run.as_mut()?;
        if (
            run.chunk_id.as_str(),
            run.count,
            run.byte_length,
            run.next_index,
        ) != (meta.chunk_id, meta.count, meta.byte_length, meta.index)
        {
            return None;
        }
        let start = run.bytes.len();
        let end = start + len;
        if end > run.byte_length {
            return None;
        }
        if run.bytes.capacity() < end {
            // Doubling keeps reassembly linear; the clamp keeps the buffer
            // within `byteLength`.
            let target = (run.bytes.capacity() * 2).clamp(end, run.byte_length);
            run.bytes.reserve_exact(target - start);
        }
        run.bytes.resize(end, 0);
        if STANDARD.decode_slice(data, &mut run.bytes[start..]).ok()? != len {
            return None;
        }
        run.next_index += 1;
        if run.next_index < run.count {
            return Some(Push::Pending);
        }
        let run = self.run.take()?;
        (run.bytes.len() == run.byte_length).then_some(Push::Complete(run.bytes))
    }
}

#[cfg(test)]
pub(super) mod tests {
    use super::*;
    use serde_json::json;

    /// `json` as omp's `encodeChunkedRpcFrames` would send it: one
    /// `rpc_chunk` line per 256 KiB.
    pub(in crate::agent) fn chunk_lines(json: impl AsRef<[u8]>, chunk_id: &str) -> Vec<String> {
        let bytes = json.as_ref();
        let count = bytes.len().div_ceil(CHUNK_PAYLOAD_BYTES);
        bytes
            .chunks(CHUNK_PAYLOAD_BYTES)
            .enumerate()
            .map(|(index, part)| {
                json!({
                    "type": "rpc_chunk", "chunkId": chunk_id, "index": index, "count": count,
                    "byteLength": bytes.len(), "data": STANDARD.encode(part),
                })
                .to_string()
            })
            .collect()
    }

    /// A frame of `type` just over omp's chunking threshold, plus `extra`.
    pub(in crate::agent) fn big_frame(mut extra: Value) -> String {
        extra["pad"] = json!("p".repeat(MIN_CHUNKED_BYTES + 1000));
        extra.to_string()
    }

    fn chunk(index: u64, count: u64, byte_length: usize, data: &str) -> Value {
        json!({ "type": "rpc_chunk", "chunkId": "c1", "index": index, "count": count,
                "byteLength": byte_length, "data": data })
    }

    /// The text of every logical frame `lines` yield, then of the EOF step.
    fn texts(lines: &[&[u8]]) -> Vec<String> {
        let mut assembler = ChunkAssembler::default();
        let mut out = Vec::new();
        for line in lines {
            logical_frames(&mut assembler, line, |logical| out.push(text_of(logical)));
        }
        if assembler.interrupt() {
            out.push(FrameError::ChunkInterrupted.text().to_owned());
        }
        out
    }

    fn text_of(logical: Logical<'_>) -> String {
        match logical {
            Logical::Frame {
                value,
                verbatim: Some(raw),
            } => {
                assert_eq!(parse(&raw).unwrap(), (value, false));
                String::from_utf8(raw.into_owned()).unwrap()
            }
            Logical::Frame {
                value,
                verbatim: None,
            } => format!("repaired:{value}"),
            Logical::Error(e) => e.text().to_owned(),
        }
    }

    fn reasons(lines: &[String]) -> Vec<String> {
        let refs: Vec<&[u8]> = lines.iter().map(String::as_bytes).collect();
        texts(&refs)
    }

    const INVALID: &str = FrameError::ChunkInvalid.text();
    const INTERRUPTED: &str = FrameError::ChunkInterrupted.text();
    const UNPARSABLE: &str = FrameError::Unparsable.text();

    #[test]
    fn a_whole_run_reassembles_into_one_frame() {
        let frame = big_frame(json!({ "type": "response", "id": "r1" }));
        let lines = chunk_lines(&frame, "c1");
        assert_eq!(lines.len(), 5);
        assert_eq!(reasons(&lines), vec![frame]);
    }

    #[test]
    fn a_run_cut_short_reports_interrupted_and_the_line_still_counts() {
        let frame = big_frame(json!({ "type": "response" }));
        let mut lines = chunk_lines(&frame, "c1");
        lines.truncate(2);
        lines.push(r#"{"type":"agent_end"}"#.to_owned());
        assert_eq!(
            reasons(&lines),
            vec![INTERRUPTED.to_owned(), r#"{"type":"agent_end"}"#.to_owned()]
        );
        // End of stream with an open run.
        lines.pop();
        assert_eq!(reasons(&lines), vec![INTERRUPTED.to_owned()]);
        // No run open: a line is just a line.
        assert_eq!(
            texts(&[br#"{"type":"agent_end"}"#]),
            vec![r#"{"type":"agent_end"}"#]
        );
    }

    #[test]
    fn out_of_order_index_is_invalid_and_the_rest_of_the_run_is_dropped() {
        let frame = big_frame(json!({ "type": "response" }));
        let mut lines = chunk_lines(&frame, "c1");
        lines.swap(1, 2);
        assert_eq!(reasons(&lines), vec![INVALID.to_owned()]);
        // A run must start at index 0.
        assert_eq!(reasons(&lines[1..]), vec![INVALID.to_owned()]);
        // After the failed run, another id starts fresh.
        let mut next = lines;
        next.extend(chunk_lines(&frame, "c2"));
        assert_eq!(reasons(&next), vec![INVALID.to_owned(), frame]);
    }

    #[test]
    fn a_failed_run_is_forgotten_after_another_line_or_a_new_start() {
        let mut assembler = ChunkAssembler::default();
        let bad = chunk(1, 4, MIN_CHUNKED_BYTES, "QUJD");
        assert_eq!(assembler.push(&bad), Push::Invalid);
        assert_eq!(assembler.push(&bad), Push::Discarded);
        assert!(!assembler.interrupt(), "no run was open");
        assert_eq!(assembler.push(&bad), Push::Invalid);
        // Index 0 under the failed id starts a new run.
        assert_eq!(
            assembler.push(&chunk(0, 4, MIN_CHUNKED_BYTES, "QUJD")),
            Push::Pending
        );
    }

    #[test]
    fn metadata_bounds_mirror_omp() {
        let ok = |index, count, byte_length| {
            ChunkAssembler::default().push(&chunk(index, count, byte_length, "QUJD"))
                != Push::Invalid
        };
        assert!(ok(0, 2, MIN_CHUNKED_BYTES));
        assert!(!ok(0, 1, MIN_CHUNKED_BYTES), "count below 2");
        assert!(ok(0, MAX_CHUNK_COUNT, MIN_CHUNKED_BYTES));
        assert!(
            !ok(0, MAX_CHUNK_COUNT + 1, MIN_CHUNKED_BYTES),
            "count above 256"
        );
        assert!(!ok(2, 2, MIN_CHUNKED_BYTES), "index not below count");
        assert!(!ok(3, 2, MIN_CHUNKED_BYTES), "index above count");
        assert!(!ok(0, 2, MIN_CHUNKED_BYTES - 1), "byteLength below 1 MiB");
        assert!(ok(0, 2, MAX_REASSEMBLED_BYTES));
        assert!(
            !ok(0, 2, MAX_REASSEMBLED_BYTES + 1),
            "byteLength above 64 MiB"
        );

        let with = |key: &str, value: Value| {
            let mut c = chunk(0, 2, MIN_CHUNKED_BYTES, "QUJD");
            c[key] = value;
            ChunkAssembler::default().push(&c)
        };
        assert_eq!(with("index", json!(-1)), Push::Invalid);
        assert_eq!(with("index", json!(0.5)), Push::Invalid);
        assert_eq!(with("count", json!("2")), Push::Invalid);
        assert_eq!(with("chunkId", json!(7)), Push::Invalid);
        assert_eq!(with("chunkId", json!("")), Push::Invalid);
        assert_eq!(with("chunkId", json!("i".repeat(128))), Push::Pending);
        assert_eq!(with("chunkId", json!("i".repeat(129))), Push::Invalid);
        // UTF-16 units, as `String.length` counts: 64 astral chars = 128.
        assert_eq!(with("chunkId", json!("😀".repeat(64))), Push::Pending);
        assert_eq!(with("chunkId", json!("😀".repeat(65))), Push::Invalid);
    }

    #[test]
    fn metadata_must_match_across_the_run() {
        for (key, value) in [
            ("chunkId", json!("other")),
            ("count", json!(3)),
            ("byteLength", json!(MIN_CHUNKED_BYTES + 1)),
        ] {
            let mut assembler = ChunkAssembler::default();
            assert_eq!(
                assembler.push(&chunk(0, 2, MIN_CHUNKED_BYTES, "QUJD")),
                Push::Pending
            );
            let mut second = chunk(1, 2, MIN_CHUNKED_BYTES, "QUJD");
            second[key] = value;
            assert_eq!(assembler.push(&second), Push::Invalid, "{key}");
        }
    }

    #[test]
    fn data_must_be_canonical_base64() {
        let push = |data: Value| {
            let mut c = chunk(0, 2, MIN_CHUNKED_BYTES, "");
            c["data"] = data;
            ChunkAssembler::default().push(&c)
        };
        assert_eq!(push(json!("QQ==")), Push::Pending);
        assert_eq!(push(json!("QUI=")), Push::Pending);
        assert_eq!(push(json!("")), Push::Invalid, "empty");
        assert_eq!(push(json!("QQ")), Push::Invalid, "unpadded");
        assert_eq!(push(json!("QR==")), Push::Invalid, "non-zero trailing bits");
        assert_eq!(push(json!("QU I=")), Push::Invalid, "whitespace");
        assert_eq!(push(json!("QU-_")), Push::Invalid, "url-safe alphabet");
        assert_eq!(push(json!("Q===")), Push::Invalid, "over-padded");
        assert_eq!(push(json!("QQ==QUJD")), Push::Invalid, "padding mid-string");
        assert_eq!(push(json!(42)), Push::Invalid, "not a string");
    }

    #[test]
    fn a_chunk_decodes_to_at_most_256_kib() {
        let push = |len: usize| {
            let data = STANDARD.encode(vec![b'a'; len]);
            ChunkAssembler::default().push(&chunk(0, 2, MIN_CHUNKED_BYTES, &data))
        };
        assert_eq!(push(CHUNK_PAYLOAD_BYTES), Push::Pending);
        assert_eq!(push(CHUNK_PAYLOAD_BYTES + 1), Push::Invalid);
    }

    #[test]
    fn the_total_must_equal_byte_length() {
        let piece = STANDARD.encode(vec![b' '; CHUNK_PAYLOAD_BYTES]);
        let run = |count: u64, byte_length: usize| {
            let mut assembler = ChunkAssembler::default();
            let mut last = Push::Pending;
            for i in 0..count {
                last = assembler.push(&chunk(i, count, byte_length, &piece));
                if last != Push::Pending {
                    break;
                }
            }
            last
        };
        let five = 5 * CHUNK_PAYLOAD_BYTES;
        assert_eq!(run(5, five), Push::Complete(vec![b' '; five]));
        // Growth doubles but stops at byteLength: 1 MiB held, 2 MiB not taken.
        let mut assembler = ChunkAssembler::default();
        for i in 0..4 {
            assembler.push(&chunk(i, 5, five, &piece));
        }
        let Push::Complete(bytes) = assembler.push(&chunk(4, 5, five, &piece)) else {
            panic!("the run completes");
        };
        assert!(bytes.capacity() <= five, "{}", bytes.capacity());
        assert_eq!(run(5, five + 1), Push::Invalid, "total below byteLength");
        // Above: the fifth chunk would cross byteLength, so it never lands.
        let mut assembler = ChunkAssembler::default();
        for i in 0..4 {
            assert_eq!(
                assembler.push(&chunk(i, 5, five - 1, &piece)),
                Push::Pending
            );
        }
        assert_eq!(
            assembler.push(&chunk(4, 5, five - 1, &piece)),
            Push::Invalid
        );
        assert!(!assembler.interrupt(), "the run was dropped");
    }

    #[test]
    fn the_payload_must_be_a_json_object() {
        let lines = |payload: &[u8]| {
            let mut padded = payload.to_vec();
            padded.resize(MIN_CHUNKED_BYTES, b' ');
            reasons(&chunk_lines(&padded, "c1"))
        };
        assert_eq!(lines(b"[1, 2]"), vec![UNPARSABLE.to_owned()], "array");
        assert_eq!(lines(b"\"text\""), vec![UNPARSABLE.to_owned()], "string");
        assert_eq!(
            lines(b"{\"type\":"),
            vec![UNPARSABLE.to_owned()],
            "not JSON"
        );
        assert_eq!(
            lines(b"{\"t\":\"\xFF\"}"),
            vec![UNPARSABLE.to_owned()],
            "not UTF-8"
        );
        let object = lines(b"{\"type\":\"x\"}");
        assert_eq!(object.len(), 1);
        assert!(object[0].starts_with("{\"type\":\"x\"}"));
    }

    #[test]
    fn an_unparsable_line_is_only_the_diagnostic() {
        let out = texts(&[b"not json sk-raw-secret"]);
        assert_eq!(out, vec![UNPARSABLE]);
        let out = texts(&[b"{\"key\":\"\xFFsk\"}"]);
        assert_eq!(out, vec![UNPARSABLE], "invalid UTF-8");
    }

    #[test]
    fn lone_surrogates_are_repaired_and_valid_pairs_kept() {
        let repair = |raw: &str| {
            repair_lone_surrogates(raw.as_bytes()).map(|v| String::from_utf8(v).unwrap())
        };
        assert_eq!(
            repair(r#"{"a":"x\ud800y"}"#).as_deref(),
            Some(r#"{"a":"x\uFFFDy"}"#),
            "lone high"
        );
        assert_eq!(
            repair(r#"{"a":"\uDC00"}"#).as_deref(),
            Some(r#"{"a":"\uFFFD"}"#),
            "lone low"
        );
        assert_eq!(
            repair(r#"{"a":"\ud800\ud800\udc00"}"#).as_deref(),
            Some(r#"{"a":"\uFFFD\ud800\udc00"}"#),
            "high before a pair"
        );
        assert_eq!(
            repair(r#"{"\udfff":1}"#).as_deref(),
            Some(r#"{"\uFFFD":1}"#),
            "inside a key"
        );
        assert_eq!(repair(r#"{"a":"\ud83d\ude00"}"#), None, "valid pair");
        assert_eq!(repair(r#"{"a":"\\ud800"}"#), None, "escaped backslash");
        assert_eq!(
            repair(r#"{"a":"\"\\\ud800"}"#).as_deref(),
            Some(r#"{"a":"\"\\\uFFFD"}"#),
            "after \\\\"
        );
        assert_eq!(repair(r#"{"a":"\u0041"}"#), None, "not a surrogate");
        assert_eq!(repair(r#"{"a":"\ud80"}"#), None, "short escape");
    }

    #[test]
    fn a_repaired_line_is_a_frame_re_serialized_from_its_value() {
        let out = texts(&[br#"{"type":"x","t":"a\ud800b"}"#]);
        assert_eq!(out, vec!["repaired:{\"t\":\"a\u{FFFD}b\",\"type\":\"x\"}"]);
        // Repair does not apply to escaped text, which parses as is.
        let out = texts(&[br#"{"t":"\\ud800"}"#]);
        assert_eq!(out, vec![r#"{"t":"\\ud800"}"#]);
    }

    #[test]
    fn a_reassembled_payload_is_repaired_too() {
        let frame = big_frame(json!({ "type": "response", "id": "SURROGATE" }))
            .replace("SURROGATE", r"\udc01");
        let out = reasons(&chunk_lines(&frame, "c1"));
        assert_eq!(out.len(), 1);
        assert!(out[0].starts_with("repaired:"), "{}", &out[0][..40]);
        assert!(out[0].contains("\"id\":\"\u{FFFD}\""));
    }

    /// `n` nested arrays around `1`.
    fn arrays(n: usize) -> String {
        format!("{}1{}", "[".repeat(n), "]".repeat(n))
    }

    /// A frame `depth` levels deep: an object around nested arrays.
    fn nested(depth: usize) -> String {
        format!(r#"{{"type":"deep","v":{}}}"#, arrays(depth - 1))
    }

    /// D94-7: serde's default refuses 128 levels; the retry takes them, up
    /// to `MAX_FRAME_DEPTH` (whose run on the reader's stack is
    /// `reader::tests::a_frame_at_the_depth_ceiling_runs_on_the_reader_stack`).
    #[test]
    fn frames_deeper_than_serde_allows_parse_up_to_the_ceiling() {
        assert!(serde_json::from_str::<Value>(&nested(127)).is_ok());
        assert!(serde_json::from_str::<Value>(&nested(SERDE_DEPTH_LIMIT)).is_err());
        for depth in [127, 128, 129, 200] {
            let frame = nested(depth);
            assert_eq!(texts(&[frame.as_bytes()]), vec![frame], "depth {depth}");
        }
        let too_deep = nested(MAX_FRAME_DEPTH + 1);
        assert_eq!(texts(&[too_deep.as_bytes()]), vec![UNPARSABLE]);
        // Deep but invalid is still unparsable.
        let broken = nested(200).replace("1]", "1,]");
        assert_eq!(texts(&[broken.as_bytes()]), vec![UNPARSABLE]);
    }

    /// The depth scan counts no bracket inside a string, an escaped quote
    /// included: counted, these brackets would put the frame past the
    /// ceiling.
    #[test]
    fn the_depth_scan_skips_strings_and_escapes() {
        let brackets = "[".repeat(MAX_FRAME_DEPTH);
        for string in [brackets.clone(), format!(r#"\"{brackets}"#)] {
            let frame = nested(200).replacen("\"deep\"", &format!("\"{string}\""), 1);
            assert_eq!(max_depth(frame.as_bytes()), 200, "{}", &string[..2]);
            assert_eq!(texts(&[frame.as_bytes()]), vec![frame]);
        }
    }

    /// Repair, then the depth retry: a deep line with a lone surrogate.
    #[test]
    fn a_deep_frame_with_a_lone_surrogate_is_repaired_and_parsed() {
        let frame = nested(200).replace("\"deep\"", r#""a\ud800b""#);
        let out = texts(&[frame.as_bytes()]);
        assert_eq!(out.len(), 1);
        assert!(
            out[0].starts_with("repaired:{\"type\":\"a\u{FFFD}b\""),
            "{}",
            &out[0][..40]
        );
    }

    /// A reassembled payload takes the same retry as a line.
    #[test]
    fn a_deep_reassembled_payload_parses() {
        let frame =
            big_frame(json!({ "type": "response", "v": "DEEP" })).replace("\"DEEP\"", &arrays(199));
        assert_eq!(max_depth(frame.as_bytes()), 200);
        assert_eq!(reasons(&chunk_lines(&frame, "c1")), vec![frame]);
    }

    /// The buffer grows with the data, never to the claimed `byteLength`.
    #[test]
    fn a_run_does_not_preallocate_its_byte_length() {
        let mut assembler = ChunkAssembler::default();
        assert_eq!(
            assembler.push(&chunk(0, 2, MAX_REASSEMBLED_BYTES, "QUJD")),
            Push::Pending
        );
        let capacity = assembler.run.as_ref().unwrap().bytes.capacity();
        assert!(capacity < CHUNK_PAYLOAD_BYTES, "{capacity}");
    }
}

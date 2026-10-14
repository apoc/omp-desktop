//! `ws_frames.rs` unit tests: the frame builders here are also what the tap
//! and proxy tests put on the wire.

use super::ws_frames::{Lost, Messages};

const KEY: [u8; 4] = [0x11, 0x22, 0x33, 0x44];

/// One frame as a client (`masked`) or a server sends it, with the shortest
/// length encoding.
pub(super) fn frame(opcode: u8, fin: bool, masked: bool, payload: &[u8]) -> Vec<u8> {
    let mut out = vec![if fin { 0x80 | opcode } else { opcode }];
    let flag = if masked { 0x80 } else { 0 };
    match payload.len() {
        n @ 0..=125 => out.push(flag | u8::try_from(n).unwrap()),
        n @ 126..=0xFFFF => {
            out.push(flag | 0x7E);
            out.extend_from_slice(&u16::try_from(n).unwrap().to_be_bytes());
        }
        n => {
            out.push(flag | 0x7F);
            out.extend_from_slice(&u64::try_from(n).unwrap().to_be_bytes());
        }
    }
    if masked {
        out.extend_from_slice(&KEY);
        out.extend(payload.iter().enumerate().map(|(i, b)| b ^ KEY[i % 4]));
    } else {
        out.extend_from_slice(payload);
    }
    out
}

/// A client's text message in one frame.
pub(super) fn masked_text(text: &str) -> Vec<u8> {
    frame(0x1, true, true, text.as_bytes())
}

/// A server's text message in one frame.
pub(super) fn text(text: &str) -> Vec<u8> {
    frame(0x1, true, false, text.as_bytes())
}

fn feed_all(decoder: &mut Messages, chunks: &[&[u8]]) -> Result<Vec<String>, Lost> {
    let mut out = Vec::new();
    for chunk in chunks {
        decoder.feed(chunk, &mut out)?;
    }
    Ok(out
        .into_iter()
        .map(|m| String::from_utf8(m).unwrap())
        .collect())
}

fn client() -> Messages {
    Messages::new(true, 1 << 20)
}

fn server(max: usize) -> Messages {
    Messages::new(false, max)
}

#[test]
fn masked_and_unmasked_frames_of_every_length_encoding_decode() {
    for len in [0, 1, 125, 126, 300, 65_535, 65_536, 70_000] {
        let payload = "x".repeat(len);
        assert_eq!(
            feed_all(&mut client(), &[&masked_text(&payload)]),
            Ok(vec![payload.clone()]),
            "client, {len}"
        );
        assert_eq!(
            feed_all(&mut server(1 << 20), &[&text(&payload)]),
            Ok(vec![payload]),
            "server, {len}"
        );
    }
}

#[test]
fn any_chunking_gives_the_same_messages() {
    let mut wire = masked_text("one");
    wire.extend(frame(0x9, true, true, b"ping"));
    wire.extend(frame(0x1, false, true, b"tw"));
    wire.extend(frame(0xA, true, true, b"")); // a control frame between fragments
    wire.extend(frame(0x0, false, true, b"o-"));
    wire.extend(frame(0x0, true, true, b"fragments"));
    wire.extend(masked_text(&"y".repeat(300)));
    let expected = vec![
        "one".to_owned(),
        "two-fragments".to_owned(),
        "y".repeat(300),
    ];
    for step in [1, 2, 3, 5, 7, wire.len()] {
        let mut decoder = client();
        let chunks: Vec<&[u8]> = wire.chunks(step).collect();
        assert_eq!(
            feed_all(&mut decoder, &chunks),
            Ok(expected.clone()),
            "{step}"
        );
    }
}

#[test]
fn binary_messages_and_close_frames_are_dropped() {
    let mut wire = frame(0x2, true, false, b"\x00\x01");
    wire.extend(frame(0x2, false, false, b"a"));
    wire.extend(frame(0x0, true, false, b"b"));
    wire.extend(text("kept"));
    wire.extend(frame(0x8, true, false, b"\x03\xe8"));
    assert_eq!(
        feed_all(&mut server(1 << 20), &[&wire]),
        Ok(vec!["kept".to_owned()])
    );
}

#[test]
fn a_message_over_the_cap_is_skipped_and_decoding_stays_in_sync() {
    let mut wire = frame(0x1, false, false, &[b'a'; 40]);
    wire.extend(frame(0x9, true, false, b"ping"));
    wire.extend(frame(0x0, false, false, &[b'b'; 40]));
    wire.extend(frame(0x0, true, false, &[b'c'; 40]));
    wire.extend(text("next"));
    wire.extend(text(&"z".repeat(101))); // one frame over the cap
    wire.extend(text("last"));
    assert_eq!(
        feed_all(&mut server(100), &[&wire]),
        Ok(vec!["next".to_owned(), "last".to_owned()])
    );
}

#[test]
fn a_stream_that_breaks_the_framing_is_lost() {
    let cases: [(&str, bool, Vec<u8>); 8] = [
        ("a client frame without a mask", true, text("x")),
        ("a server frame with a mask", false, masked_text("x")),
        ("an RSV bit", false, vec![0xC1, 0x01, b'x']),
        ("an unknown opcode", false, vec![0x83, 0x00]),
        (
            "a continuation with nothing to continue",
            false,
            frame(0x0, true, false, b"x"),
        ),
        (
            "a fragmented control frame",
            false,
            frame(0x9, false, false, b""),
        ),
        (
            "a control frame over 125 bytes",
            false,
            frame(0x9, true, false, &[0; 126]),
        ),
        (
            "a length with its top bit set",
            false,
            vec![0x81, 127, 0x80, 0, 0, 0, 0, 0, 0, 0],
        ),
    ];
    for (what, from_client, wire) in cases {
        let mut decoder = Messages::new(from_client, 1 << 20);
        assert_eq!(feed_all(&mut decoder, &[&wire]), Err(Lost), "{what}");
    }
    let mut wire = frame(0x1, false, false, b"a");
    wire.extend(text("a new message while one is open"));
    assert_eq!(feed_all(&mut server(100), &[&wire]), Err(Lost));
}

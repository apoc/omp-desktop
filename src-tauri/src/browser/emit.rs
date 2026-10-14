//! Payloads and sink of the browser panel's events (`browser://…/{session}`),
//! and the frame's pixel size read from its JPEG header.

use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Emitter};

/// One screencast frame. `b64` is Chromium's JPEG, base64 already.
/// `w`/`h` are image pixels; `css_w`/`css_h` the page's CSS viewport the
/// frame shows (clicks map through those).
#[derive(Serialize, Clone, Debug, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct Frame {
    pub b64: String,
    pub w: u32,
    pub h: u32,
    pub css_w: u32,
    pub css_h: u32,
}

#[derive(Serialize, Clone, Debug, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct TabInfo {
    pub target_id: String,
    pub title: String,
    pub url: String,
    pub active: bool,
}

#[derive(Serialize, Clone)]
struct Tabs<'a> {
    tabs: &'a [TabInfo],
}

#[derive(Serialize, Clone, Copy, Debug, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum Status {
    Idle,
    Starting,
    Running,
    Stopped,
    Error,
}

#[derive(Serialize, Clone, Debug, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct ViewState {
    pub status: Status,
    pub error: Option<String>,
    pub url: String,
    pub loading: bool,
    pub can_back: bool,
    pub can_forward: bool,
}

impl ViewState {
    pub const fn new(status: Status) -> Self {
        Self {
            status,
            error: None,
            url: String::new(),
            loading: false,
            can_back: false,
            can_forward: false,
        }
    }
}

#[derive(Serialize, Deserialize, Clone, Debug, PartialEq)]
pub struct Rect {
    pub x: f64,
    pub y: f64,
    pub w: f64,
    pub h: f64,
}

/// An element or area the user picked in the page (annotate mode).
/// `kind` is `element` or `area`; `selector`, `tag`, `html` and `text` are
/// `None` for an area.
#[derive(Serialize, Deserialize, Clone, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Pick {
    pub kind: String,
    pub selector: Option<String>,
    pub tag: Option<String>,
    pub rect: Rect,
    /// Document CSS pixels at pick time; `rect` remains viewport-relative.
    pub doc_rect: Option<Rect>,
    pub html: Option<String>,
    pub text: Option<String>,
    pub url: String,
}

/// Where the view reports to; `session` is the omp tab's session id.
pub trait BrowserEmit: Send + Sync {
    fn frame(&self, sid: &str, f: &Frame);
    fn tabs(&self, sid: &str, tabs: &[TabInfo]);
    fn state(&self, sid: &str, s: &ViewState);
    fn pick(&self, sid: &str, p: &Pick);
}

/// Emits the events to the webview.
pub struct TauriBrowserEmit(pub AppHandle);

impl BrowserEmit for TauriBrowserEmit {
    fn frame(&self, sid: &str, f: &Frame) {
        let _ = self.0.emit(&format!("browser://frame/{sid}"), f);
    }

    fn tabs(&self, sid: &str, tabs: &[TabInfo]) {
        let _ = self.0.emit(&format!("browser://tabs/{sid}"), Tabs { tabs });
    }

    fn state(&self, sid: &str, s: &ViewState) {
        let _ = self.0.emit(&format!("browser://state/{sid}"), s);
    }

    fn pick(&self, sid: &str, p: &Pick) {
        let _ = self.0.emit(&format!("browser://pick/{sid}"), p);
    }
}

impl Frame {
    /// A frame of Chromium's base64 JPEG, untouched. The image size is read
    /// from the JPEG header (the screencast metadata only carries the CSS
    /// size); without a readable header it falls back to the CSS size.
    pub fn new(b64: String, css_w: u32, css_h: u32) -> Self {
        let (w, h) = jpeg_size(&b64).unwrap_or((css_w, css_h));
        Self {
            b64,
            w,
            h,
            css_w,
            css_h,
        }
    }

    /// Whether the image has the proportions of the CSS size the metadata
    /// claims, give or take the rounding of its pixel size. Chromium's
    /// first frame of a screencast can be the whole window surface labelled
    /// with the emulated viewport's size; clicks mapped through such a
    /// label would land beside the target.
    pub fn has_css_proportions(&self) -> bool {
        let across = u64::from(self.w) * u64::from(self.css_h);
        let down = u64::from(self.h) * u64::from(self.css_w);
        // Each image side is rounded by up to half a pixel.
        across.abs_diff(down) <= u64::from(self.css_w.max(self.css_h))
    }
}

/// Base64 characters decoded for [`jpeg_size`]; the start-of-frame segment
/// sits well before.
const PREFIX: usize = 4096;

fn sextet(c: u8) -> Option<u32> {
    match c {
        b'A'..=b'Z' => Some(u32::from(c - b'A')),
        b'a'..=b'z' => Some(u32::from(c - b'a') + 26),
        b'0'..=b'9' => Some(u32::from(c - b'0') + 52),
        b'+' => Some(62),
        b'/' => Some(63),
        _ => None,
    }
}

/// The bytes of the first `PREFIX` base64 characters (an incomplete trailing
/// group is dropped).
fn decode_prefix(b64: &str) -> Vec<u8> {
    let text = &b64.as_bytes()[..b64.len().min(PREFIX)];
    let mut bytes = Vec::with_capacity(text.len() / 4 * 3);
    for group in text.as_chunks::<4>().0 {
        let mut bits = 0u32;
        let mut sextets = 0usize;
        for &c in group {
            let Some(value) = sextet(c) else { break };
            bits = bits << 6 | value;
            sextets += 1;
        }
        if sextets < 4 {
            // Padding: 2 sextets carry 1 byte, 3 carry 2.
            let bits = bits << (6 * (4 - sextets));
            for shift in [16, 8].into_iter().take(sextets.saturating_sub(1)) {
                bytes.push((bits >> shift & 0xFF) as u8); // masked to a byte
            }
            break;
        }
        bytes.extend([16, 8, 0].map(|shift| (bits >> shift & 0xFF) as u8)); // masked to a byte
    }
    bytes
}

fn be16(bytes: &[u8], at: usize) -> Option<u32> {
    Some(u32::from(*bytes.get(at)?) << 8 | u32::from(*bytes.get(at + 1)?))
}

/// `(width, height)` in pixels of the JPEG `b64` encodes.
fn jpeg_size(b64: &str) -> Option<(u32, u32)> {
    let bytes = decode_prefix(b64);
    if bytes.get(..2)? != [0xFF, 0xD8] {
        return None;
    }
    let mut at = 2;
    loop {
        if *bytes.get(at)? != 0xFF {
            return None;
        }
        let marker = *bytes.get(at + 1)?;
        // Start of frame: SOF0..SOF15 except DHT (C4), JPG (C8) and DAC (CC).
        if (0xC0..=0xCF).contains(&marker) && ![0xC4, 0xC8, 0xCC].contains(&marker) {
            return Some((be16(&bytes, at + 7)?, be16(&bytes, at + 5)?));
        }
        at += 2 + usize::try_from(be16(&bytes, at + 2)?).ok()?;
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// SOI, JFIF, a DQT, then SOF0 of 400x300.
    const HEADER: &str = "/9j/4AAQSkZJRgABAQAAAQABAAD/2wAFAAEC/8AAEQgBLAGQAwEiAAIRAQMRAQ==";

    #[test]
    fn jpeg_size_is_read_past_other_segments() {
        assert_eq!(jpeg_size(HEADER), Some((400, 300)));
        let frame = Frame::new(HEADER.to_owned(), 200, 150);
        assert_eq!(
            (frame.w, frame.h, frame.css_w, frame.css_h),
            (400, 300, 200, 150)
        );
        assert_eq!(frame.b64, HEADER, "passed through untouched");
    }

    #[test]
    fn truncated_or_foreign_data_falls_back_to_the_css_size() {
        assert_eq!(
            jpeg_size(&HEADER[..30]),
            None,
            "cut before the frame header"
        );
        assert_eq!(jpeg_size("iVBORw0KGgoAAAANSUhEUgAA"), None, "a PNG");
        assert_eq!(jpeg_size(""), None);
        let frame = Frame::new(String::new(), 200, 150);
        assert_eq!((frame.w, frame.h), (200, 150));
    }

    #[test]
    fn proportions_are_checked_against_the_css_size() {
        let frame = |w, h, css_w, css_h| Frame {
            b64: String::new(),
            w,
            h,
            css_w,
            css_h,
        };
        assert!(frame(800, 600, 400, 300).has_css_proportions());
        assert!(frame(1280, 657, 1280, 657).has_css_proportions());
        assert!(frame(801, 600, 400, 300).has_css_proportions(), "rounding");
        assert!(
            !frame(400, 205, 400, 300).has_css_proportions(),
            "window surface under the panel's metadata"
        );
    }
}

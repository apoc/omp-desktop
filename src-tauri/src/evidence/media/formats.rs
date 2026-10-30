//! Identify supported content from bytes, never from a supplied MIME type.

const TEXT_LIMIT: usize = 1024 * 1024;
const IMAGE_LIMIT: usize = 8 * 1024 * 1024;
pub(super) const VIDEO_LIMIT: usize = 64 * 1024 * 1024;

pub(super) fn classify(bytes: &[u8], name: &str) -> Result<&'static str, String> {
    let extension = name
        .rsplit_once('.')
        .map(|(_, ext)| ext.to_ascii_lowercase());
    if matches!(
        extension.as_deref(),
        Some("html" | "htm" | "xhtml" | "svg" | "svgz")
    ) {
        return Err("HTML and SVG evidence is not supported".into());
    }
    let mime = if bytes.starts_with(b"\x89PNG\r\n\x1a\n") {
        png(bytes).then_some("image/png")
    } else if bytes.starts_with(b"\xff\xd8") {
        jpeg(bytes).then_some("image/jpeg")
    } else if bytes.starts_with(b"GIF87a") || bytes.starts_with(b"GIF89a") {
        gif(bytes).then_some("image/gif")
    } else if bytes.starts_with(b"RIFF") {
        webp(bytes).then_some("image/webp")
    } else if bytes.get(4..8) == Some(b"ftyp") {
        mp4(bytes).then_some("video/mp4")
    } else if bytes.starts_with(b"\x1a\x45\xdf\xa3") {
        webm(bytes).then_some("video/webm")
    } else {
        let text = std::str::from_utf8(bytes).map_err(|_| "unsupported evidence format")?;
        if bytes.contains(&0) {
            return Err("binary evidence is not supported".into());
        }
        // Reject document-like HTML/SVG even when it has a misleading extension.
        let start = text.trim_start_matches('\u{feff}').trim_start();
        let prefix: String = start
            .chars()
            .take(1024)
            .collect::<String>()
            .to_ascii_lowercase();
        if prefix.starts_with("<!doctype html")
            || prefix.starts_with("<html")
            || prefix.starts_with("<svg")
            || (prefix.starts_with("<?xml") && prefix.contains("<svg"))
        {
            return Err("HTML and SVG evidence is not supported".into());
        }
        if bytes.len() > TEXT_LIMIT {
            return Err("text evidence exceeds 1 MiB".into());
        }
        return Ok("text/plain");
    };
    let mime = mime.ok_or("invalid or unsupported evidence content")?;
    let limit = if mime.starts_with("image/") {
        IMAGE_LIMIT
    } else {
        VIDEO_LIMIT
    };
    if bytes.len() > limit {
        return Err(format!("{mime} evidence exceeds its size limit"));
    }
    Ok(mime)
}

fn u32be(bytes: &[u8]) -> Option<usize> {
    Some(u32::from_be_bytes(bytes.try_into().ok()?) as usize)
}

fn png(bytes: &[u8]) -> bool {
    let mut pos = 8;
    let mut ihdr = false;
    let mut idat = false;
    while let Some(header) = bytes.get(pos..pos + 8) {
        let Some(len) = u32be(&header[..4]) else {
            return false;
        };
        let Some(end) = pos.checked_add(12).and_then(|n| n.checked_add(len)) else {
            return false;
        };
        let Some(chunk) = bytes.get(pos + 4..end) else {
            return false;
        };
        if crc32(&chunk[..chunk.len() - 4])
            != u32::from_be_bytes(chunk[chunk.len() - 4..].try_into().unwrap_or([0; 4]))
        {
            return false;
        }
        let kind = &header[4..8];
        if !ihdr {
            if kind != b"IHDR" || len != 13 || chunk[4..8] == [0; 4] || chunk[8..12] == [0; 4] {
                return false;
            }
            ihdr = true;
        } else if kind == b"IHDR" {
            return false;
        }
        if kind == b"IDAT" {
            idat = true;
        }
        if kind == b"IEND" {
            return len == 0 && idat && end == bytes.len();
        }
        pos = end;
    }
    false
}

fn crc32(bytes: &[u8]) -> u32 {
    let mut crc = !0u32;
    for &byte in bytes {
        crc ^= u32::from(byte);
        for _ in 0..8 {
            crc = (crc >> 1) ^ (0xedb8_8320 & (0u32.wrapping_sub(crc & 1)));
        }
    }
    !crc
}

fn jpeg(bytes: &[u8]) -> bool {
    let mut pos = 2;
    let mut frame = false;
    while pos < bytes.len() {
        if bytes[pos] != 0xff {
            return false;
        }
        while bytes.get(pos) == Some(&0xff) {
            pos += 1;
        }
        let Some(&marker) = bytes.get(pos) else {
            return false;
        };
        pos += 1;
        if marker == 0xd9 {
            return false;
        }
        let Some(length) = bytes
            .get(pos..pos + 2)
            .map(|v| usize::from(u16::from_be_bytes([v[0], v[1]])))
        else {
            return false;
        };
        if length < 2 || pos.checked_add(length).is_none_or(|end| end > bytes.len()) {
            return false;
        }
        if matches!(marker, 0xc0..=0xc3 | 0xc5..=0xc7 | 0xc9..=0xcb | 0xcd..=0xcf) {
            if length < 8 || bytes[pos + 3..pos + 5] == [0, 0] || bytes[pos + 5..pos + 7] == [0, 0]
            {
                return false;
            }
            frame = true;
        }
        pos += length;
        if marker == 0xda {
            return frame && bytes.len() >= pos + 2 && bytes.ends_with(b"\xff\xd9");
        }
    }
    false
}

fn subblocks(bytes: &[u8], mut pos: usize) -> Option<usize> {
    loop {
        let len = usize::from(*bytes.get(pos)?);
        pos = pos.checked_add(1 + len)?;
        if pos > bytes.len() {
            return None;
        }
        if len == 0 {
            return Some(pos);
        }
    }
}

fn gif(bytes: &[u8]) -> bool {
    let Some(header) = bytes.get(..13) else {
        return false;
    };
    if header[6..8] == [0, 0] || header[8..10] == [0, 0] {
        return false;
    }
    let packed = header[10];
    let mut pos = 13
        + if packed & 0x80 != 0 {
            3 * (1usize << ((packed & 7) + 1))
        } else {
            0
        };
    let mut image = false;
    loop {
        match bytes.get(pos) {
            Some(0x3b) => return image && pos + 1 == bytes.len(),
            Some(0x21) => {
                let Some(next) = subblocks(bytes, pos + 2) else {
                    return false;
                };
                pos = next;
            }
            Some(0x2c) => {
                let Some(desc) = bytes.get(pos..pos + 10) else {
                    return false;
                };
                if desc[5..7] == [0, 0] || desc[7..9] == [0, 0] {
                    return false;
                }
                let packed = desc[9];
                let table = if packed & 0x80 != 0 {
                    3 * (1usize << ((packed & 7) + 1))
                } else {
                    0
                };
                let Some(next) = subblocks(bytes, pos + 10 + table + 1) else {
                    return false;
                };
                image = true;
                pos = next;
            }
            _ => return false,
        }
    }
}

fn webp(bytes: &[u8]) -> bool {
    if bytes.get(8..12) != Some(b"WEBP") || bytes.len() < 20 {
        return false;
    }
    let size = u32::from_le_bytes([bytes[4], bytes[5], bytes[6], bytes[7]]) as usize;
    if size.checked_add(8) != Some(bytes.len()) {
        return false;
    }
    let mut pos = 12;
    let mut picture = false;
    while let Some(head) = bytes.get(pos..pos + 8) {
        let len = u32::from_le_bytes([head[4], head[5], head[6], head[7]]) as usize;
        let Some(end) = pos
            .checked_add(8)
            .and_then(|n| n.checked_add(len))
            .and_then(|n| n.checked_add(len % 2))
        else {
            return false;
        };
        if end > bytes.len() {
            return false;
        }
        if (head[..4] == *b"VP8 "
            && len >= 10
            && bytes.get(pos + 11..pos + 14) == Some(b"\x9d\x01\x2a"))
            || (head[..4] == *b"VP8L" && len >= 5 && bytes.get(pos + 8) == Some(&0x2f))
        {
            picture = true;
        }
        pos = end;
    }
    picture && pos == bytes.len()
}

fn mp4(bytes: &[u8]) -> bool {
    let mut pos = 0usize;
    let mut ftyp = false;
    let mut video = false;
    let mut mdat = false;
    while pos < bytes.len() {
        let Some((kind, payload, end)) = mp4_box(bytes, pos) else {
            return false;
        };
        match kind {
            b"ftyp" if pos == 0 && payload.len() >= 8 => ftyp = true,
            b"moov" => video |= mp4_video_track(payload),
            b"mdat" if !payload.is_empty() => mdat = true,
            _ => {}
        }
        pos = end;
    }
    ftyp && video && mdat
}

fn mp4_box(bytes: &[u8], pos: usize) -> Option<(&[u8], &[u8], usize)> {
    let head = bytes.get(pos..pos.checked_add(8)?)?;
    let size = u32be(&head[..4])?;
    let (size, header) = if size == 1 {
        let extended = bytes.get(pos + 8..pos + 16)?;
        (
            usize::try_from(u64::from_be_bytes(extended.try_into().ok()?)).ok()?,
            16,
        )
    } else if size == 0 {
        (bytes.len() - pos, 8)
    } else {
        (size, 8)
    };
    if size < header {
        return None;
    }
    let end = pos.checked_add(size)?;
    Some((&head[4..8], bytes.get(pos + header..end)?, end))
}

fn mp4_video_track(moov: &[u8]) -> bool {
    let mut pos = 0;
    while pos < moov.len() {
        let Some((kind, trak, end)) = mp4_box(moov, pos) else {
            return false;
        };
        if kind == b"trak" {
            let mut child = 0;
            while child < trak.len() {
                let Some((kind, mdia, end)) = mp4_box(trak, child) else {
                    return false;
                };
                if kind == b"mdia" && mp4_video_media(mdia) {
                    return true;
                }
                child = end;
            }
        }
        pos = end;
    }
    false
}

fn mp4_video_media(mdia: &[u8]) -> bool {
    let mut pos = 0;
    let mut video = false;
    let mut has_media_data = false;
    while pos < mdia.len() {
        let Some((kind, payload, end)) = mp4_box(mdia, pos) else {
            return false;
        };
        if kind == b"hdlr" && payload.get(8..12) == Some(b"vide") {
            video = true;
        }
        if kind == b"minf" && !payload.is_empty() {
            has_media_data = true;
        }
        pos = end;
    }
    video && has_media_data
}

fn webm(bytes: &[u8]) -> bool {
    let Some((id, Some(length), start)) = ebml_element(bytes, 0) else {
        return false;
    };
    if id != 0x1a45_dfa3 {
        return false;
    }
    let Some(end) = start.checked_add(length).filter(|end| *end <= bytes.len()) else {
        return false;
    };
    let mut pos = start;
    let mut doctype = false;
    while pos < end {
        let Some((id, Some(length), start)) = ebml_element(bytes, pos) else {
            return false;
        };
        let Some(next) = start.checked_add(length).filter(|next| *next <= end) else {
            return false;
        };
        if id == 0x4282 && &bytes[start..next] == b"webm" {
            doctype = true;
        }
        pos = next;
    }
    if !doctype {
        return false;
    }
    // Void/CRC elements may precede the Segment.
    loop {
        let Some((id, length, start)) = ebml_element(bytes, pos) else {
            return false;
        };
        if id == 0x1853_8067 {
            let end = match length {
                Some(length) => match start.checked_add(length).filter(|end| *end <= bytes.len()) {
                    Some(end) => end,
                    None => return false,
                },
                None => bytes.len(),
            };
            let mut child = start;
            let mut tracks = false;
            let mut cluster = false;
            while child < end {
                let Some((id, length, data)) = ebml_element(bytes, child) else {
                    return false;
                };
                let next = match length {
                    Some(length) => match data.checked_add(length).filter(|next| *next <= end) {
                        Some(next) => next,
                        None => return false,
                    },
                    None => end,
                };
                if id == 0x1654_ae6b {
                    if length.is_none() {
                        return false;
                    }
                    let Some(has_video) = webm_video_tracks(&bytes[data..next]) else {
                        return false;
                    };
                    tracks |= has_video;
                }
                if id == 0x1f43_b675 && next > data {
                    cluster = true;
                }
                child = next;
            }
            return tracks && cluster;
        }
        if id != 0xec && id != 0xbf {
            return false;
        }
        let Some(length) = length else { return false };
        let Some(next) = start
            .checked_add(length)
            .filter(|next| *next <= bytes.len())
        else {
            return false;
        };
        pos = next;
    }
}

fn webm_video_tracks(tracks: &[u8]) -> Option<bool> {
    let mut pos = 0;
    let mut video = false;
    let mut has_entry = false;
    while pos < tracks.len() {
        let (id, payload, next) = ebml_sized_element(tracks, pos)?;
        if id == 0xae {
            has_entry = true;
            video |= webm_video_track_entry(payload)?;
        }
        pos = next;
    }
    has_entry.then_some(video)
}

fn webm_video_track_entry(entry: &[u8]) -> Option<bool> {
    let mut pos = 0;
    let mut track_type = None;
    while pos < entry.len() {
        let (id, payload, next) = ebml_sized_element(entry, pos)?;
        if id == 0x83 {
            if track_type.is_some()
                || payload.is_empty()
                || payload.len() > 8
                || payload.iter().all(|byte| *byte == 0)
            {
                return None;
            }
            track_type = Some(
                payload.last() == Some(&1)
                    && payload[..payload.len() - 1].iter().all(|byte| *byte == 0),
            );
        }
        pos = next;
    }
    track_type
}

fn ebml_sized_element(bytes: &[u8], pos: usize) -> Option<(u32, &[u8], usize)> {
    let (id, Some(length), start) = ebml_element(bytes, pos)? else {
        return None;
    };
    let end = start.checked_add(length)?;
    Some((id, bytes.get(start..end)?, end))
}

// EBML ID and variable-length payload size; unknown size is permitted only
// where the caller can bound it to the containing element.
fn ebml_element(bytes: &[u8], pos: usize) -> Option<(u32, Option<usize>, usize)> {
    let first = *bytes.get(pos)?;
    let id_len = first.leading_zeros() as usize + 1;
    if id_len > 4 {
        return None;
    }
    let id_bytes = bytes.get(pos..pos.checked_add(id_len)?)?;
    let mut id = 0u32;
    for &byte in id_bytes {
        id = (id << 8) | u32::from(byte);
    }
    let size_pos = pos.checked_add(id_len)?;
    let first_size = *bytes.get(size_pos)?;
    let size_len = first_size.leading_zeros() as usize + 1;
    if size_len > 8 {
        return None;
    }
    let size_bytes = bytes.get(size_pos..size_pos.checked_add(size_len)?)?;
    let mut size = u64::from(first_size) & (0xff_u64 >> size_len);
    for &byte in &size_bytes[1..] {
        size = (size << 8) | u64::from(byte);
    }
    let unknown = size == (1u64 << (7 * size_len)) - 1;
    let length = if unknown {
        None
    } else {
        Some(usize::try_from(size).ok()?)
    };
    Some((id, length, size_pos + size_len))
}

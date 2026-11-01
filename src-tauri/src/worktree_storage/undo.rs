//! Preserve objects referenced only by the index's resolve-undo extension.
//!
//! gix decodes REUC but does not expose its paths or stages, and a malformed
//! REUC decodes as absent. Inspect the captured index bytes instead of relying
//! on that lossy API. The caller must pass the same bytes saved for recovery.
use std::collections::BTreeSet;

const MAX_INDEX_BYTES: usize = 64 * 1024 * 1024;
const MAX_ENTRIES: usize = 200_000;

fn take<'a>(input: &mut &'a [u8], len: usize) -> Result<&'a [u8], String> {
    if len > input.len() {
        return Err("truncated Git index".into());
    }
    let (value, rest) = input.split_at(len);
    *input = rest;
    Ok(value)
}

fn nul_field<'a>(input: &mut &'a [u8]) -> Result<&'a [u8], String> {
    let end = input
        .iter()
        .position(|byte| *byte == 0)
        .ok_or("unterminated Git index field")?;
    let value = take(input, end + 1)?;
    Ok(&value[..end])
}

const fn be_u32(bytes: &[u8]) -> u32 {
    u32::from_be_bytes([bytes[0], bytes[1], bytes[2], bytes[3]])
}

// Locate the extension block without interpreting index paths. Version 4 paths
// have a variable-length prefix removal count and no padding; v2/v3 entries
// are NUL-terminated and padded to an eight-byte boundary per entry.
fn extensions(bytes: &[u8], hash_len: usize) -> Result<&[u8], String> {
    if bytes.len() > MAX_INDEX_BYTES || bytes.len() < 12 + hash_len || &bytes[..4] != b"DIRC" {
        return Err("invalid or oversized Git index".into());
    }
    let version = be_u32(&bytes[4..8]);
    if !(2..=4).contains(&version) {
        return Err("unsupported Git index version".into());
    }
    let count = be_u32(&bytes[8..12]) as usize;
    if count > MAX_ENTRIES {
        return Err("Git index exceeds recovery entry limit".into());
    }
    let mut input = &bytes[12..bytes.len() - hash_len];
    let mut previous_path_len = 0usize;
    for _ in 0..count {
        let before = input.len();
        let fixed = take(&mut input, 40 + hash_len + 2)?;
        let flags = u16::from_be_bytes([fixed[40 + hash_len], fixed[41 + hash_len]]);
        if flags & 0x4000 != 0 {
            take(&mut input, 2)?;
        }
        if version == 4 {
            let mut strip = 0usize;
            let mut terminated = false;
            for byte_index in 0..10 {
                let byte = take(&mut input, 1)?[0];
                if byte_index != 0 {
                    strip = strip
                        .checked_add(1)
                        .ok_or("invalid Git index path prefix")?;
                }
                strip = strip
                    .checked_mul(128)
                    .and_then(|value| value.checked_add(usize::from(byte & 0x7f)))
                    .ok_or("invalid Git index path prefix")?;
                if byte & 0x80 == 0 {
                    terminated = true;
                    break;
                }
            }
            if !terminated || strip > previous_path_len {
                return Err("invalid Git index path prefix".into());
            }
            let suffix = nul_field(&mut input)?;
            previous_path_len = (previous_path_len - strip)
                .checked_add(suffix.len())
                .ok_or("invalid Git index path length")?;
        } else {
            let path = nul_field(&mut input)?;
            let encoded_len = usize::from(flags & 0x0fff);
            if encoded_len != 0x0fff && encoded_len != path.len() {
                return Err("invalid Git index path length".into());
            }
            let consumed = before - input.len();
            let padding = (8 - consumed % 8) % 8;
            if take(&mut input, padding)?.iter().any(|byte| *byte != 0) {
                return Err("invalid Git index padding".into());
            }
        }
    }
    Ok(input)
}

fn valid_path(bytes: &[u8]) -> bool {
    let Ok(path) = std::str::from_utf8(bytes) else {
        return false;
    };
    if path.is_empty() || path.len() > 4096 || path.split('/').count() > 128 {
        return false;
    }
    path.split('/').all(|part| {
        !part.is_empty()
            && part.len() <= 255
            && part != "."
            && part != ".."
            && !part.eq_ignore_ascii_case(".git")
            && !part.contains(['\\', '\0', ':'])
            && windows_safe_component(part)
    })
}

#[cfg(not(windows))]
const fn windows_safe_component(_: &str) -> bool {
    true
}

#[cfg(windows)]
fn windows_safe_component(part: &str) -> bool {
    if part.ends_with(['.', ' '])
        || part
            .chars()
            .any(|c| c < ' ' || matches!(c, '<' | '>' | '"' | '|' | '?' | '*'))
    {
        return false;
    }
    let stem = part.split('.').next().unwrap_or("");
    if ["CON", "PRN", "AUX", "NUL"]
        .iter()
        .any(|name| stem.eq_ignore_ascii_case(name))
    {
        return false;
    }
    let bytes = stem.as_bytes();
    !(bytes.len() == 4
        && (bytes[..3].eq_ignore_ascii_case(b"COM") || bytes[..3].eq_ignore_ascii_case(b"LPT"))
        && (b'1'..=b'9').contains(&bytes[3]))
}

fn collect_reuc(
    data: &mut &[u8],
    hash_len: usize,
    repo: &gix::Repository,
    ids: &mut BTreeSet<gix::hash::ObjectId>,
) -> Result<(), String> {
    let mut paths = 0usize;
    let mut stages = 0usize;
    while !data.is_empty() {
        paths += 1;
        if paths > MAX_ENTRIES {
            return Err("resolve-undo exceeds recovery entry limit".into());
        }
        if !valid_path(nul_field(data)?) {
            return Err("unsafe resolve-undo path".into());
        }
        let mut modes = [0u32; 3];
        for mode in &mut modes {
            let field = nul_field(data)?;
            if field.is_empty()
                || field.len() > 6
                || !field.iter().all(|b| (b'0'..=b'7').contains(b))
            {
                return Err("invalid resolve-undo mode".into());
            }
            let value = std::str::from_utf8(field).map_err(|_| "invalid resolve-undo mode")?;
            *mode = u32::from_str_radix(value, 8).map_err(|_| "invalid resolve-undo mode")?;
            if !matches!(*mode, 0 | 0o100_644 | 0o100_755 | 0o120_000) {
                return Err("unsupported resolve-undo mode".into());
            }
        }
        for mode in modes {
            if mode == 0 {
                continue;
            }
            stages += 1;
            if stages > MAX_ENTRIES {
                return Err("resolve-undo exceeds recovery object limit".into());
            }
            let raw = take(data, hash_len)?;
            let id =
                gix::hash::ObjectId::try_from(raw).map_err(|_| "invalid resolve-undo object ID")?;
            if id.is_null() {
                return Err("invalid resolve-undo object ID".into());
            }
            if ids.insert(id) {
                let header = repo
                    .find_header(id)
                    .map_err(|e| format!("cannot inspect resolve-undo object: {e}"))?;
                if header.kind() != gix::objs::Kind::Blob {
                    return Err("resolve-undo object is not a blob".into());
                }
            }
        }
    }
    Ok(())
}

/// Return all distinct REUC blob IDs from the exact captured index bytes.
pub(super) fn object_ids(
    index_bytes: &[u8],
    repo: &gix::Repository,
) -> Result<Vec<String>, String> {
    let hash_len = repo.object_hash().len_in_bytes();
    let mut input = extensions(index_bytes, hash_len)?;
    let mut ids = BTreeSet::new();
    let mut seen = false;
    while !input.is_empty() {
        let header = take(&mut input, 8)?;
        let size = be_u32(&header[4..8]) as usize;
        let mut data = take(&mut input, size)?;
        if &header[..4] == b"link" || &header[..4] == b"sdir" {
            return Err("split or sparse Git index is not supported".into());
        }
        if &header[..4] == b"REUC" {
            if seen {
                return Err("duplicate resolve-undo extension".into());
            }
            seen = true;
            collect_reuc(&mut data, hash_len, repo, &mut ids)?;
        }
    }
    Ok(ids.into_iter().map(|id| id.to_string()).collect())
}

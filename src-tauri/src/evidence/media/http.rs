//! Capability-only protocol responses; no URL component is treated as a path.

use tauri::http::{header, Method, Request, Response, StatusCode};

use super::{is_hex, MediaStore};

const MAX_RANGE: u64 = 8 * 1024 * 1024;

pub(super) fn respond(store: &MediaStore, request: &Request<Vec<u8>>) -> Response<Vec<u8>> {
    let mut response = respond_inner(store, request);
    if request.method() == Method::HEAD {
        response.body_mut().clear();
    }
    response
}

fn respond_inner(store: &MediaStore, request: &Request<Vec<u8>>) -> Response<Vec<u8>> {
    if request.method() != Method::GET && request.method() != Method::HEAD {
        return error(
            StatusCode::METHOD_NOT_ALLOWED,
            "method not allowed",
            Some(("allow", "GET, HEAD".into())),
        );
    }
    let Some(token) = request.uri().path().strip_prefix('/') else {
        return error(StatusCode::NOT_FOUND, "evidence source not found", None);
    };
    if request.uri().query().is_some() || !is_hex(token, 64) {
        return error(StatusCode::NOT_FOUND, "evidence source not found", None);
    }
    let artifact = match store.grants.lock() {
        Ok(grants) => match grants.get(token) {
            // The grant must outlive the lock so disk I/O never holds it.
            Some(grant) => grant.artifact.clone(),
            None => return error(StatusCode::NOT_FOUND, "evidence source not found", None),
        },
        Err(_) => {
            return error(
                StatusCode::INTERNAL_SERVER_ERROR,
                "evidence authorization unavailable",
                None,
            )
        }
    };
    let length = artifact.bytes;
    let video = artifact.mime.starts_with("video/");
    let range = if video {
        requested_range(request, length)
    } else {
        Ok(None)
    };
    let invalid_range = range.is_err();
    let range = range.unwrap_or(None);
    let (status, start, end) = match range {
        Some((start, end)) => (StatusCode::PARTIAL_CONTENT, start, end + 1),
        None => (StatusCode::OK, 0, length),
    };
    // Capture only the response bytes while hashing the complete file. HEAD
    // and invalid ranges still verify integrity without allocating the asset.
    let capture = if request.method() == Method::HEAD || invalid_range {
        None
    } else {
        Some((start, end))
    };
    let Ok(body) = store.verified_range(&artifact, capture) else {
        return error(
            StatusCode::GONE,
            "evidence file is missing or has been modified",
            None,
        );
    };
    // Revocation may have happened during disk I/O. Do not retain the grant
    // lock while streaming, but check it again before releasing any bytes.
    match store.grants.lock() {
        Ok(grants)
            if grants
                .get(token)
                .is_some_and(|grant| grant.artifact == artifact) => {}
        Ok(_) => return error(StatusCode::NOT_FOUND, "evidence source not found", None),
        Err(_) => {
            return error(
                StatusCode::INTERNAL_SERVER_ERROR,
                "evidence authorization unavailable",
                None,
            )
        }
    }
    if invalid_range {
        return error(
            StatusCode::RANGE_NOT_SATISFIABLE,
            "invalid evidence range",
            Some(("content-range", format!("bytes */{length}"))),
        );
    }
    let mut builder = Response::builder()
        .status(status)
        .header(header::CONTENT_TYPE, artifact.mime.as_str())
        .header(header::CONTENT_LENGTH, (end - start).to_string())
        .header(header::CACHE_CONTROL, "no-store")
        .header("x-content-type-options", "nosniff")
        .header("content-security-policy", "default-src 'none'; sandbox");
    if video {
        builder = builder.header(header::ACCEPT_RANGES, "bytes");
    }
    if range.is_some() {
        builder = builder.header(
            header::CONTENT_RANGE,
            format!("bytes {start}-{}/{length}", end - 1),
        );
    }
    builder
        .body(body)
        .unwrap_or_else(|_| Response::new(Vec::new()))
}

fn requested_range(request: &Request<Vec<u8>>, length: u64) -> Result<Option<(u64, u64)>, ()> {
    request
        .headers()
        .get(header::RANGE)
        .map_or(Ok(None), |value| {
            value
                .to_str()
                .ok()
                .and_then(|value| parse_range(value, length))
                .map(Some)
                .ok_or(())
        })
}

fn error(status: StatusCode, message: &str, extra: Option<(&str, String)>) -> Response<Vec<u8>> {
    let mut builder = Response::builder()
        .status(status)
        .header(header::CONTENT_TYPE, "text/plain; charset=utf-8")
        .header(header::CACHE_CONTROL, "no-store")
        .header("x-content-type-options", "nosniff");
    if let Some((name, value)) = extra {
        builder = builder.header(name, value);
    }
    builder
        .body(message.as_bytes().to_vec())
        .unwrap_or_else(|_| Response::new(Vec::new()))
}

// A single range only. Large ranges are shortened, never expanded; the
// returned Content-Range tells the browser which bytes it actually received.
fn parse_range(value: &str, length: u64) -> Option<(u64, u64)> {
    if length == 0 {
        return None;
    }
    let spec = value.strip_prefix("bytes=")?;
    if spec.contains(',') {
        return None;
    }
    let (first, last) = spec.split_once('-')?;
    if first.is_empty() {
        let count = last.parse::<u64>().ok()?;
        if count == 0 {
            return None;
        }
        let start = length.saturating_sub(count.min(MAX_RANGE));
        return Some((start, length - 1));
    }
    let start = first.parse::<u64>().ok()?;
    if start >= length {
        return None;
    }
    let end = if last.is_empty() {
        length - 1
    } else {
        last.parse::<u64>().ok()?.min(length - 1)
    };
    if end < start {
        return None;
    }
    Some((start, end.min(start.saturating_add(MAX_RANGE - 1))))
}

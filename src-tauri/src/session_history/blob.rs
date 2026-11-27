//! omp's blob store: user images of 1 KiB and more are persisted as
//! `blob:sha256:<hex>` references to files in `<agent dir>/blobs`, the
//! sibling of the sessions directory (omp's `getBlobsDir`). The webview
//! needs the base64 data, so the images of a returned page are read here.

use std::fs::File;
use std::io::Read;
use std::path::{Path, PathBuf};

use base64::engine::general_purpose::STANDARD;
use base64::Engine;

const PREFIX: &str = "blob:sha256:";

/// Largest blob read, in bytes.
const MAX_BLOB: u64 = 10 * 1024 * 1024;
/// Most blob bytes read for one page.
const MAX_PAGE: u64 = 32 * 1024 * 1024;

/// What an image block's `data` holds.
#[derive(Debug, PartialEq, Eq)]
pub enum Data<'a> {
    /// The image itself (base64), shown as is.
    Inline,
    /// A reference to blob `hash` (64 lowercase hex chars).
    Blob(&'a str),
    /// A reference omp itself refuses (`parseBlobRef`): never shown.
    Malformed,
}

/// Classify an image block's `data` as omp's `parseBlobRef` does.
pub fn classify(data: &str) -> Data<'_> {
    let Some(hash) = data.strip_prefix(PREFIX) else {
        return Data::Inline;
    };
    let canonical =
        hash.len() == 64 && hash.bytes().all(|b| matches!(b, b'0'..=b'9' | b'a'..=b'f'));
    if canonical {
        Data::Blob(hash)
    } else {
        Data::Malformed
    }
}

/// The blob store of one sessions root, with the page's byte budget.
pub struct Blobs {
    /// The canonical blobs directory; `None` when there is none.
    dir: Option<PathBuf>,
    left: u64,
}

impl Blobs {
    pub fn new(sessions_root: &Path) -> Self {
        Self {
            dir: sessions_root
                .parent()
                .and_then(|agent| agent.join("blobs").canonicalize().ok()),
            left: MAX_PAGE,
        }
    }

    /// The base64 data of blob `hash` (as [`classify`] returned it); `None`
    /// when it is missing, unreadable, outside the blobs directory, larger
    /// than 10 MiB, or past the page's 32 MiB.
    pub fn read(&mut self, hash: &str) -> Option<String> {
        let dir = self.dir.as_deref()?;
        // `hash` is hex only, yet the file may be a link pointing elsewhere.
        let path = dir.join(hash).canonicalize().ok()?;
        if !path.starts_with(dir) {
            return None;
        }
        let cap = MAX_BLOB.min(self.left);
        let file = File::open(&path).ok()?;
        let meta = file.metadata().ok()?;
        if !meta.is_file() || meta.len() > cap {
            return None;
        }
        let mut bytes = Vec::new();
        // `take`: a blob growing after the size check stays within the cap.
        file.take(cap + 1).read_to_end(&mut bytes).ok()?;
        let len = u64::try_from(bytes.len()).ok().filter(|&n| n <= cap)?;
        self.left -= len;
        Some(STANDARD.encode(bytes))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn classifies_references_like_omp() {
        let hash = "c215cd6852d45f68e0807fc48ab4c54647d6c1c194d6919435a6ea14acf6ef07";
        assert_eq!(classify("iVBORw0KGgo="), Data::Inline);
        assert_eq!(classify(&format!("blob:sha256:{hash}")), Data::Blob(hash));
        for bad in [
            format!("blob:sha256:{}", hash.to_uppercase()),
            format!("blob:sha256:{}", &hash[1..]),
            format!("blob:sha256:{hash}0"),
            format!("blob:sha256:../{}", &hash[3..]),
            "blob:sha256:".to_string(),
        ] {
            assert_eq!(classify(&bad), Data::Malformed, "{bad}");
        }
    }
}

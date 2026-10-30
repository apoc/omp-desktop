use std::fs;
use std::path::Path;

use tauri::http::{Request, StatusCode};

use super::{
    check_capacity, formats, remove_created, InboxHandle, MediaStore, MAX_TOTAL, TEXT_PREVIEW,
};
use crate::test_support::TempDir;

struct Fixture {
    dir: TempDir,
    store: MediaStore,
}

impl Fixture {
    fn new(name: &str) -> Self {
        let dir = TempDir::new("evidence-media", name);
        let store = MediaStore::new(Some(dir.path().join("assets")));
        Self { dir, store }
    }

    fn write(&self, name: &str, bytes: &[u8]) -> std::path::PathBuf {
        let path = self.dir.path().join(name);
        fs::write(&path, bytes).unwrap();
        path
    }
}

impl Drop for Fixture {
    fn drop(&mut self) {
        if let Ok(entries) = fs::read_dir(self.dir.path().join("assets")) {
            for entry in entries.flatten() {
                remove_created(&entry.path());
            }
        }
    }
}

fn request(method: &str, token: &str, range: Option<&str>) -> Request<Vec<u8>> {
    let mut builder = Request::builder()
        .method(method)
        .uri(format!("evidence://localhost/{token}"));
    if let Some(range) = range {
        builder = builder.header("range", range);
    }
    builder.body(Vec::new()).unwrap()
}

fn box_bytes(kind: [u8; 4], payload: &[u8]) -> Vec<u8> {
    let mut result = Vec::with_capacity(payload.len() + 8);
    result.extend_from_slice(&u32::try_from(payload.len() + 8).unwrap().to_be_bytes());
    result.extend_from_slice(&kind);
    result.extend_from_slice(payload);
    result
}

// A structurally valid set of boxes for transport tests, with a video track.
fn movie(payload_len: usize) -> Vec<u8> {
    let mut handler = vec![0; 8];
    handler.extend_from_slice(b"vide");
    let mut mdia = box_bytes(*b"hdlr", &handler);
    mdia.extend(box_bytes(*b"minf", &[1]));
    let moov = box_bytes(*b"moov", &box_bytes(*b"trak", &box_bytes(*b"mdia", &mdia)));
    let mut result = box_bytes(*b"ftyp", b"isom\0\0\0\0");
    result.extend(moov);
    result.extend(box_bytes(*b"mdat", &vec![0x5a; payload_len]));
    result
}

fn ebml_element(id: &[u8], payload: &[u8]) -> Vec<u8> {
    assert!(payload.len() < 127);
    let mut result = Vec::with_capacity(id.len() + 1 + payload.len());
    result.extend_from_slice(id);
    result.push(0x80 | u8::try_from(payload.len()).unwrap());
    result.extend_from_slice(payload);
    result
}

fn webm(tracks: &[u8]) -> Vec<u8> {
    let mut segment = ebml_element(b"\x16\x54\xae\x6b", tracks);
    segment.extend_from_slice(b"\x1f\x43\xb6\x75\x81\x00");
    webm_segment(&segment)
}

fn webm_segment(segment: &[u8]) -> Vec<u8> {
    let mut result = b"\x1a\x45\xdf\xa3\x87\x42\x82\x84webm".to_vec();
    result.extend(ebml_element(b"\x18\x53\x80\x67", segment));
    result
}

fn webm_video_track() -> Vec<u8> {
    ebml_element(
        b"\xae",
        b"\xd7\x81\x01\x73\xc5\x81\x01\x83\x81\x01\x86\x85V_VP8\xe0\x86\xb0\x81\x01\xba\x81\x01",
    )
}

fn webm_audio_track() -> Vec<u8> {
    ebml_element(
        b"\xae",
        b"\xd7\x81\x02\x73\xc5\x81\x02\x83\x81\x02\x86\x86A_OPUS\xe1\x89\xb5\x84\x47\x3b\x80\x00\x9f\x81\x01",
    )
}

fn png() -> Vec<u8> {
    let mut bytes = Vec::new();
    {
        let mut encoder = png::Encoder::new(&mut bytes, 1, 1);
        encoder.set_color(png::ColorType::Rgba);
        encoder.set_depth(png::BitDepth::Eight);
        let mut writer = encoder.write_header().unwrap();
        writer.write_image_data(&[1, 2, 3, 255]).unwrap();
    }
    bytes
}

#[test]
fn copies_durably_and_authenticates_all_metadata() {
    let fixture = Fixture::new("durable");
    let path = fixture.write("proof.txt", b"original proof");
    let artifact = fixture
        .store
        .import(&path, "user", Some("receipt.txt"))
        .unwrap();
    assert_eq!(artifact.mime, "text/plain");
    assert_eq!(artifact.bytes, 14);
    fs::write(&path, b"changed input").unwrap();
    assert_eq!(
        fixture.store.text(&artifact).unwrap()["text"],
        "original proof"
    );
    let reopened = MediaStore::new(Some(fixture.dir.path().join("assets")));
    assert_eq!(reopened.text(&artifact).unwrap()["text"], "original proof");
    assert!(reopened.source(&artifact, "epoch").is_ok());
    let mut forged = artifact;
    forged.owner = "agent".into();
    assert!(reopened.source(&forged, "epoch").is_err());
    forged.id = "../outside".into();
    assert!(reopened.text(&forged).is_err());
}

#[test]
fn recognizes_content_not_just_filenames_and_rejects_active_or_broken_formats() {
    let fixture = Fixture::new("formats");
    let image = png();
    let artifact = fixture
        .store
        .import(&fixture.write("photo.data", &image), "user", None)
        .unwrap();
    assert_eq!(artifact.mime, "image/png");
    assert!(fixture.store.text(&artifact).is_err());
    let mut corrupt = image;
    corrupt[20] ^= 1;
    assert!(fixture
        .store
        .import(&fixture.write("bad.png", &corrupt), "user", None)
        .is_err());
    assert!(fixture
        .store
        .import(
            &fixture.write("bad.jpg", b"\xff\xd8garbage\xff\xd9"),
            "user",
            None
        )
        .is_err());
    assert!(fixture
        .store
        .import(
            &fixture.write("bad.webm", b"\x1a\x45\xdf\xa3broken"),
            "user",
            None
        )
        .is_err());
    assert!(fixture
        .store
        .import(
            &fixture.write("bad.mp4", b"\0\0\0\x10ftypisom\0\0\0\0"),
            "user",
            None
        )
        .is_err());
    assert!(fixture
        .store
        .import(
            &fixture.write("fake.txt", b"  <!DOCTYPE html><html></html>"),
            "user",
            None
        )
        .is_err());
    assert!(fixture
        .store
        .import(
            &fixture.write("fake2.txt", b"<?xml version='1.0'?><svg></svg>"),
            "user",
            None
        )
        .is_err());
    assert!(fixture
        .store
        .import(
            &fixture.write("real.svg", b"ordinary text"),
            "user",
            Some("safe.txt")
        )
        .is_err());
    assert!(fixture
        .store
        .import(&fixture.write("binary", &[0, 1, 2]), "user", None)
        .is_err());
    let video = movie(128);
    assert_eq!(formats::classify(&video, "movie.mp4").unwrap(), "video/mp4");
    assert!(formats::classify(&video[..video.len() - 1], "movie.mp4").is_err());
    let webm = webm(&webm_video_track());
    assert_eq!(
        formats::classify(&webm, "movie.webm").unwrap(),
        "video/webm"
    );
    assert!(formats::classify(&webm[..webm.len() - 1], "movie.webm").is_err());
}

#[test]
fn webm_import_requires_a_video_track() {
    let fixture = Fixture::new("webm-tracks");
    let video = webm_video_track();
    let audio = webm_audio_track();

    for (name, tracks) in [
        ("video.webm", video.clone()),
        ("audio-video.webm", [&audio[..], &video[..]].concat()),
        ("video-audio.webm", [&video[..], &audio[..]].concat()),
    ] {
        let artifact = fixture
            .store
            .import(&fixture.write(name, &webm(&tracks)), "user", None)
            .unwrap();
        assert_eq!(artifact.mime, "video/webm");
    }

    assert!(fixture
        .store
        .import(&fixture.write("audio.webm", &webm(&audio)), "user", None)
        .is_err());
}

#[test]
fn webm_validates_bounded_track_declarations() {
    let valid_padded_type = ebml_element(b"\xae", b"\x83\x82\x00\x01");
    assert_eq!(
        formats::classify(&webm(&valid_padded_type), "movie.webm").unwrap(),
        "video/webm"
    );

    let cluster = b"\x1f\x43\xb6\x75\x81\x00";
    assert!(formats::classify(&webm_segment(cluster), "movie.webm").is_err());
    let mut unknown_tracks = b"\x16\x54\xae\x6b\xff".to_vec();
    unknown_tracks.extend(webm_video_track());
    unknown_tracks.extend_from_slice(cluster);
    assert!(formats::classify(&webm_segment(&unknown_tracks), "movie.webm").is_err());
    let mut empty_tracks_after_video = ebml_element(b"\x16\x54\xae\x6b", &webm_video_track());
    empty_tracks_after_video.extend(ebml_element(b"\x16\x54\xae\x6b", &[]));
    empty_tracks_after_video.extend_from_slice(cluster);
    assert!(formats::classify(&webm_segment(&empty_tracks_after_video), "movie.webm").is_err());

    for (name, tracks) in [
        ("empty tracks", Vec::new()),
        ("type outside entry", b"\x83\x81\x01".to_vec()),
        (
            "type nested in another element",
            ebml_element(b"\xae", b"\xe0\x83\x83\x81\x01"),
        ),
        (
            "non-video padded type",
            ebml_element(b"\xae", b"\x83\x82\x01\x01"),
        ),
    ] {
        assert!(
            formats::classify(&webm(&tracks), "movie.webm").is_err(),
            "{name}"
        );
    }

    let video = webm_video_track();
    for (name, invalid_entry) in [
        ("missing type", ebml_element(b"\xae", b"\xd7\x81\x01")),
        ("empty type", ebml_element(b"\xae", b"\x83\x80")),
        ("zero type", ebml_element(b"\xae", b"\x83\x81\x00")),
        (
            "oversized type",
            ebml_element(
                b"\xae",
                &ebml_element(b"\x83", &[0, 0, 0, 0, 0, 0, 0, 0, 1]),
            ),
        ),
        (
            "duplicate type",
            ebml_element(b"\xae", b"\x83\x81\x01\x83\x81\x02"),
        ),
        ("truncated type", ebml_element(b"\xae", b"\x83\x81")),
        ("unknown entry size", b"\xae\xff\x83\x81\x01".to_vec()),
    ] {
        assert!(
            formats::classify(&webm(&invalid_entry), "movie.webm").is_err(),
            "{name}"
        );
        assert!(
            formats::classify(
                &webm(&[&video[..], &invalid_entry[..]].concat()),
                "movie.webm"
            )
            .is_err(),
            "{name} after a video track"
        );
    }
}

#[test]
fn bounds_text_and_total_storage_and_reports_preview_truncation() {
    let fixture = Fixture::new("limits");
    let exact = vec![b'a'; 1024 * 1024];
    let artifact = fixture
        .store
        .import(&fixture.write("exact.txt", &exact), "user", None)
        .unwrap();
    let preview = fixture.store.text(&artifact).unwrap();
    assert_eq!(preview["text"].as_str().unwrap().len(), TEXT_PREVIEW);
    assert_eq!(preview["truncated"], true);
    let large = vec![b'a'; 1024 * 1024 + 1];
    assert!(fixture
        .store
        .import(&fixture.write("large.txt", &large), "user", None)
        .is_err());
    let root = fixture.dir.path().join("assets");
    assert!(check_capacity(&root, MAX_TOTAL).is_err());
}

#[test]
fn tokens_are_opaque_scoped_revocable_and_never_resolve_paths() {
    let fixture = Fixture::new("tokens");
    let artifact = fixture
        .store
        .import(&fixture.write("proof.txt", b"proof"), "agent", None)
        .unwrap();
    let one = fixture.store.source(&artifact, "epoch-one").unwrap();
    let two = fixture.store.source(&artifact, "epoch-two").unwrap();
    assert_ne!(one.token, two.token);
    assert_eq!(one.token.len(), 64);
    let response = fixture.store.response(&request("GET", &one.token, None));
    assert_eq!(response.status(), StatusCode::OK);
    assert_eq!(response.body().as_slice(), b"proof");
    assert_eq!(response.headers()["x-content-type-options"], "nosniff");
    assert_eq!(
        fixture
            .store
            .response(&request("POST", &one.token, None))
            .status(),
        StatusCode::METHOD_NOT_ALLOWED
    );
    assert_eq!(
        fixture
            .store
            .response(&request("GET", "../proof.txt", None))
            .status(),
        StatusCode::NOT_FOUND
    );
    assert_eq!(
        fixture
            .store
            .response(&request("GET", &"0".repeat(64), None))
            .status(),
        StatusCode::NOT_FOUND
    );
    fixture.store.revoke("epoch-one");
    assert_eq!(
        fixture
            .store
            .response(&request("GET", &one.token, None))
            .status(),
        StatusCode::NOT_FOUND
    );
    assert_eq!(
        fixture
            .store
            .response(&request("GET", &two.token, None))
            .status(),
        StatusCode::OK
    );
}

#[test]
fn reopening_previews_reuses_scoped_capabilities_without_exhausting_other_tabs() {
    let fixture = Fixture::new("reopen");
    let artifact = fixture
        .store
        .import(
            &fixture.write("proof.txt", b"reopenable proof"),
            "session",
            None,
        )
        .unwrap();
    let original = fixture.store.source(&artifact, "tab-one").unwrap();
    for _ in 0..=super::MAX_GRANTS {
        let opened = fixture.store.source(&artifact, "tab-one").unwrap();
        assert_eq!(opened.token, original.token);
    }
    std::thread::scope(|scope| {
        for _ in 0..4 {
            scope.spawn(|| {
                for _ in 0..16 {
                    assert_eq!(
                        fixture.store.source(&artifact, "tab-one").unwrap().token,
                        original.token
                    );
                }
            });
        }
    });
    let other = fixture.store.source(&artifact, "tab-two").unwrap();
    assert_ne!(other.token, original.token);
    assert_eq!(
        fixture
            .store
            .response(&request("GET", &other.token, None))
            .body()
            .as_slice(),
        b"reopenable proof"
    );
    fixture.store.revoke("tab-one");
    assert_eq!(
        fixture
            .store
            .response(&request("GET", &original.token, None))
            .status(),
        StatusCode::NOT_FOUND
    );
    assert_eq!(
        fixture
            .store
            .response(&request("GET", &other.token, None))
            .status(),
        StatusCode::OK
    );
}

#[test]
fn video_ranges_and_head_are_bounded_and_well_formed() {
    let fixture = Fixture::new("ranges");
    let contents = movie(8 * 1024 * 1024 + 256);
    let artifact = fixture
        .store
        .import(&fixture.write("clip.mp4", &contents), "user", None)
        .unwrap();
    let token = fixture.store.source(&artifact, "e").unwrap().token;
    let response = fixture
        .store
        .response(&request("GET", &token, Some("bytes=2-5")));
    assert_eq!(response.status(), StatusCode::PARTIAL_CONTENT);
    assert_eq!(response.body().as_slice(), &contents[2..6]);
    assert!(response.body().capacity() < 64 * 1024);
    assert_eq!(
        response.headers()["content-range"].to_str().unwrap(),
        format!("bytes 2-5/{}", contents.len())
    );
    let response = fixture
        .store
        .response(&request("GET", &token, Some("bytes=65534-65538")));
    assert_eq!(response.body().as_slice(), &contents[65534..65539]);
    assert!(response.body().capacity() < 64 * 1024);
    assert_eq!(
        response.headers()["content-range"].to_str().unwrap(),
        format!("bytes 65534-65538/{}", contents.len())
    );
    let response = fixture
        .store
        .response(&request("GET", &token, Some("bytes=0-")));
    assert_eq!(response.body().len(), 8 * 1024 * 1024);
    let response = fixture
        .store
        .response(&request("GET", &token, Some("bytes=-3")));
    assert_eq!(response.body().as_slice(), &contents[contents.len() - 3..]);
    let response = fixture
        .store
        .response(&request("HEAD", &token, Some("bytes=1-3")));
    assert_eq!(response.status(), StatusCode::PARTIAL_CONTENT);
    assert_eq!(response.headers()["content-length"], "3");
    assert_eq!(response.body().as_slice(), b"");
    assert_eq!(response.body().capacity(), 0);
    for value in [
        "bytes=999999999-",
        "bytes=4-2",
        "bytes=-0",
        "bytes=0-1,4-5",
        "bad",
    ] {
        let response = fixture.store.response(&request("GET", &token, Some(value)));
        assert_eq!(response.status(), StatusCode::RANGE_NOT_SATISFIABLE);
        assert_eq!(
            response.headers()["content-range"].to_str().unwrap(),
            format!("bytes */{}", contents.len())
        );
    }
}

#[test]
fn ranged_and_head_responses_detect_tampering_outside_the_requested_bytes() {
    let fixture = Fixture::new("range-integrity");
    let mut contents = movie(128 * 1024);
    let artifact = fixture
        .store
        .import(&fixture.write("clip.mp4", &contents), "user", None)
        .unwrap();
    let token = fixture.store.source(&artifact, "epoch").unwrap().token;
    let stored = fixture.dir.path().join("assets").join(&artifact.id);
    remove_created(&stored);
    let last = contents.len() - 1;
    contents[last] ^= 1;
    fs::write(&stored, &contents).unwrap();
    assert_eq!(
        fixture
            .store
            .response(&request("GET", &token, Some("bytes=0-3")))
            .status(),
        StatusCode::GONE
    );
    assert_eq!(
        fixture
            .store
            .response(&request("HEAD", &token, None))
            .status(),
        StatusCode::GONE
    );
    assert_eq!(
        fixture
            .store
            .response(&request("GET", &token, Some("bytes=999999999-")))
            .status(),
        StatusCode::GONE
    );
}

#[test]
fn tampered_and_missing_files_are_explicit_errors_even_after_authorization() {
    let fixture = Fixture::new("missing");
    let artifact = fixture
        .store
        .import(&fixture.write("proof.txt", b"proof"), "user", None)
        .unwrap();
    let token = fixture.store.source(&artifact, "e").unwrap().token;
    let stored = fixture.dir.path().join("assets").join(&artifact.id);
    remove_created(&stored);
    fs::write(&stored, b"other").unwrap();
    assert!(fixture
        .store
        .text(&artifact)
        .unwrap_err()
        .contains("modified"));
    assert_eq!(
        fixture
            .store
            .response(&request("GET", &token, None))
            .status(),
        StatusCode::GONE
    );
    fs::remove_file(&stored).unwrap();
    assert!(fixture
        .store
        .source(&artifact, "e")
        .unwrap_err()
        .contains("missing"));
    assert_eq!(
        fixture
            .store
            .response(&request("HEAD", &token, None))
            .status(),
        StatusCode::GONE
    );
    assert_eq!(
        fixture
            .store
            .response(&request("HEAD", &token, None))
            .body()
            .as_slice(),
        b""
    );
}

#[test]
fn rejects_unavailable_roots_traversal_and_non_files() {
    let fixture = Fixture::new("paths");
    let file = fixture.write("proof.txt", b"proof");
    let no_storage = MediaStore::new(None);
    assert!(no_storage
        .import(&file, "user", None)
        .unwrap_err()
        .contains("unavailable"));
    assert!(fixture
        .store
        .import(fixture.dir.path(), "user", None)
        .is_err());
    assert!(fixture
        .store
        .import(&fixture.dir.path().join("any/../proof.txt"), "user", None)
        .is_err());
    assert!(fixture
        .store
        .import(&file, "user", Some("../proof.txt"))
        .is_err());
    assert!(fixture
        .store
        .import(Path::new("/definitely-not-an-evidence-file"), "user", None)
        .is_err());
}

#[test]
fn inbox_handle_reads_only_relative_regular_file_names() {
    let fixture = Fixture::new("inbox");
    let directory = fixture.dir.path().join("inbox");
    fs::create_dir(&directory).unwrap();
    fs::write(directory.join("proof.txt"), b"inbox proof").unwrap();
    let inbox = InboxHandle::open(&directory).unwrap();
    let artifact = fixture
        .store
        .import_inbox(&inbox, "proof.txt", "agent", None)
        .unwrap();
    assert_eq!(
        fixture.store.text(&artifact).unwrap()["text"],
        "inbox proof"
    );
    for bad in ["", ".", "..", "../proof.txt", "/proof.txt", "a\\b", "a:b"] {
        assert!(fixture
            .store
            .import_inbox(&inbox, bad, "agent", None)
            .is_err());
    }
}

#[cfg(windows)]
#[test]
fn inbox_rejects_hardlinked_files_on_windows() {
    let fixture = Fixture::new("inbox-hardlink");
    let directory = fixture.dir.path().join("inbox");
    fs::create_dir(&directory).unwrap();
    let external = fixture.write("external.txt", b"secret");
    fs::hard_link(&external, directory.join("link.txt")).unwrap();
    let inbox = InboxHandle::open(&directory).unwrap();
    assert!(fixture
        .store
        .import_inbox(&inbox, "link.txt", "agent", None)
        .is_err());
}

#[cfg(unix)]
#[test]
fn inbox_handle_survives_replacement_and_rejects_symlinks_and_hardlinks() {
    use std::os::unix::fs::symlink;
    let fixture = Fixture::new("inbox-replacement");
    let directory = fixture.dir.path().join("inbox");
    fs::create_dir(&directory).unwrap();
    fs::write(directory.join("proof.txt"), b"original").unwrap();
    let inbox = InboxHandle::open(&directory).unwrap();
    let moved = fixture.dir.path().join("moved");
    fs::rename(&directory, &moved).unwrap();
    fs::create_dir(&directory).unwrap();
    fs::write(directory.join("proof.txt"), b"replacement").unwrap();
    let artifact = fixture
        .store
        .import_inbox(&inbox, "proof.txt", "agent", None)
        .unwrap();
    assert_eq!(fixture.store.text(&artifact).unwrap()["text"], "original");
    let external = fixture.write("external.txt", b"secret");
    symlink(&external, moved.join("link")).unwrap();
    assert!(fixture
        .store
        .import_inbox(&inbox, "link", "agent", None)
        .is_err());
    fs::hard_link(&external, moved.join("hardlink")).unwrap();
    assert!(fixture
        .store
        .import_inbox(&inbox, "hardlink", "agent", None)
        .is_err());
    let symlinked = fixture.dir.path().join("linked-inbox");
    symlink(&moved, &symlinked).unwrap();
    assert!(InboxHandle::open(&symlinked).is_err());
}

#[cfg(unix)]
#[test]
fn rejects_symlink_imports_roots_and_stored_assets() {
    use std::os::unix::fs::symlink;
    let fixture = Fixture::new("symlinks");
    let file = fixture.write("proof.txt", b"proof");
    let link = fixture.dir.path().join("link.txt");
    symlink(&file, &link).unwrap();
    assert!(fixture.store.import(&link, "user", None).is_err());
    let artifact = fixture.store.import(&file, "user", None).unwrap();
    let asset = fixture.dir.path().join("assets").join(&artifact.id);
    remove_created(&asset);
    symlink(&file, &asset).unwrap();
    assert!(fixture.store.source(&artifact, "epoch").is_err());
    let linked_root = fixture.dir.path().join("linked-root");
    symlink(fixture.dir.path().join("assets"), &linked_root).unwrap();
    assert!(MediaStore::new(Some(linked_root))
        .source(&artifact, "epoch")
        .is_err());
}

use std::fs::File;
use std::io::{Cursor, Write};
use std::path::Path;

use zip::write::SimpleFileOptions;
use zip::{CompressionMethod, ZipWriter};

const IMAGE_EXTS: [&str; 7] = ["jpg", "jpeg", "png", "gif", "webp", "bmp", "avif"];

const ENCRYPTED_ERR: &str = "encrypted archives are not supported";

/// True when `name` ends with a known image extension. Avoids per-call
/// `format!(".{ext}")` allocation by slicing after the last `.`.
fn has_image_ext(name: &str) -> bool {
    let lower = name.to_lowercase();
    match lower.rfind('.') {
        Some(i) => IMAGE_EXTS.contains(&&lower[i + 1..]),
        None => false,
    }
}

fn is_keepable(name: &str) -> bool {
    if name.to_lowercase().ends_with("comicinfo.xml") {
        return true;
    }
    has_image_ext(name)
}

/// Packs (name, bytes) members into a STORE-mode (uncompressed) zip. Members
/// are written sorted by name (page order). Errors if no image pages.
fn pack_cbz(mut members: Vec<(String, Vec<u8>)>) -> Result<Vec<u8>, String> {
    members.sort_by(|a, b| a.0.cmp(&b.0));
    if !members.iter().any(|(n, _)| has_image_ext(n)) {
        return Err("no readable pages".into());
    }
    let mut cursor = Cursor::new(Vec::new());
    {
        let mut zip = ZipWriter::new(&mut cursor);
        let opts = SimpleFileOptions::default()
            .compression_method(CompressionMethod::Stored)
            .last_modified_time(zip::DateTime::default());
        for (name, bytes) in members {
            zip.start_file(name, opts).map_err(|e| e.to_string())?;
            zip.write_all(&bytes).map_err(|e| e.to_string())?;
        }
        zip.finish().map_err(|e| e.to_string())?;
    }
    Ok(cursor.into_inner())
}

/// Extracts keepable members from a RAR/CBR archive using the `unrar` crate.
/// Reads each file entry into memory, preserving on-disk entry order; rejects
/// encrypted entries.
fn extract_rar(src: &Path) -> Result<Vec<(String, Vec<u8>)>, String> {
    let mut members: Vec<(String, Vec<u8>)> = Vec::new();
    let mut archive = unrar::Archive::new(src)
        .open_for_processing()
        .map_err(|e| e.to_string())?;
    while let Some(header) = archive.read_header().map_err(|e| e.to_string())? {
        let entry = header.entry();
        if entry.is_encrypted() {
            return Err(ENCRYPTED_ERR.into());
        }
        let name = entry.filename.to_string_lossy().replace('\\', "/");
        if entry.is_file() && is_keepable(&name) {
            let (data, rest) = header.read().map_err(|e| e.to_string())?;
            members.push((name, data));
            archive = rest;
        } else {
            archive = header.skip().map_err(|e| e.to_string())?;
        }
    }
    Ok(members)
}

/// Extracts keepable members from a 7z/CB7 archive using the `sevenz-rust2`
/// crate. Opens with an empty password; a password/encryption error maps to the
/// shared "encrypted archives are not supported" message.
fn extract_7z(src: &Path) -> Result<Vec<(String, Vec<u8>)>, String> {
    let mut reader = sevenz_rust2::SevenZReader::open(src, sevenz_rust2::Password::empty())
        .map_err(map_7z_err)?;
    let mut members: Vec<(String, Vec<u8>)> = Vec::new();
    reader
        .for_each_entries(|entry, rd| {
            if !entry.is_directory() && entry.has_stream() && is_keepable(entry.name()) {
                let mut bytes = Vec::with_capacity(entry.size() as usize);
                rd.read_to_end(&mut bytes)?;
                members.push((entry.name().replace('\\', "/"), bytes));
            }
            Ok(true)
        })
        .map_err(map_7z_err)?;
    Ok(members)
}

/// Maps a `sevenz-rust2` error to a user-facing string, collapsing
/// password/encryption errors to the shared encrypted-archive message.
fn map_7z_err(err: sevenz_rust2::Error) -> String {
    match err {
        sevenz_rust2::Error::PasswordRequired | sevenz_rust2::Error::MaybeBadPassword(_) => {
            ENCRYPTED_ERR.to_string()
        }
        other => other.to_string(),
    }
}

fn convert_sync(src_path: &str) -> Result<String, String> {
    let src = Path::new(src_path);
    if !src.is_file() {
        return Err(format!("file not found: {src_path}"));
    }
    let ext = src
        .extension()
        .and_then(|e| e.to_str())
        .unwrap_or("")
        .to_lowercase();
    let members = match ext.as_str() {
        "cbr" | "rar" => extract_rar(src)?,
        "cb7" | "7z" => extract_7z(src)?,
        other => return Err(format!("unsupported archive extension: {other}")),
    };
    let cbz = pack_cbz(members)?;
    let stem = src.file_stem().and_then(|s| s.to_str()).unwrap_or("comic");
    // Process-local counter keeps temp names unique across concurrent
    // conversions of same-basename archives (importer runs with concurrency).
    static COUNTER: std::sync::atomic::AtomicUsize = std::sync::atomic::AtomicUsize::new(0);
    let count = COUNTER.fetch_add(1, std::sync::atomic::Ordering::Relaxed);
    let dst =
        std::env::temp_dir().join(format!("readest-{stem}-{}-{count}.cbz", std::process::id()));
    let mut f = File::create(&dst).map_err(|e| e.to_string())?;
    f.write_all(&cbz).map_err(|e| e.to_string())?;
    Ok(dst.to_string_lossy().to_string())
}

/// Converts a CBR/CB7 archive at `src_path` to a STORE-mode CBZ in the temp
/// dir and returns the produced `.cbz` path. Caller reads it back + deletes it.
#[tauri::command]
pub async fn convert_to_cbz(src_path: String) -> Result<String, String> {
    tauri::async_runtime::spawn_blocking(move || convert_sync(&src_path))
        .await
        .map_err(|e| format!("join error: {e}"))?
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn pack_orders_and_stores_images() {
        let png = vec![0x89, 0x50, 0x4e, 0x47];
        let members = vec![
            ("02.png".to_string(), png.clone()),
            ("01.png".to_string(), png.clone()),
            ("ComicInfo.xml".to_string(), b"<ComicInfo/>".to_vec()),
        ];
        let cbz = pack_cbz(members).unwrap();
        let mut zip = zip::ZipArchive::new(Cursor::new(cbz)).unwrap();
        let names: Vec<String> = (0..zip.len())
            .map(|i| zip.by_index(i).unwrap().name().to_string())
            .collect();
        assert_eq!(names, vec!["01.png", "02.png", "ComicInfo.xml"]);
        // assert all entries are Stored (uncompressed)
        let e = zip.by_index(0).unwrap();
        assert_eq!(e.compression(), zip::CompressionMethod::Stored);
    }
    #[test]
    fn pack_is_byte_deterministic() {
        let png = vec![0x89, 0x50, 0x4e, 0x47];
        let members = vec![
            ("01.png".to_string(), png.clone()),
            ("02.png".to_string(), png.clone()),
        ];
        let a = pack_cbz(members.clone()).unwrap();
        let b = pack_cbz(members).unwrap();
        assert_eq!(a, b);
    }
    #[test]
    fn pack_rejects_imageless_archive() {
        let members = vec![("readme.txt".to_string(), b"hi".to_vec())];
        assert_eq!(pack_cbz(members).unwrap_err(), "no readable pages");
    }
    #[test]
    fn is_keepable_filters() {
        assert!(is_keepable("pages/01.JPG"));
        assert!(is_keepable("ComicInfo.xml"));
        assert!(!is_keepable("thumbs.db"));
    }
}

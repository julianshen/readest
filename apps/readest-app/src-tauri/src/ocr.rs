//! Tauri command wrappers for the on-device comic OCR pipeline. The detection /
//! OCR / ONNX-runtime logic lives in the GTK-free `manga-ocr` crate so it is
//! unit-testable without the desktop toolchain; these are thin async wrappers
//! that run the (CPU-bound) work off the UI thread.

use futures_util::StreamExt;
use sha2::{Digest, Sha256};
use std::fs;
use std::io::Write;
use tauri::{Emitter, Manager};

use manga_ocr::page::DetectedRegion;
use manga_ocr::runtime::selftest;

/// Cached OCR pipeline, loaded once on first `ocr_page_regions` call and reused
/// across calls. Only built on Android, where `manga-ocr` is compiled with the
/// `onnx` feature (so `OcrPipeline` exists). `ort`'s `Session` is `Send`, so the
/// pipeline can live behind a `Mutex` shared across `spawn_blocking` calls.
#[cfg(target_os = "android")]
static OCR_PIPELINE: std::sync::Mutex<Option<(String, manga_ocr::pipeline::OcrPipeline)>> =
    std::sync::Mutex::new(None);

/// Smoke-tests the ONNX runtime end to end from the JS layer. Returns
/// `[2.0, 3.0, 4.0]` when the runtime is healthy — used to verify ONNX Runtime
/// links and runs on a platform (notably Android, via the load-dynamic dylib).
#[tauri::command]
pub async fn ocr_runtime_selftest() -> Result<Vec<f32>, String> {
    tauri::async_runtime::spawn_blocking(selftest)
        .await
        .map_err(|e| format!("join: {e}"))?
}

/// Download the OCR model files for `lang` into the app's model cache, verifying
/// each against its expected SHA-256 and emitting `ocr-model-download` progress
/// events per chunk. Files already present and matching their checksum are
/// skipped. Writes to a `.part` file then atomically renames so a partial
/// download can't be mistaken for a complete one. Downloading works on any
/// platform (it just fetches files); running the models is Android-only.
#[tauri::command]
pub async fn ensure_ocr_models(app: tauri::AppHandle, lang: String) -> Result<(), String> {
    let manifest = manga_ocr::models::manifest_for(&lang)
        .ok_or_else(|| format!("unsupported OCR language: {lang}"))?;

    let cache_dir = app
        .path()
        .app_data_dir()
        .map_err(|e| e.to_string())?
        .join("ocr-models")
        .join(&lang);
    fs::create_dir_all(&cache_dir).map_err(|e| e.to_string())?;

    for f in manifest {
        let target = cache_dir.join(f.name);
        if target.exists() {
            if let Ok(existing) = fs::read(&target) {
                if manga_ocr::models::verify_sha256(&existing, f.sha256) {
                    continue;
                }
            }
        }

        let resp = reqwest::get(f.url).await.map_err(|e| e.to_string())?;
        let total = resp.content_length().unwrap_or(0);
        let mut stream = resp.bytes_stream();

        // Stream chunks straight to the `.part` file while feeding the hasher
        // incrementally, so a 118 MB file never sits fully in RAM.
        let part = cache_dir.join(format!("{}.part", f.name));
        let mut file = fs::File::create(&part).map_err(|e| e.to_string())?;
        let mut hasher = Sha256::new();
        let mut received = 0u64;
        while let Some(chunk) = stream.next().await {
            let chunk = chunk.map_err(|e| e.to_string())?;
            file.write_all(&chunk).map_err(|e| e.to_string())?;
            hasher.update(&chunk);
            received += chunk.len() as u64;
            let _ = app.emit(
                "ocr-model-download",
                serde_json::json!({ "file": f.name, "received": received, "total": total }),
            );
        }
        file.flush().map_err(|e| e.to_string())?;

        let digest = hex::encode(hasher.finalize());
        if !digest.eq_ignore_ascii_case(f.sha256) {
            let _ = fs::remove_file(&part);
            return Err(format!("checksum mismatch for {}", f.name));
        }

        fs::rename(&part, &target).map_err(|e| e.to_string())?;
    }

    Ok(())
}

/// Cheap existence check: returns `true` when all model files for `lang` are
/// present and non-empty, without reading or SHA-verifying them. Used by the
/// frontend to skip the confirm + download flow when models are already cached.
#[tauri::command]
pub async fn ocr_models_present(app: tauri::AppHandle, lang: String) -> Result<bool, String> {
    let Some(manifest) = manga_ocr::models::manifest_for(&lang) else {
        return Ok(false);
    };
    let dir = app
        .path()
        .app_data_dir()
        .map_err(|e| e.to_string())?
        .join("ocr-models")
        .join(&lang);
    Ok(manifest.iter().all(|f| {
        std::fs::metadata(dir.join(f.name))
            .map(|m| m.len() > 0)
            .unwrap_or(false)
    }))
}

/// Detect + OCR a comic page into translatable regions (image-pixel boxes +
/// original text). On Android this runs the real ONNX pipeline against the
/// models downloaded by [`ensure_ocr_models`]; on other platforms on-device OCR
/// isn't wired up yet and this returns an error. `app` is injected by Tauri, so
/// the JS caller is unaffected (it still passes `{ imageBytes, sourceLang }`).
#[tauri::command]
pub async fn ocr_page_regions(
    app: tauri::AppHandle,
    image_bytes: Vec<u8>,
    source_lang: String,
) -> Result<Vec<DetectedRegion>, String> {
    #[cfg(target_os = "android")]
    {
        let cache_dir = app
            .path()
            .app_data_dir()
            .map_err(|e| e.to_string())?
            .join("ocr-models")
            .join(&source_lang);
        tauri::async_runtime::spawn_blocking(move || {
            let mut guard = OCR_PIPELINE
                .lock()
                .unwrap_or_else(|poisoned| poisoned.into_inner());
            // (Re)load when empty or when the requested language differs from the
            // currently-loaded engine.
            if guard
                .as_ref()
                .map(|(l, _)| l != &source_lang)
                .unwrap_or(true)
            {
                let pipeline = manga_ocr::pipeline::OcrPipeline::load(&cache_dir, &source_lang)
                    .map_err(|e| format!("load OCR models (call ensure_ocr_models first?): {e}"))?;
                *guard = Some((source_lang.clone(), pipeline));
            }
            guard.as_mut().unwrap().1.run(&image_bytes)
        })
        .await
        .map_err(|e| format!("join: {e}"))?
    }
    #[cfg(not(target_os = "android"))]
    {
        let _ = (&app, &image_bytes, &source_lang);
        Err("On-device OCR isn't available on this platform yet".to_string())
    }
}

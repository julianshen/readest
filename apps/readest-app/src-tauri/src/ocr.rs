//! Tauri command wrappers for the on-device comic OCR pipeline. The detection /
//! OCR / ONNX-runtime logic lives in the GTK-free `manga-ocr` crate so it is
//! unit-testable without the desktop toolchain; these are thin async wrappers
//! that run the (CPU-bound) work off the UI thread.

use manga_ocr::page::{detect_and_ocr, DetectedRegion};
use manga_ocr::runtime::selftest;

/// Smoke-tests the ONNX runtime end to end from the JS layer. Returns
/// `[2.0, 3.0, 4.0]` when the runtime is healthy — used to verify ONNX Runtime
/// links and runs on a platform (notably Android, via the load-dynamic dylib).
#[tauri::command]
pub async fn ocr_runtime_selftest() -> Result<Vec<f32>, String> {
    tauri::async_runtime::spawn_blocking(selftest)
        .await
        .map_err(|e| format!("join: {e}"))?
}

/// Detect + OCR a comic page into translatable regions (image-pixel boxes +
/// original text). Phase 1a returns deterministic stub regions sized to the
/// page so the frontend overlay can be exercised against real IPC.
#[tauri::command]
pub async fn ocr_page_regions(
    image_bytes: Vec<u8>,
    source_lang: String,
) -> Result<Vec<DetectedRegion>, String> {
    tauri::async_runtime::spawn_blocking(move || detect_and_ocr(&image_bytes, &source_lang))
        .await
        .map_err(|e| format!("join: {e}"))?
}

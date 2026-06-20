//! On-device comic OCR primitives. GTK-free so it is unit-testable without the
//! Tauri desktop toolchain. The Tauri lib wraps these in #[tauri::command]s.
pub mod models;
pub mod page;
pub mod preprocess;
pub mod runtime;

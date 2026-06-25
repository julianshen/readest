//! On-device comic OCR primitives. GTK-free so it is unit-testable without the
//! Tauri desktop toolchain. The Tauri lib wraps these in #[tauri::command]s.
pub mod ctc;
pub mod detect;
pub mod lines;
pub mod models;
pub mod page;
pub mod pipeline;
pub mod preprocess;
pub mod recognize;
pub mod runtime;
pub mod tokenizer;

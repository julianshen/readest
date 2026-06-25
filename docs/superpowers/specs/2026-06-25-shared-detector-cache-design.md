# Shared detector cache (design)

**Goal:** Download the language-agnostic `comic-text-detector.onnx` (~94 MB) **once** into a shared cache dir and reference it from every OCR language, instead of re-downloading it into each `ocr-models/<lang>/` directory.

**Scope:** the on-device comic OCR model cache only — Rust `models.rs`, `src-tauri/src/ocr.rs`, `pipeline.rs`. **Out of scope:** no new hosted models, no UX/TS change, no other backlog optimization.

## Background (verified against current code)

- `comic-text-detector.onnx` is language-agnostic and **identical** across ja/ko/zh — same URL + SHA, referenced via the `JA_DETECTOR_URL`/`JA_DETECTOR_SHA` consts in `models.rs` (single source of truth).
- Today every path roots at `app_data_dir/ocr-models/<lang>/`:
  - `ensure_ocr_models(lang)` downloads **all** files in `manifest_for(lang)` into `ocr-models/<lang>/`.
  - `ocr_models_present(lang)` checks them there.
  - `ocr_page_regions` calls `OcrPipeline::load(ocr-models/<lang>, lang)`, which loads the detector from `<dir>/comic-text-detector.onnx` and the per-lang engine files from `<dir>`.
- **Cost:** a user who reads ja + ko + zh downloads the 94 MB detector **3×** (~282 MB) and stores 3 copies.

## Design

### Cache layout
- `ocr-models/shared/comic-text-detector.onnx` — the shared detector.
- `ocr-models/<lang>/…` — per-language files only (ja: `encoder_model.onnx`/`decoder_model.onnx`/`vocab.txt`; ko/zh: `rec.onnx` + `dict.txt`).

### `ModelFile.shared` (models.rs)
Add `pub shared: bool` to `ModelFile`. Detector entries in the ja/ko/zh manifests set `shared: true`; all other entries `false`. Add a `pub const OCR_SHARED_DIR: &str = "shared";` for the dir name (single source of truth, used by `ocr.rs`).

### Download + presence (ocr.rs)
- `ensure_ocr_models(lang)`: compute `models_root = app_data_dir/ocr-models`, `shared_dir = models_root/shared`, `lang_dir = models_root/<lang>`. For each manifest file, `target_dir = if f.shared { &shared_dir } else { &lang_dir }`; create dirs as needed. The existing per-file SHA-skip + streamed `.part` + atomic-rename logic is unchanged except for the routed `target_dir`.
- **Migration (migrate-move), before downloading a `shared` file:** if `shared_dir/<name>` is absent but `lang_dir/<name>` exists and matches its SHA, `fs::rename` it into `shared_dir` (no re-download). After the file is ensured present in `shared_dir`, remove any leftover `lang_dir/<name>` copy (orphan cleanup). A rename failure is non-fatal — fall through to normal download.
- `ocr_models_present(lang)`: check each manifest file in its routed dir (`shared_dir` if `f.shared` else `lang_dir`).

### Load (pipeline.rs)
Change `OcrPipeline::load(model_dir, lang)` → `OcrPipeline::load(detector_path: &Path, lang_dir: &Path, lang: &str)`: load the detector from `detector_path`, the per-lang engine files from `lang_dir`. `ocr.rs ocr_page_regions` passes `shared_dir/comic-text-detector.onnx` + `lang_dir`. (The crate's ignored E2E test passes both — the same fixture dir works for both args.)

## Error handling
- Missing shared detector at load → the existing `load OCR models (call ensure_ocr_models first?)` error (unchanged).
- Migration `fs::rename` failure → non-fatal; falls through to a normal download.
- Checksum-mismatch / `.part` cleanup logic unchanged.

## Data flow (after)
First use of a language: `ensure_ocr_models(lang)` → detector to `shared/` (or migrated from a lang dir), per-lang files to `<lang>/` → `ocr_page_regions` → `OcrPipeline::load(shared/detector, <lang>)`. A second language reuses the already-present `shared/` detector — no re-download.

## Testing
- **Crate unit (models.rs):** each manifest's detector entry has `shared == true` and all other entries `shared == false`; `OCR_SHARED_DIR` is `"shared"`.
- **Crate pipeline (pipeline.rs):** the ignored E2E test updated to the new `load(detector_path, lang_dir, lang)` signature.
- **On-device gate (Android, tablet AVD):** (1) **fresh install** → ✨ → models download (detector → `ocr-models/shared/`, rec → `ocr-models/<lang>/`, verified via `run-as ls`) → OCR works end-to-end; (2) **migration** → pre-place a v0.13.0-style detector at `ocr-models/<lang>/comic-text-detector.onnx`, run ✨ → confirm it's **moved** to `shared/` (no 94 MB re-download — watch the progress events / timing) and OCR still works.

## Risks
- This is the reliability-critical download/cache/load path. Mitigated by: migrate-move (existing users incur **zero** re-download), unit tests on the routing/manifest, and the on-device gate covering both fresh-install and migration.
- No new hosted models, no server-side change — purely local cache-layout.

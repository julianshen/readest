# Shared detector cache — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Store the language-agnostic `comic-text-detector.onnx` (~94 MB) once in `ocr-models/shared/` and reference it from every OCR language, instead of re-downloading it into each `ocr-models/<lang>/` dir.

**Architecture:** Identify the shared file by name (`ModelFile::is_shared()` → the detector). Route downloads/presence-checks to `ocr-models/shared/` (shared) vs `ocr-models/<lang>/` (per-language). `OcrPipeline::load` takes the detector path + the lang dir separately. On ensure, migrate an existing per-lang detector into `shared/` (move, no re-download) and clean orphans.

**Tech Stack:** Rust (`manga-ocr` crate is GTK-free + host-testable; `Readest` Tauri crate's Android block compiles only in the APK build).

**Context (verified):**
- `models.rs`: `ModelFile { name, url, sha256 }`; detector entries (ja[0]/ko[0]/zh[0]) all use `JA_DETECTOR_URL`/`JA_DETECTOR_SHA`. `manifest_for(lang)`, `verify_sha256`.
- `pipeline.rs`: `OcrPipeline::load(model_dir, lang)` loads detector from `model_dir.join("comic-text-detector.onnx")` + engine files from `model_dir`. Ignored E2E test at the bottom.
- `src-tauri/src/ocr.rs`: `ensure_ocr_models` (download all manifest files into `ocr-models/<lang>/`), `ocr_models_present` (check there), `ocr_page_regions` (`#[cfg(target_os="android")]` block → `OcrPipeline::load(ocr-models/<lang>, lang)`).
- Run crate tests: `cd apps/readest-app && cargo test -p manga-ocr`. Build onnx: `cargo build -p manga-ocr --features onnx`. The `Readest` crate needs GTK (cairo) which isn't on this host → `ocr.rs` is verified by `pnpm fmt:check` + review + the APK build (Task 4). Branch `perf/shared-detector-cache`.

## File Structure

| File | Change |
|---|---|
| `crates/manga-ocr/src/models.rs` | add `DETECTOR_FILE` + `OCR_SHARED_DIR` consts + `ModelFile::is_shared()`; detector `name:` → `DETECTOR_FILE`. |
| `crates/manga-ocr/src/pipeline.rs` | `OcrPipeline::load(detector_path, lang_dir, lang)`. |
| `src-tauri/src/ocr.rs` | route shared vs per-lang dirs in `ensure_ocr_models`/`ocr_models_present`; migrate-move + orphan cleanup; pass detector path + lang dir to `load`. |

---

### Task 1: `models.rs` — shared-file identity

**Files:** Modify `crates/manga-ocr/src/models.rs`.

- [ ] **Step 1: Write the failing test** — add to the `#[cfg(test)] mod tests`:

```rust
    #[test]
    fn detector_is_the_only_shared_file() {
        for m in [ja_manifest(), ko_manifest(), zh_manifest()] {
            let shared: Vec<&str> = m.iter().filter(|f| f.is_shared()).map(|f| f.name).collect();
            assert_eq!(shared, vec![DETECTOR_FILE], "exactly the detector is shared");
        }
        assert_eq!(OCR_SHARED_DIR, "shared");
    }
```

- [ ] **Step 2: Run → fail.** `cargo test -p manga-ocr detector_is_the_only_shared_file` — Expected: FAIL (missing items).

- [ ] **Step 3: Implement** — add after the `ModelFile` struct (top of `models.rs`):

```rust
/// Filename of the shared, language-agnostic text-block detector.
pub const DETECTOR_FILE: &str = "comic-text-detector.onnx";
/// Subdirectory (under `ocr-models/`) holding files shared across all languages.
pub const OCR_SHARED_DIR: &str = "shared";

impl ModelFile {
    /// True for files shared across all languages (the detector), which live in
    /// the shared cache dir instead of a per-language dir.
    pub fn is_shared(&self) -> bool {
        self.name == DETECTOR_FILE
    }
}
```

Then change the three detector entries' `name: "comic-text-detector.onnx",` → `name: DETECTOR_FILE,` (in `ja_manifest`, `ko_manifest`, `zh_manifest`) so the name has a single source of truth.

- [ ] **Step 4: Run → pass.** `cargo test -p manga-ocr models` — Expected: PASS (existing + new). (`ja_manifest_has_four_valid_entries` and `ko_zh_manifests_valid_and_share_detector` still pass — they read `.name`/`.sha256`, unaffected.)
- [ ] **Step 5: Commit** `feat(ocr): mark the detector as the shared model file`.

### Task 2: `pipeline.rs` — split detector path from lang dir

**Files:** Modify `crates/manga-ocr/src/pipeline.rs`.

- [ ] **Step 1: Update the ignored E2E test** to the new signature (replace the `mod tests`):

```rust
#[cfg(all(feature = "onnx", test))]
mod tests {
    use super::*;

    #[test]
    #[ignore]
    fn pipeline_detects_and_recognizes_sample_page() {
        let dir = std::path::PathBuf::from(
            std::env::var("MANGA_OCR_MODEL_DIR").expect("set MANGA_OCR_MODEL_DIR"),
        );
        let detector = dir.join("comic-text-detector.onnx");
        let mut p = OcrPipeline::load(&detector, &dir, "ja").unwrap();
        p.conf_thresh = 0.12;
        let bytes =
            std::fs::read("tests-fixtures/manga_page_sample.png").expect("fixture not found");
        let regions = p.run(&bytes).unwrap();
        assert!(!regions.is_empty(), "expected at least one region");
        assert!(regions.iter().any(|r| r.original.contains("こんにち")));
        assert!(OcrPipeline::load(&detector, &dir, "xx").is_err());
    }
}
```

- [ ] **Step 2: Implement** — replace the `pub fn load` (keep `run` unchanged):

```rust
    /// Load the shared detector (from `detector_path`) + the per-language engine
    /// files (from `lang_dir`). `ja` → manga-ocr seq2seq; `ko`/`zh` → PP-OCRv5 CTC.
    pub fn load(
        detector_path: &std::path::Path,
        lang_dir: &std::path::Path,
        lang: &str,
    ) -> Result<Self, String> {
        let detector = crate::detect::Detector::load(detector_path)?;
        let engine: Box<dyn crate::recognize::OcrEngine + Send> = match lang {
            "ja" => Box::new(crate::recognize::MangaOcrEngine::load(
                &lang_dir.join("encoder_model.onnx"),
                &lang_dir.join("decoder_model.onnx"),
                &lang_dir.join("vocab.txt"),
            )?),
            "ko" | "zh" => {
                let spec = crate::models::ctc_spec(lang)
                    .ok_or_else(|| format!("no ctc spec for {lang}"))?;
                Box::new(crate::recognize::CtcRecognizer::load(
                    &lang_dir.join(spec.rec_onnx),
                    &lang_dir.join(spec.dict),
                    spec.input_h,
                )?)
            }
            other => return Err(format!("unsupported source language: {other}")),
        };
        Ok(Self {
            detector,
            engine,
            conf_thresh: 0.3,
            nms_thresh: 0.35,
        })
    }
```

- [ ] **Step 3: Build.** `cargo build -p manga-ocr --features onnx` — Expected: compiles clean. `cargo test -p manga-ocr` — Expected: non-onnx unit tests pass. `cargo fmt -p manga-ocr`.
- [ ] **Step 4: Commit** `refactor(ocr): OcrPipeline::load takes detector path + lang dir`.

### Task 3: `ocr.rs` — route shared/per-lang dirs + migrate-move

**Files:** Modify `src-tauri/src/ocr.rs`.

- [ ] **Step 1: Replace `ensure_ocr_models`** (the migration + orphan cleanup + routed `.part`/target):

```rust
#[tauri::command]
pub async fn ensure_ocr_models(app: tauri::AppHandle, lang: String) -> Result<(), String> {
    let manifest = manga_ocr::models::manifest_for(&lang)
        .ok_or_else(|| format!("unsupported OCR language: {lang}"))?;

    let models_root = app
        .path()
        .app_data_dir()
        .map_err(|e| e.to_string())?
        .join("ocr-models");
    let shared_dir = models_root.join(manga_ocr::models::OCR_SHARED_DIR);
    let lang_dir = models_root.join(&lang);
    fs::create_dir_all(&shared_dir).map_err(|e| e.to_string())?;
    fs::create_dir_all(&lang_dir).map_err(|e| e.to_string())?;

    for f in manifest {
        let target_dir = if f.is_shared() { &shared_dir } else { &lang_dir };
        let target = target_dir.join(f.name);

        // Migration: if a shared file isn't in shared/ yet but a valid copy sits in
        // the lang dir (pre-shared-cache layout), move it instead of re-downloading.
        if f.is_shared() && !target.exists() {
            let legacy = lang_dir.join(f.name);
            if let Ok(bytes) = fs::read(&legacy) {
                if manga_ocr::models::verify_sha256(&bytes, f.sha256) {
                    let _ = fs::rename(&legacy, &target);
                }
            }
        }

        if target.exists() {
            if let Ok(existing) = fs::read(&target) {
                if manga_ocr::models::verify_sha256(&existing, f.sha256) {
                    if f.is_shared() {
                        let _ = fs::remove_file(lang_dir.join(f.name)); // drop legacy orphan
                    }
                    continue;
                }
            }
        }

        let resp = reqwest::get(f.url).await.map_err(|e| e.to_string())?;
        let total = resp.content_length().unwrap_or(0);
        let mut stream = resp.bytes_stream();

        // Stream chunks straight to the `.part` file while feeding the hasher
        // incrementally, so a 94 MB file never sits fully in RAM.
        let part = target_dir.join(format!("{}.part", f.name));
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
        if f.is_shared() {
            let _ = fs::remove_file(lang_dir.join(f.name)); // drop legacy orphan
        }
    }

    Ok(())
}
```

- [ ] **Step 2: Replace `ocr_models_present`'s dir logic** (route per-file):

```rust
#[tauri::command]
pub async fn ocr_models_present(app: tauri::AppHandle, lang: String) -> Result<bool, String> {
    let Some(manifest) = manga_ocr::models::manifest_for(&lang) else {
        return Ok(false);
    };
    let models_root = app
        .path()
        .app_data_dir()
        .map_err(|e| e.to_string())?
        .join("ocr-models");
    let shared_dir = models_root.join(manga_ocr::models::OCR_SHARED_DIR);
    let lang_dir = models_root.join(&lang);
    Ok(manifest.iter().all(|f| {
        let dir = if f.is_shared() { &shared_dir } else { &lang_dir };
        std::fs::metadata(dir.join(f.name))
            .map(|m| m.len() > 0)
            .unwrap_or(false)
    }))
}
```

- [ ] **Step 3: Update `ocr_page_regions`'s android block** to pass the detector path + lang dir. Replace the `#[cfg(target_os = "android")]` block body:

```rust
    #[cfg(target_os = "android")]
    {
        let models_root = app
            .path()
            .app_data_dir()
            .map_err(|e| e.to_string())?
            .join("ocr-models");
        let detector_path = models_root
            .join(manga_ocr::models::OCR_SHARED_DIR)
            .join(manga_ocr::models::DETECTOR_FILE);
        let lang_dir = models_root.join(&source_lang);
        tauri::async_runtime::spawn_blocking(move || {
            let mut guard = OCR_PIPELINE
                .lock()
                .unwrap_or_else(|poisoned| poisoned.into_inner());
            // (Re)load when empty or when the requested language differs.
            if guard
                .as_ref()
                .map(|(l, _)| l != &source_lang)
                .unwrap_or(true)
            {
                let pipeline =
                    manga_ocr::pipeline::OcrPipeline::load(&detector_path, &lang_dir, &source_lang)
                        .map_err(|e| {
                            format!("load OCR models (call ensure_ocr_models first?): {e}")
                        })?;
                *guard = Some((source_lang.clone(), pipeline));
            }
            guard.as_mut().unwrap().1.run(&image_bytes)
        })
        .await
        .map_err(|e| format!("join: {e}"))?
    }
```

- [ ] **Step 4: Verify.** `cd apps/readest-app && pnpm fmt:check` (Rust formatting). `grep -n "OcrPipeline::load(&cache_dir\|\.join(&lang)\b" src-tauri/src/ocr.rs` → only the intended `lang_dir`/`shared_dir` joins remain (no stale single-dir `load`). (Full compile of `Readest` needs GTK — not on this host; the APK build in Task 4 is the compile gate.)
- [ ] **Step 5: Commit** `feat(ocr): shared detector cache + migrate-move from per-lang dirs`.

### Task 4: On-device gate (fresh-install + migration)

**Files:** none (verification). Per [[android-build-flow]] in `.agents/memory`; use the **4 GB tablet AVD (emulator-5556)** + the **state-aware toolbar reveal** (see [[comic-auto-translate-phase1]]).

- [ ] **Step 1:** `pnpm android:onnx` then build the debug APK (`pnpm tauri android build --debug --target x86_64 --apk`), strip/sign/install on emulator-5556.
- [ ] **Step 2 (fresh install):** uninstall first so the cache is empty. Open the ZH test CBZ → ✨ → auto-detect → download. Then verify the layout: `adb -s emulator-5556 shell run-as com.jlnshen.reader ls -la ocr-models/shared ocr-models/zh` → detector in `ocr-models/shared/`, `rec.onnx`+`dict.txt` in `ocr-models/zh/`, **no** detector in `ocr-models/zh/`. Confirm OCR works end-to-end (markers + 早上好!→translation).
- [ ] **Step 3 (migration):** simulate a v0.13.0 cache — `run-as ... mkdir -p ocr-models/ja && cp ocr-models/shared/comic-text-detector.onnx ocr-models/ja/ && rm -rf ocr-models/shared` (leave the detector only in a lang dir). Then trigger ensure for that lang (open a `ja` book → ✨, or call `ensureOcrModels('ja')`): confirm the detector is **moved** to `ocr-models/shared/` with **no 94 MB re-download** (watch `ocr-model-download` progress / timing — a move is instant) and `ocr-models/ja/comic-text-detector.onnx` is gone. OCR still works.
- [ ] **Step 4:** Capture screenshots / `ls` output. Note any deviation.

## Final verification
- `cargo test -p manga-ocr` (units pass; E2E stays `#[ignore]`), `cargo build -p manga-ocr --features onnx` clean, `pnpm fmt:check` clean. On-device gate: fresh-install layout correct + migration moves (no re-download), OCR works.

## Self-review
- **Spec coverage:** shared layout (T3), `is_shared`/`OCR_SHARED_DIR`/`DETECTOR_FILE` (T1), routed download/presence (T3), `load(detector_path, lang_dir, lang)` (T2), migrate-move + orphan cleanup (T3), testing units (T1/T2) + two-case on-device gate (T4). All mapped. (Implementation note: the spec said `shared: bool` on `ModelFile`; using `is_shared()` keyed on the fixed detector filename is equivalent, avoids editing 10 struct literals, and keeps a single source of truth — a deliberate refinement, not a gap.)
- **Type consistency:** `OcrPipeline::load(detector_path, lang_dir, lang)` identical in T2 (def + test) and T3 (caller); `is_shared()`/`OCR_SHARED_DIR`/`DETECTOR_FILE` from `manga_ocr::models` used consistently in T1→T3.
- **No new hosted models / no TS change** — purely local cache-layout, as scoped.
